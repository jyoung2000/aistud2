"""Stage 2 — intent parsing: casual user text → structured EditSpec.

Deterministic and rule-based (no LLM dependency): a verb/keyword taxonomy plus ~40
pattern rules, ordered most-specific-first. The parser never fails — unknown phrasing
falls through to a generic `restyle`/`replace` with the raw text carried along, and
anything unresolved lands in `ambiguities` so the UI can ask instead of guessing.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Optional

# --- vocab ------------------------------------------------------------------

COLOR_WORDS = {
    "red", "orange", "yellow", "green", "blue", "purple", "violet", "pink", "brown",
    "black", "white", "gray", "grey", "gold", "golden", "silver", "beige", "teal",
    "cyan", "magenta", "maroon", "navy", "olive", "turquoise", "crimson", "scarlet",
    "ivory", "cream", "tan", "charcoal", "emerald", "ruby", "sapphire", "amber",
}

MATERIAL_WORDS = {
    "leather", "denim", "silk", "cotton", "wool", "velvet", "linen", "metal", "metallic",
    "chrome", "steel", "iron", "copper", "brass", "wood", "wooden", "oak", "marble",
    "stone", "brick", "concrete", "glass", "plastic", "rubber", "ceramic", "porcelain",
    "fur", "suede", "lace", "satin", "canvas", "paper", "gold", "silver", "crystal",
}

STYLE_WORDS = {
    "photorealistic", "realistic", "cartoon", "anime", "watercolor", "watercolour",
    "oil", "painting", "sketch", "pencil", "pixel", "cyberpunk", "steampunk", "vintage",
    "retro", "noir", "minimalist", "impressionist", "surreal", "abstract", "gothic",
    "baroque", "pop-art", "comic", "manga", "3d", "render", "claymation", "origami",
}

LIGHT_WORDS = {
    "brighter", "darker", "sunset", "sunrise", "golden hour", "night", "daylight",
    "moonlight", "candlelight", "neon", "studio lighting", "backlit", "dramatic lighting",
    "soft lighting", "hard light", "overcast", "sunny",
}

# vague quality words with no dimension — these are the classic ambiguous asks
VAGUE_WORDS = {"better", "nicer", "improve", "improved", "good", "great", "fix", "fixed", "enhance", "enhanced", "cooler", "prettier", "cleaner"}

PRONOUNS = {"it", "this", "that", "them", "these", "those"}

# --- model ------------------------------------------------------------------

OPERATIONS = (
    "replace", "remove", "add", "restyle", "recolor", "retexture", "pose_change",
    "expression", "background_swap", "text_edit", "relight", "upscale_detail",
)


@dataclass
class EditSpec:
    operation: str = "restyle"
    target_noun: Optional[str] = None      # what they referenced ("the jacket")
    new_content: Optional[str] = None      # what it becomes
    attributes: List[str] = field(default_factory=list)   # colors/materials/styles named
    preserve: List[str] = field(default_factory=list)     # anything they said to keep
    ambiguities: List[str] = field(default_factory=list)  # unresolved references
    specificity: str = "med"               # low | med | high
    raw: str = ""
    rule: str = ""                          # which rule fired (for rationale/telemetry)

    def to_dict(self) -> dict:
        return {
            "operation": self.operation,
            "target_noun": self.target_noun,
            "new_content": self.new_content,
            "attributes": self.attributes,
            "preserve": self.preserve,
            "ambiguities": self.ambiguities,
            "specificity": self.specificity,
            "raw": self.raw,
            "rule": self.rule,
        }


# --- helpers ----------------------------------------------------------------

_ARTICLE = r"(?:the |a |an |my |his |her |their |its )?"


def _clean(s: Optional[str]) -> Optional[str]:
    if s is None:
        return None
    s = s.strip(" .,!;:")
    return s or None


def _attrs_in(text: str) -> List[str]:
    t = text.lower()
    out: List[str] = []
    for w in sorted(COLOR_WORDS | MATERIAL_WORDS | STYLE_WORDS):
        if re.search(rf"\b{re.escape(w)}\b", t) and w not in out:
            out.append(w)
    return out


def _preserve_in(text: str) -> List[str]:
    out: List[str] = []
    for m in re.finditer(
        rf"(?:keep|preserve|maintain|don'?t (?:change|touch|alter)|leave|without changing)\s+{_ARTICLE}([\w\s'-]{{2,60}}?)(?:\s+(?:the same|identical|unchanged|intact|alone|as is))?(?:[,.;]|$)",
        text,
        re.I,
    ):
        p = _clean(m.group(1))
        if p and p.lower() not in ("everything else",):
            out.append(p)
    return out


def _strip_preserve(text: str) -> str:
    """Remove preservation sub-clauses so the change-detection rules see only the ask."""
    return re.sub(
        rf"(?:but\s+|and\s+|,\s*)?(?:keep|preserve|maintain|don'?t (?:change|touch|alter)|leave)\s+{_ARTICLE}[\w\s'-]{{2,60}}?(?:\s+(?:the same|identical|unchanged|intact|alone|as is))?(?=[,.;]|$)",
        "",
        text,
        flags=re.I,
    ).strip(" ,.;")


# --- rules ------------------------------------------------------------------
# Each rule: (name, compiled regex or predicate) → fills the spec. Ordered
# most-specific-first; the FIRST match wins the operation. ~40 rules total.

_QUOTED = r"[\"'“”‘’]([^\"'“”‘’]{1,120})[\"'“”‘’]"

_RULES: list[tuple[str, str]] = []  # (name, pattern) — documented for the audit


def parse_intent(text: str) -> EditSpec:
    raw = (text or "").strip()
    spec = EditSpec(raw=raw)
    if not raw:
        spec.operation = "restyle"
        spec.ambiguities.append("empty request — describe what should change")
        spec.specificity = "low"
        spec.rule = "empty"
        return spec

    t = _strip_preserve(raw)
    low = t.lower()
    spec.preserve = _preserve_in(raw)
    spec.attributes = _attrs_in(raw)

    quotes = re.findall(_QUOTED, raw)

    def done(rule: str) -> EditSpec:
        spec.rule = rule
        _finish(spec, raw)
        return spec

    # ---- text edits (quoted strings + text-ish nouns) ----
    m = re.search(rf"replace\s+{_QUOTED}\s+with\s+{_QUOTED}", raw, re.I)
    if m:  # 1. replace 'old' with 'new'
        spec.operation = "text_edit"
        spec.target_noun = m.group(1)
        spec.new_content = m.group(2)
        return done("text_edit.replace_quoted")
    m = re.search(rf"(?:change|make|set)\s+(?:the\s+)?(?:text|sign|label|caption|writing|words?)\s*(?:to|say|read)?\s*{_QUOTED}", raw, re.I)
    if m:  # 2. change the text to '...'
        spec.operation = "text_edit"
        spec.new_content = m.group(1)
        return done("text_edit.set_quoted")
    if quotes and re.search(r"\b(text|sign|label|caption|writing|words?|says?|reads?)\b", low):
        # 3. quoted string + text-noun anywhere
        spec.operation = "text_edit"
        spec.new_content = quotes[-1]
        spec.target_noun = quotes[0] if len(quotes) > 1 else None
        return done("text_edit.quoted_plus_noun")

    # ---- remove ----
    m = re.search(rf"\b(?:remove|delete|erase|get rid of|take (?:out|away)|eliminate|clear away)\s+{_ARTICLE}([\w\s'-]{{2,60}}?)(?:[,.;]|$)", t, re.I)
    if m:  # 4. remove X
        spec.operation = "remove"
        spec.target_noun = _clean(m.group(1))
        return done("remove.verb")
    if re.fullmatch(r"(?:remove|delete|erase)(?:\s+(?:it|this|that))?[.!]?", low):  # 5. bare "remove it"
        spec.operation = "remove"
        return done("remove.bare")
    if re.search(r"\bmake\s+(?:it|this|that)\s+(?:disappear|vanish|go away)\b", low):  # 6.
        spec.operation = "remove"
        return done("remove.disappear")
    if re.search(r"\b(?:without|no more)\s+", low) and len(low.split()) <= 5:  # 7. "without the hat"
        m = re.search(rf"\b(?:without|no more)\s+{_ARTICLE}([\w\s'-]{{2,40}})", t, re.I)
        if m:
            spec.operation = "remove"
            spec.target_noun = _clean(m.group(1))
            return done("remove.without")

    # ---- background swap (before replace so "change the background to X" wins) ----
    m = re.search(rf"(?:change|swap|replace|make)\s+the\s+(?:background|backdrop|scenery|setting)\s+(?:to|into|with|for)\s+(.{{2,120}}?)(?:[.;]|$)", t, re.I)
    if m:  # 8.
        spec.operation = "background_swap"
        spec.target_noun = "background"
        spec.new_content = _clean(m.group(1))
        return done("background.change_to")
    if re.search(r"\b(?:background|backdrop)\b", low) and re.search(r"\b(?:beach|city|forest|mountain|studio|space|sunset|office|street|sky)\b", low):
        # 9. "put them on a beach background"
        spec.operation = "background_swap"
        spec.target_noun = "background"
        spec.new_content = _clean(re.sub(r".*?\b(?:background|backdrop)\b\s*(?:to|of|with)?", "", t, flags=re.I)) or t
        return done("background.scene_noun")

    # ---- replace / turn into ----
    for name, pat in (
        ("replace.change_to", rf"(?:change|turn|convert|transform|swap|morph)\s+(?:out\s+)?{_ARTICLE}([\w\s'-]{{2,60}}?)\s+(?:to|into|for)\s+(.{{2,120}}?)(?:[.;]|$)"),
        ("replace.replace_with", rf"replace\s+{_ARTICLE}([\w\s'-]{{2,60}}?)\s+(?:with|by)\s+(.{{2,120}}?)(?:[.;]|$)"),
        ("replace.make_into", rf"make\s+{_ARTICLE}([\w\s'-]{{2,60}}?)\s+into\s+(.{{2,120}}?)(?:[.;]|$)"),
        ("replace.swap_for", rf"swap\s+(?:out\s+)?{_ARTICLE}([\w\s'-]{{2,60}}?)\s+for\s+(.{{2,120}}?)(?:[.;]|$)"),
    ):  # 10-13
        m = re.search(pat, t, re.I)
        if m:
            spec.operation = "replace"
            spec.target_noun = _clean(m.group(1))
            spec.new_content = _clean(m.group(2))
            # a pure color/material new_content is really a recolor/retexture
            nc = (spec.new_content or "").lower()
            words = set(nc.split())
            if words and words <= COLOR_WORDS:
                spec.operation = "recolor"
                return done("recolor.change_to_color")
            if words and words <= (MATERIAL_WORDS | {"a", "the"}):
                spec.operation = "retexture"
                return done("retexture.change_to_material")
            return done(name)

    # ---- add ----
    m = re.search(rf"\b(?:add|insert|put|place|give (?:him|her|them|it))\s+(?:in\s+|on\s+)?{_ARTICLE}(.{{2,120}}?)(?:\s+(?:to|into|onto|on|in)\s+.{{0,60}})?(?:[.;]|$)", t, re.I)
    # "give her a surprised expression / a smile" is an expression edit, not an add
    if m and low.startswith("give") and re.search(
        r"\b(?:smile|smiling|frown|expression|surprised|angry|sad|happy|wink|serious)\b", low
    ):
        m = None
    if m and re.match(r"\b(?:add|insert|put|place|give)", low):  # 14.
        spec.operation = "add"
        spec.new_content = _clean(m.group(1))
        return done("add.verb")
    if re.match(r"(?:with|wearing|holding)\s+", low):  # 15. "wearing a red hat"
        spec.operation = "add"
        spec.new_content = _clean(t)
        return done("add.wearing")

    # ---- pose / expression ----
    if re.search(r"\b(?:pose|posture|stance|position of (?:the )?(?:arm|leg|hand|head|body))\b", low) or re.search(
        r"\b(?:raise|lower|cross|extend|bend|lift)\s+(?:his|her|their|the)\s+(?:arms?|legs?|hands?|head)\b", low
    ):  # 16-17
        spec.operation = "pose_change"
        spec.new_content = _clean(t)
        return done("pose.keywords")
    if re.search(r"\b(?:smile|smiling|frown|laugh|laughing|angry|sad|happy|surprised|expression|wink|serious face)\b", low):  # 18.
        spec.operation = "expression"
        spec.new_content = _clean(t)
        return done("expression.keywords")

    # ---- relight ----
    if re.search(r"\b(?:lighting|relight|illuminat|light it|backlit|golden hour|sunset light|studio light|brighter|darker|dimmer)\b", low):  # 19.
        spec.operation = "relight"
        spec.new_content = _clean(t)
        return done("relight.keywords")

    # ---- upscale / detail ----
    if re.search(r"\b(?:sharper|sharpen|more detail|detailed|higher (?:res|resolution)|upscale|crisper|less blurry|deblur|enhance detail)\b", low):  # 20.
        spec.operation = "upscale_detail"
        return done("detail.keywords")

    # ---- recolor: color word + optional target ----
    m = re.search(rf"(?:make|paint|color|colour|dye|tint)\s+{_ARTICLE}([\w\s'-]{{2,40}}?)\s+((?:\w+\s+)?\w+)$", t, re.I)
    if m and set(m.group(2).lower().split()) & COLOR_WORDS:  # 21. "make the car blue"
        spec.operation = "recolor"
        tgt = _clean(m.group(1))
        spec.target_noun = None if (tgt or "").lower() in PRONOUNS else tgt
        spec.new_content = _clean(m.group(2))
        return done("recolor.make_color")
    if spec.attributes and set(spec.attributes) & COLOR_WORDS and len(low.split()) <= 6 and not re.search(r"\bstyle\b", low):
        # 22. short ask naming a color ("blue jacket please")
        spec.operation = "recolor"
        spec.new_content = _clean(t)
        return done("recolor.short_color")

    # ---- retexture: material word + make/turn ----
    m = re.search(rf"(?:make|turn)\s+{_ARTICLE}([\w\s'-]{{2,40}}?)\s+(?:look\s+)?(?:like\s+)?((?:\w+\s+)?\w+)$", t, re.I)
    if m and set(m.group(2).lower().split()) & MATERIAL_WORDS:  # 23. "make the table marble"
        spec.operation = "retexture"
        tgt = _clean(m.group(1))
        spec.target_noun = None if (tgt or "").lower() in PRONOUNS else tgt
        spec.new_content = _clean(m.group(2))
        return done("retexture.make_material")

    # ---- restyle ----
    if re.search(r"\bin the style of\b|\bstyle of\b|\blike a (?:painting|photo|sketch|cartoon)\b", low):  # 24.
        spec.operation = "restyle"
        spec.new_content = _clean(t)
        return done("restyle.style_of")
    if set(low.split()) & STYLE_WORDS:  # 25. style word present
        spec.operation = "restyle"
        spec.new_content = _clean(t)
        return done("restyle.style_word")

    # ---- vague / fallback ----
    vague = set(re.findall(r"[a-z']+", low)) & VAGUE_WORDS
    if vague and len(low.split()) <= 6:  # 26. "make it better"
        spec.operation = "restyle"
        spec.ambiguities.append(
            f"'{sorted(vague)[0]}' — better how? (sharper / brighter / more detailed / different style)"
        )
        return done("vague.quality_word")

    m = re.search(rf"^make\s+{_ARTICLE}([\w\s'-]{{2,40}}?)\s+(.{{2,80}})$", t, re.I)
    if m:  # 27. generic "make X Y"
        tgt = _clean(m.group(1))
        spec.operation = "restyle"
        spec.target_noun = None if (tgt or "").lower() in PRONOUNS else tgt
        spec.new_content = _clean(m.group(2))
        return done("restyle.make_generic")

    # 28. fallback: treat the whole text as the desired result
    spec.operation = "restyle"
    spec.new_content = _clean(t)
    return done("fallback.raw")


def _finish(spec: EditSpec, raw: str) -> None:
    low = raw.lower()
    words = re.findall(r"[a-z']+", low)
    # pronoun-only target when nothing concrete was named (fine: "it" = the selection, but flag
    # when the sentence NEEDS a distinct target, e.g. remove with no noun at all)
    if spec.operation in ("replace", "remove") and not spec.target_noun and not any(
        w for w in words if w not in PRONOUNS and len(w) > 3
    ):
        spec.ambiguities.append("no target named — applying to the whole selection")
    # specificity: word count + concrete attributes/nouns
    concrete = len(spec.attributes) + (1 if spec.target_noun else 0) + (1 if spec.new_content and len(spec.new_content.split()) > 1 else 0)
    n = len(words)
    if n <= 3 and concrete == 0:
        spec.specificity = "low"
    elif n >= 8 or concrete >= 2:
        spec.specificity = "high"
    else:
        spec.specificity = "med"

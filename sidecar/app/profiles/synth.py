"""Synthesis — one intent → a model-tuned prompt, grounded in the selection.

Two cheap calls per edit in the full design: (1) vision-grounding of the crop → a factual
description + the subject as a noun phrase; (2) intent classification → edit type. Then a
fixed paradigm transform applies the profile's template + preservation clause + style rules,
enforcing constraints (token cap; negatives only if supported). The synthesis LOGIC is fixed
code; the profile supplies data only (templates/clauses) and can never raise the token cap
or weaken safety. Vision grounding is stubbed here (no LLM); subject/description are passed
in or defaulted.
"""
from __future__ import annotations

import re
from typing import Dict, Optional, Tuple

_TEXT_EDIT = re.compile(r"""replace\s+['"](?P<old>[^'"]+)['"]\s+with\s+['"](?P<new>[^'"]+)['"]""", re.I)


def classify(intent: str) -> Tuple[str, Dict[str, str]]:
    m = _TEXT_EDIT.search(intent or "")
    if m:
        return "text_edit", {"old": m.group("old"), "new": m.group("new")}
    return "generic", {}


def _truncate(text: str, max_tokens: int) -> Tuple[str, bool]:
    # ~1.3 tokens/word heuristic
    max_words = max(4, int(max_tokens / 1.3))
    words = text.split()
    if len(words) <= max_words:
        return text, False
    return " ".join(words[:max_words]).rstrip(",.") + ".", True


def _fmt(tmpl: str, **kw) -> str:
    class _Safe(dict):
        def __missing__(self, k):  # leave unknown placeholders blank, never crash
            return ""

    return tmpl.format_map(_Safe(**kw))


def synthesize(
    profile: dict,
    intent: str,
    subject: Optional[str] = None,
    reference_role: Optional[str] = None,
    crop_desc: Optional[str] = None,
    loras: Optional[list] = None,
) -> dict:
    paradigm = profile.get("paradigm", "instruction")
    subject = (subject or "the selected subject").strip()
    preservation = profile.get("preservation_clause", "")
    templates: dict = profile.get("templates", {}) or {}
    rules = []

    edit_type, slots = classify(intent)
    if edit_type == "text_edit" and "text_edit" in templates:
        prompt = _fmt(templates["text_edit"], old=slots["old"], new=slots["new"],
                      preservation=preservation, subject=subject, intent=intent)
        rules.append("text-edit: forced Replace 'old' with 'new'")
    else:
        key_by_paradigm = {
            "instruction": "instruction",
            "inpaint": "inpaint",
            "controlnet": "controlnet",
            "reference/character": "reference",
        }
        key = key_by_paradigm.get(paradigm, "instruction")
        if reference_role and "reference" in templates:
            key = "reference"
        tmpl = templates.get(key) or templates.get("instruction") or "{intent}. {preservation}"
        prompt = _fmt(tmpl, intent=(intent or "apply the reference"),
                      preservation=preservation, subject=subject)
        rules.append(f"{paradigm}: applied '{key}' template")

    if crop_desc:
        rules.append("vision-grounded subject")
    if reference_role:
        rules.append(f"reference role: {reference_role}")

    # LoRA trigger-word injection — prepend any attached LoRA triggers so the LoRA fires.
    if loras:
        triggers: list = []
        for lo in loras:
            for tw in lo.get("trigger_words", []) or ([lo["trigger"]] if lo.get("trigger") else []):
                if tw and tw not in triggers:
                    triggers.append(tw)
        if triggers:
            prompt = f"{', '.join(triggers)}, {prompt}"
            rules.append(f"injected LoRA trigger(s): {', '.join(triggers)}")

    max_tokens = int(profile.get("constraints", {}).get("max_prompt_tokens", 512))
    prompt, truncated = _truncate(" ".join(prompt.split()), max_tokens)
    if truncated:
        rules.append(f"truncated to token cap {max_tokens}")

    return {"prompt": prompt.strip(), "rule_note": "; ".join(rules), "paradigm": paradigm}

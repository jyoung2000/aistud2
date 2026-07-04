"""Stage 4 — the per-model prompt compiler.

compile_prompt(EditSpec, SelectionContext, profile) → {prompt, negative_prompt,
params_overrides, rationale[], clauses[], send_region_pad}

The compiler is deterministic and works with zero network access. Every clause it adds
carries a machine-readable kind and a human-readable reason (surfaced in the UI). The
per-model behavior is DATA (the profile's prompt_grammar / dos / known_failures /
vocab, sourced in the research layers); the strategies below are fixed code.

Operation strategies (each documented with its source or reasoning):
- remove on an INPAINT model describes the background that should exist — an inpaint
  model paints what you describe, it does not execute commands (FLUX Fill card: "fills
  masked regions based on a text description"; community failure reports of 'remove'
  prompts regenerating objects: github.com/huggingface/diffusers/issues/9486).
- recolor restates object identity + new color + "same shape, material, lighting" so
  the model doesn't reinvent the object (BFL Kontext guide: be specific, preserve).
- text_edit quotes exact strings (BFL Kontext guide: Replace '[old]' with '[new]';
  Qwen-Image-Edit blog: text edits preserve font/size/style).
- background_swap pins the subject: "keep ... exact same position, scale, and pose"
  (BFL Kontext guide's three-layer example).
"""
from __future__ import annotations

from typing import List, Optional

from app.prompting.context import SelectionContext
from app.prompting.intent import EditSpec

# Clause kinds, in DROP priority order when over the token budget (leftmost dropped
# first). "change" and "preservation" are never dropped; LoRA triggers are load-bearing.
DROP_ORDER = ["quality", "vocab", "scene", "position", "context"]
NEVER_DROP = {"change", "preservation", "reference", "lora", "mitigation", "medium"}

# Medium-locked style language. Crossing mediums is the #1 way an edit sticks out —
# "photorealistic, detailed" inside a cel-shaded drawing (or a cartoon patch inside a
# photograph) reads as broken even when the seam is perfect. The compiler therefore
# (a) never emits photo-quality vocab into a non-photo image and (b) pins the medium
# with a load-bearing clause when the image is drawn or CG.
MEDIUM_STYLE = {
    "drawn": {
        "instruction": "Match the original hand-drawn / animated style exactly — same "
                       "line weight, flat cel shading, and palette; do not make it photorealistic",
        "inpaint": "in the same flat, cel-shaded illustration style as the surrounding "
                   "artwork, clean line art, matching palette",
        "quality": ["clean line art", "flat colors", "consistent illustration style"],
    },
    "render_cg": {
        "instruction": "Match the original 3D-rendered look — smooth CG shading and "
                       "materials; do not make it photographic or hand-drawn",
        "inpaint": "in the same smooth 3D-rendered style as the surrounding image, "
                   "matching CG materials and lighting",
        "quality": ["high-quality 3D render", "smooth shading", "consistent CG style"],
    },
}


def _tokens(text: str) -> int:
    return max(1, int(len(text.split()) * 1.3))  # same heuristic as synth._truncate


def _clause(text: str, kind: str, reason: str) -> dict:
    return {"text": text.strip(), "kind": kind, "reason": reason}


def _target(spec: EditSpec, ctx: SelectionContext) -> str:
    if spec.target_noun:
        return spec.target_noun
    if ctx.selection_label:
        return ctx.selection_label
    if ctx.likely_person:
        return "the person in the selection"
    return "the selected area"


def _sentence(s: str) -> str:
    s = s.strip()
    if s and s[-1] not in ".!?'\"":
        s += "."
    return s[0].upper() + s[1:] if s else s


# --- instruction-paradigm change clauses (Kontext/Qwen grammar) -----------------------

def _instruction_change(spec: EditSpec, ctx: SelectionContext) -> tuple[str, str]:
    t = _target(spec, ctx)
    nc = spec.new_content or ""
    op = spec.operation
    if op == "replace":
        return f"Replace {t} with {nc}", "explicit verb + named subject (BFL Kontext guide)"
    if op == "remove":
        return (
            f"Remove {t} and fill the area with the surrounding background so nothing looks missing",
            "removal with an explicit fill instruction — instruction models accept commands",
        )
    if op == "add":
        where = f" {ctx.position}" if ctx.position and ctx.position != "centered" else ""
        return f"Add {nc} to the selection{where}", "additive edit scoped to the selection"
    if op == "recolor":
        return (
            f"Change the color of {t} to {nc}, keeping the same shape, material, and lighting",
            "recolor restates identity so the object isn't reinvented (BFL Kontext guide: be specific)",
        )
    if op == "retexture":
        return (
            f"Make {t} out of {nc}, keeping the same shape, proportions, and lighting",
            "material change with shape/lighting locks",
        )
    if op == "restyle":
        if nc:
            return (
                f"Change to {nc} while maintaining the original composition and object placement",
                "named style + composition lock (BFL Kontext guide example)",
            )
        return f"Restyle {t}", "generic restyle"
    if op == "pose_change":
        return (
            f"Change the pose: {nc or 'as directed by the control image'}, keeping identity, clothing, and face identical",
            "pose change with identity lock (identity drift is a documented failure — BFL guide)",
        )
    if op == "expression":
        return (
            f"Change the facial expression: {nc}, keeping identity, pose, and lighting identical",
            "expression-only change with identity lock",
        )
    if op == "background_swap":
        subj = ctx.selection_label or ("the person" if ctx.likely_person else "the subject")
        return (
            f"Change the background to {nc} while keeping {subj} in the exact same position, scale, and pose",
            "background swap pins the subject (BFL Kontext guide three-layer example)",
        )
    if op == "text_edit":
        if spec.target_noun and spec.new_content:
            return (
                f"Replace '{spec.target_noun}' with '{spec.new_content}', matching the original font, size, and color",
                "exact-quote text edit (BFL Kontext guide syntax; Qwen preserves font/size/style)",
            )
        return (
            f"Change the text to read '{spec.new_content}', matching the original font, size, and color",
            "quoted target text (Qwen-Image-Edit blog: precise bilingual text editing)",
        )
    if op == "relight":
        return (
            f"Change the lighting: {nc}, keeping subjects, colors, and composition identical",
            "lighting-only edit with content lock",
        )
    if op == "upscale_detail":
        return (
            "Enhance fine detail and sharpness without changing content, colors, or composition",
            "detail pass phrased as a no-content-change instruction",
        )
    return _sentence(spec.raw or "Edit the selection"), "fallback: raw intent"


# --- inpaint-paradigm content descriptions (Fill grammar) ------------------------------

def _inpaint_content(spec: EditSpec, ctx: SelectionContext) -> tuple[str, str]:
    t = _target(spec, ctx)
    nc = spec.new_content or ""
    op = spec.operation
    scene = ctx.scene_desc or "the surrounding scene"
    if op == "remove":
        # THE key strategy: describe the background, never the removal (see module docstring)
        return (
            f"seamless continuation of the surrounding background, {scene}, with no objects present",
            "inpaint models paint what you describe: removals compile to a background description, "
            "not a removal command (FLUX Fill card; diffusers#9486)",
        )
    if op == "background_swap":
        return (nc or "a new background", "masked region described as the new backdrop")
    if op == "recolor":
        return (
            f"{t} in {nc}, same shape and material, matching the surrounding lighting",
            "recolor described as final content with identity restated",
        )
    if op == "retexture":
        return (f"{t} made of {nc}, same shape, matching the surrounding lighting",
                "material change described as final content")
    if op == "text_edit":
        return (
            f"the text reads '{spec.new_content}', matching the original font, size, and color",
            "text edit described as the final rendered text",
        )
    if op == "add":
        return (nc or t, "added object described as the masked region's final content")
    if op == "replace":
        return (nc or t, "replacement described as the masked region's final content (Fill grammar)")
    if op in ("restyle", "relight"):
        return (
            f"{t}, {nc}" if nc else t,
            "restyle described as the region's final appearance",
        )
    if op == "upscale_detail":
        return (f"{t}, sharp and highly detailed", "detail pass described as final appearance")
    return (nc or spec.raw or t, "fallback: raw intent as content description")


def compile_prompt(
    spec: EditSpec,
    ctx: SelectionContext,
    profile: dict,
    strength: str = "normal",
) -> dict:
    paradigm = profile.get("paradigm", "instruction")
    grammar = profile.get("prompt_grammar", {}) or {}
    clauses: List[dict] = []
    rationale: List[str] = []
    params_overrides: dict = {}
    send_region_pad: Optional[float] = None

    # ---- change clause (never dropped) ----
    if paradigm == "inpaint":
        text, why = _inpaint_content(spec, ctx)
        clauses.append(_clause(text, "change", why))
    elif paradigm == "reference/character":
        # identity clause FIRST, then change, then context (Ideogram docs structure)
        clauses.append(_clause(
            "The reference character, with the same facial features and hair",
            "reference", "identity clause first (Ideogram Character docs)"))
        text, why = _instruction_change(spec, ctx)
        clauses.append(_clause(text.lower()[0] + text[1:] if text else text, "change", why))
    else:  # instruction / controlnet
        text, why = _instruction_change(spec, ctx)
        clauses.append(_clause(_sentence(text), "change", why))

    # ---- small-object mitigation (context flag → known_failures) ----
    failures = profile.get("known_failures", []) or []
    flags = {
        "small_object": ctx.small_object,
        "likely_person": ctx.likely_person,
        "remove": spec.operation == "remove",
        "background_swap": spec.operation == "background_swap",
    }
    for f in failures:
        flag = f.get("flag")
        if flag and flags.get(flag):
            rationale.append(f"mitigation applied ({flag}): {f.get('mitigation')} [{f.get('source', '')}]")
            if flag == "small_object":
                send_region_pad = 0.3  # widen the crop so the model gets context
                clauses.append(_clause(
                    "The edit target is small within the frame; keep its scale and position exact",
                    "mitigation", f"small-selection failure pattern: {f.get('pattern')}"))
            if flag == "likely_person" and paradigm != "inpaint":
                clauses.append(_clause(
                    "Keep the person's face, identity, and expression exactly the same"
                    if spec.operation not in ("expression", "pose_change")
                    else "Preserve the person's identity",
                    "mitigation", f"identity-drift failure pattern: {f.get('pattern')}"))

    # ---- medium lock (never dropped): drawn/CG images pin their style ----
    # EXCEPT for restyle — a deliberate "make it watercolor" beats the lock; the user is
    # asking to change the medium, and fighting them would compile a contradiction.
    med = MEDIUM_STYLE.get(ctx.medium or "") if spec.operation != "restyle" else None
    med_reason = (
        f"the image is {ctx.medium}: {ctx.medium_cue or 'medium detected from image statistics'} "
        f"— an edit must stay in the original medium"
    )
    if med and paradigm != "inpaint":
        clauses.append(_clause(med["instruction"], "medium", med_reason))
        rationale.append(f"medium lock ({ctx.medium}): style clause pinned, photo vocab suppressed")

    # ---- scene/context clauses ----
    if paradigm == "inpaint":
        if med:
            clauses.append(_clause(med["inpaint"], "medium", med_reason))
            rationale.append(f"medium lock ({ctx.medium}): description styled to the medium")
        if ctx.scene_desc and spec.operation != "remove":  # remove already embeds it
            clauses.append(_clause(
                f"matching the surrounding {ctx.scene_desc}",
                "scene", "scene-matching descriptors from the image's own LAB statistics"))
        vocab = profile.get("vocab", {}) or {}
        # photo-quality tags ("photorealistic, detailed") only belong in photographs —
        # a non-photo medium swaps in its own quality vocabulary
        quality = (med["quality"] if med else (vocab.get("quality") or []))[:3]
        if quality:
            clauses.append(_clause(", ".join(quality), "quality",
                                   "medium-matched quality tags" if med
                                   else "model-preferred quality tags (research layer vocab)"))
    else:
        if spec.operation in ("replace", "add", "background_swap") and ctx.scene_desc:
            clauses.append(_clause(
                f"Match the scene's {ctx.scene_desc}",
                "scene", "style-matching from the image's own LAB statistics"))

    # ---- preservation clause (never dropped; instruction-family only) ----
    if paradigm != "inpaint":
        keep_bits = list(dict.fromkeys(spec.preserve))
        base_keep = profile.get("preservation_clause") or (
            "Keep everything else — lighting, identity, and composition — exactly the same."
        )
        if keep_bits:
            clauses.append(_clause(
                f"Keep {', '.join(keep_bits)} unchanged. {base_keep}",
                "preservation",
                "user's preserve list + explicit preservation language (BFL Kontext guide)"))
        else:
            clauses.append(_clause(base_keep, "preservation",
                                   "explicit preservation language (BFL Kontext guide)"))

    # ---- reference clause per role ----
    if ctx.reference_role == "replace":
        clauses.append(_clause(
            "Use the second image as the subject to place into the selection",
            "reference", "replace role: reference carries the new subject"))
    elif ctx.reference_role == "pose":
        clauses.append(_clause(
            "Match the pose shown in the control image exactly; change nothing else about the subject",
            "reference", "pose role: control image drives structure only"))
    elif ctx.reference_role == "style":
        clauses.append(_clause(
            "Adopt the reference image's style and palette while keeping the original content",
            "reference", "style role: look transfer, content lock"))

    # ---- LoRA triggers (load-bearing — the LoRA doesn't fire without them) ----
    triggers = [t for t in ctx.lora_triggers if t]
    if triggers:
        clauses.insert(0, _clause(", ".join(dict.fromkeys(triggers)), "lora",
                                  "LoRA trigger words prepended so the attached LoRA activates"))

    # ---- strength variant (used by the no-change suggestion) ----
    if strength == "strong":
        clauses.append(_clause(
            "Make the change strong, clearly visible, and unambiguous",
            "mitigation", "stronger variant requested (previous result barely changed)"))
        params_overrides.setdefault("guidance_scale_bump", 1.2)

    # ---- token budget: fit ideal first, drop by priority, never the load-bearing clauses ----
    ideal = int(grammar.get("ideal_length_tokens") or 0) or None
    hard = int((profile.get("constraints") or {}).get("max_prompt_tokens", 512))
    budget = min(ideal or hard, hard)

    def total(cl: List[dict]) -> int:
        return sum(_tokens(c["text"]) for c in cl)

    dropped: List[str] = []
    working = list(clauses)
    for kind in DROP_ORDER:
        if total(working) <= budget:
            break
        keep = [c for c in working if c["kind"] != kind]
        if len(keep) != len(working):
            dropped.append(kind)
            working = keep
    if dropped:
        rationale.append(f"over the model's ideal length — dropped clause(s): {', '.join(dropped)}")

    # ---- assemble ----
    if paradigm == "inpaint":
        # comma-joined description; strictly no imperatives
        prompt = ", ".join(c["text"].rstrip(".") for c in working)
    else:
        prompt = " ".join(_sentence(c["text"]) for c in working)

    negative = None
    np_conf = profile.get("negative_prompt") or {}
    if np_conf.get("supported"):
        negative = np_conf.get("default") or profile.get("negative_defaults")

    for c in working:
        rationale.append(f"{c['kind']}: “{c['text'][:60]}{'…' if len(c['text']) > 60 else ''}” — {c['reason']}")
    for a in spec.ambiguities:
        rationale.append(f"ambiguity: {a}")

    return {
        "prompt": prompt.strip(),
        "negative_prompt": negative,
        "params_overrides": params_overrides,
        "rationale": rationale,
        "clauses": working,
        "send_region_pad": send_region_pad,
        "paradigm": paradigm,
    }

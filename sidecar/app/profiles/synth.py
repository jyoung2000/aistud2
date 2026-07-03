"""Synthesis — one intent → a model-tuned prompt, grounded in the selection.

Since the prompt-intelligence build this is a thin façade over the real pipeline:

    parse_intent (app.prompting.intent)   — casual text → structured EditSpec
    build_context (app.prompting.context) — mask geometry + LAB scene stats + pipeline state
    compile_prompt (app.prompting.compiler) — per-model, per-paradigm clause assembly
    polish_prompt (app.prompting.polish)   — OPTIONAL LLM smoothing (off by default)

The synthesis LOGIC is fixed code; the profile supplies data only (grammar/claims/vocab
from the sourced research layers + the user's edits) and can never raise the token cap
or weaken safety. Everything below the polish pass is deterministic and offline.

The legacy signature is preserved for /shootout and older callers; they get the full
compiler through the same call. `rule_note` stays populated (joined rationale summary).
"""
from __future__ import annotations

from typing import List, Optional

from app.prompting.compiler import compile_prompt
from app.prompting.context import build_context
from app.prompting.intent import parse_intent


def _lora_triggers(loras: Optional[list]) -> List[str]:
    triggers: List[str] = []
    for lo in loras or []:
        for tw in lo.get("trigger_words", []) or ([lo["trigger"]] if lo.get("trigger") else []):
            if tw and tw not in triggers:
                triggers.append(tw)
    return triggers


def synthesize(
    profile: dict,
    intent: str,
    subject: Optional[str] = None,
    reference_role: Optional[str] = None,
    crop_desc: Optional[str] = None,
    loras: Optional[list] = None,
    *,
    rgb=None,
    mask=None,
    selection_label: Optional[str] = None,
    strength: str = "normal",
    polish: bool = False,
    operation_override: Optional[str] = None,
) -> dict:
    """intent (+ optional pixels/mask for context grounding) → tuned prompt package.

    Returns {prompt, negative_prompt, params_overrides, rationale[], clauses[],
    send_region_pad, edit_spec, paradigm, ambiguities[], rule_note, polished}.
    `rgb`/`mask` are optional numpy arrays — without them the compiler still runs on
    the parsed intent alone (mock path / no session), it just has less context.
    """
    spec = parse_intent(intent)
    if subject and not spec.target_noun:
        spec.target_noun = subject
    # the UI's one-click parse correction: the user says what the parser got wrong
    from app.prompting.intent import OPERATIONS

    if operation_override and operation_override in OPERATIONS:
        if operation_override != spec.operation:
            spec.rule = f"user-corrected: {spec.rule} → {operation_override}"
        spec.operation = operation_override

    ctx = build_context(
        rgb,
        mask,
        selection_label=selection_label or subject or crop_desc,
        reference_role=reference_role,
        lora_triggers=_lora_triggers(loras),
        paradigm=profile.get("paradigm"),
    )

    result = compile_prompt(spec, ctx, profile, strength=strength)

    # feedback-loop retrieval: past KEPT exemplars steer the rationale (guidance the user
    # can see — never verbatim prompt injection from the untrusted user layer)
    try:
        from app.profiles import store as _store

        near = _store.nearest_exemplars(profile, spec.operation, intent, k=2)
        for e in near:
            result["rationale"].append(
                f"similar kept edit: “{str(e.get('intent',''))[:60]}” → "
                f"“{str(e.get('prompt',''))[:80]}”"
            )
    except Exception:
        pass  # retrieval is a bonus, never a blocker

    polished = False
    if polish:
        try:
            from app.prompting.polish import polish_prompt

            better = polish_prompt(result["prompt"], profile, result["paradigm"])
            if better:
                result["rationale"].append("LLM polish applied (claude-haiku, temperature 0)")
                result["prompt"] = better
                polished = True
        except Exception:
            pass  # polish never breaks the deterministic result

    # legacy compatibility: shootout tiles + older UI read rule_note
    top = [r for r in result["rationale"] if r.startswith(("change:", "mitigation"))][:2]
    rule_note = "; ".join(
        [f"{result['paradigm']}: {spec.operation} ({spec.rule})"] + top
    )

    return {
        **result,
        "edit_spec": spec.to_dict(),
        "ambiguities": list(spec.ambiguities),
        "rule_note": rule_note,
        "polished": polished,
    }

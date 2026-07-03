"""Golden snapshot suite for the prompt-intelligence compiler (PI acceptance #2).

48 (intent, paradigm) → exact-prompt snapshots — every operation × every paradigm —
plus behavioral invariants. The key acceptance check lives in
test_remove_on_inpaint_is_background_description: 'remove object' on an inpaint model
provably compiles to a background DESCRIPTION, never a removal command.

If a compiler change intentionally alters phrasing, regenerate the GOLDEN dict (each
value is exactly `synthesize(profile_for(paradigm), INTENTS[op])["prompt"]`) and review
the diff — that review IS the point of a golden suite.
"""
import pytest

from app.profiles import store, synth
from app.prompting.compiler import compile_prompt
from app.prompting.context import SelectionContext, build_context
from app.prompting.intent import parse_intent

# one canonical intent per operation
INTENTS = {
    "replace": "replace the jacket with a red dress",
    "remove": "remove the trash can",
    "add": "add a small dog",
    "restyle": "make it watercolor style",
    "recolor": "make the car blue",
    "retexture": "make the table marble",
    "pose_change": "raise her arms above her head",
    "expression": "make him smile",
    "background_swap": "change the background to a sunny beach",
    "text_edit": "replace 'OPEN' with 'CLOSED'",
    "relight": "golden hour lighting",
    "upscale_detail": "make it sharper",
}

PARADIGMS = ("instruction", "inpaint", "reference/character", "controlnet")


def profile_for(paradigm: str) -> dict:
    if paradigm == "instruction":
        return store.load("flux-kontext")[0]
    if paradigm == "inpaint":
        return store.load("flux-fill")[0]
    if paradigm == "reference/character":
        return store.load("ideogram-character")[0]
    return store.load_for_dynamic("test/controlnet-model", "controlnet")


GOLDEN = {
    ('instruction', 'replace'): 'Replace jacket with a red dress. Keep everything outside the selection identical — lighting, composition, identity, and untouched pixels unchanged.',
    ('instruction', 'remove'): 'Remove trash can and fill the area with the surrounding background so nothing looks missing. Keep everything outside the selection identical — lighting, composition, identity, and untouched pixels unchanged.',
    ('instruction', 'add'): 'Add small dog to the selection. Keep everything outside the selection identical — lighting, composition, identity, and untouched pixels unchanged.',
    ('instruction', 'restyle'): 'Change to make it watercolor style while maintaining the original composition and object placement. Keep everything outside the selection identical — lighting, composition, identity, and untouched pixels unchanged.',
    ('instruction', 'recolor'): 'Change the color of car to blue, keeping the same shape, material, and lighting. Keep everything outside the selection identical — lighting, composition, identity, and untouched pixels unchanged.',
    ('instruction', 'retexture'): 'Make table out of marble, keeping the same shape, proportions, and lighting. Keep everything outside the selection identical — lighting, composition, identity, and untouched pixels unchanged.',
    ('instruction', 'pose_change'): 'Change the pose: raise her arms above her head, keeping identity, clothing, and face identical. Keep everything outside the selection identical — lighting, composition, identity, and untouched pixels unchanged.',
    ('instruction', 'expression'): 'Change the facial expression: make him smile, keeping identity, pose, and lighting identical. Keep everything outside the selection identical — lighting, composition, identity, and untouched pixels unchanged.',
    ('instruction', 'background_swap'): 'Change the background to a sunny beach while keeping the subject in the exact same position, scale, and pose. Keep everything outside the selection identical — lighting, composition, identity, and untouched pixels unchanged.',
    ('instruction', 'text_edit'): "Replace 'OPEN' with 'CLOSED', matching the original font, size, and color. Keep everything outside the selection identical — lighting, composition, identity, and untouched pixels unchanged.",
    ('instruction', 'relight'): 'Change the lighting: golden hour lighting, keeping subjects, colors, and composition identical. Keep everything outside the selection identical — lighting, composition, identity, and untouched pixels unchanged.',
    ('instruction', 'upscale_detail'): 'Enhance fine detail and sharpness without changing content, colors, or composition. Keep everything outside the selection identical — lighting, composition, identity, and untouched pixels unchanged.',
    ('inpaint', 'replace'): 'a red dress, photorealistic, seamless, detailed',
    ('inpaint', 'remove'): 'seamless continuation of the surrounding background, the surrounding scene, with no objects present, photorealistic, seamless, detailed',
    ('inpaint', 'add'): 'small dog, photorealistic, seamless, detailed',
    ('inpaint', 'restyle'): 'the selected area, make it watercolor style, photorealistic, seamless, detailed',
    ('inpaint', 'recolor'): 'car in blue, same shape and material, matching the surrounding lighting, photorealistic, seamless, detailed',
    ('inpaint', 'retexture'): 'table made of marble, same shape, matching the surrounding lighting, photorealistic, seamless, detailed',
    ('inpaint', 'pose_change'): 'raise her arms above her head, photorealistic, seamless, detailed',
    ('inpaint', 'expression'): 'make him smile, photorealistic, seamless, detailed',
    ('inpaint', 'background_swap'): 'a sunny beach, photorealistic, seamless, detailed',
    ('inpaint', 'text_edit'): "the text reads 'CLOSED', matching the original font, size, and color, photorealistic, seamless, detailed",
    ('inpaint', 'relight'): 'the selected area, golden hour lighting, photorealistic, seamless, detailed',
    ('inpaint', 'upscale_detail'): 'the selected area, sharp and highly detailed, photorealistic, seamless, detailed',
    ('reference/character', 'replace'): "The reference character, with the same facial features and hair. Replace jacket with a red dress. Preserve the reference subject's identity; match the scene's lighting and perspective.",
    ('reference/character', 'remove'): "The reference character, with the same facial features and hair. Remove trash can and fill the area with the surrounding background so nothing looks missing. Preserve the reference subject's identity; match the scene's lighting and perspective.",
    ('reference/character', 'add'): "The reference character, with the same facial features and hair. Add small dog to the selection. Preserve the reference subject's identity; match the scene's lighting and perspective.",
    ('reference/character', 'restyle'): "The reference character, with the same facial features and hair. Change to make it watercolor style while maintaining the original composition and object placement. Preserve the reference subject's identity; match the scene's lighting and perspective.",
    ('reference/character', 'recolor'): "The reference character, with the same facial features and hair. Change the color of car to blue, keeping the same shape, material, and lighting. Preserve the reference subject's identity; match the scene's lighting and perspective.",
    ('reference/character', 'retexture'): "The reference character, with the same facial features and hair. Make table out of marble, keeping the same shape, proportions, and lighting. Preserve the reference subject's identity; match the scene's lighting and perspective.",
    ('reference/character', 'pose_change'): "The reference character, with the same facial features and hair. Change the pose: raise her arms above her head, keeping identity, clothing, and face identical. Preserve the reference subject's identity; match the scene's lighting and perspective.",
    ('reference/character', 'expression'): "The reference character, with the same facial features and hair. Change the facial expression: make him smile, keeping identity, pose, and lighting identical. Preserve the reference subject's identity; match the scene's lighting and perspective.",
    ('reference/character', 'background_swap'): "The reference character, with the same facial features and hair. Change the background to a sunny beach while keeping the subject in the exact same position, scale, and pose. Preserve the reference subject's identity; match the scene's lighting and perspective.",
    ('reference/character', 'text_edit'): "The reference character, with the same facial features and hair. Replace 'OPEN' with 'CLOSED', matching the original font, size, and color. Preserve the reference subject's identity; match the scene's lighting and perspective.",
    ('reference/character', 'relight'): "The reference character, with the same facial features and hair. Change the lighting: golden hour lighting, keeping subjects, colors, and composition identical. Preserve the reference subject's identity; match the scene's lighting and perspective.",
    ('reference/character', 'upscale_detail'): "The reference character, with the same facial features and hair. Enhance fine detail and sharpness without changing content, colors, or composition. Preserve the reference subject's identity; match the scene's lighting and perspective.",
    ('controlnet', 'replace'): "Replace jacket with a red dress. Preserve the subject's identity and the scene; follow the control image for structure only.",
    ('controlnet', 'remove'): "Remove trash can and fill the area with the surrounding background so nothing looks missing. Preserve the subject's identity and the scene; follow the control image for structure only.",
    ('controlnet', 'add'): "Add small dog to the selection. Preserve the subject's identity and the scene; follow the control image for structure only.",
    ('controlnet', 'restyle'): "Change to make it watercolor style while maintaining the original composition and object placement. Preserve the subject's identity and the scene; follow the control image for structure only.",
    ('controlnet', 'recolor'): "Change the color of car to blue, keeping the same shape, material, and lighting. Preserve the subject's identity and the scene; follow the control image for structure only.",
    ('controlnet', 'retexture'): "Make table out of marble, keeping the same shape, proportions, and lighting. Preserve the subject's identity and the scene; follow the control image for structure only.",
    ('controlnet', 'pose_change'): "Change the pose: raise her arms above her head, keeping identity, clothing, and face identical. Preserve the subject's identity and the scene; follow the control image for structure only.",
    ('controlnet', 'expression'): "Change the facial expression: make him smile, keeping identity, pose, and lighting identical. Preserve the subject's identity and the scene; follow the control image for structure only.",
    ('controlnet', 'background_swap'): "Change the background to a sunny beach while keeping the subject in the exact same position, scale, and pose. Preserve the subject's identity and the scene; follow the control image for structure only.",
    ('controlnet', 'text_edit'): "Replace 'OPEN' with 'CLOSED', matching the original font, size, and color. Preserve the subject's identity and the scene; follow the control image for structure only.",
    ('controlnet', 'relight'): "Change the lighting: golden hour lighting, keeping subjects, colors, and composition identical. Preserve the subject's identity and the scene; follow the control image for structure only.",
    ('controlnet', 'upscale_detail'): "Enhance fine detail and sharpness without changing content, colors, or composition. Preserve the subject's identity and the scene; follow the control image for structure only.",
}


@pytest.mark.parametrize("paradigm,operation", list(GOLDEN.keys()))
def test_golden_snapshot(paradigm, operation):
    res = synth.synthesize(profile_for(paradigm), INTENTS[operation])
    assert res["edit_spec"]["operation"] == operation, (
        f"intent {INTENTS[operation]!r} parsed as {res['edit_spec']['operation']}"
    )
    assert res["prompt"] == GOLDEN[(paradigm, operation)]
    assert res["paradigm"] == paradigm


# --- the acceptance-critical invariant --------------------------------------------------

def test_remove_on_inpaint_is_background_description():
    """'remove object' on an inpaint model compiles to a background description —
    NEVER a removal command (FLUX Fill card; diffusers#9486)."""
    res = synth.synthesize(profile_for("inpaint"), "remove the trash can")
    p = res["prompt"].lower()
    for verb in ("remove", "delete", "erase", "get rid"):
        assert verb not in p, f"removal command {verb!r} leaked into an inpaint prompt: {p}"
    assert "background" in p
    # the target object must not be described INTO the fill either
    assert "trash" not in p


def test_inpaint_prompts_have_no_imperatives():
    """Inpaint prompts are comma-joined content descriptions, not sentences of commands."""
    prof = profile_for("inpaint")
    for op in ("replace", "remove", "recolor", "background_swap", "text_edit"):
        p = synth.synthesize(prof, INTENTS[op])["prompt"]
        assert not p.rstrip().endswith("."), p
        first = p.split()[0].lower()
        assert first not in ("replace", "remove", "change", "make", "add", "delete"), p


def test_instruction_prompts_keep_preservation_clause():
    prof = profile_for("instruction")
    for op in INTENTS:
        p = synth.synthesize(prof, INTENTS[op])["prompt"]
        assert "Keep everything outside the selection identical" in p


# --- context-driven behavior -------------------------------------------------------------

def test_small_object_mitigation_widens_send_region():
    prof = profile_for("instruction")
    spec = parse_intent("make the car blue")
    ctx = SelectionContext(area_frac=0.01, small_object=True)
    res = compile_prompt(spec, ctx, prof)
    assert res["send_region_pad"] == 0.3
    assert any("small" in c["text"].lower() for c in res["clauses"])


def test_likely_person_gets_identity_lock():
    prof = profile_for("instruction")
    spec = parse_intent("make the jacket blue")
    ctx = SelectionContext(likely_person=True)
    res = compile_prompt(spec, ctx, prof)
    assert any("identity" in c["text"].lower() and c["kind"] == "mitigation" for c in res["clauses"])


def test_lora_triggers_prepended_and_never_dropped():
    prof = profile_for("instruction")
    res = synth.synthesize(prof, "make the car blue",
                           loras=[{"trigger_words": ["nclp-style"]}])
    assert res["prompt"].startswith("Nclp-style") or res["prompt"].startswith("nclp-style")


def test_strong_variant_adds_emphasis_and_param_bump():
    prof = profile_for("instruction")
    res = synth.synthesize(prof, "make the car blue", strength="strong")
    assert res["params_overrides"].get("guidance_scale_bump") == 1.2
    assert "strong" in res["prompt"].lower()


def test_negative_prompt_only_when_supported():
    # no verified adapter exposes a negative_prompt field → always None today
    for paradigm in PARADIGMS:
        res = synth.synthesize(profile_for(paradigm), "make the car blue")
        assert res["negative_prompt"] is None


def test_token_budget_never_drops_change_or_preservation():
    prof = dict(profile_for("instruction"))
    prof = {**prof, "prompt_grammar": {**(prof.get("prompt_grammar") or {}), "ideal_length_tokens": 20}}
    spec = parse_intent("replace the jacket with a red dress")
    ctx = build_context(None, None)
    res = compile_prompt(spec, ctx, prof)
    kinds = {c["kind"] for c in res["clauses"]}
    assert "change" in kinds and "preservation" in kinds


def test_vague_intent_lands_in_ambiguities():
    res = synth.synthesize(profile_for("instruction"), "make it better")
    assert res["ambiguities"], "vague ask should surface an ambiguity"
    assert res["edit_spec"]["specificity"] == "low"


def test_preserve_clause_carries_user_keeps():
    res = synth.synthesize(profile_for("instruction"),
                           "change the jacket to a red dress, keep the face the same")
    assert "face" in res["prompt"].lower()


def test_reference_role_clauses():
    prof = profile_for("instruction")
    for role, needle in (("replace", "second image"), ("pose", "control image"),
                         ("style", "style and palette")):
        res = synth.synthesize(prof, "replace the jacket with a red dress", reference_role=role)
        assert needle in res["prompt"].lower() or needle in res["prompt"], (role, res["prompt"])


def test_rationale_cites_every_clause():
    res = synth.synthesize(profile_for("inpaint"), "remove the trash can")
    assert len(res["rationale"]) >= len(res["clauses"])
    assert any("diffusers#9486" in r or "FLUX Fill" in r for r in res["rationale"])

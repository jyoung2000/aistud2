"""Research builder — produces a base `.nprofile` per model.

The real builder is the ONLY web-touching step (run once per model / on refresh): it would
introspect the model card's API tab for paradigm/capabilities/constraints, distill the
official prompt guide into style_rules/templates/preservation_clause, and harvest exemplars.
Here (offline) it synthesizes a sane base from the machine-introspected registry spec so the
synthesis pipeline works without network; `notes` records that it's an offline base.
"""
from __future__ import annotations

from typing import Dict

PRESERVATION = {
    "instruction": "Keep everything outside the selection identical — lighting, composition, identity, and untouched pixels unchanged.",
    "inpaint": "Blend seamlessly with the surrounding lighting, shadows, and texture; do not alter anything beyond the masked region.",
    "controlnet": "Preserve the subject's identity and the scene; follow the control image for structure only.",
    "reference/character": "Preserve the reference subject's identity; match the scene's lighting and perspective.",
}

TEMPLATES = {
    "instruction": {
        "instruction": "Edit the selection: {intent}. {preservation}",
        "text_edit": "Replace '{old}' with '{new}' in the selected text, matching the original font, size, and color. {preservation}",
        "reference": "Edit the selection: {intent}, using the reference subject. {preservation}",
    },
    "inpaint": {
        "inpaint": "Photorealistic result in the masked region: {intent}; matched to the surrounding lighting, shadows, and texture, with seamless edges.",
        "text_edit": "The masked text now reads '{new}', matching the original font, size, and color.",
    },
    "controlnet": {
        "controlnet": "Preserve {subject}'s identity and the scene. Apply: {intent}. Follow the attached control image for structure.",
    },
    "reference/character": {
        "reference": "Insert the reference character into the selection, {intent}, matching the scene's lighting and perspective; preserve the reference identity.",
    },
}

STYLE_RULES = {
    "instruction": ["Be imperative and specific.", "Name what to change and what to keep.", "Avoid pronouns; name the subject."],
    "inpaint": ["Describe the desired RESULT, not an instruction.", "Mention lighting/material so the fill matches."],
    "controlnet": ["State identity preservation first.", "Reference the control image explicitly."],
    "reference/character": ["State identity preservation.", "Describe how the reference is placed."],
}


def build_base(spec) -> Dict:
    paradigm = spec.paradigm
    return {
        "model": spec.id,
        "paradigm": paradigm,
        "version": "offline-1",
        "layer": "base",
        "capabilities": {
            "reference_roles": list(spec.reference_roles),
            "needs_mask": spec.needs_mask,
            "instruction_based": spec.instruction_based,
            "supports_negative": paradigm in ("inpaint", "instruction"),
        },
        "constraints": {
            "max_prompt_tokens": 512,
            "params": {
                "seed": {"min": 0, "max": 2_147_483_647},
                "guidance_scale": {"min": 1.0, "max": 12.0},
                "num_inference_steps": {"min": 1, "max": 60},
            },
        },
        "style_rules": STYLE_RULES.get(paradigm, STYLE_RULES["instruction"]),
        "templates": TEMPLATES.get(paradigm, TEMPLATES["instruction"]),
        "preservation_clause": PRESERVATION.get(paradigm, PRESERVATION["instruction"]),
        "negative_defaults": "lowres, artifacts, distorted, extra limbs, watermark, text",
        "exemplars": [],
        "notes": "Offline base generated from the registry spec. Re-run the research builder online to enrich style_rules/templates/exemplars from the model card.",
    }

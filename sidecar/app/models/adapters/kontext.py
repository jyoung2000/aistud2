"""FLUX Kontext adapter (instruction-based, no mask, no reference slot). TODO confirm slug."""
from __future__ import annotations

from app.imaging import png_to_base64

NEEDS_MASK = False
INSTRUCTION_BASED = True


def build_payload(crop_rgb, crop_mask, prompt, params, reference_rgb=None, reference_role=None) -> dict:
    payload = {
        "prompt": prompt,
        "image": "data:image/png;base64," + png_to_base64(crop_rgb, "RGB"),
    }
    for k in ("guidance_scale", "seed", "num_inference_steps"):
        if params.get(k) is not None:
            payload[k] = params[k]
    return payload

"""FLUX Kontext adapter (instruction-based, no mask, no reference slot).

Slug + field names verified from the WaveSpeed docs for `wavespeed-ai/flux-kontext-dev`
(2026-07): prompt, image (singular), num_inference_steps, guidance_scale, num_images,
seed, output_format, enable_base64_output, enable_safety_checker.
"""
from __future__ import annotations

from app.imaging import png_to_base64

SLUG = "flux-kontext-dev"

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

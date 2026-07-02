"""FLUX Fill adapter (masked inpaint): crop + mask + prompt -> WaveSpeed payload.

Slug + field names verified from the WaveSpeed docs for `wavespeed-ai/flux-fill-dev`
(2026-07): image, mask_image, prompt, size, num_inference_steps, seed, guidance_scale,
num_images, loras (max 3), enable_safety_checker. Images are passed as base64 data URLs
(models that require hosted URLs need an uploader — a future seam).
"""
from __future__ import annotations

import numpy as np

from app.imaging import png_to_base64

SLUG = "flux-fill-dev"

NEEDS_MASK = True
NEEDS_REFERENCE = False
INSTRUCTION_BASED = False


def _data_url(arr: np.ndarray, mode: str) -> str:
    return "data:image/png;base64," + png_to_base64(arr, mode)


def build_payload(crop_rgb, crop_mask, prompt, params, reference_rgb=None, reference_role=None) -> dict:
    payload = {
        "prompt": prompt,
        "image": _data_url(crop_rgb, "RGB"),
        "mask_image": _data_url(crop_mask, "L"),
    }
    for k in ("num_inference_steps", "guidance_scale", "seed"):
        if k in params and params[k] is not None:
            payload[k] = params[k]
    return payload

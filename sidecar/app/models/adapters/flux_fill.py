"""FLUX Fill adapter (masked inpaint): crop + mask + prompt -> WaveSpeed payload.

The exact slug + field names must be confirmed from the model card's API tab (contract #6);
the slug here is a placeholder until verified. Images are passed as base64 data URLs (models
that require hosted URLs need an uploader — a future seam).
"""
from __future__ import annotations

import numpy as np

from app.imaging import png_to_base64

# TODO: confirm from the FLUX Fill model card API tab.
SLUG = "flux-fill/dev"

NEEDS_MASK = True
NEEDS_REFERENCE = False
INSTRUCTION_BASED = False


def _data_url(arr: np.ndarray, mode: str) -> str:
    return "data:image/png;base64," + png_to_base64(arr, mode)


def build_payload(crop_rgb: np.ndarray, crop_mask: np.ndarray, prompt: str, params: dict) -> dict:
    payload = {
        "prompt": prompt,
        "image": _data_url(crop_rgb, "RGB"),
        "mask_image": _data_url(crop_mask, "L"),
    }
    # carry through only known, range-checked params
    for k in ("num_inference_steps", "guidance_scale", "seed", "strength"):
        if k in params and params[k] is not None:
            payload[k] = params[k]
    return payload

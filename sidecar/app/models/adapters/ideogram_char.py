"""Ideogram Character adapter (reference/character: drop a reference subject into the
selection). Requires a reference image. TODO confirm slug + field names from the card."""
from __future__ import annotations

from app.imaging import png_to_base64

NEEDS_MASK = False
NEEDS_REFERENCE = True


def _u(arr, mode):
    return "data:image/png;base64," + png_to_base64(arr, mode)


def build_payload(crop_rgb, crop_mask, prompt, params, reference_rgb=None, reference_role=None) -> dict:
    payload = {"prompt": prompt, "image": _u(crop_rgb, "RGB")}
    if reference_rgb is not None:
        payload["character_reference_image"] = _u(reference_rgb, "RGB")
    for k in ("seed",):
        if params.get(k) is not None:
            payload[k] = params[k]
    return payload

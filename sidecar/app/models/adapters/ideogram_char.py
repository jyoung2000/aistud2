"""Ideogram Character adapter (reference/character: drop a reference subject into the
selection).

Slug verified from the WaveSpeed card (2026-07): `ideogram-ai/ideogram-character`
(full provider path — note the `ideogram-ai` provider prefix). Verified fields: prompt,
image (the CHARACTER REFERENCE image), style, rendering_speed, aspect_ratio.
The card advertises mask-based inpainting but its mask/scene field names could not be
verified, so the registry keeps confirmed_slug=False until they are — do not guess them.
"""
from __future__ import annotations

from app.imaging import png_to_base64

SLUG = "ideogram-ai/ideogram-character"

NEEDS_MASK = False
NEEDS_REFERENCE = True


def _u(arr, mode):
    return "data:image/png;base64," + png_to_base64(arr, mode)


def build_payload(crop_rgb, crop_mask, prompt, params, reference_rgb=None, reference_role=None) -> dict:
    # `image` is the character reference per the card; the scene crop is described by the
    # prompt until the inpaint field names are confirmed.
    payload = {"prompt": prompt}
    payload["image"] = _u(reference_rgb if reference_rgb is not None else crop_rgb, "RGB")
    for k in ("seed", "style", "rendering_speed", "aspect_ratio"):
        if params.get(k) is not None:
            payload[k] = params[k]
    return payload

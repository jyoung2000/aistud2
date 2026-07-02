"""Qwen-Image-Edit / Edit-Plus adapter (instruction-based; multi-image reference).

Slugs + field names verified from the WaveSpeed model cards (2026-07):
`wavespeed-ai/qwen-image/edit-2511` and `wavespeed-ai/qwen-image/edit-plus` both take
prompt, images (an ARRAY — the crop first, any reference image second), seed,
output_format, enable_base64_output, enable_sync_mode. Instruction models edit the whole
crop from the prompt; a reference image (replace/pose) rides along as images[1].
"""
from __future__ import annotations

from app.imaging import png_to_base64

NEEDS_MASK = False
INSTRUCTION_BASED = True


def _u(arr, mode):
    return "data:image/png;base64," + png_to_base64(arr, mode)


def build_payload(crop_rgb, crop_mask, prompt, params, reference_rgb=None, reference_role=None) -> dict:
    images = [_u(crop_rgb, "RGB")]
    if reference_rgb is not None:
        # multi-image: the reference (replace subject / pose control image) as images[1];
        # the role shapes the synthesized prompt, not the payload (no such API field).
        images.append(_u(reference_rgb, "RGB"))
    payload = {"prompt": prompt, "images": images}
    if params.get("seed") is not None:
        payload["seed"] = params["seed"]
    return payload

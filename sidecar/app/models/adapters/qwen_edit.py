"""Qwen-Image-Edit / Edit-Plus adapter (instruction-based; multi-image reference).

Confirmed slug: wavespeed-ai/qwen-image/edit-2511 (registry). Instruction models edit the
whole crop from the prompt; a reference image (replace/pose) is attached as a second image.
"""
from __future__ import annotations

from app.imaging import png_to_base64

NEEDS_MASK = False
INSTRUCTION_BASED = True


def _u(arr, mode):
    return "data:image/png;base64," + png_to_base64(arr, mode)


def build_payload(crop_rgb, crop_mask, prompt, params, reference_rgb=None, reference_role=None) -> dict:
    payload = {"prompt": prompt, "image": _u(crop_rgb, "RGB")}
    if reference_rgb is not None:
        # multi-image: the reference subject as image_2 (replace) / control (pose)
        payload["image_2"] = _u(reference_rgb, "RGB")
        if reference_role:
            payload["reference_role"] = reference_role
    for k in ("num_inference_steps", "guidance_scale", "seed"):
        if params.get(k) is not None:
            payload[k] = params[k]
    return payload

"""Generic image-to-image adapter for models discovered dynamically from the WaveSpeed
catalog (contract #6: we don't guess — the field names come from the model's own
`api_schema`, fetched live from `/api/v3/models`).

Dynamic models don't have a hand-written adapter, so `build_payload` inspects the schema
that was pulled from the card and fills the image / mask / prompt slots using the property
names the model actually declares. If the schema is missing we fall back to the common
WaveSpeed convention (`image` + `prompt`, optional `mask_image`).
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from app.imaging import png_to_base64

# Property-name synonyms seen across WaveSpeed cards, most-specific first.
_IMAGE_KEYS = ("image", "input_image", "init_image", "image_url", "images")
_MASK_KEYS = ("mask_image", "mask", "mask_url")
_PROMPT_KEYS = ("prompt", "text", "instruction")
_REF_KEYS = ("image_2", "reference_image", "ref_image", "control_image", "images")
_PASS_PARAMS = ("num_inference_steps", "guidance_scale", "seed", "strength", "negative_prompt", "control_strength")


def _data_url(arr: np.ndarray, mode: str) -> str:
    return "data:image/png;base64," + png_to_base64(arr, mode)


def _schema_props(api_schema: Optional[dict]) -> dict:
    if not isinstance(api_schema, dict):
        return {}
    # WaveSpeed schemas nest the input fields under a few possible keys.
    for key in ("properties", "input", "inputs", "parameters"):
        node = api_schema.get(key)
        if isinstance(node, dict) and node:
            # `input` may itself wrap `properties`.
            if "properties" in node and isinstance(node["properties"], dict):
                return node["properties"]
            return node
    return {}


def _pick(props: dict, candidates) -> Optional[str]:
    if props:
        for c in candidates:
            if c in props:
                return c
        # loose match (e.g. "source_image") — first prop that contains a candidate token.
        for name in props:
            low = name.lower()
            if any(c in low for c in candidates):
                return name
        return None
    # No schema — fall back to the first (canonical) candidate name.
    return candidates[0]


def build_payload(
    crop_rgb,
    crop_mask,
    prompt,
    params,
    reference_rgb=None,
    reference_role=None,
    api_schema: Optional[dict] = None,
) -> dict:
    props = _schema_props(api_schema)
    payload: dict = {}

    prompt_key = _pick(props, _PROMPT_KEYS) or "prompt"
    payload[prompt_key] = prompt

    image_key = _pick(props, _IMAGE_KEYS) or "image"
    payload[image_key] = _data_url(crop_rgb, "RGB")

    mask_key = _pick(props, _MASK_KEYS)
    if mask_key and crop_mask is not None:
        payload[mask_key] = _data_url(crop_mask, "L")

    if reference_rgb is not None:
        ref_key = _pick(props, _REF_KEYS) or "image_2"
        if ref_key == image_key:  # single-image model: nowhere to put a reference
            ref_key = "image_2"
        payload[ref_key] = _data_url(reference_rgb, "RGB")
        if reference_role:
            payload["reference_role"] = reference_role

    for k in _PASS_PARAMS:
        if params.get(k) is not None and (not props or k in props):
            payload[k] = params[k]
    return payload

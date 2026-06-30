"""Model registry — each model declares its capabilities + endpoint slug + which adapter
builds its request (contract #6). The inspector reads these flags to show the right
controls (mask vs reference slot vs plain instruction). Slugs marked TODO must be confirmed
from each model card's API tab; `qwen-image/edit-2511` is confirmed.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

import numpy as np

from app.models.adapters import flux_fill, ideogram_char, kontext, qwen_edit


@dataclass
class ModelSpec:
    id: str
    label: str
    slug: str
    paradigm: str  # instruction | inpaint | controlnet | reference/character
    est_cost_cents: float
    needs_mask: bool
    instruction_based: bool
    reference_roles: List[str]
    reference_inputs: Dict[str, str]
    build: Callable
    confirmed_slug: bool = False


REGISTRY: List[ModelSpec] = [
    ModelSpec(
        "flux-fill", "FLUX Fill", flux_fill.SLUG, "inpaint", 1.2,
        needs_mask=True, instruction_based=False,
        reference_roles=[], reference_inputs={}, build=flux_fill.build_payload,
    ),
    ModelSpec(
        "qwen-image-edit-2511", "Qwen-Image-Edit", "qwen-image/edit-2511", "instruction", 0.8,
        needs_mask=False, instruction_based=True,
        reference_roles=["replace"], reference_inputs={"replace": "multi_image"},
        build=qwen_edit.build_payload, confirmed_slug=True,
    ),
    ModelSpec(
        "qwen-image-edit-plus", "Qwen-Image-Edit-Plus", "qwen-image/edit-plus", "instruction", 0.9,
        needs_mask=False, instruction_based=True,
        reference_roles=["replace", "pose"],
        reference_inputs={"replace": "multi_image", "pose": "multi_image"},
        build=qwen_edit.build_payload,
    ),
    ModelSpec(
        "flux-kontext", "FLUX Kontext", "flux-kontext/dev", "instruction", 1.0,
        needs_mask=False, instruction_based=True,
        reference_roles=[], reference_inputs={}, build=kontext.build_payload,
    ),
    ModelSpec(
        "ideogram-character", "Ideogram Character", "ideogram/character", "reference/character", 1.1,
        needs_mask=False, instruction_based=False,
        reference_roles=["replace"], reference_inputs={"replace": "multi_image"},
        build=ideogram_char.build_payload,
    ),
]

_BY_ID = {m.id: m for m in REGISTRY}
_BY_SLUG = {m.slug: m for m in REGISTRY}


def get(model_id: Optional[str]):
    if model_id and model_id in _BY_ID:
        return _BY_ID[model_id]
    if model_id and model_id in _BY_SLUG:
        return _BY_SLUG[model_id]
    return None


def public_list() -> list:
    """Frontend-facing shape (mirrors ModelRefCaps + flags)."""
    return [
        {
            "id": m.id,
            "label": m.label,
            "slug": m.slug,
            "paradigm": m.paradigm,
            "estCostCents": m.est_cost_cents,
            "needs_mask": m.needs_mask,
            "instruction_based": m.instruction_based,
            "reference_roles": m.reference_roles,
            "reference_inputs": m.reference_inputs,
            "confirmed_slug": m.confirmed_slug,
        }
        for m in REGISTRY
    ]


def build_payload(
    model_id: str,
    crop_rgb: np.ndarray,
    crop_mask: np.ndarray,
    prompt: str,
    params: dict,
    reference_rgb: Optional[np.ndarray] = None,
    reference_role: Optional[str] = None,
) -> tuple:
    """Return (slug, payload) for a model. Raises if unknown."""
    spec = get(model_id)
    if spec is None:
        raise KeyError(f"unknown model: {model_id}")
    payload = spec.build(
        crop_rgb=crop_rgb,
        crop_mask=crop_mask,
        prompt=prompt,
        params=params,
        reference_rgb=reference_rgb,
        reference_role=reference_role,
    )
    return spec.slug, payload

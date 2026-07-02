"""Model registry — each model declares its capabilities + endpoint slug + which adapter
builds its request (contract #6). The inspector reads these flags to show the right
controls (mask vs reference slot vs plain instruction).

Slug verification (2026-07, from the WaveSpeed docs/model cards):
confirmed — qwen-image/edit-2511, qwen-image/edit-plus, flux-fill-dev, flux-kontext-dev.
ideogram-ai/ideogram-character: slug verified but its inpaint field names are not, so it
stays confirmed_slug=False (the UI marks it "unverified").
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

import numpy as np

from app.models import catalog
from app.models.adapters import flux_fill, generic, ideogram_char, kontext, qwen_edit


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
    supports_lora: bool = False
    max_loras: int = 0


REGISTRY: List[ModelSpec] = [
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
        build=qwen_edit.build_payload, confirmed_slug=True, supports_lora=True, max_loras=3,
    ),
    ModelSpec(
        "flux-fill", "FLUX Fill", flux_fill.SLUG, "inpaint", 1.2,
        needs_mask=True, instruction_based=False,
        reference_roles=[], reference_inputs={}, build=flux_fill.build_payload,
        confirmed_slug=True,
    ),
    ModelSpec(
        "flux-kontext", "FLUX Kontext", kontext.SLUG, "instruction", 1.0,
        needs_mask=False, instruction_based=True,
        reference_roles=[], reference_inputs={}, build=kontext.build_payload,
        confirmed_slug=True,
    ),
    ModelSpec(
        # slug verified; inpaint/mask field names still unverified → confirmed_slug=False
        "ideogram-character", "Ideogram Character", ideogram_char.SLUG, "reference/character", 1.1,
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


def _static_public() -> list:
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
            "supports_lora": m.supports_lora,
            "max_loras": m.max_loras,
            "dynamic": False,
        }
        for m in REGISTRY
    ]


def public_list(api_key: Optional[str] = None, force: bool = False) -> dict:
    """Frontend-facing catalog: the curated static models (confirmed slugs + hand-tuned
    adapters) first, then the latest image-to-image + i2i-LoRA models pulled live from the
    WaveSpeed catalog. Deduped by slug; static entries win. Returns
    { models, dynamic_error, dynamic_count } so the UI can surface a "couldn't refresh" note.
    """
    static = _static_public()
    # confirmed-slug models first — the picker defaults to the first entry, and an
    # unconfirmed default would 404 the user's first real-key generation.
    static.sort(key=lambda m: not m["confirmed_slug"])
    seen = {m["slug"] for m in static}
    seen.update(m["id"] for m in static)
    dynamic_error = None
    dynamic: list = []
    if api_key is not None:
        cat = catalog.fetch_catalog(api_key, force=force)
        dynamic_error = cat.get("error")
        for m in cat.get("models", []):
            if m["slug"] in seen or m["id"] in seen:
                continue
            seen.add(m["slug"])
            # Drop the heavy raw schema from the public payload (kept server-side for builds).
            pub = {k: v for k, v in m.items() if k != "api_schema"}
            dynamic.append(pub)
    return {"models": static + dynamic, "dynamic_error": dynamic_error, "dynamic_count": len(dynamic)}


def build_payload(
    model_id: str,
    crop_rgb: np.ndarray,
    crop_mask: np.ndarray,
    prompt: str,
    params: dict,
    reference_rgb: Optional[np.ndarray] = None,
    reference_role: Optional[str] = None,
    loras: Optional[list] = None,
) -> tuple:
    """Return (slug, payload) for a model. Static models use their hand-written adapter;
    models discovered live from the WaveSpeed catalog use the generic schema-driven adapter.
    Raises if the model is unknown to both."""
    spec = get(model_id)
    if spec is not None:
        payload = spec.build(
            crop_rgb=crop_rgb,
            crop_mask=crop_mask,
            prompt=prompt,
            params=params,
            reference_rgb=reference_rgb,
            reference_role=reference_role,
        )
        slug, supports_lora, max_loras = spec.slug, spec.supports_lora, spec.max_loras
    else:
        dyn = catalog.find(model_id)
        if dyn is None:
            raise KeyError(f"unknown model: {model_id}")
        payload = generic.build_payload(
            crop_rgb=crop_rgb,
            crop_mask=crop_mask,
            prompt=prompt,
            params=params,
            reference_rgb=reference_rgb,
            reference_role=reference_role,
            api_schema=dyn.get("api_schema"),
        )
        slug, supports_lora, max_loras = dyn["slug"], dyn.get("supports_lora", False), dyn.get("max_loras", 0)
    # LoRA stack — only attach for models that support it (machine-introspected cap wins).
    if loras and supports_lora:
        capped = loras[: max_loras]
        payload["loras"] = [
            {"path": l.get("ref"), "scale": float(l.get("weight", 1.0))} for l in capped if l.get("ref")
        ]
    return slug, payload

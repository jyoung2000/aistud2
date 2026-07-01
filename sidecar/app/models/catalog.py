"""Live WaveSpeed model catalog (contract #6 — pull real slugs + schemas, never guess).

`GET https://api.wavespeed.ai/api/v3/models` (Bearer auth) returns the full catalog:
  { "code": 200, "message": "...", "data": [ { model_id, name, base_price, description,
                                               type, api_schema }, ... ] }

We keep only the **image-to-image** and **image-to-image-LoRA** models (an input image is
required and the output is an image), map them to the frontend registry shape, and detect
LoRA support from the model's own `api_schema`. Results are cached with a short TTL so the
inspector can list "the latest models" without a network hit on every `/models` call.

Dynamic models carry `dynamic: True` and their raw `api_schema`, so the generic adapter can
build a correct request from the field names the card actually declares.
"""
from __future__ import annotations

import time
from typing import List, Optional

import httpx

BASE = "https://api.wavespeed.ai/api/v3"
TIMEOUT = httpx.Timeout(30.0)
_CACHE_TTL = 900  # 15 min — "latest models" without hammering the API

_cache: dict = {"key_fp": None, "at": 0.0, "models": [], "error": None}


# ---- classification helpers ------------------------------------------------

def _schema_prop_names(api_schema) -> List[str]:
    """Flatten the property names a card declares, wherever they're nested."""
    names: List[str] = []
    if not isinstance(api_schema, dict):
        return names
    for key in ("properties", "input", "inputs", "parameters"):
        node = api_schema.get(key)
        if isinstance(node, dict):
            props = node.get("properties") if isinstance(node.get("properties"), dict) else node
            if isinstance(props, dict):
                names.extend(str(k).lower() for k in props.keys())
    return names


def _is_image_to_image(mtype: str, props: List[str]) -> bool:
    t = (mtype or "").lower().replace("_", "-").replace(" ", "-")
    if "image-to-image" in t or t in ("i2i", "img2img", "image-edit", "inpaint", "edit"):
        return True
    # Fall back to schema shape: takes an image input AND the type mentions image output.
    takes_image = any(("image" in p or p in ("mask", "control")) for p in props)
    outputs_image = t.endswith("-image") or t.startswith("image-") or "image" in t
    # Exclude obvious non-i2i even if they take an image (video/audio/3d/upscale-only stay out
    # of the *edit* list unless they clearly do image->image).
    if any(bad in t for bad in ("video", "audio", "3d", "text-to-", "-to-video", "-to-audio")):
        return False
    return bool(takes_image and outputs_image)


def _lora_support(props: List[str], api_schema) -> tuple[bool, int]:
    has_lora = any("lora" in p for p in props)
    if not has_lora:
        return False, 0
    # Best-effort max: look for a maxItems on a lora array field.
    max_loras = 3
    if isinstance(api_schema, dict):
        for key in ("properties", "input", "inputs", "parameters"):
            node = api_schema.get(key)
            props_map = None
            if isinstance(node, dict):
                props_map = node.get("properties") if isinstance(node.get("properties"), dict) else node
            if isinstance(props_map, dict):
                for name, spec in props_map.items():
                    if "lora" in str(name).lower() and isinstance(spec, dict):
                        mi = spec.get("maxItems")
                        if isinstance(mi, int) and mi > 0:
                            max_loras = mi
    return True, max_loras


def _paradigm(mtype: str, props: List[str], needs_mask: bool) -> str:
    if needs_mask:
        return "inpaint"
    if any("control" in p for p in props):
        return "controlnet"
    return "instruction"


def _to_public(m: dict) -> Optional[dict]:
    model_id = str(m.get("model_id") or m.get("id") or "").strip()
    if not model_id:
        return None
    api_schema = m.get("api_schema") or m.get("schema")
    props = _schema_prop_names(api_schema)
    mtype = str(m.get("type") or "")
    if not _is_image_to_image(mtype, props):
        return None
    needs_mask = any(p in ("mask", "mask_image", "mask_url") or "mask" in p for p in props)
    supports_lora, max_loras = _lora_support(props, api_schema)
    # WaveSpeed submit path is /api/v3/{model_id}; our slug drops the leading "wavespeed-ai/"
    # so the existing wavespeed.submit (which prepends it) keeps working for that provider,
    # while other providers keep their full path (submit handles both).
    slug = model_id[len("wavespeed-ai/"):] if model_id.startswith("wavespeed-ai/") else model_id
    base_price = m.get("base_price")
    try:
        est_cents = round(float(base_price) * 100, 2) if base_price is not None else 1.0
    except (TypeError, ValueError):
        est_cents = 1.0
    roles = ["replace"] if any("image_2" in p or "reference" in p for p in props) else []
    return {
        "id": model_id,
        "label": str(m.get("name") or model_id.split("/")[-1]),
        "slug": slug,
        "model_path": model_id,  # full path for submit
        "paradigm": _paradigm(mtype, props, needs_mask),
        "estCostCents": est_cents,
        "needs_mask": needs_mask,
        "instruction_based": not needs_mask,
        "reference_roles": roles,
        "reference_inputs": {r: "multi_image" for r in roles},
        "confirmed_slug": False,
        "supports_lora": supports_lora,
        "max_loras": max_loras,
        "dynamic": True,
        "type": mtype,
        "description": str(m.get("description") or "")[:400],
        "api_schema": api_schema,
    }


# ---- fetch + cache ---------------------------------------------------------

def _fingerprint(api_key: str) -> str:
    return api_key[-6:] if api_key else "none"


def fetch_catalog(api_key: str, force: bool = False) -> dict:
    """Return { models: [...public...], error: str|None, cached: bool, fetched_at: float }.

    Filtered to image-to-image + i2i-LoRA models. Never raises — a network/auth failure
    returns the last good cache (or an empty list) with an `error` string so the UI can fall
    back to the static registry gracefully.
    """
    key_fp = _fingerprint(api_key)
    now = time.time()
    fresh = (
        not force
        and _cache["key_fp"] == key_fp
        and _cache["models"]
        and (now - _cache["at"]) < _CACHE_TTL
    )
    if fresh:
        return {"models": _cache["models"], "error": _cache["error"], "cached": True, "fetched_at": _cache["at"]}

    if not api_key:
        _cache.update(key_fp=key_fp, at=now, models=[], error="no WaveSpeed API key set")
        return {"models": [], "error": _cache["error"], "cached": False, "fetched_at": now}

    try:
        headers = {"Authorization": f"Bearer {api_key}"}
        with httpx.Client(timeout=TIMEOUT) as c:
            r = c.get(f"{BASE}/models", headers=headers)
            r.raise_for_status()
            body = r.json()
        raw = body.get("data") if isinstance(body, dict) else body
        if not isinstance(raw, list):
            raise ValueError(f"unexpected catalog shape: {str(body)[:160]}")
        models = [p for p in (_to_public(m) for m in raw if isinstance(m, dict)) if p]
        # LoRA models first, then alphabetical — newest/curated ordering is not guaranteed.
        models.sort(key=lambda p: (not p["supports_lora"], p["label"].lower()))
        _cache.update(key_fp=key_fp, at=now, models=models, error=None)
        return {"models": models, "error": None, "cached": False, "fetched_at": now}
    except Exception as e:  # noqa: BLE001 — never break /models on a catalog hiccup
        err = f"{type(e).__name__}: {e}"[:200]
        # Keep any previously-good models for this key; just report the error.
        keep = _cache["models"] if _cache["key_fp"] == key_fp else []
        _cache.update(key_fp=key_fp, at=now, models=keep, error=err)
        return {"models": keep, "error": err, "cached": bool(keep), "fetched_at": now}


def find(model_id: str) -> Optional[dict]:
    for m in _cache["models"]:
        if m["id"] == model_id or m["slug"] == model_id:
            return m
    return None

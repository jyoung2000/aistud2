"""WaveSpeed async client — submit a prediction, poll until completed (contract #6).

Confirmed call pattern:
  POST https://api.wavespeed.ai/api/v3/wavespeed-ai/{slug}   (Authorization: Bearer <key>)
    -> { "data": { "id": <prediction_id>, ... } }
  GET  https://api.wavespeed.ai/api/v3/predictions/{id}/result
    -> { "data": { "status": "...", "outputs": [url], ... } }   status=="completed" when done

Exact per-model input schemas come from each model card's API tab and live in the adapters.
"""
from __future__ import annotations

from typing import Optional, Tuple

import httpx

BASE = "https://api.wavespeed.ai/api/v3"
TIMEOUT = httpx.Timeout(60.0)


def _model_url(slug: str) -> str:
    """Build the submit URL. A bare slug (e.g. "qwen-image/edit-2511") is a wavespeed-ai
    model; a slug that already carries a provider prefix (e.g. "alibaba/..." from the live
    catalog) is used as the full path."""
    s = slug.lstrip("/")
    if "/" in s and s.split("/", 1)[0] in _PROVIDERS:
        return f"{BASE}/{s}"
    return f"{BASE}/wavespeed-ai/{s}"


# Provider prefixes that appear as the first path segment of a WaveSpeed model_id.
_PROVIDERS = {
    "wavespeed-ai", "alibaba", "google", "bytedance", "kwaivgi", "luma", "nvidia", "bria",
    "minimax", "black-forest-labs", "ideogram", "tencent", "stability-ai", "runway",
}


def submit(slug: str, payload: dict, api_key: str) -> str:
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    with httpx.Client(timeout=TIMEOUT) as c:
        r = c.post(_model_url(slug), json=payload, headers=headers)
        r.raise_for_status()
        data = r.json().get("data", {})
        pid = data.get("id")
        if not pid:
            raise RuntimeError(f"no prediction id in response: {r.text[:200]}")
        return str(pid)


def poll(prediction_id: str, api_key: str) -> Tuple[str, list, Optional[str]]:
    """Return (status, outputs, error). status ∈ {completed, failed, polling}."""
    headers = {"Authorization": f"Bearer {api_key}"}
    with httpx.Client(timeout=TIMEOUT) as c:
        r = c.get(f"{BASE}/predictions/{prediction_id}/result", headers=headers)
        r.raise_for_status()
        data = r.json().get("data", {})
    raw = str(data.get("status", "")).lower()
    outputs = data.get("outputs", []) or []
    error = data.get("error")
    if raw in ("completed", "succeeded", "success"):
        return "completed", outputs, None
    if raw in ("failed", "error", "canceled", "cancelled"):
        return "failed", outputs, error or raw
    return "polling", outputs, None


def download_image(url: str) -> bytes:
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True) as c:
        r = c.get(url)
        r.raise_for_status()
        return r.content

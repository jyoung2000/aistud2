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


def submit(slug: str, payload: dict, api_key: str) -> str:
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    with httpx.Client(timeout=TIMEOUT) as c:
        r = c.post(f"{BASE}/wavespeed-ai/{slug}", json=payload, headers=headers)
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

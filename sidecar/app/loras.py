"""LoRA library — register LoRAs (local file paths for local generation, or hosted refs /
URLs / ids for WaveSpeed endpoints that accept them). Stored as JSON in the config dir.

A LoRA: { id, name, trigger_words[], ref, compatible_base, weight_default, thumb? }
`ref` is a local path or a hosted URL/id; `compatible_base` names the base it was trained on.
"""
from __future__ import annotations

import json
import uuid
from typing import List

from app.settings import config_dir


def _path():
    return config_dir() / "loras.json"


def list_loras() -> List[dict]:
    p = _path()
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception:
        return []


def register(lora: dict) -> List[dict]:
    items = list_loras()
    entry = {
        "id": uuid.uuid4().hex,
        "name": str(lora.get("name", "LoRA")),
        "trigger_words": list(lora.get("trigger_words", []))[:8],
        "ref": str(lora.get("ref", "")),
        "compatible_base": str(lora.get("compatible_base", "")),
        "weight_default": float(lora.get("weight_default", 0.8)),
        "thumb": lora.get("thumb"),
    }
    items.append(entry)
    config_dir().mkdir(parents=True, exist_ok=True)
    _path().write_text(json.dumps(items, indent=2), "utf-8")
    return items


def remove(lora_id: str) -> List[dict]:
    items = [x for x in list_loras() if x.get("id") != lora_id]
    _path().write_text(json.dumps(items, indent=2), "utf-8")
    return items

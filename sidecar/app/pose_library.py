"""Pose library — save/load named reusable rigs (the edited Pose JSON). Stored as JSON in the
config dir, like the LoRA library. A saved pose: { id, name, pose, w, h }.
"""
from __future__ import annotations

import json
import uuid
from typing import List

from app.settings import config_dir


def _path():
    return config_dir() / "poses.json"


def list_poses() -> List[dict]:
    p = _path()
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception:
        return []


def save(entry: dict) -> List[dict]:
    items = list_poses()
    rec = {
        "id": uuid.uuid4().hex,
        "name": str(entry.get("name", "Pose"))[:80],
        "pose": entry.get("pose", {}),
        "w": int(entry.get("w", 0)),
        "h": int(entry.get("h", 0)),
    }
    items.append(rec)
    config_dir().mkdir(parents=True, exist_ok=True)
    _path().write_text(json.dumps(items, indent=2), "utf-8")
    return items


def remove(pose_id: str) -> List[dict]:
    items = [x for x in list_poses() if x.get("id") != pose_id]
    _path().write_text(json.dumps(items, indent=2), "utf-8")
    return items

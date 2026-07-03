"""Stage 5 — local keep/reroll telemetry per (model, operation).

A tiny local counter file (`<config>/feedback.json`) recording which model the user
KEPT results from vs REROLLED, per operation. Powers the model-picker badges ("kept 8/9
recolors") and, over time, the compiler's own honesty about what works. Purely local,
never uploaded, never blocks anything — every path degrades to a no-op on error.
"""
from __future__ import annotations

import json
import threading
import time
from typing import Optional

from app import settings as _settings

_LOCK = threading.Lock()


def _path():
    return _settings.config_dir() / "feedback.json"


def _load() -> dict:
    try:
        p = _path()
        if p.exists():
            data = json.loads(p.read_text("utf-8"))
            return data if isinstance(data, dict) else {}
    except Exception:
        pass
    return {}


def record(model_id: str, kept: bool, operation: Optional[str] = None) -> dict:
    """Increment the (model, operation) keep/reroll counter. Returns the model's row."""
    op = (operation or "any")[:40]
    with _LOCK:
        data = _load()
        row = data.setdefault(str(model_id)[:200], {})
        cell = row.setdefault(op, {"keep": 0, "reroll": 0})
        cell["keep" if kept else "reroll"] += 1
        row["_ts"] = time.time()
        try:
            _path().parent.mkdir(parents=True, exist_ok=True)
            _path().write_text(json.dumps(data, indent=1), "utf-8")
        except Exception:
            pass  # read-only config dir → telemetry silently off
        return row


def stats() -> dict:
    """{model_id: {keeps, rerolls, keep_rate, by_operation}} — for picker badges."""
    out: dict = {}
    for mid, row in _load().items():
        keeps = rerolls = 0
        by_op = {}
        for op, cell in row.items():
            if not isinstance(cell, dict):
                continue
            k, r = int(cell.get("keep", 0)), int(cell.get("reroll", 0))
            keeps += k
            rerolls += r
            by_op[op] = {"keep": k, "reroll": r}
        total = keeps + rerolls
        if total:
            out[mid] = {
                "keeps": keeps,
                "rerolls": rerolls,
                "keep_rate": round(keeps / total, 3),
                "by_operation": by_op,
            }
    return out

"""Settings + secret storage for Neuclip Studio.

Secrets (WaveSpeed / Anthropic API keys) come from the in-app Settings screen and are saved
to a user-writable config file, with environment variables as a fallback. NEVER hardcoded;
the file is chmod 600 on POSIX. (OS keychain is a future upgrade — the resolve order here
keeps that swap local.)

Resolve order for a secret: saved config file → environment variable → unset.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional, TypedDict

# Map of logical secret name → environment variable fallback.
SECRET_ENV = {
    "wavespeed_api_key": "WAVESPEED_API_KEY",
    "anthropic_api_key": "ANTHROPIC_API_KEY",
}


def config_dir() -> Path:
    override = os.environ.get("NEUCLIP_CONFIG_DIR")
    return Path(override) if override else Path.home() / ".neuclip"


def config_path() -> Path:
    return config_dir() / "config.json"


def _read() -> dict:
    p = config_path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception:
        return {}


def _write(data: dict) -> None:
    d = config_dir()
    d.mkdir(parents=True, exist_ok=True)
    p = config_path()
    p.write_text(json.dumps(data, indent=2), encoding="utf-8")
    try:
        os.chmod(p, 0o600)  # owner-only; best-effort (no-op semantics on Windows)
    except OSError:
        pass


def get_secret(name: str) -> Optional[str]:
    """Effective value of a secret: config file first, then env var."""
    val = _read().get(name)
    if val:
        return str(val)
    env = SECRET_ENV.get(name)
    if env:
        ev = os.environ.get(env)
        if ev:
            return ev
    return None


class SecretStatus(TypedDict):
    set: bool
    source: Optional[str]  # "config" | "env" | None
    hint: Optional[str]    # masked tail, e.g. "…a1b2"


def _status_for(name: str) -> SecretStatus:
    cfg_val = _read().get(name)
    if cfg_val:
        s = str(cfg_val)
        return SecretStatus(set=True, source="config", hint="…" + s[-4:])
    env = SECRET_ENV.get(name)
    ev = os.environ.get(env) if env else None
    if ev:
        return SecretStatus(set=True, source="env", hint="…" + ev[-4:])
    return SecretStatus(set=False, source=None, hint=None)


def settings_status() -> dict:
    """Non-secret status the UI can render — never returns the raw key."""
    return {
        "config_path": str(config_path()),
        "secrets": {name: _status_for(name) for name in SECRET_ENV},
    }


def save_secrets(updates: dict[str, Optional[str]]) -> dict:
    """Merge secret updates into the config file.

    A non-empty string sets the key; an empty string or None clears it (falling back to env).
    Only known secret names are accepted.
    """
    data = _read()
    for name, value in updates.items():
        if name not in SECRET_ENV:
            continue
        if value:
            data[name] = value
        else:
            data.pop(name, None)
    _write(data)
    return settings_status()

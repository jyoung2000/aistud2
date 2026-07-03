"""Profile store — load (base+user merged), validate, and import with the Phase 8 safety
rules (contract #7):

- imports are schema-validated and size-capped;
- machine-introspected paradigm / capabilities / constraints WIN over imported claims
  (warn on conflict);
- the hard token cap cannot be raised by a profile;
- nothing in a profile is executable — templates are data, the synthesis logic is fixed.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Dict, List, Tuple

import yaml

from app import settings as _settings
from app.models import registry
from app.profiles import builder

HARD_MAX_TOKENS = 1024
MAX_PROFILE_BYTES = 256_000
MAX_EXEMPLARS = 20

_DIR = Path(__file__).parent
# Read-only legacy location inside the package (frozen builds bundle it); user profiles are
# WRITTEN to the config dir, which survives upgrades and works in read-only installs.
_BUNDLED_STORE = _DIR / "store"
# Read-only, shipped research layers (Stage 1 of the prompt-intelligence pipeline): every
# claim carries {source, confidence}; the audit CLI enforces it.
RESEARCH_DIR = _DIR / "research"
_SCHEMA_CACHE: dict | None = None


def _slug_fname(model_or_slug: str) -> str:
    """Filesystem-safe research filename: slashes in slugs become '--'."""
    return model_or_slug.replace("/", "--")


def research_path(model_id: str, slug: str | None = None) -> Path | None:
    """Research layer for a model: by registry id first, then by (sanitized) slug."""
    for key in filter(None, (model_id, slug)):
        p = RESEARCH_DIR / f"{_slug_fname(key)}.research.nprofile"
        if p.exists():
            return p
    return None


def load_research(model_id: str, slug: str | None = None) -> dict | None:
    p = research_path(model_id, slug)
    if p is None:
        return None
    try:
        data = yaml.safe_load(p.read_text("utf-8")) or {}
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def store_dir() -> Path:
    """Writable user-profile dir: <config>/profiles (honors NEUCLIP_CONFIG_DIR)."""
    return _settings.config_dir() / "profiles"


def _user_path(model_id: str) -> Path:
    """Path of a model's user layer: config dir first, bundled dir as read-only fallback."""
    p = store_dir() / f"{model_id}.user.nprofile"
    if p.exists():
        return p
    legacy = _BUNDLED_STORE / f"{model_id}.user.nprofile"
    if legacy.exists():
        return legacy
    return p  # default (write target)


def _schema() -> dict | None:
    """Load schema.json lazily; tolerate a missing bundled data file (degrade, don't crash)."""
    global _SCHEMA_CACHE
    if _SCHEMA_CACHE is None:
        p = _DIR / "schema.json"
        if p.exists():
            _SCHEMA_CACHE = json.loads(p.read_text("utf-8"))
        else:
            print("[profiles] schema.json not bundled; skipping strict validation")
            _SCHEMA_CACHE = {}
    return _SCHEMA_CACHE or None


def _validate(profile: dict) -> None:
    schema = _schema()
    if not schema:
        return
    import jsonschema  # local import keeps startup light

    jsonschema.validate(profile, schema)


def base_profile(model_id: str) -> dict:
    spec = registry.get(model_id)
    if spec is None:
        raise KeyError(model_id)
    return builder.build_base(spec)


def _deep_merge(a: dict, b: dict) -> dict:
    out = copy.deepcopy(a)
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def _enforce_introspection(profile: dict, model_id: str) -> Tuple[dict, List[str]]:
    spec = registry.get(model_id)
    warnings: List[str] = []
    if spec is None:
        return profile, warnings
    if profile.get("paradigm") not in (None, spec.paradigm):
        warnings.append(f"imported paradigm '{profile.get('paradigm')}' ignored; using introspected '{spec.paradigm}'")
    profile["paradigm"] = spec.paradigm
    caps = profile.setdefault("capabilities", {})
    truth = {
        "reference_roles": list(spec.reference_roles),
        "needs_mask": spec.needs_mask,
        "instruction_based": spec.instruction_based,
    }
    for k, val in truth.items():
        if k in caps and caps[k] != val:
            warnings.append(f"imported capability '{k}' ignored; using introspected value")
        caps[k] = val
    return profile, warnings


def _enforce_caps(profile: dict) -> Tuple[dict, List[str]]:
    warnings: List[str] = []
    c = profile.setdefault("constraints", {})
    mt = c.get("max_prompt_tokens", 512)
    if not isinstance(mt, int) or mt > HARD_MAX_TOKENS:
        warnings.append(f"max_prompt_tokens {mt} exceeds the hard cap {HARD_MAX_TOKENS}; clamped")
        c["max_prompt_tokens"] = HARD_MAX_TOKENS
    return profile, warnings


def load(model_id: str, slug: str | None = None) -> Tuple[dict, List[str]]:
    """Merged profile. Precedence (weakest → strongest):
    paradigm default (builder) < research layer < user layer < machine introspection.
    Introspection is the machine truth and always wins; the user's edits beat shipped
    research; research beats the offline defaults."""
    profile = base_profile(model_id)
    warnings: List[str] = []
    research = load_research(model_id, slug)
    if research:
        profile = _deep_merge(profile, research)
    user_path = _user_path(model_id)
    if user_path.exists():
        user = yaml.safe_load(user_path.read_text("utf-8")) or {}
        profile = _deep_merge(profile, user)
    profile, w1 = _enforce_introspection(profile, model_id)
    profile, w2 = _enforce_caps(profile)
    return profile, warnings + w1 + w2


def load_for_dynamic(slug: str, paradigm: str = "instruction") -> dict:
    """Profile for a catalog-discovered model with no registry spec: a generic paradigm
    base enriched by a research layer when one ships for the slug."""
    from types import SimpleNamespace

    spec = SimpleNamespace(
        id=slug, paradigm=paradigm, reference_roles=[], needs_mask=(paradigm == "inpaint"),
        instruction_based=(paradigm == "instruction"),
    )
    profile = builder.build_base(spec)
    research = load_research(slug)
    if research:
        profile = _deep_merge(profile, research)
    profile, _ = _enforce_caps(profile)
    return profile


def import_profile(text: str, persist: bool = False) -> Tuple[dict, List[str]]:
    if len(text.encode("utf-8")) > MAX_PROFILE_BYTES:
        raise ValueError("profile exceeds size cap")
    data = yaml.safe_load(text)
    if not isinstance(data, dict):
        raise ValueError("profile must be a YAML mapping")
    _validate(data)
    model_id = data.get("model")
    warnings: List[str] = []
    if model_id and registry.get(model_id):
        data, w1 = _enforce_introspection(data, model_id)
        warnings += w1
    data, w2 = _enforce_caps(data)
    warnings += w2
    if persist and model_id:
        store_dir().mkdir(parents=True, exist_ok=True)
        data["layer"] = "user"
        (store_dir() / f"{model_id}.user.nprofile").write_text(yaml.safe_dump(data), "utf-8")
    return data, warnings


def append_exemplar(
    model_id: str,
    intent: str,
    prompt: str,
    operation: str | None = None,
    kept: bool = True,
    ts: float | None = None,
) -> dict:
    """Append a structured exemplar {intent, operation, prompt, kept, ts} to the model's
    user layer (shootout/keep feedback). Append-only, capped at MAX_EXEMPLARS (oldest
    dropped), persisted to the config dir. Exemplars ride the untrusted user layer —
    synthesis treats them as data only (phrasing analogy, never executable)."""
    if not registry.get(model_id):
        raise KeyError(model_id)
    path = store_dir() / f"{model_id}.user.nprofile"
    data: dict = {}
    src = _user_path(model_id)
    if src.exists():
        data = yaml.safe_load(src.read_text("utf-8")) or {}
    ex = data.setdefault("exemplars", [])
    if not isinstance(ex, list):
        ex = data["exemplars"] = []
    entry: dict = {"intent": str(intent)[:500], "prompt": str(prompt)[:2000], "kept": bool(kept)}
    if operation:
        entry["operation"] = str(operation)[:40]
    if ts is not None:
        entry["ts"] = float(ts)
    ex.append(entry)
    del ex[:-MAX_EXEMPLARS]
    data["layer"] = "user"
    data.setdefault("model", model_id)
    store_dir().mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(data), "utf-8")
    return {"model": model_id, "exemplars": len(ex)}


def nearest_exemplars(profile: dict, operation: str, intent: str, k: int = 2) -> List[dict]:
    """The k nearest KEPT exemplars by operation match + keyword overlap — used by the
    compiler as internal phrasing guidance (never appended verbatim to the prompt)."""
    exemplars = [e for e in profile.get("exemplars", []) if isinstance(e, dict) and e.get("kept", True)]
    if not exemplars:
        return []
    intent_words = set(str(intent).lower().split())

    def score(e: dict) -> float:
        s = 2.0 if e.get("operation") == operation else 0.0
        ewords = set(str(e.get("intent", "")).lower().split())
        if intent_words and ewords:
            s += len(intent_words & ewords) / max(len(intent_words), 1)
        return s

    ranked = sorted(exemplars, key=score, reverse=True)
    return [e for e in ranked[:k] if score(e) > 0]


def list_profiles() -> List[dict]:
    out = []
    for spec in registry.REGISTRY:
        prof, _ = load(spec.id)
        out.append(
            {
                "model": spec.id,
                "paradigm": prof["paradigm"],
                "max_prompt_tokens": prof["constraints"]["max_prompt_tokens"],
                "has_user_layer": _user_path(spec.id).exists(),
                "has_research_layer": research_path(spec.id, spec.slug) is not None,
            }
        )
    return out

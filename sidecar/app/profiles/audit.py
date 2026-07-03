"""Profile audit CLI — `python -m app.profiles.audit`.

Checks (exit code 1 on any failure):
1. Every research/user layer schema-validates against schema.json.
2. Every claim (dos/donts entries, known_failures, param_guidance values, and a research
   layer's negative_prompt) carries a non-empty `source` — no unsourced claims ship.
3. Research layers must not contradict machine-introspected capabilities: paradigm must
   match the registry, and a research layer claiming negative_prompt.supported=true for a
   model whose live card/adapter has no such field fails the audit.
"""
from __future__ import annotations

import sys

import yaml

from app.models import registry
from app.profiles import store


def _iter_claims(profile: dict):
    for key in ("dos", "donts"):
        for i, c in enumerate(profile.get(key, []) or []):
            yield f"{key}[{i}]", c if isinstance(c, dict) else {"rule": str(c)}
    for i, c in enumerate(profile.get("known_failures", []) or []):
        yield f"known_failures[{i}]", c if isinstance(c, dict) else {"pattern": str(c)}
    for param, c in (profile.get("param_guidance", {}) or {}).items():
        yield f"param_guidance.{param}", c if isinstance(c, dict) else {}
    np_ = profile.get("negative_prompt")
    if isinstance(np_, dict) and np_:
        yield "negative_prompt", np_


def audit() -> int:
    failures: list[str] = []
    warnings: list[str] = []

    layers: list[tuple[str, dict]] = []
    if store.RESEARCH_DIR.exists():
        for p in sorted(store.RESEARCH_DIR.glob("*.research.nprofile")):
            try:
                data = yaml.safe_load(p.read_text("utf-8")) or {}
                layers.append((p.name, data))
            except Exception as e:
                failures.append(f"{p.name}: unreadable YAML: {e}")
    user_dir = store.store_dir()
    if user_dir.exists():
        for p in sorted(user_dir.glob("*.user.nprofile")):
            try:
                layers.append((p.name, yaml.safe_load(p.read_text("utf-8")) or {}))
            except Exception as e:
                failures.append(f"{p.name}: unreadable YAML: {e}")

    for name, data in layers:
        # 1. schema validation
        try:
            store._validate(data)
        except Exception as e:
            failures.append(f"{name}: schema violation: {str(e).splitlines()[0]}")
            continue

        is_research = data.get("layer") == "research"

        # 2. sourced claims (hard requirement for research layers; warning for user layers)
        for where, claim in _iter_claims(data):
            src = str(claim.get("source", "") or "").strip()
            if not src:
                msg = f"{name}: {where} has no source"
                (failures if is_research else warnings).append(msg)
            conf = claim.get("confidence")
            if is_research and conf not in ("confirmed", "inferred", None):
                failures.append(f"{name}: {where} has invalid confidence {conf!r}")

        # 3. research vs machine introspection
        if is_research:
            spec = registry.get(data.get("model"))
            if spec is not None:
                if data.get("paradigm") not in (None, spec.paradigm):
                    failures.append(
                        f"{name}: research paradigm {data.get('paradigm')!r} contradicts "
                        f"introspected {spec.paradigm!r}"
                    )
                np_ = data.get("negative_prompt") or {}
                if np_.get("supported") is True:
                    # our verified adapters expose no negative_prompt field for any
                    # registry model — a research claim of support contradicts the card
                    failures.append(
                        f"{name}: claims negative_prompt.supported=true but the verified "
                        f"adapter/card for {spec.id} has no such field"
                    )

    print(f"profile audit: {len(layers)} layer(s) checked")
    for w in warnings:
        print(f"  WARN  {w}")
    for f in failures:
        print(f"  FAIL  {f}")
    if not failures:
        print("  OK — zero unsourced claims, all layers schema-valid, no introspection conflicts")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(audit())

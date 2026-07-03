"""Stage 4 (optional) — LLM polish of the compiled prompt.

OFF BY DEFAULT. The deterministic compiler is the product; this pass only smooths the
compiler's output into more natural phrasing when (a) the caller explicitly asks for it
AND (b) an Anthropic key is configured. It is a rewrite pass, not a generator: the
compiled prompt is the input, the model-profile rules are the constraints, and any
failure (no SDK installed, no key, network error, over-long output) returns None so the
deterministic result stands untouched.

Uses the official `anthropic` SDK (lazy import — the sidecar never requires it),
claude-haiku-4-5 at temperature 0 with a hard max_tokens cap.
"""
from __future__ import annotations

from typing import Optional

from app import settings as _settings

MODEL = "claude-haiku-4-5"
MAX_OUT_TOKENS = 300  # hard cap: a prompt rewrite, never an essay

_SYSTEM = (
    "You rewrite image-editing prompts for a specific model. You receive a compiled "
    "prompt plus the model's grammar rules. Rewrite the prompt into natural, fluent "
    "phrasing that keeps EVERY factual clause (change, preservation, reference, trigger "
    "words) and follows the grammar rules. Never add new content, objects, styles, or "
    "instructions that are not in the compiled prompt. Reply with the rewritten prompt "
    "only — no quotes, no commentary."
)


def available() -> bool:
    """True when a polish pass could run (SDK importable + key configured)."""
    try:
        import anthropic  # noqa: F401
    except Exception:
        return False
    return bool(_settings.get_secret("anthropic_api_key"))


def polish_prompt(compiled_prompt: str, profile: dict, paradigm: str) -> Optional[str]:
    """One deterministic (temperature 0) rewrite; None on ANY failure or bad output."""
    if not compiled_prompt or not compiled_prompt.strip():
        return None
    key = _settings.get_secret("anthropic_api_key")
    if not key:
        return None
    try:
        import anthropic  # lazy: optional dependency, never required at boot
    except Exception:
        return None

    grammar = profile.get("prompt_grammar", {}) or {}
    rules = []
    if grammar.get("voice"):
        rules.append(f"voice: {grammar['voice']}")
    if grammar.get("person"):
        rules.append(f"person: {grammar['person']}")
    if grammar.get("ideal_length_tokens"):
        rules.append(f"ideal length: ~{grammar['ideal_length_tokens']} tokens")
    for d in (profile.get("dos") or [])[:6]:
        r = d.get("rule") if isinstance(d, dict) else str(d)
        if r:
            rules.append(f"do: {r}")
    for d in (profile.get("donts") or [])[:6]:
        r = d.get("rule") if isinstance(d, dict) else str(d)
        if r:
            rules.append(f"don't: {r}")
    if paradigm == "inpaint":
        rules.append("this model paints a DESCRIPTION of the masked region's final "
                     "content — no imperative verbs, no commands")

    user = (
        f"Model paradigm: {paradigm}\n"
        f"Grammar rules:\n- " + "\n- ".join(rules or ["(none)"]) + "\n\n"
        f"Compiled prompt:\n{compiled_prompt}"
    )
    try:
        client = anthropic.Anthropic(api_key=key, max_retries=1, timeout=20.0)
        msg = client.messages.create(
            model=MODEL,
            max_tokens=MAX_OUT_TOKENS,
            temperature=0,
            system=_SYSTEM,
            messages=[{"role": "user", "content": user}],
        )
        text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
    except Exception:
        return None
    # sanity gates: non-empty, single prompt, not wildly longer than the input
    if not text or "\n\n" in text or len(text) > max(200, len(compiled_prompt) * 2):
        return None
    return text

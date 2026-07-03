"""Prompt Intelligence pipeline: intent → context → compile → verify → learn.

- intent.py   : raw user text → structured EditSpec (deterministic, no LLM)
- context.py  : session/mask/scene → SelectionContext (all CPU-degradable)
- compiler.py : (EditSpec, SelectionContext, profile) → model-tuned prompt + rationale
- polish.py   : optional Anthropic rewrite layer (off by default; never required)
"""

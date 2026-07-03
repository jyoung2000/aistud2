# Prompt research — model-by-model prompting evidence

This document is the human-readable companion to the machine research layers in
`sidecar/app/profiles/research/*.research.nprofile`. **Every claim below carries the
source it was taken from and a confidence tag** — the per-model sections are generated
from the layer files themselves so the doc and the machine data cannot drift.

## Methodology & provenance rules

- **No guessed claims.** A rule ships only if it traces to a source: the model vendor's
  own prompting guide / model card ("confirmed") or a documented, sourced community
  consensus ("inferred"). WaveSpeed model/API pages are the source of truth for slugs,
  input schemas, defaults, and parameter ranges (build contract #6).
- **Confidence taxonomy:**
  - `confirmed` — stated in official documentation (vendor guide, HF model card,
    WaveSpeed API page) that was read during the research pass.
  - `inferred` — sourced community documentation (tutorials, issue threads) whose advice
    is consistent across sources but not vendor-official.
- **Audit-enforced.** `python -m app.profiles.audit` (runs in CI, `.github/workflows/tests.yml`)
  fails the build on any research claim without a source, any invalid confidence value,
  and any research claim that contradicts machine introspection (paradigm mismatch, or
  claiming `negative_prompt.supported: true` when the verified adapter/card has no such
  field).
- **Merge precedence** (weakest → strongest): paradigm default (`profiles/builder.py`)
  < **research layer** < user layer (`~/.neuclip/profiles/*.user.nprofile`, editable &
  shareable) < machine introspection (registry paradigm/capabilities/token caps always win).
- **Untrusted-until-validated.** Research and user layers are DATA only: schema-validated,
  size-capped, token-cap-clamped; nothing in a profile is executable (contract #7).

## How the compiler consumes this research

`sidecar/app/prompting/compiler.py` turns each model's layer into behavior:

- `prompt_grammar` → clause order, voice (imperative vs description), ideal token length
  (budget with drop priority — change/preservation/reference/LoRA clauses are never dropped).
- `dos`/`donts` → the paradigm strategies (e.g. Kontext's named-subjects + explicit
  preservation language; Fill's describe-only-the-masked-region grammar).
- `known_failures` → automatic mitigations keyed by context flags (e.g. `small_object`
  widens the send region to pad 0.3 and pins scale; `likely_person` adds an identity lock).
- `vocab` → model-preferred quality tags appended to inpaint descriptions (droppable).
- `param_guidance` → documented sweet spots surfaced in rationale / parameter hints.
- `negative_prompt` → only emitted when the card confirms the field exists (today: none
  of the verified adapters do).

**The one non-negotiable strategy** (acceptance-tested in
`sidecar/tests/test_prompt_compiler.py::test_remove_on_inpaint_is_background_description`):
*"remove X" on an inpaint model compiles to a description of the background that should
exist — never a removal command* — because fill models paint what the text describes
([FLUX.1-Fill-dev card](https://huggingface.co/black-forest-labs/FLUX.1-Fill-dev):
fills masked regions "based on a text description"; community failure reports of
'remove'-style prompts regenerating the object:
[diffusers#9486](https://github.com/huggingface/diffusers/issues/9486)).

## Adding a new model (the rule)

A new registry entry may not set `confirmed_slug: true` until it has a research layer:
create `sidecar/app/profiles/research/<id-or-slug with / → -->.research.nprofile`, source
every claim from the model's card/guide, and run `python -m app.profiles.audit` — the
audit failing is the gate. Dynamic catalog models without a layer run on the generic
paradigm profile (honestly labeled in the UI).

---

## Per-model evidence (generated from the research layers)

### `bytedance/seedream-v4.5/edit`

*Layer file:* `sidecar/app/profiles/research/bytedance--seedream-v4.5--edit.research.nprofile` · *paradigm:* `instruction` · *version:* `research-2026-07`

*Grammar:* voice **imperative**; ideal length ~60 tokens; structure: change_clause → preservation_clause


**Do**

- Lean on its strength: it 'preserves facial features, lighting, and color tone from reference images' — good default for people edits. — [confirmed](https://wavespeed.ai/models/bytedance/seedream-v4.5/edit)
- Use edit-sequential for multi-step consistent edit chains. — [confirmed](https://wavespeed.ai/models/bytedance/seedream-v4.5/edit-sequential)


**Negative prompt:** not supported — [inferred](https://wavespeed.ai/models/bytedance/seedream-v4.5/edit)


---

### `flux-fill`

*Layer file:* `sidecar/app/profiles/research/flux-fill.research.nprofile` · *paradigm:* `inpaint` · *version:* `research-2026-07`

*Grammar:* voice **declarative-description**; ideal length ~40 tokens; structure: content_description → style_context → quality_tags


**Do**

- Describe ONLY the desired FINAL content of the masked region — the model 'fills masked regions based on a text description' (official example prompt: 'a white paper cup'). — [confirmed](https://huggingface.co/black-forest-labs/FLUX.1-Fill-dev)
- Mention material and lighting so the fill matches the surroundings. — [inferred](https://huggingface.co/black-forest-labs/FLUX.1-Fill-dev)
- Use the high default guidance (30) — Fill is tuned for strong prompt adherence in the masked area. — [confirmed](https://huggingface.co/black-forest-labs/FLUX.1-Fill-dev)


**Don't**

- Never phrase as an instruction ('remove the cup') — an inpaint model paints what you describe, it does not execute commands. — [inferred](https://huggingface.co/black-forest-labs/FLUX.1-Fill-dev)
- Don't describe the unmasked scene as something to change — content outside the mask is fixed; mentioning it confuses the fill. — [inferred](https://github.com/huggingface/diffusers/issues/9486)
- For removals, don't name the object being removed — describe the background that should exist instead. — [inferred](https://github.com/huggingface/diffusers/issues/9486)


**Known failures & mitigations**

- 'remove X' prompts regenerate a similar object because the model must paint something in the mask → *compile removals as a description of the surrounding background continuing through the region* — [inferred](https://github.com/huggingface/diffusers/issues/9486)
- small masks (<3% of frame) give the model too little context → *expand send-region padding and restate the object's scale* — [inferred](https://huggingface.co/black-forest-labs/FLUX.1-Fill-dev)


**Parameter guidance**

- `guidance_scale`: 30 (official example) — much lower = fill ignores the prompt; Fill is calibrated for high guidance unlike base FLUX [confirmed](https://huggingface.co/black-forest-labs/FLUX.1-Fill-dev)
- `num_inference_steps`: 28-50 (official example uses 50) — fewer = faster, softer detail [confirmed](https://huggingface.co/black-forest-labs/FLUX.1-Fill-dev)


**Negative prompt:** not supported — [confirmed](https://wavespeed.ai/docs/docs-api/wavespeed-ai/flux-fill-dev)

**Documented example prompts**

- “a white paper cup” — [source](https://huggingface.co/black-forest-labs/FLUX.1-Fill-dev)


---

### `flux-kontext`

*Layer file:* `sidecar/app/profiles/research/flux-kontext.research.nprofile` · *paradigm:* `instruction` · *version:* `research-2026-07`

*Grammar:* voice **imperative**; ideal length ~60 tokens; structure: change_clause → context_clause → preservation_clause


**Do**

- Use clear action verbs: change, add, remove, replace. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Name subjects explicitly — 'the woman with short black hair', never pronouns like 'her'. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- State what must NOT change with explicit preservation language: 'while maintaining the same facial features, hairstyle, and expression'. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Anchor composition when swapping backgrounds: 'keep the person in the exact same position, scale, and pose'. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Edit text with the exact syntax: Replace '[original text]' with '[new text]'. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Start with a simple edit and iterate; chain small edits rather than stacking many changes in one prompt. — [inferred](https://comfyui-wiki.com/en/tutorial/advanced/image/flux/flux-1-kontext)
- Name the style explicitly for restyles: 'Change to Bauhaus art style while maintaining the original composition and object placement'. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)


**Don't**

- Avoid vague quality asks like 'make it better' — specify the dimension ('change the wall color to blue'). — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Avoid vague pronouns ('it', 'her', 'that thing') — the model needs the subject named. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Don't pack many unrelated edits into one prompt; results degrade — iterate instead. — [inferred](https://www.mimicpc.com/learn/flux-kontext-prompt-guide-how-to-edit-images)


**Known failures & mitigations**

- identity drift on faces across heavy or repeated edits → *add an explicit preservation clause naming facial features/hairstyle/expression and keep edits incremental* — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- composition shifts when the background is changed → *add a context clause pinning position/scale/pose of the subject* — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- small selections can be ignored or repainted coarsely → *expand the send-region padding and restate the object's small scale in the prompt* — [inferred](https://www.mimicpc.com/learn/flux-kontext-prompt-guide-how-to-edit-images)


**Parameter guidance**

- `guidance_scale`: ~2.5 (WaveSpeed default) — higher = stronger prompt adherence but risks oversaturation/artifacts; lower = subtler edits [confirmed](https://wavespeed.ai/docs-api/flux-kontext-dev)
- `num_inference_steps`: ~28 (default); quality plateaus beyond ~40 — more steps = slower with diminishing returns [confirmed](https://wavespeed.ai/docs-api/flux-kontext-dev)


**Negative prompt:** not supported — [confirmed](https://wavespeed.ai/docs-api/flux-kontext-dev)

**Documented example prompts**

- “Change the background to a tropical beach with sunset colors while keeping the woman in the exact same position and pose, maintaining her facial features, expression, and clothing details” — [source](https://www.mimicpc.com/learn/flux-kontext-prompt-guide-how-to-edit-images)
- “Change to Bauhaus art style while maintaining the original composition and object placement” — [source](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- “Replace 'OPEN' with 'CLOSED'” — [source](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)


---

### `google/nano-banana/edit`

*Layer file:* `sidecar/app/profiles/research/google--nano-banana--edit.research.nprofile` · *paradigm:* `instruction` · *version:* `research-2026-07`

*Grammar:* voice **declarative-description**; ideal length ~90 tokens; structure: scene_or_change_narration → preservation_clause


**Do**

- Write narrative, natural-language descriptions — 'describe the scene, don't just list keywords'. — [confirmed](https://deepmind.google/models/gemini-image/prompt-guide/)
- Be hyper-specific about the single element to change; the model does semantic, 'pixel-perfect' local edits (e.g. change a sofa's color without disturbing the scene). — [confirmed](https://blog.google/products/gemini/nano-banana-tips/)
- Spell out subject, composition, action, location, and style when the edit is broad. — [confirmed](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana)


**Don't**

- Skip quality-tag spam ('4k, masterpiece, trending on artstation') — the model understands natural language; be descriptive, not repetitive. — [confirmed](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana)


**Negative prompt:** not supported — [inferred](https://wavespeed.ai/models/google/nano-banana/edit)


---

### `google/nano-banana-pro/edit`

*Layer file:* `sidecar/app/profiles/research/google--nano-banana-pro--edit.research.nprofile` · *paradigm:* `instruction` · *version:* `research-2026-07`

*Grammar:* voice **declarative-description**; ideal length ~90 tokens; structure: scene_or_change_narration → preservation_clause


**Do**

- Write narrative, natural-language descriptions — 'describe the scene, don't just list keywords'. — [confirmed](https://deepmind.google/models/gemini-image/prompt-guide/)
- Be hyper-specific about the single element to change; the model does semantic, 'pixel-perfect' local edits (e.g. change a sofa's color without disturbing the scene). — [confirmed](https://blog.google/products/gemini/nano-banana-tips/)
- Spell out subject, composition, action, location, and style when the edit is broad. — [confirmed](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana)


**Don't**

- Skip quality-tag spam ('4k, masterpiece, trending on artstation') — the model understands natural language; be descriptive, not repetitive. — [confirmed](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana)


**Negative prompt:** not supported — [inferred](https://wavespeed.ai/models/google/nano-banana-pro/edit)


---

### `ideogram-character`

*Layer file:* `sidecar/app/profiles/research/ideogram-character.research.nprofile` · *paradigm:* `reference/character` · *version:* `research-2026-07`

*Grammar:* voice **declarative-description**; ideal length ~60 tokens; structure: identity_clause → scene_clause → style_clause


**Do**

- Describe the character's physical appearance AND the environment in detail — e.g. '[character] as a 19th-century explorer in a Victorian library, warm tungsten lamps, leather-bound books, fine-art portrait style'. — [confirmed](https://docs.ideogram.ai/using-ideogram/features-and-tools/reference-features/character-reference)
- Use a portrait-style, clear, well-lit reference face (slight angle works best). — [confirmed](https://docs.ideogram.ai/using-ideogram/features-and-tools/reference-features/character-reference)
- Structure prompts as subject → setting → style (Ideogram's own prompt-structure guide). — [confirmed](https://docs.ideogram.ai/using-ideogram/prompting-guide/3-prompt-structure)
- Set style ('Auto'|'Fiction'|'Realistic') and rendering_speed via params rather than prompt words. — [confirmed](https://wavespeed.ai/models/ideogram-ai/ideogram-character)


**Don't**

- Don't rely on the prompt to preserve identity — the reference image carries identity; the prompt describes scene and action. — [inferred](https://docs.ideogram.ai/using-ideogram/features-and-tools/reference-features/character-reference)


**Known failures & mitigations**

- WaveSpeed card's mask/inpaint field names are unverified — scene-targeted inpainting may not be wired → *treat as reference/character generation; keep confirmed_slug=False until fields verified* — [confirmed](https://wavespeed.ai/models/ideogram-ai/ideogram-character)


**Parameter guidance**

- `style`: 'Realistic' for photo composites — 'Fiction' stylizes; 'Auto' lets the model pick [confirmed](https://wavespeed.ai/models/ideogram-ai/ideogram-character)
- `rendering_speed`: 'Default'; 'Quality' for final renders — 'Turbo' is fastest but softer [confirmed](https://wavespeed.ai/models/ideogram-ai/ideogram-character)


**Negative prompt:** not supported — [confirmed](https://wavespeed.ai/models/ideogram-ai/ideogram-character)

**Documented example prompts**

- “as a 19th-century explorer in a Victorian library, warm tungsten lamps, leather-bound books, fine-art portrait style” — [source](https://docs.ideogram.ai/using-ideogram/features-and-tools/reference-features/character-reference)


---

### `qwen-image-edit-2511`

*Layer file:* `sidecar/app/profiles/research/qwen-image-edit-2511.research.nprofile` · *paradigm:* `instruction` · *version:* `research-2026-07`

*Grammar:* voice **imperative**; ideal length ~50 tokens; structure: change_clause → preservation_clause


**Do**

- For text edits, state the exact target text; Qwen-Image-Edit does bilingual (EN/ZH) text add/delete/modify while preserving font, size, and style. — [confirmed](https://qwenlm.github.io/blog/qwen-image-edit/)
- Quote the exact strings to change — tutorials consistently use quoted replacements for reliable text edits. — [inferred](https://github.com/FurkanGozukara/Stable-Diffusion/wiki/Qwen-Image-Edit-Full-Tutorial-26-Different-Demo-Cases-Prompts-and-Images-Pwns-FLUX-Kontext-Dev)
- Use plain imperative instructions; the model supports both appearance edits (add/remove/modify elements) and semantic edits (style transfer, object rotation, IP re-creation). — [confirmed](https://qwenlm.github.io/blog/qwen-image-edit/)
- Chain small edits progressively for corrections instead of one big prompt (official chained-editing examples). — [confirmed](https://qwenlm.github.io/blog/qwen-image-edit/)
- State what to keep — appearance editing 'keeps other regions of the image completely unchanged' when the instruction is scoped to the target. — [confirmed](https://qwenlm.github.io/blog/qwen-image-edit/)


**Don't**

- Don't rely on vague pronouns; name the object/text to edit. — [inferred](https://github.com/FurkanGozukara/Stable-Diffusion/wiki/Qwen-Image-Edit-Full-Tutorial-26-Different-Demo-Cases-Prompts-and-Images-Pwns-FLUX-Kontext-Dev)


**Known failures & mitigations**

- identity/pose drift with multiple people → *prefer the 2511 generation (improved multi-person identity/pose consistency) and add preservation language* — [confirmed](https://wavespeed.ai/models/wavespeed-ai/qwen-image/edit-2511-lora)


**Parameter guidance**

- `seed`: -1 (random) or fixed for reproducibility — fixed seed = repeatable framing across re-runs [confirmed](https://wavespeed.ai/models/wavespeed-ai/qwen-image/edit-2511)


**Negative prompt:** not supported — [confirmed](https://wavespeed.ai/models/wavespeed-ai/qwen-image/edit-2511)


---

### `qwen-image-edit-plus`

*Layer file:* `sidecar/app/profiles/research/qwen-image-edit-plus.research.nprofile` · *paradigm:* `instruction` · *version:* `research-2026-07`

*Grammar:* voice **imperative**; ideal length ~50 tokens; structure: change_clause → preservation_clause


**Do**

- For text edits, state the exact target text; Qwen-Image-Edit does bilingual (EN/ZH) text add/delete/modify while preserving font, size, and style. — [confirmed](https://qwenlm.github.io/blog/qwen-image-edit/)
- Quote the exact strings to change — tutorials consistently use quoted replacements for reliable text edits. — [inferred](https://github.com/FurkanGozukara/Stable-Diffusion/wiki/Qwen-Image-Edit-Full-Tutorial-26-Different-Demo-Cases-Prompts-and-Images-Pwns-FLUX-Kontext-Dev)
- Use plain imperative instructions; the model supports both appearance edits (add/remove/modify elements) and semantic edits (style transfer, object rotation, IP re-creation). — [confirmed](https://qwenlm.github.io/blog/qwen-image-edit/)
- Chain small edits progressively for corrections instead of one big prompt (official chained-editing examples). — [confirmed](https://qwenlm.github.io/blog/qwen-image-edit/)
- State what to keep — appearance editing 'keeps other regions of the image completely unchanged' when the instruction is scoped to the target. — [confirmed](https://qwenlm.github.io/blog/qwen-image-edit/)


**Don't**

- Don't rely on vague pronouns; name the object/text to edit. — [inferred](https://github.com/FurkanGozukara/Stable-Diffusion/wiki/Qwen-Image-Edit-Full-Tutorial-26-Different-Demo-Cases-Prompts-and-Images-Pwns-FLUX-Kontext-Dev)


**Known failures & mitigations**

- identity/pose drift with multiple people → *prefer the 2511 generation (improved multi-person identity/pose consistency) and add preservation language* — [confirmed](https://wavespeed.ai/models/wavespeed-ai/qwen-image/edit-2511-lora)


**Parameter guidance**

- `seed`: -1 (random) or fixed for reproducibility — fixed seed = repeatable framing across re-runs [confirmed](https://wavespeed.ai/models/wavespeed-ai/qwen-image/edit-plus)


**Negative prompt:** not supported — [confirmed](https://wavespeed.ai/models/wavespeed-ai/qwen-image/edit-plus)


---

### `wavespeed-ai/flux-kontext-max`

*Layer file:* `sidecar/app/profiles/research/wavespeed-ai--flux-kontext-max.research.nprofile` · *paradigm:* `instruction` · *version:* `research-2026-07`

*Grammar:* voice **imperative**; ideal length ~60 tokens; structure: change_clause → context_clause → preservation_clause


**Do**

- Use clear action verbs: change, add, remove, replace. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Name subjects explicitly — 'the woman with short black hair', never pronouns like 'her'. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- State what must NOT change with explicit preservation language: 'while maintaining the same facial features, hairstyle, and expression'. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Anchor composition when swapping backgrounds: 'keep the person in the exact same position, scale, and pose'. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Edit text with the exact syntax: Replace '[original text]' with '[new text]'. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Start with a simple edit and iterate; chain small edits rather than stacking many changes in one prompt. — [inferred](https://comfyui-wiki.com/en/tutorial/advanced/image/flux/flux-1-kontext)
- Name the style explicitly for restyles: 'Change to Bauhaus art style while maintaining the original composition and object placement'. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)


**Don't**

- Avoid vague quality asks like 'make it better' — specify the dimension ('change the wall color to blue'). — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Avoid vague pronouns ('it', 'her', 'that thing') — the model needs the subject named. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Don't pack many unrelated edits into one prompt; results degrade — iterate instead. — [inferred](https://www.mimicpc.com/learn/flux-kontext-prompt-guide-how-to-edit-images)


**Known failures & mitigations**

- identity drift on faces across heavy or repeated edits → *add an explicit preservation clause naming facial features/hairstyle/expression and keep edits incremental* — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- composition shifts when the background is changed → *add a context clause pinning position/scale/pose of the subject* — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- small selections can be ignored or repainted coarsely → *expand the send-region padding and restate the object's small scale in the prompt* — [inferred](https://www.mimicpc.com/learn/flux-kontext-prompt-guide-how-to-edit-images)


**Parameter guidance**

- `guidance_scale`: ~2.5 (WaveSpeed default) — higher = stronger prompt adherence but risks oversaturation/artifacts; lower = subtler edits [confirmed](https://wavespeed.ai/docs-api/flux-kontext-dev)
- `num_inference_steps`: ~28 (default); quality plateaus beyond ~40 — more steps = slower with diminishing returns [confirmed](https://wavespeed.ai/docs-api/flux-kontext-dev)


**Negative prompt:** not supported — [confirmed](https://wavespeed.ai/docs-api/flux-kontext-max)

**Documented example prompts**

- “Change the background to a tropical beach with sunset colors while keeping the woman in the exact same position and pose, maintaining her facial features, expression, and clothing details” — [source](https://www.mimicpc.com/learn/flux-kontext-prompt-guide-how-to-edit-images)
- “Change to Bauhaus art style while maintaining the original composition and object placement” — [source](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- “Replace 'OPEN' with 'CLOSED'” — [source](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)


---

### `wavespeed-ai/flux-kontext-pro`

*Layer file:* `sidecar/app/profiles/research/wavespeed-ai--flux-kontext-pro.research.nprofile` · *paradigm:* `instruction` · *version:* `research-2026-07`

*Grammar:* voice **imperative**; ideal length ~60 tokens; structure: change_clause → context_clause → preservation_clause


**Do**

- Use clear action verbs: change, add, remove, replace. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Name subjects explicitly — 'the woman with short black hair', never pronouns like 'her'. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- State what must NOT change with explicit preservation language: 'while maintaining the same facial features, hairstyle, and expression'. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Anchor composition when swapping backgrounds: 'keep the person in the exact same position, scale, and pose'. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Edit text with the exact syntax: Replace '[original text]' with '[new text]'. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Start with a simple edit and iterate; chain small edits rather than stacking many changes in one prompt. — [inferred](https://comfyui-wiki.com/en/tutorial/advanced/image/flux/flux-1-kontext)
- Name the style explicitly for restyles: 'Change to Bauhaus art style while maintaining the original composition and object placement'. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)


**Don't**

- Avoid vague quality asks like 'make it better' — specify the dimension ('change the wall color to blue'). — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Avoid vague pronouns ('it', 'her', 'that thing') — the model needs the subject named. — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- Don't pack many unrelated edits into one prompt; results degrade — iterate instead. — [inferred](https://www.mimicpc.com/learn/flux-kontext-prompt-guide-how-to-edit-images)


**Known failures & mitigations**

- identity drift on faces across heavy or repeated edits → *add an explicit preservation clause naming facial features/hairstyle/expression and keep edits incremental* — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- composition shifts when the background is changed → *add a context clause pinning position/scale/pose of the subject* — [confirmed](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- small selections can be ignored or repainted coarsely → *expand the send-region padding and restate the object's small scale in the prompt* — [inferred](https://www.mimicpc.com/learn/flux-kontext-prompt-guide-how-to-edit-images)


**Parameter guidance**

- `guidance_scale`: ~2.5 (WaveSpeed default) — higher = stronger prompt adherence but risks oversaturation/artifacts; lower = subtler edits [confirmed](https://wavespeed.ai/docs-api/flux-kontext-dev)
- `num_inference_steps`: ~28 (default); quality plateaus beyond ~40 — more steps = slower with diminishing returns [confirmed](https://wavespeed.ai/docs-api/flux-kontext-dev)


**Negative prompt:** not supported — [confirmed](https://wavespeed.ai/docs/docs-api/flux-kontext-pro-multi)

**Documented example prompts**

- “Change the background to a tropical beach with sunset colors while keeping the woman in the exact same position and pose, maintaining her facial features, expression, and clothing details” — [source](https://www.mimicpc.com/learn/flux-kontext-prompt-guide-how-to-edit-images)
- “Change to Bauhaus art style while maintaining the original composition and object placement” — [source](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)
- “Replace 'OPEN' with 'CLOSED'” — [source](https://docs.bfl.ml/guides/prompting_guide_kontext_i2i)


---

### `wavespeed-ai/hidream-e1-full`

*Layer file:* `sidecar/app/profiles/research/wavespeed-ai--hidream-e1-full.research.nprofile` · *paradigm:* `instruction` · *version:* `research-2026-07`

*Grammar:* voice **imperative**; ideal length ~40 tokens; structure: change_clause → preservation_clause


**Do**

- Describe the change (wardrobe, accessories, color tweaks, minor scene adjustments); the model 'keeps the subject and overall composition stable'. — [confirmed](https://wavespeed.ai/docs/docs-api/wavespeed-ai/hidream-e1-full)


**Don't**

- Avoid large structural rewrites — the card scopes it to identity-preserving edits of a single input image. — [inferred](https://wavespeed.ai/docs/docs-api/wavespeed-ai/hidream-e1-full)


**Negative prompt:** not supported — [inferred](https://wavespeed.ai/docs/docs-api/wavespeed-ai/hidream-e1-full)


---

### `wavespeed-ai/hidream-o1-image/edit`

*Layer file:* `sidecar/app/profiles/research/wavespeed-ai--hidream-o1-image--edit.research.nprofile` · *paradigm:* `instruction` · *version:* `research-2026-07`

*Grammar:* voice **imperative**; ideal length ~50 tokens; structure: change_clause → preservation_clause


**Do**

- Source image + a text instruction; produces high-resolution edits up to 2K (unified native editing model). — [confirmed](https://wavespeed.ai/models/wavespeed-ai/hidream-o1-image/edit)


**Negative prompt:** not supported — [inferred](https://wavespeed.ai/models/wavespeed-ai/hidream-o1-image/edit)


---

### `wavespeed-ai/qwen-image/edit-2511-lora`

*Layer file:* `sidecar/app/profiles/research/wavespeed-ai--qwen-image--edit-2511-lora.research.nprofile` · *paradigm:* `instruction` · *version:* `research-2026-07`

*Grammar:* voice **imperative**; ideal length ~50 tokens; structure: change_clause → preservation_clause


**Do**

- For text edits, state the exact target text; Qwen-Image-Edit does bilingual (EN/ZH) text add/delete/modify while preserving font, size, and style. — [confirmed](https://qwenlm.github.io/blog/qwen-image-edit/)
- Quote the exact strings to change — tutorials consistently use quoted replacements for reliable text edits. — [inferred](https://github.com/FurkanGozukara/Stable-Diffusion/wiki/Qwen-Image-Edit-Full-Tutorial-26-Different-Demo-Cases-Prompts-and-Images-Pwns-FLUX-Kontext-Dev)
- Use plain imperative instructions; the model supports both appearance edits (add/remove/modify elements) and semantic edits (style transfer, object rotation, IP re-creation). — [confirmed](https://qwenlm.github.io/blog/qwen-image-edit/)
- Chain small edits progressively for corrections instead of one big prompt (official chained-editing examples). — [confirmed](https://qwenlm.github.io/blog/qwen-image-edit/)
- State what to keep — appearance editing 'keeps other regions of the image completely unchanged' when the instruction is scoped to the target. — [confirmed](https://qwenlm.github.io/blog/qwen-image-edit/)


**Don't**

- Don't rely on vague pronouns; name the object/text to edit. — [inferred](https://github.com/FurkanGozukara/Stable-Diffusion/wiki/Qwen-Image-Edit-Full-Tutorial-26-Different-Demo-Cases-Prompts-and-Images-Pwns-FLUX-Kontext-Dev)


**Known failures & mitigations**

- identity/pose drift with multiple people → *prefer the 2511 generation (improved multi-person identity/pose consistency) and add preservation language* — [confirmed](https://wavespeed.ai/models/wavespeed-ai/qwen-image/edit-2511-lora)


**Parameter guidance**

- `seed`: -1 (random) or fixed for reproducibility — fixed seed = repeatable framing across re-runs [confirmed](https://wavespeed.ai/models/wavespeed-ai/qwen-image/edit-2511-lora)


**Negative prompt:** not supported — [confirmed](https://wavespeed.ai/models/wavespeed-ai/qwen-image/edit-2511-lora)


---

### `wavespeed-ai/step1x-edit`

*Layer file:* `sidecar/app/profiles/research/wavespeed-ai--step1x-edit.research.nprofile` · *paradigm:* `instruction` · *version:* `research-2026-07`

*Grammar:* voice **imperative**; ideal length ~40 tokens; structure: change_clause


**Do**

- Use simple, direct instructions — the card positions it as 'professional-quality edits using simple instructions'. — [confirmed](https://wavespeed.ai/models/wavespeed-ai/step1x-edit)


**Negative prompt:** not supported — [inferred](https://wavespeed.ai/models/wavespeed-ai/step1x-edit)


---

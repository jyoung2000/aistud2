# Magic Brush audit (M0)

Audit before building the Magic Brush + Eraser (scribble selection). **No code changed.** Good
news up front: the SAM 2 sidecar already does encode-once/query-many, so the "make it responsive"
work M4 warns about is largely already in place.

## SAM 2 sidecar — location, contract, embedding cache

- **Sidecar model:** `sidecar/app/select_sam.py` → `SmartSelector`. **Endpoint:** `/select` in
  `sidecar/app/main.py`. **Client:** `frontend/src/api/select.ts` → `smartSelect(id, points, box, opts)`.
- **Request** (`SelectIn`, image space): `{ id, points:[[x,y],…], labels:[1|0,…], box:[x0,y0,x1,y1]|null,
  subject:bool, semantic:str|null }`. **Response:** `{ mask_png(base64 grayscale), width, height, backend, note }`.
- **Encode once? YES.** `set_image(rgb, image_id)` calls `predictor.set_image(rgb)` **only when
  `_embedded_for_id != image_id`** (`select_sam.py:57-62`). Repeated `/select` calls on the same
  image reuse the cached SAM embedding — **no re-encode per call.** This *is* the encode-once /
  query-many pattern M4 asks for, already implemented at the whole-image level.
- **Scope:** SAM runs on the **full image** (`session.rgb`), not a crop. So brush prompts anywhere
  query the same cached full-image embedding — we do **not** need a per-crop embedding (simplifies M4;
  drop the "keyed by crop id / evict on crop change" plan — key by `image_id`, which `/load` already does).
- **Pos/neg point prompts:** ✅ fully wired (`points` + `labels` 1/0 → `predictor.predict(point_coords,
  point_labels, box, multimask_output=True)`, best-by-score). This is exactly what the brush needs.
- **Low-res mask prompt:** ❌ **not exposed.** `predict(...)` is never passed `mask_input`, so the
  accumulated positive-hint mask can't (yet) be sent as a mask prompt. **Gap** — points-only works for
  M4; adding `mask_input` is an optional refinement (§ "gaps").
- **CPU fallback:** no GPU → flood-fill / GrabCut (`_select_fallback`). AI mode degrades to these on the
  headless box; the **Local** engine is the real offline path.
- **Refine:** `/refine` (`RefineIn {id, mask_png}`) → BiRefNet on target, morphological feather fallback.
  Client `refineMask(id, mask, w, h)`. Ready to reuse for "Refine edges on commit" (M5).

## Existing brush / cursor / options UI

- **No brush tool and no round brush cursor exist.** There's a coordinate readout (`cursor`/`setCursor`)
  and SAM point markers drawn on the Konva `Layer`; both must be joined by a new brush ring + a faint
  hint overlay. The cursor ring must be drawn at `brushSize × t.scale` screen px (image-space size).
- **Options bar** = `SelectBar` (in `canvasStage.tsx`) — currently hosts wand tolerance/contiguous +
  one-click Subject + semantic text. The Magic-Brush options row (size/mode/snap/refine/feather/…) slots
  in here, gated on `tool === "magic-brush"`, same as the wand row is gated on `tool === "wand"`.
- **Tool rail** = `ZoomBar` tool group (Move/Select/Lasso/Pen/Hand). Add `magic-brush` there; wire
  `Shift+W` to cycle Magic Wand ↔ Magic Brush (wand isn't currently on the rail — it's reached via a
  SelectBar button; grouping them under one rail slot + Shift+W matches PS).

## Shared commit pipeline — "give me a mask, apply an op"

- There is **no single named commit function** yet. The pattern is inlined in every tool:
  `pushHistory(); const next = mask.clone(); next.apply(incoming, op); setMask(next);` — see `commitLasso`,
  `magicWand`, and the SAM `runSelect` (which *replaces* rather than boolean-composites).
- `MaskBuffer.apply(incoming, op)` is the boolean core, but it **binarizes** (1-bit). **Anti-alias and
  feather do not exist yet** — they're the lasso overhaul's M5 (fractional-alpha channel), still pending.
- **Recommendation:** extract a `commitMask(incoming, op, {antialias, feather})` helper in `canvasStage`
  (or `maskBuffer`) and route BOTH the brush and the lassos through it. Until the fractional-alpha work
  lands, the brush commits 1-bit like the others; when lasso-M5 adds AA/feather to that one helper, the
  brush inherits it for free (satisfies invariant #3).

## Gaps vs. the build plan

| Plan item | Status | Note |
|---|---|---|
| SAM encode-once / query-many | ✅ already | keyed by `image_id`, full-image; per-crop embedding unnecessary |
| Pos/neg point prompts | ✅ already | `points`+`labels` |
| Low-res **mask prompt** input | ❌ missing | add `mask_input` passthrough to `predict` for M4 (optional; points suffice) |
| Debounce/throttle brush queries | ❌ missing | client-side; add in M4 |
| Named shared commit helper (AA/feather) | ⚠️ inlined, 1-bit | extract `commitMask`; AA/feather come with lasso-M5 |
| Brush tool / round cursor / hint overlay | ❌ missing | build in M1–M2 |
| Local edge-grow engine | ❌ missing | build in M3 (a gradient/region-grow like `livewire` cost map) |
| BiRefNet refine-on-commit toggle | ✅ endpoint ready | wire toggle in M5 via `refineMask` |

## Verdict

SAM 2 contract does **not** differ materially — it's better than assumed (embedding already cached).
Proceed to Phase B. Adjusted plan deltas:
- **M4** keys the embedding by `image_id` (already done) instead of a new per-crop cache; just add
  client debounce/throttle + optional `mask_input` passthrough.
- **Commit** routes through a new shared `commitMask` helper; fractional AA/feather is shared with the
  lasso overhaul's pending M5 (brush is 1-bit until then, then inherits it).
- Everything else (tool, shared size, cursor ring, hint buffers, Off/Local/AI engines, refine toggle)
  is net-new UI/logic layered on the existing mask + `/select` + `/refine` primitives.

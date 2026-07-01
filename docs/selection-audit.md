# Selection audit (M0)

Diagnostic audit of the current selection pipeline before the Photoshop-parity lasso overhaul +
Magic Wand. **No behavior was changed to produce this report.** Architecture matches Section 0 of
the build prompt (two coordinate spaces; one shared mask + boolean commit), so the plan is to
extend, not rewrite.

## File map — who owns what

| Piece | File | Notes |
|---|---|---|
| Screen ↔ image transforms | `frontend/src/canvas/coords.ts` | `screenToImage` / `imageToScreen` / `zoomAtPoint` / `fitTransform`. Sound. |
| Shared mask + boolean ops | `frontend/src/canvas/maskBuffer.ts` | `MaskBuffer` is **1-bit (0/255)**. `opFromModifiers`, `apply` (binarizes incoming), `invert/grow/shrink/smooth/bbox/outline/toRGBA`. **No fractional alpha, no feather.** |
| Polygon rasterize + geom | `frontend/src/canvas/lasso.ts` | `rasterizePolygon` (canvas `fill("evenodd")` → hard `alpha>127`), `dist`, `constrain45`, `flatten`. |
| Magnetic live-wire | `frontend/src/canvas/livewire.ts` | `LiveWire`: cached single-source Dijkstra in `setSeed`, `pathTo` backtrace. `windowRadius` = Width. Grid may be downscaled (`scale`). |
| Tool state machines + handlers + options bar + keyboard | `frontend/src/canvas/canvasStage.tsx` | `onMouseDown/Move/endDrag`, `lassoClick`, `commitLasso`, `cancelLasso`, `magicWand`, `SelectBar`/`ZoomBar`, key handler. |
| Cost map | sidecar `/livewire/costmap` (`fetchCostMap`) | Sobel magnitude + Laplacian zero-crossing → per-pixel cost. Accepts a contrast arg (currently hardcoded `1.0`). |

## Per-variant behavior (today)

- **Freehand** (`lassoMode==="free"`): mousedown seeds a point; mousemove appends a point when it's
  moved `> 2/scale` image px from the last; mouseup appends the release point and commits (rasterize
  closes the loop). Modifier op captured at mousedown.
- **Polygonal** (`"poly"`): click appends anchors; a rubber-band preview line to the cursor renders;
  Shift constrains the *placed* anchor to 45°; Backspace pops the last; Enter or click-near-origin
  closes; Esc cancels.
- **Magnetic** (`"magnetic"`): first click seeds the live-wire (`setSeed`); each move backtraces
  `pathTo(cursor)` for a preview; a click commits that segment and re-seeds from the new point;
  `[`/`]` change `windowRadius`; Backspace removes the last fastening point and re-seeds the prior;
  Enter/near-origin close; Esc cancels.

## Defect checklist

### Coordinate correctness
- ✅ **Vertices stored in image space** — every handler converts via `screenToImage(p, t)` before
  storing (`canvasStage.tsx:678,712,735,824`); live-wire returns image-space in `pathTo`.
- ✅ **Pixel-aligned across zoom** — thresholds use `2 / t.scale`; no raw pointer coords are stored.

### Freehand lasso
- ✅ **Auto-closes on mouse-up** — `endDrag` → `commitLasso([...lassoPts, ip])`; rasterize closes.
- ⚠️ **Distance-thresholded but NOT interpolated** (`:712`) — a fast flick jumps straight between
  samples (no sub-sampling along the segment). Threshold is `2px` screen, spec wants `1.5px` scaled.
- ❌ **Alt mid-drag → polygonal straight-segment** — not implemented.
- ⚠️ **Douglas–Peucker pre-commit simplification** — absent.

### Polygonal lasso
- ✅ Click places anchors, straight segments (`:810-814`).
- ✅ Rubber-band preview to cursor (`lassoDraw`, `:406`).
- ⚠️ **Shift 45°** — applied to the *placed* anchor only; the live rubber-band preview is **not**
  drawn constrained, so it doesn't match what will be placed.
- ✅ Backspace removes last anchor (`:349`).
- ⚠️ **Close gestures** — click-origin ✅, Enter ✅, **double-click ❌** (no dblclick handler).
- ✅ Esc cancels (`:354`).
- ❌ **Alt-drag mid-gesture → freehand** — not implemented.

### Magnetic lasso
- ✅ **Cached path map + per-move backtrace** — `setSeed` solves once, `pathTo` backtraces; **no**
  per-move re-solve (`livewire.ts:76,118`).
- ⚠️ **Width** — exists as `windowRadius`, but **not exposed as a numeric option** in the bar.
- ❌ **Contrast** — `fetchCostMap(imageId, 1.0)` hardcodes contrast; no option.
- ❌ **Frequency / auto-fastening** — only manual clicks drop anchors; no distance-based auto-drop.
- ✅ `[` / `]` change Width live and re-seed (`:356`).
- ✅ Manual click adds a fastening point; Backspace removes last + restores prior map (`:349-353`).
- ⚠️ Close/cancel same as polygonal (so also missing double-click).

### Commit / edge quality (all lassos)
- ✅ **Boolean op from gesture-start modifiers** (`lassoOp.current`, `:679,807`).
- ❌ **Anti-alias** — `rasterizePolygon` hard-thresholds; `MaskBuffer.apply` binarizes. No sub-pixel.
- ❌ **Feather** — none. Mask is strictly 1-bit end to end.
- ✅ **Even-odd fill** — `ctx.fill("evenodd")` (`lasso.ts:17`).

### Magic Wand (already partially present as tool `wand`)
- ⚠️ Not on the tool rail / no **W** shortcut — reachable only via a SelectBar "Magic wand" button.
- ❌ **Metric** — uses **Euclidean** RGB distance (`Math.hypot`, `:962`); PS uses **max per-channel**.
- ❌ **Tolerance range** — `0.01–0.6` fraction, not `0–255` (default 32).
- ❌ **Sample Size** — point-sample only; no N×N average.
- ✅ **Contiguous** flood (4-conn) ✅ / **global** ✅ — but pixel-stack, not span/scanline.
- ❌ **Anti-alias** — hard edge only.
- ⚠️ **Sample All Layers** — samples cached base pixels (`imgPx`), not the composite; no toggle.

### Cross-tool (Section 4)
- ✅ Invert — `Cmd/Ctrl+Shift+I`. ❌ **Deselect `Cmd/Ctrl+D`**. ❌ **Select-All `Cmd/Ctrl+A`**.
- ❌ Add/Subtract/Intersect cursor **badge** (`+`/`−`/`×`).
- ⚠️ Marching-ants outline traces pixel corners (`outline()`); fine at 1-bit, will need to read the
  binary layer of the fractional mask once anti-alias lands.

## Biggest structural gap → drives the plan

The mask is **1-bit**. Anti-alias (M5) and Feather (M5) and wand AA (M6) all need a **fractional
alpha** selection channel. Plan: give `MaskBuffer` an optional `alpha: Uint8Array` (0–255 coverage)
alongside the binary `data`; `apply` composites fractional coverage per boolean op (add=max,
subtract=a·(1−b), intersect=min, replace=b); `outline()`/`bbox()` read `data = alpha>127`. All three
lassos + the wand feed one commit pipeline: rasterize→AA supersample→feather Gaussian→boolean apply.

## Verdict
Architecture is consistent with Section 0 — no rewrite. Work items, by milestone:
- **M1** coordinate correctness: already ✅; add the `1.5/scale` threshold + interpolation hook.
- **M2** polygonal: live 45° preview, double-click close, Alt→freehand.
- **M3** freehand: interpolation, Alt→polygonal, DP simplify.
- **M4** magnetic: Width/Contrast/Frequency options + auto-fastening (contrast → cost map).
- **M5** fractional mask + AA + feather shared commit pipeline.
- **M6** Magic Wand PS-parity (max-channel metric, tolerance 0–255, sample size, span flood, AA, W key).
- **M7** boolean modifiers polish + `Cmd+D`/`Cmd+A` + cursor badges.

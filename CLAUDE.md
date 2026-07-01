# Neuclip Studio — Build Contract & Decisions

> AI-assisted "Photoshop": open an image, select any element (SAM 2 / lasso / editable
> manual pen), refine the edge, then send **only the selected crop** to a WaveSpeed
> image-to-image model to edit/replace/restyle it while the rest of the image stays
> byte-for-byte untouched. A per-model prompt-profile system researches each model once
> and synthesizes a model-tuned prompt grounded in the actual image.

**App name:** "Neuclip Studio" — single renameable constant (`APP_NAME`).
Frontend: `frontend/src/constants.ts`. Sidecar: `sidecar/app/constants.py`.

## Architecture
- **Rust / Tauri 2.x** (`src-tauri/`) — native window + packaging; spawns/health-checks/
  shuts down the Python sidecar (no orphans).
- **Python / FastAPI sidecar** (`sidecar/`) — ALL ML (SAM 2, BiRefNet, live-wire cost map,
  compositing, WaveSpeed client, prompt agent).
- **React + Vite + Konva** (`frontend/`) — runs in the Tauri webview.

## Target / build environment (IMPORTANT)
- **Target machine:** user's desktop, **NVIDIA RTX 4070 (12 GB), CUDA**. This is where
  GPU + desktop-window checkpoints are verified.
- **This build container:** headless Ubuntu 24.04, **no GPU, no display**. Used to author
  code and verify the CPU-verifiable paths (sidecar boots, `/health`, frontend builds,
  Rust compiles). All ML code MUST detect CUDA and fall back to CPU so it runs anywhere.
- Python **3.11**. Node LTS. Rust stable. Tauri 2.x.
- Secrets (`WAVESPEED_API_KEY`, `ANTHROPIC_API_KEY`) come from the settings screen / OS
  keychain with a local-config fallback. **Never hardcode.** `.env.example` is shipped.

## Cross-cutting contracts (honor in EVERY phase)
1. **Two coordinate spaces, never conflated.** *View space* = Konva `Stage` transform
   (scale/position); zoom/pan touch ONLY this and are non-destructive. *Image space* =
   original pixel grid; every selection artifact (SAM points, lasso vertices, manual
   anchors, live-wire path, mask buffer) is stored in image-space. `screenToImage` /
   `imageToScreen` in `frontend/src/canvas/coords.ts`. Same pixel → identical image-space
   coord at any zoom.
2. **One shared mask buffer + boolean ops.** All select tools write a single image-space
   mask via a modifier-chosen op: none = **replace**, Shift = **add**, Alt = **subtract**,
   Shift+Alt = **intersect**. Marching ants, edge-refine, crop-bbox, cost card all read
   this one buffer. (`frontend/src/canvas/maskBuffer.ts`)
3. **Crop-only send.** Generation ALWAYS sends a padded crop of the selection, never the
   full frame. Composite the result back through the feathered alpha; untouched pixels
   stay bit-identical. (`sidecar/app/compose.py`)
4. **Async everything.** Encode, matting, live-wire, polling, LLM calls never block UI.
5. **Color logic.** Cyan = everything *selection*; amber = everything *AI-generation*.
6. **Don't guess WaveSpeed slugs/schemas.** Pull each model's exact endpoint path + input
   schema from its model-card "API" tab; encode it in that adapter. Confirmed pattern:
   `POST https://api.wavespeed.ai/api/v3/wavespeed-ai/{slug}` with
   `Authorization: Bearer <key>` → prediction id → poll until `status=="completed"` →
   read `data.outputs[0]`. Confirmed slug: `wavespeed-ai/qwen-image/edit-2511`.
7. **Imported prompt profiles are untrusted data** (see Phase 8 safety).

## Reference roles (Edit pipeline — replace / pose / style)
A reference image has a **role**, and each role wires up differently. Adding a future role
must be just another table entry.
- **replace** — place the reference's subject into the selection (character/object swap).
  No preprocess; raw reference is the subject source. Crop = tight selection bbox + pad.
- **pose** — keep the original subject's identity, change only pose to match the reference
  (ControlNet-style). Preprocess = DWpose/OpenPose skeleton (the control image). Crop MUST
  expand to the subject's **full extent** (full-body bbox) — a tight crop breaks pose.
- **style** *(bonus)* — adopt the reference's look/palette, keep original content. No
  structural preprocess. Crop = region as selected.
- Registry per model (pulled from its card, contract #6): `reference_roles: [...]` and
  `reference_inputs: { pose: "controlnet"|"multi_image", ... }` (how the ref is attached).
  Replaces the old boolean `needs_reference_image`. Role toggle offers only supported
  roles; picking an unsupported role surfaces a "switch to {model}" suggestion (no silent
  fail). Confirmed-capable: Qwen-Image-Edit-Plus (replace+pose), Ideogram Character
  (replace), Z-Image-Turbo ControlNet (pose).
- `.nprofile` gains `reference_roles`, `reference_inputs`, per-role templates + default
  strengths (untrusted-data rules apply; machine-introspected caps win over imports).
- UI is **amber** (AI-side). Frontend: `panels/referenceBlock.tsx` (controlled component,
  role-agnostic `ReferenceState`), hosted by `panels/inspectorPipeline.tsx`. Stub model
  caps in `api/referenceModels.ts` until the real registry lands (Phase 7 / M2).
- Reference-feature milestones: [x] M1 UI (stubbed) · [x] M2 routing · [x] M3 reference/pose
  → generate e2e · [x] M4 pose preprocess+transfer (Pose Editor) · [ ] M5 profiles+style.
  (Builds on Phases 6–8.)
  M2: role toggle dims unsupported roles; picking one shows a "switch to {model}" notice
  (`SwitchNotice` → `findModelForRole`) that re-targets the active/primary model and carries
  the reference image + role across; models with no `reference_roles` show a "no reference"
  note instead of the toggle.
  M3: the inspector (model + reference/pose + control_strength + LoRAs) publishes to a shared
  external store `state/genConfig.ts`; the canvas `generateNow` reads it and sends
  `model_slug`/`reference_png`/`reference_role`/`params.control_strength`/`loras`, then pushes an
  ai-edit layer carrying `source.reference` + `source.pose`. The Generate bar shows the active
  model + reference/LoRA readout. (Inspector and canvas are App.tsx siblings with no shared
  ancestor — the store is the bridge.) Verified e2e: load→generate(pose ref+strength)→poll
  composites; no key → mock path, key → real model via the same call.

## Multi-model compare ("shootout")
Run one edit across 2..N models at once, each prompted from its own research profile, then
compare and keep the best. **Fairness contract — hold identical across every model in a
run:** same selection mask, same reference image + role, same intent text, and the **same
send region computed as the union of what each model needs** (a pose model needs the full
subject, an inpaint model a tight crop → send a region sufficient for all). The ONLY
variables are the model + its independently-synthesized tuned prompt. **Seed caveat:** lock
a seed per model for re-runs, but seeds are NOT comparable across architectures — say so in
the UI ("seeds locked per model for re-runs; not comparable across models").
- Compare mode adds `comparisonSet: string[]` to app state; cap at `MAX_COMPARE` (6).
  Comparison is intentional spend — the cost card always shows the aggregate + per-model
  breakdown + quick deselect.
- Fan out N jobs concurrently; each has its own poll loop, latency, cost, error handling.
  Partial failure is normal (a failed tile shows reason + retry, never blocks the rest).
  Composite each result through the shared feathered alpha so every tile previews finished.
- Pick a winner → composite into canvas + history, save the "shootout" group, and append
  `(intent → winning prompt)` to the winning model's `exemplars` (user layer) to improve
  future synthesis. Optional advisory vision judge (toggle) ranks intent-adherence +
  unselected-region integrity; human always picks.
- `ShootoutRun` shape:
  ```ts
  type ShootoutRun = {
    id: string;
    input: { maskId: string; intent: string; reference?: RefSpec;
             sendRegion: [number, number, number, number] };
    jobs: { slug: string; paradigm: string; prompt: string; ruleNote?: string;
            status: 'synth' | 'polling' | 'done' | 'failed';
            predictionId?: string; latencyMs?: number; costCents?: number;
            resultUrl?: string; score?: number; error?: string }[];
    winner?: string; // slug
  };
  ```
- Frontend: `panels/modelCompare.tsx` (set selection + chips + cost card),
  `panels/inspectorPipeline.tsx` hosts the COMPARE toggle. Paradigm/cost stubbed in
  `api/referenceModels.ts` until the real registry (Phase 7).
- Shootout milestones: [x] M1 compare-set UI · [x] M2 N-prompt synthesis · [ ] M3 parallel
  run+queue · [ ] M4 comparison view · [ ] M5 commit+feedback · [ ] M6 auto-rank.
  M2: one shared intent (+ optional subject + shared reference role) → one tuned prompt per
  model via `api/promptSynthesis.ts` `synthesize()` (paradigm transform: instruction =
  imperative+preservation, inpaint = result-description, controlnet = identity+control,
  reference = identity+ref-slot), each annotated with the rule that fired. UI:
  `panels/tunedPrompts.tsx` in the COMPARE pane. STUB synthesis — real vision-grounded
  version is the sidecar `profiles/synth.py` (Phase 8); signature kept stable for the swap.

## Pose Editor (manual skeleton workspace)
A dedicated view for hand-editing a pose skeleton so the pose model gets the most accurate
control signal — the **edited** rig, not the raw extraction, becomes the control image.
- **Model** (`frontend/src/pose/poseModel.ts` ↔ `sidecar/app/pose.py`): `Pose { figures[] }`,
  `Figure { id, keypoints[], bones[], limbOrder, transform }`, `Keypoint { id, x, y, visible,
  confidence, group:'body'|'face'|'handL'|'handR' }`. COCO-18 OpenPose body topology; keypoints
  are **image-space** (contract #1). `limbOrder` = per-limb depth index (higher = further back,
  drawn first) — the fix for 2D skeletons losing depth (a hand meant to be *behind* the torso).
- **Extraction** (`sidecar/app/pose.py`): DWpose on the 4070 (`NEUCLIP_DWPOSE`, controlnet_aux),
  **mannequin A-pose fallback** everywhere (flagged confidence 0 so the UI marks every joint
  "verify"). `render_control_image` draws the OpenPose colored skeleton on black, back→front by
  `limbOrder` (cv2 ellipse limbs, numpy fallback) — the exact control image the pose adapters use.
- **Endpoints:** `/pose/extract` (active image), `/pose/extract_upload` (external reference
  image), `/pose/render` (control image), `/pose/library` GET/POST/remove (`pose_library.py` →
  `poses.json`).
- **Editor** (`frontend/src/pose/PoseEditor.tsx`, amber/AI-side, OpenPose rig colors): rig over a
  dimmable **ghost** image (accurate posing); zoom/pan via `coords.ts`. Full editing: drag joints,
  group on/off, whole-rig translate/scale/rotate + **mirror** (reflects about centre, double-
  mirror = identity), arrow-nudge, joint inspector (mono coords + confidence, low-conf flag),
  editor-scoped undo/redo. Accuracy helpers: **bone-length lock** (PBD distance solve — limbs hold
  rest length while a joint drags), **depth forward/back** (per-limb `limbOrder`), **symmetry**
  edit (L↔R), **onion-skin** of the original pose. Multi-figure (add/dup/delete, blank rig, pose
  library, load-external-image→extract). Pure ops esbuild-validated.
- **Wiring:** reachable from the reference **Match pose** role (`panels/referenceBlock.tsx`
  `PosePanel`): extract from the dropped reference image (or blank rig) → hand-edit → `renderControlImage`
  → stored on `ReferenceState.pose` + `controlImage`; `poseStrength` → `control_strength` reaches
  the pose ControlNet adapter (qwen_edit/generic passthrough). `LayerSource.pose` carries the rig
  for re-editing. (The reference→canvas generate join is reference-milestone M3; the editor already
  produces exactly the control image + strength that path consumes.)
- Pose Editor milestones: [x] P1 model+extract+render · [x] P2 view (ghost/rig/zoom-pan) · [x] P3
  manual editing+inspector+undo · [x] P4 accuracy (bone-lock/depth/symmetry/onion) · [x] P5 multi-
  figure+blank+library · [x] P6 output wiring (control image + strength + layer source).

## Launching / packaging
- **Easy path — single-file app (DEFAULT consumer artifact):** one self-contained binary
  that bundles the FastAPI sidecar + the built web UI; on launch it serves the UI and opens
  the browser. NO Python/Node/Rust/Tauri for the end user, no compile step. Entry:
  `sidecar/app/desktop.py` → `main.serve_app()`; UI located via `_ui_dir()` (frozen:
  `sys._MEIPASS/web`, dev: `frontend/dist`) and mounted at `/`. Built by `sidecar/
  build_app.py` (PyInstaller `--onefile --windowed`, `--add-data dist:web`). CI: `.github/
  workflows/app.yml` builds Win/macOS(arm+intel)/Linux on tag push → draft Release. The
  frontend uses same-origin requests in production (`api/sidecar.ts` `baseUrl()` returns
  "" unless Tauri or vite-dev).
- **GPU build (NVIDIA — CUDA on double-click):** `build_app.py --gpu` bundles CUDA PyTorch so
  the double-clicked app uses the GPU with no install/first-run download. It's `--onedir` (a
  ~4–5 GB folder — an onefile would re-extract gigabytes to temp each launch) and `--collect-all`
  torch/torchvision + the `nvidia-*` CUDA runtime wheels; guarded by `_verify_cuda_torch()`
  (refuses to build against CPU-only torch). Artifact: `Neuclip Studio GPU/`. CI job
  `build-gpu-windows` in `app.yml` installs the cu124 wheel then builds it →
  `Neuclip-Studio-Windows-GPU.zip`. Torch-free `app/gpu_probe.py` (nvidia-smi / driver-lib) feeds
  `device.detect_device()` a `gpu_present` flag so the small CPU build detects an idle NVIDIA GPU
  and tells the user (Settings + onboarding) to grab the GPU build. `/health` exposes `gpu_present`.
- **Polished native (optional, later):** `tauri build` → `.msi`/`.dmg`/AppImage via
  `.github/workflows/release.yml` (manual dispatch — compiles Rust). The native shell uses
  the externalBin sidecar + `sidecar_port` handshake.
- **Dev-from-source launchers (`launchers/`, advanced):** `Start Neuclip Studio.command` /
  `.bat` auto-install toolchains and run the Tauri dev GUI. De-emphasized vs the easy path.

## Sidecar API surface (target)
`/health` `/settings` `/load` `/select` `/refine` `/livewire/costmap` `/generate` `/poll`
- **`/settings` (IMPLEMENTED):** `GET` returns non-secret status (which keys are set, source
  config|env, masked `…last4` hint, config path); `POST` saves keys. Secrets stored in
  `~/.neuclip/config.json` (override `NEUCLIP_CONFIG_DIR`), chmod 600, never returned raw.
  Resolve order per secret: config file → env var (`WAVESPEED_API_KEY`/`ANTHROPIC_API_KEY`)
  → unset (`sidecar/app/settings.py`). Frontend: `panels/settingsModal.tsx` (⚙ in header),
  `api/settings.ts`. The Settings screen also shows the compute device + a CPU/GPU note.
- **`/models` (IMPLEMENTED — live catalog):** returns the **curated static models** (confirmed
  slugs + hand-tuned adapters) PLUS the **latest image-to-image + image-to-image-LoRA models
  pulled live from the WaveSpeed catalog** (`GET https://api.wavespeed.ai/api/v3/models`, Bearer
  auth) — contract #6 is honored because slug + schema come FROM the card, not guessed.
  `sidecar/app/models/catalog.py` filters by type/schema (input image → image output; excludes
  video/audio/3d), detects LoRA support + `max_loras` from the model's own `api_schema`, caches
  15 min (`?refresh=true` bypasses). Dynamic models carry `dynamic:true` + `api_schema`; the
  schema-driven **generic adapter** (`adapters/generic.py`) builds their request, and
  `wavespeed.submit` accepts full provider paths (`{provider}/{model}`) as well as bare
  `wavespeed-ai` slugs. `/models` response: `{ models, dynamic_count, dynamic_error, has_key }`.
  Never breaks on a catalog hiccup — falls back to the static set with an error string. Frontend
  `api/referenceModels.ts` `loadModels(force?)` + `modelsMeta()`; ⚙ Settings shows a
  "Refresh model list" + live count.

## First-run onboarding (IMPLEMENTED)
- `frontend/src/panels/onboarding.tsx` — a stepped overlay shown once on first launch (gated by
  `localStorage` `neuclip.onboarded.v2`, mounted from `App.tsx` after the sidecar connects).
  Steps: welcome → **API keys** (WaveSpeed + Anthropic, `Save & test connection` runs
  `loadModels(true)` and reports the live-model count / error / device) → 5-card **UI walkthrough**
  (open+auto-separate, select tools + cyan-ants/boolean-ops, amber inspector + crop-only send,
  compare/shootout, layers + Move tool + export) → done. Re-openable via ⚙ Settings ▸ **Show
  walkthrough**. Cyan=selection / amber=AI messaging is reinforced throughout.

## Sidecar <-> Tauri handshake (Phase 0, IMPLEMENTED)
- Sidecar binds a port: tries `NEUCLIP_SIDECAR_PORT` (default 8756); on conflict it
  increments and, once bound, **prints `NEUCLIP_SIDECAR_PORT=<port>` to stdout** so the
  Rust parent can discover it (fixed-with-fallback + sidecar-prints-port).
- Rust spawns the sidecar as a Tauri `externalBin`, reads stdout for the port line, polls
  `GET /health` until ready, exposes the port to the frontend via a Tauri command
  (`sidecar_port`), and **kills the child on window close** (no orphans).
- `/health` returns `{ status, app, device, gpu_name, cuda, torch }`.

## Conventions / decisions log
- **Device selection** (`sidecar/app/device.py`): `cuda` if `torch.cuda.is_available()`
  else `cpu`. `gpu_name` from `torch.cuda.get_device_name(0)` when present. torch is
  treated as an OPTIONAL import in Phase 0 so `/health` works even before the heavy ML
  stack is installed (reports `torch: false`).
- **Status bar badge** shows the real device reported by `/health` (e.g. "RTX 4070" on
  target, "CPU" in the headless container) — never hardcoded.
- Ports/paths/secrets via env with sane fallbacks; nothing hardcoded.

## Two selections — never conflate (auto-layer feature)
- **Pixel selection** — a mask in the shared buffer, shown as **cyan marching ants**, made by
  the *selection tools* (SAM/lasso/box/pen/wand). Defines *where an edit applies*.
- **Layer selection** — which layers are active (`selectedLayerIds`), made by the **Move tool**,
  shown as a **solid bounding box + transform handles** (NEVER cyan ants). Defines *what you
  move/toggle/transform*. The Move-tool drag-marquee selects **layers** by `bounds` intersection
  — a different gesture/outcome from the selection tools' box-select that writes a mask.

## Auto-layer model additions (`canvas/document.ts`)
- `Layer.bounds:[x,y,w,h]` (image space, `boundsFromMask`/`layerBounds`) for marquee hit-testing;
  `Layer.transform:{tx,ty,scale,rotation}` applied at composite around the bounds centre
  (non-destructive — base/layer pixels never mutated, only the draw is transformed);
  `Layer.locked`, `Layer.groupId`. `Document.groups: LayerGroup[]` (name, collapsed, layerIds).
- **Auto-decompose** (`/decompose`, `select_sam.decompose`): Grounding-DINO + SAM 2 instances
  on target (Person 1/2, Background, objects at fine granularity); CPU fallback = GrabCut
  subject + background. Each region BiRefNet-refined, named, bounded. Frontend builds
  `kind:'decomposed'` layers (mask = region, pixels = base clipped to mask) bottom-up
  (Background first). When decomposed, `composite(..., {drawBase:false})` — the base image is
  NOT drawn; layers reconstruct it, so hiding a subject reveals an honest transparent hole
  (occlusion fill = P6). Auto-runs on open + manual "Auto-separate" (FileBar); an editable
  proposal, not a final cutout.
- **Move tool** (`V`, `canvasStage`): click selects the topmost visible layer whose
  (transformed) mask is hit (`pointHitsLayer`), Shift-click toggles; drag translates all
  selected (`transform.tx/ty`), corner handles scale; selection shown as a **solid white box +
  square handles** (NEVER cyan ants). **Marquee** from empty space selects layers whose
  `transformedBounds` intersect (`rectsIntersect`; hidden/locked/adjustment excluded;
  Shift+drag adds). `selectedLayerIds` is the shared state — panel rows highlight white and a
  row click (Shift=range, Cmd/Ctrl=add) drives the same set (`selectLayerRow`). Helpers in
  `document.ts`: forward/inverse point, transformedBounds, unionBounds, rectsIntersect.
- Auto-layer milestones: [x] P1 model (bounds/transform/groups) · [x] P2 auto-decompose ·
  [x] P3 Move tool · [x] P4 drag-to-select layers · [x] P5 multi-layer ops · [x] P6 fill-behind.
- P6 occlusion fill: `/fill_behind` inpaints the Background's subject-shaped hole (FLUX Fill
  on target; Telea mock — dilates the hole, reconstructs background). Per-subject-layer
  "fill ⤓" action updates the Background layer's pixels + expands its mask over the hole, so
  hiding/moving the subject leaves no hole. Until filled, a **checkerboard** renders behind
  the composite when decomposed so holes are shown honestly. In-panel caveat: auto-decompose
  + fill are AI estimates to refine, not perfect cutouts.
- P5 multi-layer ops: eye toggle affects all selected (Alt-click eye = solo/isolate); panel
  multi-select (click / Shift=range / Cmd-Ctrl=add, synced with canvas); Group selected
  (`Document.groups`, persisted in `.neuclip`); align L/Cx/R/T/Cy/B via transformedBounds;
  duplicate (offset copy, shares pixels), delete (Del), opacity across selection; the Move
  tool transforms the whole selection together.

## Edit document model (non-destructive — Tier-1)
The editor is a **layer document**, not a flattened image. The base image is NEVER mutated;
the visible picture is the composite of base → layers (in array order, bottom→top).
- `frontend/src/canvas/document.ts`: `NeuDocument { width, height, baseImageRef, layers[],
  selections? }` and `Layer { id, name, visible, opacity, blendMode, kind:'base'|'ai-edit'|
  'adjustment'|'outpaint', mask?(image-space binary alpha), resultUrl?(full-doc pixels),
  source?{ model, prompt, seed, params, sendRegion, reference? }, harmonize? }`. `composite()`
  renders base then each visible layer's pixels clipped to its mask at opacity + blend mode
  (canvas globalCompositeOperation).
- Every AI edit (crop-edit-composite) **pushes an `ai-edit` layer** carrying its full `source`
  spec + the selection mask + the composited result; edits are generated against the BASE so
  they're independent (non-overlapping edits fully so; overlapping stack top-most). Re-open
  ("edit") loads the layer's prompt + mask back into the tools.
- `frontend/src/canvas/canvasStage.tsx`: `img` is the immutable base; `layers` + a
  `layerImgs` cache → `composite` canvas is what Konva renders. Undo/redo snapshots include
  the layer array (+ mask); zoom/pan stay off the stack.
- `frontend/src/panels/layersPanel.tsx`: per-layer thumbnail, visibility, opacity, blend
  mode, reorder (▲▼), delete, and "edit this layer"; a locked Base row at the bottom.
- `.neuclip` save/resume (`serializeDoc`/`deserializeDoc`): base embedded as data URL, each
  layer's mask as PNG, resultUrl + source preserved; File-based Save/Open in the FileBar.
  **Adjustment layers** (kind `adjustment`, `adjust:{values,clip}`): exposure/contrast/
  saturation/temperature/vibrance applied in `composite()` to everything below (sliders in
  the layers panel). **Crop & straighten**: non-destructive `DocTransform {straighten,crop}`
  applied at export; aspect presets + straighten slider in the FileBar.
- Seam harmonization (`sidecar/app/harmonize.py`): per-ai-edit post pass before composite —
  LAB Reinhard color-match to the surround ring, low-freq luma relight, grain match; scaled
  by one `strength`, applied only inside the selection. Wired into `/generate` (mock) and
  `/poll` (real) via `harmonize` opts; stored on the layer. Frontend toggle + strength in the
  Generate bar (default on, 0.6). Verified: edit mean pulled toward surround (138→45), outside
  byte-identical.
- Tier-1/2 milestones: [x] P1 layer stack · [x] P2 .neuclip save + adjustment layers + crop ·
  [x] P3 harmonize · [x] P4 iterate/re-roll · [x] P5 stronger select · [x] P6 outpaint ·
  [x] P7 upscale/face-restore · [x] P8 before/after diff · [x] P9 LoRA.
- LoRA: registry `supports_lora`/`max_loras` per model (machine cap wins); `loras.py` library
  (local paths or hosted refs, trigger words, compatible base) + `/loras` GET/POST/remove;
  `/generate` `loras` attached via `registry.build_payload` only for supporting models;
  synthesis injects trigger words into the prompt (`/synthesize` + frontend stub). Frontend
  `panels/loraPanel.tsx` (amber) in the inspector when `supports_lora` — library + register +
  attach stack with weight sliders. Verified: weight reaches payload (scale 0.85), dropped
  for non-LoRA models, trigger injected into the synthesized prompt.

## Phase status
- [x] **Phase 0** — Shell & handshake (sidecar `/health`, port discovery, Tauri spawn,
      frontend status bar, clean shutdown). Verified here: sidecar boots + `/health` on
      CPU, frontend builds. Verify on 4070: GPU name in badge, desktop window, no orphan.
- [x] **Phase 1** — Canvas & coordinate core. `canvas/coords.ts` (screenToImage/
      imageToScreen/zoomAtPoint/fitTransform, clamp 1%–3200%), `canvas/maskBuffer.ts`
      (shared image-space mask, 4 boolean ops, bbox/area, marching-ants `outline()` via
      boundary tracing), `canvas/canvasStage.tsx` (Konva: image open, zoom bar, coord
      readout, cyan mask overlay + animated ants). Pure logic unit-tested (round-trip,
      zoom-invariance, ops, outline). Temporary click-stamp exercises the mask until Phase 3.
- [x] **Phase 2** — Navigation. Wheel zoom-to-pointer (pixel under cursor fixed), keyboard
      Cmd/Ctrl +/−/0(fit)/1(100%) about center, zoom-bar buttons. Pan: Hand tool, spacebar
      temp-hand (autorepeat-guarded, ignored while typing), middle-mouse drag; grab/grabbing
      cursors; 3px move threshold separates click-select from drag-pan. (`canvas/canvasStage.tsx`)
- [x] **Phase 3** — Smart select + refine. Sidecar `/load` `/select` `/refine`
      (`imaging.py` session+codec, `select_sam.py`, `matting.py`). SAM 2 encode-once/
      decode-many on GPU when `sam2` + a checkpoint are present (env `NEUCLIP_SAM2_*`);
      **classical CPU fallback** (OpenCV GrabCut for box, flood region-grow for points) so
      select runs anywhere. Refine = BiRefNet (env `NEUCLIP_BIREFNET_MODEL`) else
      edge-aware morphological feather. Frontend: `api/select.ts` + canvas Smart-Select
      tool (click=positive, Shift=add, Alt=negative, drag=box), point markers, Refine/Clear,
      backend badge (SAM 2 vs CPU). Fallback verified e2e (point→exact bbox, box→GrabCut,
      refine→soft edges). requirements.txt now installs opencv/scipy/multipart; launchers
      install full requirements.
- [x] **Phase 4** — Lasso tools. Sidecar `/livewire/costmap` (Sobel magnitude + Laplacian
      zero-crossing → per-pixel cost, cached per image/contrast, downscaled if huge). Frontend
      `canvas/livewire.ts` (bounded single-source Dijkstra + backtrace, `[`/`]` width),
      `canvas/lasso.ts` (even-odd rasterize, 45° constrain). canvasStage Lasso tool with 3
      modes (Shift+L cycles): freehand (drag samples, release closes), polygonal (click
      anchors, Shift 45°, Backspace, Enter/dbl-click/click-start closes), magnetic live-wire
      (snaps to edges, preview segment). All commit a closed path via the active boolean op
      (Shift/Alt) into the shared mask. Cost map + Dijkstra unit-tested (edge cost 14 vs 255;
      path hugs low-cost corridor).
- [x] **Phase 5** — Manual editable pen. `canvas/manualPen.ts` (anchors with in/out Bézier
      handles, cubic flatten, anchor/handle/segment hit-tests, bbox) + canvasStage Pen tool:
      click=corner anchor, click-drag=smooth w/ symmetric handles, drag anchors/handles to
      edit, click-segment inserts, Alt-click toggles corner↔smooth, Delete removes (heals),
      Esc cancels, Enter commits (rasterize→active boolean op). Invert `Cmd/Ctrl+Shift+I`
      (MaskBuffer.invert) for background selection. Live outline while editing; selection %%
      in toolbar. Flatten + hit-tests unit-tested.
- [x] **Phase 6** — Edit pipeline. `compose.py` (mask bbox → 12% pad → full-res crop →
      feather alpha → composite-back; alpha==0 + outside-region pixels stay byte-identical —
      verified). `models/wavespeed.py` (submit → poll `predictions/{id}/result` →
      `outputs[0]`, backoff/timeout/error). `models/adapters/flux_fill.py` (crop+mask+prompt
      payload). `jobs.py` job store. `/generate` (mock path when no key/slug; WaveSpeed
      otherwise) + `/poll` (downloads result, composites back). Frontend `api/generate.ts`
      + canvas amber Generate bar (prompt, status chip polling/done/failed, history strip);
      result re-uploaded so edits compound. Mock generate verified e2e (outside region
      bit-identical).
- [x] **Phase 7** — Model registry & adapters. `models/registry.py` (ModelSpec per model:
      slug, paradigm, needs_mask, instruction_based, reference_roles/inputs, est cost, build
      fn) + `/models` endpoint. Adapters `qwen_edit`, `kontext`, `ideogram_char`, `flux_fill`
      (uniform `build_payload(crop,mask,prompt,params,reference_rgb,role)`). `/generate`
      dispatches through `registry.build_payload` by model id/slug and accepts an optional
      reference image+role. Frontend `api/referenceModels.ts` `loadModels()` replaces the
      stub catalog from `/models` (fallback to stub); inspector/compare read the live
      registry. Verified `/models` returns 5 models with flags.
- [x] **Phase 8** — Prompt profiles & synthesis. `.nprofile` JSON Schema; `profiles/
      builder.py` (offline base per model from the registry spec — paradigm templates,
      preservation clause, style rules, constraints); `profiles/store.py` (base+user merge,
      validate, size-cap, **safety**: machine-introspected paradigm/capabilities/token-cap
      WIN over imports with warnings — hard cap 1024); `profiles/synth.py` (intent
      classify incl. text-edit `Replace 'old' with 'new'`, paradigm transform via profile
      templates + preservation, token-cap enforce). Endpoints `/profiles`, `/profiles/import`
      (validate+sanitize preview), `/synthesize`. Frontend `api/promptSynthesis.ts` stub
      mirrors this (swap point). Verified: same intent → different prompts per paradigm;
      malicious profile clamped+overridden with warnings. requirements add pyyaml/jsonschema.
- [x] **Phase 9** — Finish & package. Undo/redo for selection commits + edits (50-deep
      snapshot stack of mask+image+imageId; Cmd/Ctrl+Z / Shift+Z / Ctrl+Y; zoom/pan stay OFF
      the stack). Export PNG (full) + Cutout (selection as transparent alpha). Packaging:
      `build_app.py` single-file app bundles the UI + the profile `schema.json` data file
      (PyInstaller doesn't collect data files automatically) — frozen app verified serving
      `/`, `/health`, `/models`, `/profiles`, `/synthesize` and the full select→generate
      loop with cv2/scipy/yaml/jsonschema bundled. `build_sidecar.py` (Tauri externalBin)
      bundles the same data. `store.py` schema load made lazy/tolerant. CI: `app.yml`
      (single-file, all OSes) + `release.yml` (Tauri installers, manual).

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

## Prompt Intelligence ("exact change" engine — IMPLEMENTED)
One pipeline turns casual intent into the exact prompt each model's card says it wants:

```
user intent ──▶ intent.py (parse → EditSpec)          Stage 2: ~35 ordered rules, 12 operations,
                    │                                  ambiguities surfaced, never fails
selection ────▶ context.py (SelectionContext)         Stage 3: mask geometry + LAB scene stats
                    │                                  (harmonize machinery) + pipeline state
profile ──────▶ compiler.py (compile_prompt)          Stage 4: per-paradigm clause grammar,
                    │                                  operation strategies, known-failure
                    │                                  mitigations, token budget w/ drop order
                    ├──▶ polish.py (OPTIONAL LLM)      off by default; claude-haiku-4-5, temp 0,
                    │                                  hard cap; None on any failure
                    ▼
        {prompt, negative_prompt, params_overrides, rationale[], clauses[], send_region_pad}
                    │
generate ─────▶ verify (no-change detection)          Stage 5: mean |Δ| inside the mask →
                    │                                  `low_change` → one-click stronger variant
keep/reroll ──▶ learn (exemplars + telemetry)          structured exemplars (2-nearest retrieval
                                                       → rationale) + /feedback keep-reroll
                                                       counters → picker badges
```
- **Stage 1 — research layers** (`sidecar/app/profiles/research/*.research.nprofile`, YAML):
  per-model `prompt_grammar`/`dos`/`donts`/`negative_prompt`/`param_guidance`/`known_failures`
  /`vocab`/`example_prompts`; EVERY claim carries `{source, confidence: confirmed|inferred}`.
  Human-readable companion with all citations: `docs/prompt-research.md` (per-model sections
  generated FROM the layers). Audit CLI: `python -m app.profiles.audit` fails on unsourced
  claims / invalid confidence / contradictions with machine introspection — runs in CI
  (`.github/workflows/tests.yml`).
- **Merge precedence** (weakest→strongest): builder default < research < user layer
  (`~/.neuclip/profiles/*.user.nprofile` — every model's prompt file is user-editable and
  shareable) < machine introspection. Untrusted-import rules unchanged (contract #7).
- **RULE: a new registry model may NOT set `confirmed_slug=true` until it has a research
  layer** (file named by id, or slug with `/`→`--`). Dynamic catalog models without one run
  on the generic paradigm profile, honestly labeled.
- **Key compile strategies** (each cited in code): remove-on-inpaint = describe the
  background, never a removal command (FLUX Fill card; diffusers#9486 — acceptance-tested);
  recolor restates identity + "same shape/material/lighting"; text edits quote exact strings
  (`Replace '[old]' with '[new]'`); background swaps pin the subject; `small_object` context
  flag widens `send_region_pad` to 0.3; `likely_person` adds an identity lock; LoRA triggers
  prepended and never dropped by the token budget.
- **`/synthesize`** accepts `{model_id, intent, subject?, reference_role?, loras?, id?,
  mask_png?, selection_label?, strength: normal|strong, operation?(parse correction),
  polish?}` → the full package above + `edit_spec` + `ambiguities` + legacy `rule_note`.
  `/shootout` compiles per model through the same pipeline (grounded in the shared crop).
- **Feedback**: `POST /feedback {model_id, kept, operation?}` → `<config>/feedback.json`;
  stats ride `/models.feedback` → picker badge "✓ kept N/M". `/profiles/exemplar` now takes
  `operation`/`kept` and bumps telemetry too. Reroll auto-sends `kept:false`.
- **Frontend** (`panels/tunedPrompts.tsx`): `TunedPromptDisclosure` under the Generate
  prompt — debounced (400 ms) sidecar compile; clauses hoverable with sourced reasons;
  operation chip = one-click parse correction (resets on new intent); amber ambiguity chips
  with quick answers appended to the intent; ✎ edit = user override sent VERBATIM (skips
  compiler params/pad hints); `low_change` → "Try a stronger variant" (re-runs the captured
  mask via `lastGenMask`). Compare pane calls the sidecar per model and shows rationale
  diffs; stub synthesis survives only as the sidecar-down fallback.
- **Tests** (`sidecar/tests/`, CI): 48 golden snapshots (12 operations × 4 paradigms) +
  behavioral invariants in `test_prompt_compiler.py`; ~45 parser cases in `test_intent.py`.
  Goldens are exact strings — intentional phrasing changes mean regenerating and reviewing
  the diff.

## Medium awareness (photo / drawn-animated / 3D-CG — IMPLEMENTED)
Editing must never cross image mediums: "photorealistic, detailed" inside a cel-shaded
drawing (or a cartoon patch inside a photo) reads as broken even with a perfect seam.
- **Detection** (`sidecar/app/medium.py`): CPU statistics classifier, no weights —
  flat-fill coverage (16 quantized colors), sensor noise in smooth areas, dark ink-line
  fraction → `photo | drawn | render_cg` + confidence + honest cues. Runs at `/load`
  (stored on the session, returned to the UI) and inside `build_context` from raw pixels.
- **Compiler medium lock** (`prompting/compiler.py MEDIUM_STYLE`): a never-dropped
  `medium` clause pins drawn ("same line weight, flat cel shading … do not make it
  photorealistic") / CG ("smooth CG shading … not photographic") on instruction-family
  models; inpaint descriptions get medium-styled suffixes and the photo-quality vocab
  ("photorealistic, seamless, detailed") is REPLACED by medium-matched quality tags for
  non-photos. **Exception: `restyle` beats the lock** — "make it watercolor" is a
  deliberate medium change and must not compile into a contradiction.
- **Decompose** (`select_sam._decompose_flat`): drawn images skip GrabCut's photo prior —
  connected flat-color regions become `Object N` layers (interior, 0.5–55% of frame,
  capped 5) with everything border-touching as Background.
- **UI**: a chip in the Generate breadcrumb shows the detected medium (📷/✏/🧊 + cues in
  the tooltip); clicking cycles an override (starred) that rides `/synthesize.medium`;
  cycling back to the detected value returns to auto. `/load` response carries `medium`.
- Tests: `tests/test_medium.py` (3-way detection, vocab suppression, style locks,
  restyle exception, override, flat decompose).

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
- Shootout milestones: [x] M1 compare-set UI · [x] M2 N-prompt synthesis · [x] M3 parallel
  run+queue · [x] M4 comparison view · [x] M5 commit+feedback · [ ] M6 auto-rank.
  M3–M5: sidecar `POST /shootout` (ONE shared send region — pose/controlnet widens the pad
  for the whole run; per-model profile-synthesized prompt; per-model seed = stable hash of
  the model id; partial failure isolated per job; mock path returns distinct terminal
  tiles). Frontend: COMPARE publishes `compareMode/compareSet` via `state/genConfig.ts`;
  the Generate button becomes "Run shootout (N models · ~X¢)"; tiles render in the
  GenerateBar (preview/latency/expandable prompt/per-tile retry). "Keep" composites the
  tile as an ai-edit layer, records the winner, and appends the (intent → prompt) pair via
  `POST /profiles/exemplar` (append-only, capped 20, user layer in the config dir).
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
  that bundles the FastAPI sidecar + the built web UI; on launch it opens a **native
  desktop window** via pywebview (WebView2 on Windows / WebKit elsewhere; uvicorn runs on
  a daemon thread, the window owns the main thread, closing it exits cleanly) and falls
  back to serving + opening the browser when pywebview is absent/errors
  (`NEUCLIP_BROWSER=1` forces the browser; `NEUCLIP_NO_BROWSER=1` = headless). NO
  Python/Node/Rust/Tauri for the end user, no compile step. Entry:
  `sidecar/app/desktop.py` → `main.serve_app()`; UI located via `_ui_dir()` (frozen:
  `sys._MEIPASS/web`, dev: `frontend/dist`) and mounted at `/`. Built by `sidecar/
  build_app.py` (PyInstaller `--onefile --windowed`, `--add-data dist:web`,
  `--collect-all webview` when pywebview is installed — CI installs it). CI: `.github/
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

## UI shell (redesign pass — "self-explanatory first")
- **Vertical tool rail** (44 px, left): 7 icon-only tools (Move/Select/Lasso/Pen/Wand/
  Brush/Hand; lasso long-press/right-click flyout for its 3 modes) + zoom group. Active
  tool = cyan fill. `ui/tooltip.tsx` (150 ms styled tooltip: Name — description · [Key];
  also carries why-disabled reasons).
- **One contextual options bar** under the FileBar shows ONLY the active tool's options;
  advanced selection ops sit behind "⋯ More". FileBar = File/Image menus + Flatten +
  Auto-separate + undo/redo.
- **Right-side story**: canvas | Layers panel | AI panel. Generate bar: amber-bordered
  primary prompt, model breadcrumb above, dims to 40% + teach-line when nothing is
  selected, live progress on the button itself.
- **Design tokens** in `ui/tokens.ts` (spacing/type/radii, cyan=selection amber=AI
  blue=file, neutral ramp, shared btn/field/sectionHeader). Focus rings + uniform
  disabled in `src/index.css`.
- **Empty state** = drop-zone card (drop anywhere opens; drop on an open doc imports as a
  layer) + Open (⌘O) + "Try the sample image" (`public/sample.jpg`, bundled synthetic
  person+ball+background so every tool demos).
- Cursors: crosshair only for selection tools; Move=arrow; Brush hides the OS cursor
  (ring only); Hand/Space=grab.

## Onboarding architecture (4 independent layers)
**ORDER (post-fix): welcome → interface tour → guided first edit.** The tour teaches the
map (where the tools are, what preview mode means) BEFORE the tutorial asks the user to do
anything — a first-run user must never be told "click the person" without knowing which
tool does that, and a keyless Generate must never read as broken.
1. **Interface tour first** (`panels/onboarding.tsx`): welcome (sample / own image / skip,
   with a "30-second tour, then your first edit — no API key needed" expectation line) →
   the image opens BEHIND the tour → 6 spotlight stops in usage order: tool rail (every
   tool named w/ shortcut), options bar, layers panel, AI panel, generate bar, and a
   **preview-vs-live key stop** on ⚙ Settings ("Add my key now" → `neuclip:open-settings`,
   or continue keyless). Last button = "Start my first edit" → the tutorial. Tour targets
   re-measure on an interval (panels mount as the image loads). Replay (from ? Help /
   Settings / done card) runs the tour alone.
2. **Guided First Edit** (`panels/tutorial.tsx` + `state/tutorial.ts`): 4 do-it-yourself
   steps on the real app (select → prompt (pre-filled) → generate → layer), each advancing
   on the real milestone; after generate the Diff view flashes 2 s as the crop-only proof.
   Step 1 **forces the Select tool** (`neuclip:set-tool`) and names it + its rail location
   (Move would select layers, not pixels). Steps 2–3 carry a preview-mode note when no key
   is set. **Advance rule:** a completed generation advances from step 2 OR 3 (the
   pre-filled prompt + Enter never fires the typing milestone — used to strand step 2).
   `neuclip:generate-failed` (fired by generateNow with the real reason, also in the toast)
   renders a friendly retry hint instead of a silent red chip. Esc/✕ skips.
3. **Contextual coach marks** (`ui/coachmarks.tsx`): one-time single-sentence tips fired
   at first relevance (tool picked, first selection, import, 2nd AI edit, GPU idle …),
   tracked as `neuclip.tip.<key>`, max one visible, never during the tutorial AND
   suppressed while the welcome/tour overlay is open (`setTipsSuppressed`), side-placed
   for full-height targets (the tool rail), global kill-switch in Settings
   (`neuclip.tips.disabled`).
4. **Persistent help** (`panels/help.tsx`): ? Help menu; **Feature Finder** (⌘K palette
   over `ui/featureIndex.ts`, ~40 entries) spotlights any feature's location via
   `ui/spotlight.tsx`; `?` opens the shortcut overlay GENERATED from the featureIndex.
5. **Deferred key setup + checklist**: the tour's key stop sets the preview-vs-live
   expectation up front, but never blocks — an amber "preview mode" banner in the AI
   panel opens Settings at the moment of motivation ("Live — N models" toast after save).
   Getting-started checklist (5 items) lives atop the Layers panel, driven by
   `state/milestones.ts`, rows spotlight their feature, auto-dismisses at 5/5.
- **RULE: every new feature ships with a `featureIndex.ts` entry + a `data-tour`
  attribute on its element (+ optionally a coach mark).** The tutorial/tour/tips all key
  off `state/milestones.ts` — emit a milestone when adding a new user-visible action.

## Layout & width budget (post-audit fix)
- **Top bars must each fit ≤760 px** so 1280×720 works with both side panels open
  (1280 − 320 inspector − 240 layers = 720 canvas column; the layers panel collapses to a
  28 px rail, persisted in localStorage `neuclip.layersPanel.collapsed`).
- ZoomBar: icon-only tool buttons (7 tools incl. Wand; labels in tooltips) + compact
  selection ops + zoom group; `flexWrap` safety net. FileBar: **File** and **Image**
  dropdown menus (`ui/menu.tsx` — hand-rolled popover, outside-click/Esc close) hold
  open/save/import/export(+Export As…)/finish and crop/extend/straighten/separate/flatten/
  adjustment; only Flatten-for-AI + Auto-separate stay inline.
- The view-mode switch (Edit/A|B/Diff + swipe + diff%), cursor readout, sel%, and the
  select-backend badge live in the **StatusBar**, bridged from the canvas via
  `state/viewState.ts` (external store, same pattern as genConfig).
- Verified with Playwright at 1280×720 / 1366×768 / 1920×1080: no horizontal clipping,
  `document.body.scrollWidth <= innerWidth`, every bar `scrollWidth <= clientWidth`.

## Sidecar API surface (target)
`/health` `/settings` `/load` `/select` `/refine` `/livewire/costmap` `/generate` `/poll`
`/shootout` `/profiles/exemplar` `/synthesize` `/feedback`
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

## First-run onboarding (IMPLEMENTED — tour-first spotlight flow)
- `frontend/src/panels/onboarding.tsx` — shown once on first launch (gated by `localStorage`
  `neuclip.onboarded.v3`, mounted from `App.tsx` after the sidecar connects). Flow: ONE welcome
  screen (sample / own image / skip) → the chosen image opens BEHIND the overlay → **6-stop
  spotlight tour** (dims with a box-shadow cutout + pulsing ring, callout auto-picks the side with
  room, targets re-measured on an interval as panels mount): `tools` (all 7 tools named with
  shortcuts, cyan=selection), `optionsbar`, `layers`, `inspector` (amber=AI), `generate`, and
  `settings` as the **preview-vs-live key stop** ("Add my key now" → `neuclip:open-settings`, or
  continue keyless — Generate simulates edits until a WaveSpeed key exists, so nothing "fails").
  Last button "Start my first edit" → `startTutorial()` (guided first edit). Arrow-key / Enter
  navigation; replayable via ⚙ Settings ▸ **Show walkthrough** / ? Help / the tutorial done card
  (replay runs the tour alone, no tutorial after). Coach marks are suppressed while the overlay is
  open. Anchors are `data-tour="…"` attributes on the live components.

## Sidecar <-> Tauri handshake (Phase 0, IMPLEMENTED)
- Sidecar binds a port: tries `NEUCLIP_SIDECAR_PORT` (default 8756); on conflict it
  increments and, once bound, **prints `NEUCLIP_SIDECAR_PORT=<port>` to stdout** so the
  Rust parent can discover it (fixed-with-fallback + sidecar-prints-port).
- Rust spawns the sidecar as a Tauri `externalBin`, reads stdout for the port line, polls
  `GET /health` until ready, exposes the port to the frontend via a Tauri command
  (`sidecar_port`), and **kills the child on window close** (no orphans).
- `/health` returns `{ status, app, device, gpu_name, cuda, torch }`.

## Magic Brush (scribble selection, `canvas/canvasStage.tsx` + `canvas/brush.ts`)
Paint loosely over a subject → precise selection. Tool id `magic-brush` (rail 🖌 Brush; **W**,
**Shift+W** cycles wand↔brush). Strokes are *hints*, not paint: **Brush** deposits positive hints,
**Eraser** (or **Alt**) negative — into two image-space buffers, capsule-stamped along the drag
(`brush.ts stampCapsule`). One shared **`brushSize`** (image px, 1–1000, `[` `]` = ±10%) drives both
modes + the live cursor ring (`size×scale`). Three snap engines (options `BrushBar`): **AI** (default)
= sampled hints → SAM 2 point prompts (`smartSelect`, reuses the cached embedding; throttled one-in-
flight; falls back to Local on failure), **Local** = offline edge-bounded region-grow (`localGrow`,
gradient barrier + negative hints exclude), **Off** = raw paint. Snap runs on stroke-end → cyan
preview + hint overlay. **Enter** commits (BiRefNet "Refine edges" toggle on by default) → the shared
`commitMask`; **Esc** clears. Commit reuses the one shared AA/feather/boolean pipeline (invariant #3).
Pure ops esbuild-validated. Sidecar SAM is encode-once/query-many already (`select_sam.set_image`).

## Keyboard shortcuts (Photoshop-aligned, `canvas/canvasStage.tsx`)
**Tool keys are user-remappable** (`state/keymap.ts`: defaults + localStorage overrides;
single printable keys only — chorded shortcuts stay platform-fixed). The `?` shortcuts
panel (`panels/help.tsx ShortcutOverlay`) lists everything and rebinds by click-then-press
(conflicts steal the key and flag the loser as unbound; Reset restores defaults). Tool-rail
tooltips read the LIVE keymap. Defaults:
Tools: **V** Move · **M** Smart-select · **P** Pen · **W** Magic Brush (Shift+W ↔ Magic
Wand) · **L** Lasso / **Shift+L**
cycle Lasso (free/poly/magnetic) · **H** Hand
(pan) · Space-drag / middle-drag = temporary pan. Lasso/pen: **Enter**/double-click/click-origin
close · **Backspace** drop last anchor · **Esc** cancel · **`[` `]`** magnetic Width.
View: **Cmd/Ctrl +/−** zoom · **Cmd/Ctrl+0** fit · **Cmd/Ctrl+1** 100% · wheel = zoom-to-cursor.
Selection: **Cmd/Ctrl+A** select-all · **Cmd/Ctrl+D** deselect · **Cmd/Ctrl+Shift+I** invert.
Layers/doc: **Cmd/Ctrl+J** layer-via-copy (selection→new movable layer, `layerFromSelection`) ·
**Delete/Backspace** delete selected layer(s) (when any selected & not mid lasso/pen) ·
**Cmd/Ctrl+S** save `.neuclip` (`saveProject`, preventDefaults the browser save) ·
**Cmd/Ctrl+Z / Shift+Z / Ctrl+Y** undo/redo (zoom/pan stay off the stack).

## Conventions / decisions log
- **Profile user layer lives in the config dir** (`settings.config_dir()/profiles`, i.e.
  `~/.neuclip/profiles`) — writable in frozen builds; the bundled `profiles/store` dir is
  a read-only legacy fallback for loads only. Exemplars append to the same user layer.
- **Job store memory**: `JobStore` caps at 50 jobs (LRU) and drops the numpy buffers AND
  the served result_png once a job's terminal payload has been returned (the frontend
  never re-polls terminal jobs; re-polls still get the terminal status).
- **Layer ids are UUIDs** (`crypto.randomUUID`); `remapDuplicateLayerIds` heals old
  counter-based `.neuclip` files on open.
- **Fractional alpha end-to-end**: mask codecs never binarize (select.ts, generate.ts),
  sidecar `feather_alpha` treats the incoming mask as coverage, `MaskBuffer.shrink` is a
  box-min erode. Feathered selections blend fractionally in the composite (verified).
- **Saves/exports go through `api/saveFile.ts`** (Tauri dialog+fs plugins when in the
  shell — WebKitGTK ignores `<a download>` — anchor fallback otherwise).
- **CORS** restricted to the Vite dev + Tauri origins; `NEUCLIP_DEV_CORS=1` reopens it.
- **Toasts** (`ui/toast.tsx`): every user-facing action reports success/failure visibly.
- **Verified model slugs (2026-07)**: `qwen-image/edit-2511`, `qwen-image/edit-plus`,
  `flux-fill-dev`, `flux-kontext-dev` (confirmed); `ideogram-ai/ideogram-character` slug
  verified but its inpaint fields are not → stays `confirmed_slug=False`. Qwen edit
  models take an `images` ARRAY (crop first, reference second).
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

## Import image as layer + Flatten for AI (`canvas/canvasStage.tsx`)
- **Import image** (`importImageAsLayer`, FileBar **+ Import image**): drops another photo as a
  `kind:'imported'` layer — full-doc-sized pixels with the photo placed centered (~60% of the
  smaller dim), a mask over the placed rect, `bounds` + identity `transform`; auto-selects it and
  switches to the **Move** tool so it's immediately positionable/scalable (collage). It is NOT
  baked into the base, so AI edits (which crop the sidecar base) don't touch it yet.
- **Flatten for AI** (`flattenForAI`, FileBar **⤵ Flatten for AI**): bakes the whole visible
  composite (base + all layers incl. imports; base drawn under first when decomposed to avoid
  black holes) into a NEW base, re-uploads it to the sidecar (`/load`), and resets the layer
  stack — so selections + generation now see the imported/edited pixels. A deliberate commit
  (undoable). Reuses the outpaint→new-base pattern.
- **Flatten one layer** (`flattenLayer`, layers-panel **flatten ⤵** on imported/ai-edit/outpaint
  rows): merge-down — bakes the base + every layer up to and including this one into a new base,
  keeps the layers ABOVE independent (preserves z-order + final pixels exactly), re-uploads to the
  sidecar. For an imported layer on top this is exactly "bake just this image."
- **Overlap hint:** `selectionOverlapsImport` (mask bbox ∩ any imported layer's `transformedBounds`)
  shows an amber warning + inline **Flatten for AI** button right above Generate, so a selection
  over an un-baked import can't silently no-op. Explained in onboarding card 5.

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
      tool, point markers, Refine/Clear, backend badge (SAM 2 vs CPU). Fallback verified
      e2e (point→exact bbox, box→GrabCut, refine→soft edges).
      **Select-tool semantics (post-upgrade, Adobe-style multi-object):** plain click =
      select the clicked object (replace); **Ctrl/Cmd- or Shift-click = select ANOTHER
      object and ADD it** (each modifier click runs its own single-point select, combined
      through the shared boolean pipeline / commitMask — never accumulated into one SAM
      query); Alt-click = subtract an object; Alt+Ctrl = intersect. Box drags honor the
      same modifiers and show a **live cyan dashed marquee + translucent fill while
      dragging** (`boxPreview`, cleared on mouseup). **Esc or the ✕ Deselect button** (in
      the select/wand options rows) = deselect everything, same as ⌘D. macOS Ctrl-click
      context menu is suppressed on the Stage for the select tool.
      **Find (select-by-text)** `selector.semantic()` returns (mask, available, note),
      tried in order: (1) GroundingDINO→SAM boxes-union when `NEUCLIP_GDINO_CHECKPOINT`
      +`_CONFIG` are set (GPU build); (2) CLIPSeg text→mask (transformers, CPU or GPU;
      local HF cache only unless `NEUCLIP_CLIPSEG=1` allows the one-time download);
      (3) CPU heuristics — background → inverse of subject; person/subject → GrabCut;
      bright words (sun/moon/lamp) → brightest blob; sky → top-connected bright/blue;
      skin words → skin-tone rule; color words + noun→color map (grass/water/jeans…) →
      HSV band regions — each labeled honestly via `note`; a no-match keeps the current
      selection and explains what offline Find understands (`tests/test_semantic_select.py`).
      **Esc deselects everything** (pixel + layer selection) from ANY tool unless a
      lasso/pen/brush gesture is mid-flight (those keep cancel semantics).
- [x] **Phase 4** — Lasso tools. Sidecar `/livewire/costmap` (Sobel magnitude + Laplacian
      zero-crossing → per-pixel cost, cached per image/contrast, downscaled if huge). Frontend
      `canvas/livewire.ts` (bounded single-source Dijkstra + backtrace, `[`/`]` width),
      `canvas/lasso.ts` (even-odd rasterize, 45° constrain). canvasStage Lasso tool with 3
      modes (Shift+L cycles): freehand (drag samples, release closes), polygonal (click
      anchors, Shift 45°, Backspace, Enter/dbl-click/click-start closes), magnetic live-wire
      (snaps to edges, preview segment; **PS-parity auto-anchoring** — tracing along the
      edge freezes the wire's tail into real anchors every ~35 screen px, keeping the
      bounded Dijkstra window local; Backspace removes them one by one). All commit a
      closed path via the active boolean op (Shift/Alt) into the shared mask. Cost map +
      Dijkstra unit-tested (edge cost 14 vs 255; path hugs low-cost corridor).
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
      the stack). Export PNG (full) + Cutout (selection as transparent alpha) + **Export
      as PNG/JPEG/WebP (quality slider) or SVG** (full-quality raster embedded in a
      scalable vector wrapper — raster edits can't be losslessly auto-vectorized; labeled
      as such). Packaging:
      `build_app.py` single-file app bundles the UI + the profile `schema.json` data file
      (PyInstaller doesn't collect data files automatically) — frozen app verified serving
      `/`, `/health`, `/models`, `/profiles`, `/synthesize` and the full select→generate
      loop with cv2/scipy/yaml/jsonschema bundled. `build_sidecar.py` (Tauri externalBin)
      bundles the same data. `store.py` schema load made lazy/tolerant. CI: `app.yml`
      (single-file, all OSes) + `release.yml` (Tauri installers, manual).

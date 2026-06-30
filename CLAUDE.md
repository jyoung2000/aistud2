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
- Reference-feature milestones: [x] M1 UI (stubbed) · [x] M2 routing · [ ] M3 replace
  e2e · [ ] M4 pose preprocess+transfer · [ ] M5 profiles+style. (Builds on Phases 6–8.)
  M2: role toggle dims unsupported roles; picking one shows a "switch to {model}" notice
  (`SwitchNotice` → `findModelForRole`) that re-targets the active/primary model and carries
  the reference image + role across; models with no `reference_roles` show a "no reference"
  note instead of the toggle.

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
- **Polished native (optional, later):** `tauri build` → `.msi`/`.dmg`/AppImage via
  `.github/workflows/release.yml` (manual dispatch — compiles Rust). The native shell uses
  the externalBin sidecar + `sidecar_port` handshake.
- **Dev-from-source launchers (`launchers/`, advanced):** `Start Neuclip Studio.command` /
  `.bat` auto-install toolchains and run the Tauri dev GUI. De-emphasized vs the easy path.

## Sidecar API surface (target)
`/health` `/load` `/select` `/refine` `/livewire/costmap` `/generate` `/poll`

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

## Phase status
- [x] **Phase 0** — Shell & handshake (sidecar `/health`, port discovery, Tauri spawn,
      frontend status bar, clean shutdown). Verified here: sidecar boots + `/health` on
      CPU, frontend builds. Verify on 4070: GPU name in badge, desktop window, no orphan.
- [ ] Phase 1 — Canvas & coordinate core
- [ ] Phase 2 — Navigation (zoom & pan)
- [ ] Phase 3 — Smart select (SAM 2) + refine
- [ ] Phase 4 — Lasso tools (freehand / polygonal / magnetic live-wire)
- [ ] Phase 5 — Manual editable selection (pen-grade)
- [ ] Phase 6 — Edit pipeline: crop-composite + first model
- [ ] Phase 7 — Model registry & adapters
- [ ] Phase 8 — Model prompt profiles & synthesis
- [ ] Phase 9 — Finish & package

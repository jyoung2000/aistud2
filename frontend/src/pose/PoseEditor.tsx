import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COLOR_GENERATION } from "../constants";
import {
  extractPoseFromUpload,
  listPoses,
  removePose,
  savePose,
  type SavedPose,
} from "../api/pose";
import {
  fitTransform,
  imageToScreen,
  screenToImage,
  zoomAtPoint,
  type ViewTransform,
} from "../canvas/coords";
import {
  BODY_LIMBS,
  BODY_NAMES,
  LIMB_COLORS,
  addFigure,
  adjustLimbDepth,
  appendFigures,
  blankPose,
  boneKey,
  boneRestLengths,
  bodyIndex,
  clonePose,
  deleteFigure,
  duplicateFigure,
  figureCenter,
  groupVisible,
  keypointPos,
  mirrorFigure,
  mirrorPartnerId,
  moveKeypointRaw,
  nudgeKeypoint,
  pointColor,
  rgb,
  setGroupVisible,
  setKeypointVisible,
  solveBoneLengths,
  updateTransform,
  type Figure,
  type KeypointGroup,
  type Pose,
} from "./poseModel";

const AMBER = COLOR_GENERATION;

/**
 * Pose Editor — a dedicated workspace where the rig sits over a dimmable ("ghost") copy of
 * the image so joints are placed against the real body. The EDITED skeleton becomes the pose
 * control signal. View/image spaces are never conflated (contract #1): the rig is image-space,
 * every gesture round-trips through screenToImage/imageToScreen.
 *
 * P2 = view (ghost backdrop, rig render, zoom/pan, apply/cancel). P3 layers on full editing.
 */
export function PoseEditor({
  open,
  imageSrc,
  width,
  height,
  pose: initialPose,
  onApply,
  onClose,
}: {
  open: boolean;
  imageSrc: string;
  width: number;
  height: number;
  pose: Pose;
  onApply: (pose: Pose) => void;
  onClose: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgReady, setImgReady] = useState(false);

  const [pose, setPose] = useState<Pose>(() => clonePose(initialPose));
  const [view, setView] = useState<ViewTransform>({ scale: 1, x: 0, y: 0 });
  const [ghost, setGhost] = useState(0.5);
  const [vp, setVp] = useState({ w: 800, h: 600 });

  // active figure + selected joint (drag core; full editing in P3)
  const [activeFig, setActiveFig] = useState<string>(() => initialPose.figures[0]?.id ?? "fig1");
  const [selected, setSelected] = useState<string | null>(null);

  const [symmetry, setSymmetry] = useState(false);
  const [boneLock, setBoneLock] = useState(false);
  const [onion, setOnion] = useState(false);
  const restRef = useRef<Record<string, number> | null>(null);

  const [saved, setSaved] = useState<SavedPose[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const dragRef = useRef<
    | { kind: "pan"; startView: ViewTransform; sx: number; sy: number }
    | { kind: "joint"; id: string; figId: string }
    | null
  >(null);
  const spaceRef = useRef(false);

  // editor-scoped undo/redo (pose snapshots; view/ghost stay off the stack)
  const undoRef = useRef<Pose[]>([]);
  const redoRef = useRef<Pose[]>([]);
  const dragSnapRef = useRef<Pose | null>(null);

  const pushUndo = useCallback((snap: Pose) => {
    undoRef.current.push(snap);
    if (undoRef.current.length > 100) undoRef.current.shift();
    redoRef.current = [];
  }, []);

  /** Apply a discrete edit and record it for undo. */
  const commit = useCallback(
    (fn: (p: Pose) => Pose) => {
      setPose((p) => {
        const next = fn(p);
        if (next === p) return p;
        pushUndo(clonePose(p));
        return next;
      });
    },
    [pushUndo]
  );

  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    setPose((p) => {
      redoRef.current.push(clonePose(p));
      return prev;
    });
  }, []);

  const redo = useCallback(() => {
    const nxt = redoRef.current.pop();
    if (!nxt) return;
    setPose((p) => {
      undoRef.current.push(clonePose(p));
      return nxt;
    });
  }, []);

  // --- multi-figure + library (P5) -----------------------------------------
  useEffect(() => {
    if (open) listPoses().then(setSaved).catch(() => setSaved([]));
  }, [open]);

  const addFig = () => {
    pushUndo(clonePose(pose));
    const [np, id] = addFigure(pose, width, height);
    setPose(np);
    setActiveFig(id);
    setSelected(null);
  };
  const dupFig = () => {
    pushUndo(clonePose(pose));
    const [np, id] = duplicateFigure(pose, activeFig);
    setPose(np);
    setActiveFig(id);
    setSelected(null);
  };
  const delFig = () => {
    if (pose.figures.length <= 1) return;
    pushUndo(clonePose(pose));
    const np = deleteFigure(pose, activeFig);
    setPose(np);
    setActiveFig(np.figures[0]?.id ?? "fig1");
    setSelected(null);
  };
  const startBlank = () => {
    pushUndo(clonePose(pose));
    setPose(blankPose(width, height));
    setActiveFig("fig1");
    setSelected(null);
  };

  const saveCurrent = async () => {
    const name = window.prompt("Save pose as:", `Pose ${saved.length + 1}`);
    if (!name) return;
    setBusy("save");
    try {
      setSaved(await savePose(name, pose, width, height));
    } catch (e) {
      window.alert(`Save failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  const loadSaved = (sp: SavedPose) => {
    pushUndo(clonePose(pose));
    setPose(clonePose(sp.pose));
    setActiveFig(sp.pose.figures[0]?.id ?? "fig1");
    setSelected(null);
  };
  const deleteSaved = async (id: string) => {
    setSaved(await removePose(id));
  };
  const loadExternalImage = async (file: File) => {
    setBusy("extract");
    try {
      const dataUrl = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = rej;
        fr.readAsDataURL(file);
      });
      const ref = await extractPoseFromUpload(dataUrl);
      pushUndo(clonePose(pose));
      const [np, id] = appendFigures(pose, ref.figures);
      setPose(np);
      if (id) setActiveFig(id);
      setSelected(null);
    } catch (e) {
      window.alert(`Pose extraction failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  // Reset editable pose whenever we (re)open with a new source pose.
  useEffect(() => {
    if (open) {
      setPose(clonePose(initialPose));
      setActiveFig(initialPose.figures[0]?.id ?? "fig1");
      setSelected(null);
      undoRef.current = [];
      redoRef.current = [];
    }
  }, [open, initialPose]);

  // Load the backdrop image.
  useEffect(() => {
    if (!open) return;
    setImgReady(false);
    const im = new Image();
    im.onload = () => {
      imgRef.current = im;
      setImgReady(true);
    };
    im.src = imageSrc;
  }, [open, imageSrc]);

  // Track viewport size; fit on open / resize.
  useEffect(() => {
    if (!open) return;
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setVp({ w: r.width, h: r.height });
      setView(fitTransform(width, height, r.width, r.height));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, width, height]);

  // --- hit testing (screen px) ---------------------------------------------
  const HIT = 9;
  const hitJoint = useCallback(
    (sx: number, sy: number): { id: string; figId: string } | null => {
      // Prefer the active figure, then others; topmost-visible wins.
      const order = [...pose.figures].sort((a, b) => (a.id === activeFig ? 1 : 0) - (b.id === activeFig ? 1 : 0));
      for (const fig of order) {
        const c = figureCenter(fig);
        for (const k of fig.keypoints) {
          if (!k.visible) continue;
          const p = keypointPos(fig, k);
          const s = imageToScreen(p, view);
          void c;
          if (Math.hypot(s.x - sx, s.y - sy) <= HIT) return { id: k.id, figId: fig.id };
        }
      }
      return null;
    },
    [pose, view, activeFig]
  );

  // --- render ---------------------------------------------------------------
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(vp.w * dpr);
    cv.height = Math.round(vp.h * dpr);
    cv.style.width = `${vp.w}px`;
    cv.style.height = `${vp.h}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vp.w, vp.h);

    // checker so transparency/edges read honestly
    drawChecker(ctx, vp.w, vp.h);

    // ghost image backdrop
    if (imgReady && imgRef.current) {
      ctx.save();
      ctx.globalAlpha = ghost;
      ctx.imageSmoothingQuality = "high";
      const o = imageToScreen({ x: 0, y: 0 }, view);
      ctx.drawImage(imgRef.current, o.x, o.y, width * view.scale, height * view.scale);
      ctx.restore();
    }

    // image border
    const tl = imageToScreen({ x: 0, y: 0 }, view);
    ctx.strokeStyle = "#2a2f37";
    ctx.lineWidth = 1;
    ctx.strokeRect(tl.x + 0.5, tl.y + 0.5, width * view.scale, height * view.scale);

    // onion skin: the ORIGINAL extracted pose, faint, under the edited rig
    if (onion) {
      for (const fig of initialPose.figures) drawOnion(ctx, fig, view);
    }

    // rig
    for (const fig of pose.figures) drawFigure(ctx, fig, view, fig.id === activeFig, selected);
  }, [pose, view, vp, ghost, imgReady, width, height, activeFig, selected, onion, initialPose]);

  // --- pointer handlers -----------------------------------------------------
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const r = canvasRef.current!.getBoundingClientRect();
    const factor = Math.pow(1.0015, -e.deltaY);
    setView((v) => zoomAtPoint(v, { x: e.clientX - r.left, y: e.clientY - r.top }, factor));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    canvasRef.current!.setPointerCapture(e.pointerId);

    const wantPan = e.button === 1 || spaceRef.current || e.button === 2;
    if (wantPan) {
      dragRef.current = { kind: "pan", startView: view, sx, sy };
      return;
    }
    const hit = hitJoint(sx, sy);
    if (hit) {
      setActiveFig(hit.figId);
      setSelected(hit.id);
      dragSnapRef.current = clonePose(pose); // recorded on drag end if changed
      const fig = pose.figures.find((f) => f.id === hit.figId);
      restRef.current = boneLock && fig ? boneRestLengths(fig) : null;
      dragRef.current = { kind: "joint", id: hit.id, figId: hit.figId };
    } else {
      setSelected(null);
      dragRef.current = { kind: "pan", startView: view, sx, sy };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const r = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    if (d.kind === "pan") {
      setView({ ...d.startView, x: d.startView.x + (sx - d.sx), y: d.startView.y + (sy - d.sy) });
    } else {
      // Drag a joint: screen→image gives the new raw position (figure transform is identity
      // during hand-posing; whole-rig transform is applied separately). Symmetry mirrors the
      // move to the L↔R partner about the figure centre.
      const img = screenToImage({ x: sx, y: sy }, view);
      setPose((p) => {
        let next = moveKeypointRaw(p, d.figId, d.id, img.x, img.y, width, height);
        const pinned = [d.id];
        if (symmetry) {
          const fig = next.figures.find((f) => f.id === d.figId);
          const partner = fig ? mirrorPartnerId(fig, d.id) : null;
          if (fig && partner) {
            const c = figureCenter(fig);
            const moved = fig.keypoints.find((k) => k.id === d.id)!;
            next = moveKeypointRaw(next, d.figId, partner, 2 * c.x - moved.x, moved.y, width, height);
            pinned.push(partner);
          }
        }
        // bone-length lock: relax the rest of the rig to keep limb lengths (dragged joint +
        // torso anchor stay pinned).
        if (restRef.current) {
          const neck = next.figures.find((f) => f.id === d.figId)?.keypoints.find((k) => k.id.endsWith(":body:1"));
          if (neck && neck.id !== d.id) pinned.push(neck.id);
          next = solveBoneLengths(next, d.figId, restRef.current, pinned, width, height);
        }
        return next;
      });
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    try {
      canvasRef.current!.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    if (dragRef.current?.kind === "joint" && dragSnapRef.current) {
      const snap = dragSnapRef.current;
      // record the pre-drag state only if something actually moved
      setPose((cur) => {
        if (JSON.stringify(cur) !== JSON.stringify(snap)) pushUndo(snap);
        return cur;
      });
    }
    dragSnapRef.current = null;
    restRef.current = null;
    dragRef.current = null;
  };

  // keyboard: space=pan, arrows=nudge, undo/redo, delete=hide joint, Esc=cancel
  useEffect(() => {
    if (!open) return;
    const down = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === "INPUT";
      if (e.code === "Space") spaceRef.current = true;
      if (e.key === "Escape") return onClose();
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (meta && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (typing || !selected) return;
      const step = e.shiftKey ? 10 : 1;
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
      };
      if (arrows[e.key]) {
        e.preventDefault();
        const [dx, dy] = arrows[e.key];
        commit((p) => {
          let n = nudgeKeypoint(p, activeFig, selected, dx, dy, width, height);
          if (symmetry) {
            const fig = n.figures.find((f) => f.id === activeFig);
            const partner = fig ? mirrorPartnerId(fig, selected) : null;
            if (fig && partner) n = nudgeKeypoint(n, activeFig, partner, -dx, dy, width, height);
          }
          return n;
        });
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        commit((p) => setKeypointVisible(p, activeFig, selected, false));
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [open, onClose, undo, redo, commit, selected, activeFig, symmetry, width, height]);

  const fit = () => setView(fitTransform(width, height, vp.w, vp.h));

  const lowConf = useMemo(
    () => pose.figures.reduce((n, f) => n + f.keypoints.filter((k) => k.visible && k.confidence < 0.35).length, 0),
    [pose]
  );
  const activeFigure = useMemo(() => pose.figures.find((f) => f.id === activeFig), [pose, activeFig]);
  const selectedKp = useMemo(
    () => activeFigure?.keypoints.find((k) => k.id === selected) ?? null,
    [activeFigure, selected]
  );

  if (!open) return null;

  return (
    <div style={overlay}>
      <div style={panel}>
        {/* header */}
        <div style={header}>
          <span style={{ fontWeight: 700, color: AMBER }}>Pose Editor</span>
          <span style={{ fontSize: 11, color: "#7d8694" }}>
            {pose.figures.length} figure{pose.figures.length === 1 ? "" : "s"}
            {pose.backend ? ` · ${pose.backend}` : ""}
            {lowConf > 0 ? ` · ${lowConf} low-confidence joints to verify` : ""}
          </span>
          <div style={{ flex: 1 }} />
          <button style={ghostBtn} onClick={onClose}>
            Cancel
          </button>
          <button style={applyBtn} onClick={() => onApply(pose)}>
            Apply pose
          </button>
        </div>

        {/* toolbar */}
        <div style={toolbar}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#cbd5e1" }}>
            Ghost image
            <input
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={ghost}
              onChange={(e) => setGhost(Number(e.target.value))}
              style={{ width: 120, accentColor: AMBER }}
            />
            <span style={{ width: 30, color: "#7d8694" }}>{Math.round(ghost * 100)}%</span>
          </label>
          <div style={{ width: 1, height: 18, background: "#2a2f37" }} />
          <button style={toolBtn} onClick={() => setView((v) => zoomAtPoint(v, { x: vp.w / 2, y: vp.h / 2 }, 1.2))}>
            +
          </button>
          <button style={toolBtn} onClick={() => setView((v) => zoomAtPoint(v, { x: vp.w / 2, y: vp.h / 2 }, 1 / 1.2))}>
            −
          </button>
          <button style={toolBtn} onClick={fit}>
            Fit
          </button>
          <span style={{ fontSize: 11, color: "#7d8694" }}>{Math.round(view.scale * 100)}%</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 10.5, color: "#5c6473" }}>
            drag joints · space/middle-drag to pan · wheel to zoom
          </span>
        </div>

        {/* figures + library row */}
        <div style={{ ...toolbar, flexWrap: "wrap", rowGap: 6 }}>
          <span style={{ fontSize: 10, color: "#64748b", fontWeight: 700, letterSpacing: 1 }}>FIGURES</span>
          {pose.figures.map((f, i) => (
            <button
              key={f.id}
              onClick={() => {
                setActiveFig(f.id);
                setSelected(null);
              }}
              style={{ ...toolBtn, borderColor: f.id === activeFig ? AMBER : "#2a2f37", color: f.id === activeFig ? "#f4d9a6" : "#cbd5e1" }}
            >
              {i + 1}
            </button>
          ))}
          <button style={toolBtn} onClick={addFig} title="Add a blank figure">+ Add</button>
          <button style={toolBtn} onClick={dupFig} title="Duplicate active figure">Dup</button>
          <button style={{ ...toolBtn, color: "#e5687a" }} onClick={delFig} disabled={pose.figures.length <= 1} title="Delete active figure">Del</button>
          <button style={toolBtn} onClick={startBlank} title="Start from a single blank A-pose">Blank rig</button>

          <div style={{ width: 1, height: 18, background: "#2a2f37" }} />
          <span style={{ fontSize: 10, color: "#64748b", fontWeight: 700, letterSpacing: 1 }}>LIBRARY</span>
          <button style={toolBtn} onClick={saveCurrent} disabled={busy === "save"}>
            {busy === "save" ? "Saving…" : "Save pose"}
          </button>
          <button style={toolBtn} onClick={() => fileRef.current?.click()} disabled={busy === "extract"} title="Load a pose-reference image and extract its skeleton">
            {busy === "extract" ? "Extracting…" : "Load pose from image"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) loadExternalImage(f);
              e.currentTarget.value = "";
            }}
          />
          {saved.map((sp) => (
            <span key={sp.id} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
              <button style={{ ...toolBtn, fontSize: 11 }} onClick={() => loadSaved(sp)} title={`Load "${sp.name}"`}>
                {sp.name}
              </button>
              <button style={{ ...toolBtn, padding: "3px 5px", color: "#e5687a" }} onClick={() => deleteSaved(sp.id)} title="Delete saved pose">
                ×
              </button>
            </span>
          ))}
        </div>

        {/* canvas + inspector */}
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <div ref={wrapRef} style={{ position: "relative", flex: 1, minHeight: 0, background: "#0b0d10" }}>
            <canvas
              ref={canvasRef}
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onContextMenu={(e) => e.preventDefault()}
              style={{ display: "block", touchAction: "none", cursor: "crosshair" }}
            />
          </div>
          <PoseInspector
            figure={activeFigure ?? null}
            selected={selectedKp}
            symmetry={symmetry}
            boneLock={boneLock}
            onion={onion}
            canUndo={undoRef.current.length > 0}
            canRedo={redoRef.current.length > 0}
            onUndo={undo}
            onRedo={redo}
            onSetSymmetry={setSymmetry}
            onSetBoneLock={setBoneLock}
            onSetOnion={setOnion}
            onToggleGroup={(g, vis) => activeFigure && commit((p) => setGroupVisible(p, activeFigure.id, g, vis))}
            onTransform={(patch) => activeFigure && commit((p) => updateTransform(p, activeFigure.id, patch))}
            onMirror={() => activeFigure && commit((p) => mirrorFigure(p, activeFigure.id))}
            onDepth={(dir) =>
              selectedKp && activeFigure && commit((p) => adjustLimbDepth(p, activeFigure.id, selectedKp.id, dir))
            }
            onDeleteJoint={() =>
              selectedKp && activeFigure && commit((p) => setKeypointVisible(p, activeFigure.id, selectedKp.id, false))
            }
            onRestoreJoint={(id) => activeFigure && commit((p) => setKeypointVisible(p, activeFigure.id, id, true))}
          />
        </div>
      </div>
    </div>
  );
}

function PoseInspector({
  figure,
  selected,
  symmetry,
  boneLock,
  onion,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSetSymmetry,
  onSetBoneLock,
  onSetOnion,
  onToggleGroup,
  onTransform,
  onMirror,
  onDepth,
  onDeleteJoint,
  onRestoreJoint,
}: {
  figure: Figure | null;
  selected: { id: string; x: number; y: number; confidence: number; visible: boolean } | null;
  symmetry: boolean;
  boneLock: boolean;
  onion: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSetSymmetry: (v: boolean) => void;
  onSetBoneLock: (v: boolean) => void;
  onSetOnion: (v: boolean) => void;
  onToggleGroup: (g: KeypointGroup, visible: boolean) => void;
  onTransform: (patch: { scale?: number; rotation?: number }) => void;
  onMirror: () => void;
  onDepth: (dir: 1 | -1) => void;
  onDeleteJoint: () => void;
  onRestoreJoint: (id: string) => void;
}) {
  const groups: KeypointGroup[] = ["body", "face", "handL", "handR"];
  const hidden = figure?.keypoints.filter((k) => !k.visible) ?? [];
  const label = (id: string) => {
    const i = bodyIndex(id);
    return i === null ? id.split(":").slice(1).join(" ") : BODY_NAMES[i] ?? `#${i}`;
  };
  return (
    <aside style={inspector}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <SectionLabel>HISTORY</SectionLabel>
        <div style={{ flex: 1 }} />
        <button style={miniBtn} disabled={!canUndo} onClick={onUndo} title="Undo (Cmd/Ctrl+Z)">↶</button>
        <button style={miniBtn} disabled={!canRedo} onClick={onRedo} title="Redo (Shift+Cmd/Ctrl+Z)">↷</button>
      </div>

      <SectionLabel>SELECTED JOINT</SectionLabel>
      {selected ? (
        <div style={{ fontSize: 11, color: "#cbd5e1", lineHeight: 1.6 }}>
          <div style={{ color: "#e2e8f0", fontWeight: 600 }}>{label(selected.id)}</div>
          <div style={{ fontFamily: "ui-monospace, monospace", color: "#94a3b8" }}>
            x {selected.x.toFixed(1)} · y {selected.y.toFixed(1)}
          </div>
          <div style={{ color: selected.confidence < 0.35 ? "#e0b060" : "#7d8694" }}>
            confidence {(selected.confidence * 100).toFixed(0)}%
            {selected.confidence < 0.35 ? " — verify" : ""}
          </div>
          <div style={{ color: "#5c6473", marginTop: 2 }}>arrow keys nudge · Shift = ×10 · Del hides</div>
          <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "#5c6473" }}>depth</span>
            <button style={miniBtn} onClick={() => onDepth(1)} title="Bring this joint's limbs forward">▲ forward</button>
            <button style={miniBtn} onClick={() => onDepth(-1)} title="Send this joint's limbs back">▼ back</button>
          </div>
          <button style={{ ...miniBtn, marginTop: 6, color: "#e5687a" }} onClick={onDeleteJoint}>Hide joint</button>
        </div>
      ) : (
        <div style={{ fontSize: 11, color: "#5c6473" }}>Click a joint to inspect / edit.</div>
      )}

      <SectionLabel>ACCURACY</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 11, color: "#cbd5e1" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={boneLock} onChange={(e) => onSetBoneLock(e.target.checked)} />
          Bone-length lock (IK-lite)
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={onion} onChange={(e) => onSetOnion(e.target.checked)} />
          Onion-skin (show original pose)
        </label>
        <div style={{ fontSize: 10, color: "#5c6473", lineHeight: 1.4 }}>
          2D skeletons lose depth — use forward/back on a joint so an arm meant to be behind the
          torso reads correctly in the control image.
        </div>
      </div>

      <SectionLabel>GROUPS</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {groups.map((g) => {
          const present = figure?.keypoints.some((k) => k.group === g) ?? false;
          const on = figure ? groupVisible(figure, g) : false;
          return (
            <button
              key={g}
              disabled={!present}
              onClick={() => onToggleGroup(g, !on)}
              style={{
                ...chip,
                opacity: present ? 1 : 0.35,
                borderColor: on ? AMBER : "#2b313c",
                color: on ? "#f4d9a6" : "#8a93a2",
              }}
              title={present ? `Toggle ${g}` : `${g} not present`}
            >
              {g}
            </button>
          );
        })}
      </div>

      <SectionLabel>WHOLE-RIG TRANSFORM</SectionLabel>
      {figure && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Slider
            label="scale"
            min={0.3}
            max={2.5}
            step={0.01}
            value={figure.transform.scale}
            onChange={(v) => onTransform({ scale: v })}
            fmt={(v) => `${Math.round(v * 100)}%`}
          />
          <Slider
            label="rotate"
            min={-180}
            max={180}
            step={1}
            value={figure.transform.rotation}
            onChange={(v) => onTransform({ rotation: v })}
            fmt={(v) => `${Math.round(v)}°`}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button style={miniBtn} onClick={onMirror} title="Mirror left↔right">⇄ Mirror</button>
            <button
              style={miniBtn}
              onClick={() => onTransform({ scale: 1, rotation: 0 })}
              title="Reset transform"
            >
              Reset
            </button>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#cbd5e1" }}>
            <input type="checkbox" checked={symmetry} onChange={(e) => onSetSymmetry(e.target.checked)} />
            Symmetry edit (mirror joint moves L↔R)
          </label>
        </div>
      )}

      {hidden.length > 0 && (
        <>
          <SectionLabel>HIDDEN JOINTS ({hidden.length})</SectionLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {hidden.map((k) => (
              <button key={k.id} style={{ ...chip, borderColor: "#2b313c" }} onClick={() => onRestoreJoint(k.id)}>
                + {label(k.id)}
              </button>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, letterSpacing: 1, color: "#64748b", fontWeight: 700, marginTop: 4 }}>
      {children}
    </div>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
  fmt,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  fmt: (v: number) => string;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#cbd5e1" }}>
      <span style={{ width: 42 }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: AMBER }}
      />
      <span style={{ width: 40, textAlign: "right", color: "#7d8694", fontFamily: "ui-monospace, monospace" }}>
        {fmt(value)}
      </span>
    </label>
  );
}

// --- drawing ----------------------------------------------------------------

function drawChecker(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const s = 12;
  ctx.fillStyle = "#0d0f12";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#111418";
  for (let y = 0; y < h; y += s) {
    for (let x = 0; x < w; x += s) {
      if (((x / s + y / s) & 1) === 0) ctx.fillRect(x, y, s, s);
    }
  }
}

function drawFigure(
  ctx: CanvasRenderingContext2D,
  fig: Figure,
  view: ViewTransform,
  active: boolean,
  selected: string | null
) {
  const byId = new Map(fig.keypoints.map((k) => [k.id, k]));
  const colorFor = new Map<string, [number, number, number]>();
  const idAt = (i: number) => fig.keypoints.find((k) => k.id.endsWith(`:body:${i}`))?.id;
  BODY_LIMBS.forEach(([a, b], li) => {
    const ka = idAt(a);
    const kb = idAt(b);
    if (ka && kb) colorFor.set(boneKey(ka, kb), LIMB_COLORS[li % LIMB_COLORS.length]);
  });

  // bones back→front by limbOrder (higher drawn first)
  const bones = [...fig.bones].sort(
    (x, y) => (fig.limbOrder[boneKey(y[0], y[1])] ?? 0) - (fig.limbOrder[boneKey(x[0], x[1])] ?? 0)
  );
  ctx.lineCap = "round";
  for (const [aId, bId] of bones) {
    const ka = byId.get(aId);
    const kb = byId.get(bId);
    if (!ka || !kb || !ka.visible || !kb.visible) continue;
    const a = imageToScreen(keypointPos(fig, ka), view);
    const b = imageToScreen(keypointPos(fig, kb), view);
    const col = colorFor.get(boneKey(aId, bId)) ?? [200, 200, 200];
    ctx.strokeStyle = rgb(col);
    ctx.globalAlpha = active ? 0.95 : 0.5;
    ctx.lineWidth = active ? 5 : 3;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // joints
  for (const k of fig.keypoints) {
    if (!k.visible) continue;
    const s = imageToScreen(keypointPos(fig, k), view);
    const col = pointColor(k.id);
    const isSel = k.id === selected;
    const r = isSel ? 6 : active ? 4.5 : 3.5;
    // low-confidence ring
    if (k.confidence < 0.35) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 3, 0, Math.PI * 2);
      ctx.strokeStyle = "#e0b060";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = rgb(col);
    ctx.globalAlpha = active ? 1 : 0.6;
    ctx.fill();
    if (isSel) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

function drawOnion(ctx: CanvasRenderingContext2D, fig: Figure, view: ViewTransform) {
  const by = new Map(fig.keypoints.map((k) => [k.id, k]));
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.strokeStyle = "#8aa0b8";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  for (const [aId, bId] of fig.bones) {
    const ka = by.get(aId);
    const kb = by.get(bId);
    if (!ka || !kb || !ka.visible || !kb.visible) continue;
    const a = imageToScreen(keypointPos(fig, ka), view);
    const b = imageToScreen(keypointPos(fig, kb), view);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

// --- styles -----------------------------------------------------------------
const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "#000c",
  display: "grid",
  placeItems: "center",
  zIndex: 70,
};
const panel: React.CSSProperties = {
  width: "94vw",
  height: "92vh",
  background: "#12151a",
  border: "1px solid #2a2f37",
  borderRadius: 12,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  color: "#e2e8f0",
  font: "13px ui-sans-serif, system-ui, sans-serif",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  borderBottom: "1px solid #20242b",
};
const toolbar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 14px",
  borderBottom: "1px solid #20242b",
  background: "#0f1216",
};
const toolBtn: React.CSSProperties = {
  border: "1px solid #2a2f37",
  background: "#181c22",
  color: "#cbd5e1",
  borderRadius: 5,
  minWidth: 26,
  padding: "3px 7px",
  cursor: "pointer",
  fontSize: 12,
};
const ghostBtn: React.CSSProperties = {
  border: "1px solid #2a2f37",
  background: "transparent",
  color: "#cbd5e1",
  borderRadius: 6,
  padding: "6px 14px",
  cursor: "pointer",
};
const applyBtn: React.CSSProperties = {
  border: "none",
  background: AMBER,
  color: "#1a160e",
  borderRadius: 6,
  padding: "6px 16px",
  cursor: "pointer",
  fontWeight: 700,
};
const inspector: React.CSSProperties = {
  width: 232,
  flex: "0 0 232px",
  borderLeft: "1px solid #20242b",
  background: "#0f1216",
  padding: "10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  overflowY: "auto",
};
const miniBtn: React.CSSProperties = {
  border: "1px solid #2a2f37",
  background: "#181c22",
  color: "#cbd5e1",
  borderRadius: 5,
  padding: "4px 9px",
  cursor: "pointer",
  fontSize: 11,
};
const chip: React.CSSProperties = {
  border: "1px solid #2b313c",
  background: "#181c22",
  color: "#cbd5e1",
  borderRadius: 5,
  padding: "3px 8px",
  cursor: "pointer",
  fontSize: 11,
};

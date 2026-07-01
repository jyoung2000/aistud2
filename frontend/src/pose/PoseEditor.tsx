import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COLOR_GENERATION } from "../constants";
import {
  fitTransform,
  imageToScreen,
  screenToImage,
  zoomAtPoint,
  type ViewTransform,
} from "../canvas/coords";
import {
  BODY_LIMBS,
  LIMB_COLORS,
  boneKey,
  clonePose,
  figureCenter,
  keypointPos,
  pointColor,
  rgb,
  type Figure,
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

  const dragRef = useRef<
    | { kind: "pan"; startView: ViewTransform; sx: number; sy: number }
    | { kind: "joint"; id: string; figId: string }
    | null
  >(null);
  const spaceRef = useRef(false);

  // Reset editable pose whenever we (re)open with a new source pose.
  useEffect(() => {
    if (open) {
      setPose(clonePose(initialPose));
      setActiveFig(initialPose.figures[0]?.id ?? "fig1");
      setSelected(null);
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

    // rig
    for (const fig of pose.figures) drawFigure(ctx, fig, view, fig.id === activeFig, selected);
  }, [pose, view, vp, ghost, imgReady, width, height, activeFig, selected]);

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
      // Drag a joint: convert screen→image, then invert the figure transform so we store the
      // raw (pre-transform) keypoint. For the P2 identity transform this is a direct map.
      const img = screenToImage({ x: sx, y: sy }, view);
      setPose((p) => moveKeypointRaw(p, d.figId, d.id, img.x, img.y, width, height));
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    try {
      canvasRef.current!.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    dragRef.current = null;
  };

  // space = temporary pan; Esc = cancel
  useEffect(() => {
    if (!open) return;
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = true;
      if (e.key === "Escape") onClose();
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
  }, [open, onClose]);

  const fit = () => setView(fitTransform(width, height, vp.w, vp.h));

  const lowConf = useMemo(
    () => pose.figures.reduce((n, f) => n + f.keypoints.filter((k) => k.visible && k.confidence < 0.35).length, 0),
    [pose]
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

        {/* canvas */}
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
      </div>
    </div>
  );
}

// --- pose ops ---------------------------------------------------------------

/** Set a keypoint's raw (pre-transform) position, clamped to the image. */
function moveKeypointRaw(
  p: Pose,
  figId: string,
  kpId: string,
  x: number,
  y: number,
  w: number,
  h: number
): Pose {
  const next = clonePose(p);
  const fig = next.figures.find((f) => f.id === figId);
  if (!fig) return p;
  const k = fig.keypoints.find((kk) => kk.id === kpId);
  if (!k) return p;
  k.x = Math.min(Math.max(x, 0), w);
  k.y = Math.min(Math.max(y, 0), h);
  return next;
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

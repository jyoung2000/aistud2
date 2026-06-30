import { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Image as KImage, Line } from "react-konva";
import { COLOR_SELECTION } from "../constants";
import {
  fitTransform,
  screenToImage,
  zoomAtPoint,
  type Pt,
  type ViewTransform,
} from "./coords";
import { MaskBuffer, opFromModifiers } from "./maskBuffer";

type Tool = "select" | "hand";

function maskToCanvas(mask: MaskBuffer): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = mask.width;
  c.height = mask.height;
  const ctx = c.getContext("2d")!;
  const rgba = mask.toRGBA([34, 211, 238], 96); // cyan
  const id = ctx.createImageData(mask.width, mask.height);
  id.data.set(rgba);
  ctx.putImageData(id, 0, 0);
  return c;
}

function stampDisc(mask: MaskBuffer, center: Pt, radius: number): Uint8Array {
  const inc = new Uint8Array(mask.width * mask.height);
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(center.x - radius));
  const x1 = Math.min(mask.width - 1, Math.ceil(center.x + radius));
  const y0 = Math.max(0, Math.floor(center.y - radius));
  const y1 = Math.min(mask.height - 1, Math.ceil(center.y + radius));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - center.x;
      const dy = y + 0.5 - center.y;
      if (dx * dx + dy * dy <= r2) inc[y * mask.width + x] = 255;
    }
  return inc;
}

export function CanvasStage() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ w: 800, h: 600 });
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [t, setT] = useState<ViewTransform>({ scale: 1, x: 0, y: 0 });
  const [mask, setMask] = useState<MaskBuffer | null>(null);
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [dash, setDash] = useState(0);
  const [, force] = useState(0);
  const [tool, setTool] = useState<Tool>("select");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);

  // gesture refs (avoid re-renders mid-drag)
  const drag = useRef<{ start: Pt; startT: ViewTransform; pan: boolean; moved: boolean; down: Pt } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setVp({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // marching-ants animation
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setDash((d) => (d + 0.4) % 8);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // keyboard: spacebar temp-hand (ignore autorepeat) + zoom shortcuts
  useEffect(() => {
    const center = (): Pt => ({ x: vp.w / 2, y: vp.h / 2 });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat) {
        // don't hijack space while typing in an input
        const el = document.activeElement;
        if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
        e.preventDefault();
        setSpaceHeld(true);
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setT((cur) => zoomAtPoint(cur, center(), 1.2));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setT((cur) => zoomAtPoint(cur, center(), 1 / 1.2));
      } else if (e.key === "0") {
        e.preventDefault();
        if (img) setT(fitTransform(img.naturalWidth, img.naturalHeight, vp.w, vp.h));
      } else if (e.key === "1") {
        e.preventDefault();
        setT((cur) => zoomAtPoint(cur, center(), 1 / cur.scale));
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [vp.w, vp.h, img]);

  const maskCanvas = useMemo(
    () => (mask && !mask.isEmpty() ? maskToCanvas(mask) : null),
    [mask, force]
  );
  const loops = useMemo(() => (mask ? mask.outline() : []), [mask, maskCanvas]);

  const openFile = (file: File) => {
    const url = URL.createObjectURL(file);
    const image = new window.Image();
    image.onload = () => {
      setImg(image);
      setMask(new MaskBuffer(image.naturalWidth, image.naturalHeight));
      setT(fitTransform(image.naturalWidth, image.naturalHeight, vp.w, vp.h));
      URL.revokeObjectURL(url);
    };
    image.src = url;
  };

  const ptr = (e: any): Pt | null => e.target.getStage()?.getPointerPosition() ?? null;

  const onWheel = (e: any) => {
    e.evt.preventDefault();
    const p = ptr(e);
    if (!p) return;
    const factor = e.evt.deltaY < 0 ? 1.1 : 1 / 1.1; // zoom to cursor
    setT((cur) => zoomAtPoint(cur, p, factor));
  };

  const wantPan = (button: number) => spaceHeld || tool === "hand" || button === 1;

  const onMouseDown = (e: any) => {
    const p = ptr(e);
    if (!p || !img) return;
    const pan = wantPan(e.evt.button);
    drag.current = { start: p, startT: t, pan, moved: false, down: p };
    if (pan) {
      e.evt.preventDefault();
      setPanning(true);
    }
  };

  const onMouseMove = (e: any) => {
    const p = ptr(e);
    const d = drag.current;
    if (d && p) {
      if (Math.hypot(p.x - d.down.x, p.y - d.down.y) > 3) d.moved = true;
      if (d.pan) {
        setT({ scale: d.startT.scale, x: d.startT.x + (p.x - d.start.x), y: d.startT.y + (p.y - d.start.y) });
        return;
      }
    }
    setCursor(p ? screenToImage(p, t) : null);
  };

  const endDrag = (e: any) => {
    const d = drag.current;
    const p = ptr(e);
    if (d && !d.pan && !d.moved && p && mask && img) {
      // temporary select stamp (until Phase 3) — exercises shared mask + ops + ants
      const ip = screenToImage(p, t);
      const radius = Math.max(8, Math.min(mask.width, mask.height) * 0.06);
      mask.apply(stampDisc(mask, ip, radius), opFromModifiers(e.evt.shiftKey, e.evt.altKey));
      // eslint-disable-next-line no-console
      console.log(`click image-space: (${ip.x.toFixed(2)}, ${ip.y.toFixed(2)}) @ ${(t.scale * 100).toFixed(0)}%`);
      force((n) => n + 1);
    }
    drag.current = null;
    setPanning(false);
  };

  const cursorStyle = !img
    ? "default"
    : panning
    ? "grabbing"
    : spaceHeld || tool === "hand"
    ? "grab"
    : "crosshair";

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      <ZoomBar
        zoom={t.scale}
        cursor={cursor}
        hasImage={!!img}
        tool={tool}
        onTool={setTool}
        onOpen={openFile}
        onIn={() => setT((c) => zoomAtPoint(c, { x: vp.w / 2, y: vp.h / 2 }, 1.25))}
        onOut={() => setT((c) => zoomAtPoint(c, { x: vp.w / 2, y: vp.h / 2 }, 1 / 1.25))}
        onFit={() => img && setT(fitTransform(img.naturalWidth, img.naturalHeight, vp.w, vp.h))}
        onActual={() => setT((c) => zoomAtPoint(c, { x: vp.w / 2, y: vp.h / 2 }, 1 / c.scale))}
      />
      <div ref={wrapRef} style={{ flex: 1, position: "relative", background: "#0a0c0f", minHeight: 0 }}>
        {!img && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#3f4753" }}>
            Open an image to begin
          </div>
        )}
        <Stage
          width={vp.w}
          height={vp.h}
          scaleX={t.scale}
          scaleY={t.scale}
          x={t.x}
          y={t.y}
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endDrag}
          onMouseLeave={(e: any) => {
            setCursor(null);
            if (drag.current) endDrag(e);
          }}
          style={{ cursor: cursorStyle }}
        >
          <Layer imageSmoothingEnabled={t.scale < 4}>
            {img && <KImage image={img} x={0} y={0} />}
            {maskCanvas && <KImage image={maskCanvas} x={0} y={0} listening={false} />}
            {loops.map((loop, i) => (
              <Line
                key={i}
                points={loop.flatMap((p) => [p.x, p.y])}
                closed
                stroke={COLOR_SELECTION}
                strokeWidth={1 / t.scale}
                dash={[4 / t.scale, 4 / t.scale]}
                dashOffset={dash / t.scale}
                listening={false}
                perfectDrawEnabled={false}
              />
            ))}
          </Layer>
        </Stage>
      </div>
    </div>
  );
}

function ZoomBar({
  zoom,
  cursor,
  hasImage,
  tool,
  onTool,
  onOpen,
  onIn,
  onOut,
  onFit,
  onActual,
}: {
  zoom: number;
  cursor: Pt | null;
  hasImage: boolean;
  tool: Tool;
  onTool: (t: Tool) => void;
  onOpen: (f: File) => void;
  onIn: () => void;
  onOut: () => void;
  onFit: () => void;
  onActual: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const btn: React.CSSProperties = {
    background: "#181c22",
    color: "#cbd5e1",
    border: "1px solid #2a2f37",
    borderRadius: 5,
    padding: "4px 9px",
    fontSize: 12,
    cursor: "pointer",
  };
  const toolBtn = (active: boolean): React.CSSProperties => ({
    ...btn,
    background: active ? "#22d3ee22" : btn.background,
    borderColor: active ? "#22d3ee" : "#2a2f37",
    color: active ? "#22d3ee" : "#cbd5e1",
  });
  return (
    <div
      style={{
        height: 36,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 10px",
        borderBottom: "1px solid #20242b",
        background: "#101317",
        font: "12px ui-monospace, monospace",
        color: "#94a3b8",
      }}
    >
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => e.target.files?.[0] && onOpen(e.target.files[0])}
      />
      <button style={btn} onClick={() => fileRef.current?.click()}>
        Open image
      </button>
      <span style={{ width: 1, height: 18, background: "#2a2f37" }} />
      <button style={toolBtn(tool === "select")} onClick={() => onTool("select")} title="Select (V)">
        ⬚ Select
      </button>
      <button style={toolBtn(tool === "hand")} onClick={() => onTool("hand")} title="Hand — pan (H, or hold Space)">
        ✋ Hand
      </button>
      <span style={{ width: 1, height: 18, background: "#2a2f37" }} />
      <button style={btn} disabled={!hasImage} onClick={onOut}>
        −
      </button>
      <span style={{ width: 52, textAlign: "center", color: "#e2e8f0" }}>{(zoom * 100).toFixed(0)}%</span>
      <button style={btn} disabled={!hasImage} onClick={onIn}>
        +
      </button>
      <button style={btn} disabled={!hasImage} onClick={onFit}>
        Fit
      </button>
      <button style={btn} disabled={!hasImage} onClick={onActual}>
        100%
      </button>
      <span style={{ marginLeft: "auto" }}>
        {cursor ? `x ${cursor.x.toFixed(0)}  y ${cursor.y.toFixed(0)}` : "—"}
      </span>
    </div>
  );
}

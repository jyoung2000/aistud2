import { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Image as KImage, Line, Circle, Rect } from "react-konva";
import { COLOR_SELECTION } from "../constants";
import {
  fitTransform,
  screenToImage,
  zoomAtPoint,
  type Pt,
  type ViewTransform,
} from "./coords";
import { MaskBuffer, opFromModifiers, type BoolOp } from "./maskBuffer";
import { rasterizePolygon, dist, constrain45, flatten } from "./lasso";
import { LiveWire } from "./livewire";
import {
  emptyPath,
  flattenPath,
  mirror,
  nearestAnchor,
  nearestHandle,
  nearestSegment,
  type Anchor,
  type PenPath,
} from "./manualPen";
import {
  loadImageToSidecar,
  refineMask,
  smartSelect,
  fetchCostMap,
  type SamPoint,
} from "../api/select";
import {
  generate,
  runToCompletion,
  maskToPngDataUrl,
  resultToImage,
  type HarmonizeOpts,
} from "../api/generate";
import { COLOR_GENERATION } from "../constants";
import {
  composite as compositeDoc,
  newLayerId,
  serializeDoc,
  deserializeDoc,
  type BlendMode,
  type Layer as DocLayer,
  type DocTransform,
  type AdjustSpec,
} from "./document";
import { b64ToFile } from "../api/generate";
import { LayersPanel } from "../panels/layersPanel";

type Tool = "select" | "lasso" | "pen" | "hand";
type LassoMode = "free" | "poly" | "magnetic";

function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

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

export function CanvasStage() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ w: 800, h: 600 });
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [t, setT] = useState<ViewTransform>({ scale: 1, x: 0, y: 0 });
  const [mask, setMask] = useState<MaskBuffer | null>(null);
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [dash, setDash] = useState(0);
  const [tool, setTool] = useState<Tool>("select");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [imageId, setImageId] = useState<string | null>(null);
  const [backend, setBackend] = useState<string | null>(null);
  const [samPoints, setSamPoints] = useState<SamPoint[]>([]);
  const [busy, setBusy] = useState(false);

  // lasso state
  const [lassoMode, setLassoMode] = useState<LassoMode>("magnetic");
  const [lassoPts, setLassoPts] = useState<Pt[]>([]);
  const [lassoCursor, setLassoCursor] = useState<Pt | null>(null);
  const [preview, setPreview] = useState<Pt[]>([]); // magnetic live segment
  const lassoOp = useRef<BoolOp>("replace");
  const wire = useRef<LiveWire | null>(null);
  const freehand = useRef(false);

  // manual pen
  const [pen, setPen] = useState<PenPath>(emptyPath());
  const [penSel, setPenSel] = useState(-1);
  const penDrag = useRef<{ kind: "anchor" | "in" | "out" | "new"; index: number } | null>(null);
  const penOp = useRef<BoolOp>("replace");

  // generation
  const [prompt, setPrompt] = useState("");
  const [genStatus, setGenStatus] = useState<"idle" | "busy" | "polling" | "done" | "failed">("idle");
  const [history, setHistory] = useState<{ url: string; prompt: string }[]>([]);
  const [harmonize, setHarmonize] = useState<HarmonizeOpts>({
    on: true,
    colorMatch: true,
    relight: true,
    grainMatch: true,
    strength: 0.6,
  });

  // layer document — `img` is the base (never replaced after open); edits become layers.
  const [layers, setLayers] = useState<DocLayer[]>([]);
  const layerImgs = useRef<Map<string, HTMLImageElement>>(new Map());
  const [imgVer, setImgVer] = useState(0); // bump when a layer image finishes loading
  const [activeLayer, setActiveLayer] = useState<string | null>(null);
  const [baseThumb, setBaseThumb] = useState<string | null>(null);
  const [docTransform, setDocTransform] = useState<DocTransform>({ straighten: 0 });

  const composite = useMemo(() => {
    if (!img) return null;
    return compositeDoc(img, img.naturalWidth, img.naturalHeight, layers, layerImgs.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, layers, imgVer]);

  const thumbs = useMemo(() => {
    const m = new Map<string, string>();
    layers.forEach((L) => L.resultUrl && m.set(L.id, L.resultUrl));
    return m;
  }, [layers]);

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

  // selection keyboard: lasso + pen editing, invert
  useEffect(() => {
    const typing = () => {
      const el = document.activeElement;
      return !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    };
    const onKey = (e: KeyboardEvent) => {
      if (typing()) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        invertMask(); // Cmd/Ctrl+Shift+I — invert (subject -> background)
        return;
      }
      if (e.key === "L" && e.shiftKey) {
        e.preventDefault();
        setTool("lasso");
        setLassoMode((m) => (m === "free" ? "poly" : m === "poly" ? "magnetic" : "free"));
        cancelLasso();
        return;
      }
      if (tool === "lasso") {
        if (e.key === "Enter" && lassoPts.length > 2) {
          e.preventDefault();
          commitLasso(lassoPts);
        } else if (e.key === "Backspace" && lassoPts.length > 0) {
          e.preventDefault();
          const np = lassoPts.slice(0, -1);
          setLassoPts(np);
          if (lassoMode === "magnetic" && np.length) wire.current?.setSeed(np[np.length - 1]);
        } else if (e.key === "Escape") {
          cancelLasso();
        } else if ((e.key === "[" || e.key === "]") && wire.current) {
          const w = wire.current;
          w.windowRadius = Math.max(60, Math.min(600, w.windowRadius + (e.key === "]" ? 40 : -40)));
          if (lassoPts.length) w.setSeed(lassoPts[lassoPts.length - 1]);
        }
      } else if (tool === "pen") {
        if (e.key === "Enter") {
          e.preventDefault();
          commitPen();
        } else if ((e.key === "Backspace" || e.key === "Delete") && penSel >= 0) {
          e.preventDefault();
          const arr = pen.anchors.filter((_, i) => i !== penSel);
          setPen({ ...pen, anchors: arr });
          setPenSel(-1);
        } else if (e.key === "Escape") {
          cancelPen();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, lassoPts, lassoMode, pen, penSel, mask]);

  // undo/redo keyboard (fresh closures via deps; zoom/pan are NOT on the stack)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "z" || e.key === "Z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (e.key === "y" || e.key === "Y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mask, img, imageId, backend, layers, activeLayer]);

  const maskCanvas = useMemo(
    () => (mask && !mask.isEmpty() ? maskToCanvas(mask) : null),
    [mask]
  );
  const loops = useMemo(() => (mask ? mask.outline() : []), [mask, maskCanvas]);

  const lassoDraw: Pt[] =
    tool === "lasso" && lassoPts.length
      ? lassoMode === "poly"
        ? lassoCursor
          ? [...lassoPts, lassoCursor]
          : lassoPts
        : lassoMode === "magnetic"
        ? preview.length
          ? [...lassoPts, ...preview.slice(1)]
          : lassoPts
        : lassoPts
      : [];

  const openFile = (file: File) => {
    const url = URL.createObjectURL(file);
    const image = new window.Image();
    image.onload = () => {
      setImg(image);
      setMask(new MaskBuffer(image.naturalWidth, image.naturalHeight));
      setT(fitTransform(image.naturalWidth, image.naturalHeight, vp.w, vp.h));
      setSamPoints([]);
      // reset the layer document for the new base
      setLayers([]);
      layerImgs.current.clear();
      setActiveLayer(null);
      undoStack.current = [];
      redoStack.current = [];
      // base thumbnail for the layers panel
      const tc = document.createElement("canvas");
      const s = 80 / Math.max(image.naturalWidth, image.naturalHeight);
      tc.width = Math.max(1, Math.round(image.naturalWidth * s));
      tc.height = Math.max(1, Math.round(image.naturalHeight * s));
      tc.getContext("2d")!.drawImage(image, 0, 0, tc.width, tc.height);
      setBaseThumb(tc.toDataURL("image/png"));
      URL.revokeObjectURL(url);
    };
    image.src = url;
    // Upload to the sidecar so SAM 2 can encode it (degrades to the CPU fallback).
    setImageId(null);
    setBackend(null);
    loadImageToSidecar(file)
      .then((r) => {
        setImageId(r.id);
        setBackend(r.backend);
      })
      .catch((e) => console.error("load to sidecar failed:", e));
  };

  // Run a smart-select and replace the working mask with the result.
  const runSelect = async (
    points: SamPoint[],
    box: [number, number, number, number] | null
  ) => {
    if (!imageId || !mask) return;
    pushHistory();
    setSamPoints(points);
    setBusy(true);
    try {
      const r = await smartSelect(imageId, points, box);
      setMask(new MaskBuffer(r.width, r.height, r.data));
      setBackend(r.backend);
    } catch (e) {
      console.error("select failed:", e);
    } finally {
      setBusy(false);
    }
  };

  const runRefine = async () => {
    if (!imageId || !mask || mask.isEmpty()) return;
    pushHistory();
    setBusy(true);
    try {
      const data = await refineMask(imageId, mask.data, mask.width, mask.height);
      setMask(new MaskBuffer(mask.width, mask.height, data));
    } catch (e) {
      console.error("refine failed:", e);
    } finally {
      setBusy(false);
    }
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
      return;
    }
    if (tool === "lasso" && lassoMode === "free") {
      // freehand: drag samples points; release closes
      const ip = screenToImage(p, t);
      lassoOp.current = opFromModifiers(e.evt.shiftKey, e.evt.altKey);
      freehand.current = true;
      setLassoPts([ip]);
    } else if (tool === "pen") {
      penDown(screenToImage(p, t), e);
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
    const ip = p ? screenToImage(p, t) : null;
    setCursor(ip);
    if (tool === "pen" && ip && penDrag.current) {
      penMove(ip);
      return;
    }
    if (tool === "lasso" && ip) {
      setLassoCursor(ip);
      if (freehand.current) {
        setLassoPts((pts) => (pts.length === 0 || dist(pts[pts.length - 1], ip) > 2 / t.scale ? [...pts, ip] : pts));
      } else if (lassoMode === "magnetic" && wire.current && lassoPts.length > 0) {
        setPreview(wire.current.pathTo(ip) ?? [lassoPts[lassoPts.length - 1], ip]);
      }
    }
  };

  const endDrag = (e: any) => {
    const d = drag.current;
    const p = ptr(e);
    drag.current = null;
    setPanning(false);
    if (tool === "pen") {
      penDrag.current = null;
      return;
    }
    if (!d || d.pan || !p || !mask || !img) return;

    if (tool === "lasso") {
      const ip = screenToImage(p, t);
      if (lassoMode === "free" && freehand.current) {
        freehand.current = false;
        commitLasso([...lassoPts, ip]);
      } else if (!d.moved) {
        void lassoClick(ip, e);
      }
      return;
    }
    if (tool !== "select") return;

    if (d.moved) {
      // box prompt → GrabCut / SAM box
      const a = screenToImage(d.down, t);
      const b = screenToImage(p, t);
      const box: [number, number, number, number] = [
        Math.min(a.x, b.x),
        Math.min(a.y, b.y),
        Math.max(a.x, b.x),
        Math.max(a.y, b.y),
      ];
      void runSelect([], box);
    } else {
      // point prompt. plain = new positive; Shift = add positive; Alt = negative.
      const ip = screenToImage(p, t);
      const label: 0 | 1 = e.evt.altKey ? 0 : 1;
      const accumulate = e.evt.shiftKey || e.evt.altKey;
      const next: SamPoint[] = accumulate
        ? [...samPoints, { x: ip.x, y: ip.y, label }]
        : [{ x: ip.x, y: ip.y, label }];
      void runSelect(next, null);
    }
  };

  // --- lasso ---
  const commitLasso = (pts: Pt[]) => {
    if (!mask || pts.length < 3) {
      cancelLasso();
      return;
    }
    pushHistory();
    const inc = rasterizePolygon(pts, mask.width, mask.height);
    const next = mask.clone();
    next.apply(inc, lassoOp.current);
    setMask(next);
    cancelLasso();
  };
  const cancelLasso = () => {
    setLassoPts([]);
    setPreview([]);
    setLassoCursor(null);
    freehand.current = false;
    wire.current = null;
  };
  const closeThreshold = () => 10 / t.scale; // screen px tolerance in image space

  const ensureWire = async () => {
    if (wire.current || !imageId) return;
    try {
      const cm = await fetchCostMap(imageId, 1.0);
      wire.current = new LiveWire(cm.cost, cm.w, cm.h, cm.scale);
    } catch (e) {
      console.error("costmap failed:", e);
    }
  };

  // a click in lasso mode (poly / magnetic anchors)
  const lassoClick = async (ip: Pt, e: any) => {
    if (lassoPts.length === 0) lassoOp.current = opFromModifiers(e.evt.shiftKey, e.evt.altKey);
    const near = lassoPts.length > 2 && dist(ip, lassoPts[0]) < closeThreshold();

    if (lassoMode === "poly") {
      const prev = lassoPts[lassoPts.length - 1];
      const pt = e.evt.shiftKey && prev ? constrain45(prev, ip) : ip;
      if (near) commitLasso(lassoPts);
      else setLassoPts((p) => [...p, pt]);
      return;
    }
    // magnetic
    await ensureWire();
    if (lassoPts.length === 0) {
      wire.current?.setSeed(ip);
      setLassoPts([ip]);
      return;
    }
    const seg = wire.current?.pathTo(ip) ?? [ip];
    const merged = [...lassoPts, ...seg.slice(1)];
    if (near) commitLasso(merged);
    else {
      setLassoPts(merged);
      wire.current?.setSeed(ip);
      setPreview([]);
    }
  };

  // --- manual pen ---
  const penDown = (ip: Pt, e: any) => {
    const r = 9 / t.scale;
    const h = nearestHandle(pen, ip, r);
    if (h) {
      penDrag.current = { kind: h.which, index: h.index };
      setPenSel(h.index);
      return;
    }
    const ai = nearestAnchor(pen, ip, r);
    if (ai >= 0) {
      if (e.evt.altKey) {
        toggleSmooth(ai);
        return;
      }
      if (ai === 0 && pen.anchors.length > 2 && !pen.closed) {
        setPen({ ...pen, closed: true });
        setPenSel(0);
        return;
      }
      penDrag.current = { kind: "anchor", index: ai };
      setPenSel(ai);
      return;
    }
    const seg = nearestSegment(pen, ip, r);
    if (seg) {
      const a: Anchor = { p: seg.point, hIn: null, hOut: null, smooth: false };
      const arr = [...pen.anchors];
      arr.splice(seg.index + 1, 0, a);
      setPen({ ...pen, anchors: arr });
      setPenSel(seg.index + 1);
      penDrag.current = { kind: "anchor", index: seg.index + 1 };
      return;
    }
    if (pen.anchors.length === 0) penOp.current = opFromModifiers(e.evt.shiftKey, e.evt.altKey);
    if (pen.closed) return; // closed path: no extending
    const a: Anchor = { p: ip, hIn: null, hOut: null, smooth: false };
    const arr = [...pen.anchors, a];
    setPen({ ...pen, anchors: arr });
    setPenSel(arr.length - 1);
    penDrag.current = { kind: "new", index: arr.length - 1 };
  };

  const penMove = (ip: Pt) => {
    const dr = penDrag.current;
    if (!dr) return;
    const arr = pen.anchors.map((a) => ({
      p: { ...a.p },
      hIn: a.hIn ? { ...a.hIn } : null,
      hOut: a.hOut ? { ...a.hOut } : null,
      smooth: a.smooth,
    }));
    const a = arr[dr.index];
    if (dr.kind === "anchor") {
      const dx = ip.x - a.p.x;
      const dy = ip.y - a.p.y;
      a.p = ip;
      if (a.hIn) a.hIn = { x: a.hIn.x + dx, y: a.hIn.y + dy };
      if (a.hOut) a.hOut = { x: a.hOut.x + dx, y: a.hOut.y + dy };
    } else if (dr.kind === "out" || dr.kind === "new") {
      a.hOut = ip;
      a.smooth = true;
      a.hIn = mirror(a.p, ip);
    } else {
      a.hIn = ip;
      a.smooth = true;
      a.hOut = mirror(a.p, ip);
    }
    setPen({ ...pen, anchors: arr });
  };

  const toggleSmooth = (ai: number) => {
    const arr = [...pen.anchors];
    const a = { ...arr[ai] };
    if (a.smooth) {
      a.smooth = false;
      a.hIn = null;
      a.hOut = null;
    } else {
      a.smooth = true;
      const n = arr.length;
      const prev = arr[(ai - 1 + n) % n].p;
      const next = arr[(ai + 1) % n].p;
      const d = { x: (next.x - prev.x) / 4, y: (next.y - prev.y) / 4 };
      a.hOut = { x: a.p.x + d.x, y: a.p.y + d.y };
      a.hIn = { x: a.p.x - d.x, y: a.p.y - d.y };
    }
    arr[ai] = a;
    setPen({ ...pen, anchors: arr });
  };

  const cancelPen = () => {
    setPen(emptyPath());
    setPenSel(-1);
    penDrag.current = null;
  };
  const commitPen = () => {
    if (!mask || pen.anchors.length < 3) {
      cancelPen();
      return;
    }
    pushHistory();
    const poly = flattenPath({ ...pen, closed: true });
    const next = mask.clone();
    next.apply(rasterizePolygon(poly, mask.width, mask.height), penOp.current);
    setMask(next);
    cancelPen();
  };
  const invertMask = () => {
    if (!mask) return;
    pushHistory();
    const next = mask.clone();
    next.invert();
    setMask(next);
  };

  // --- history (undo/redo) — selection commits + edits only; zoom/pan stay off the stack ---
  type Snap = {
    mask: MaskBuffer | null;
    imageId: string | null;
    backend: string | null;
    layers: DocLayer[];
    activeLayer: string | null;
  };
  const undoStack = useRef<Snap[]>([]);
  const redoStack = useRef<Snap[]>([]);
  const [, setHistTick] = useState(0);
  const cloneLayer = (L: DocLayer): DocLayer => ({ ...L, mask: L.mask ? new Uint8Array(L.mask) : undefined });
  const snapshot = (): Snap => ({
    mask: mask ? mask.clone() : null,
    imageId,
    backend,
    layers: layers.map(cloneLayer),
    activeLayer,
  });
  const pushHistory = () => {
    undoStack.current.push(snapshot());
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = [];
    setHistTick((n) => n + 1);
  };
  const restore = (s: Snap) => {
    setMask(s.mask ? s.mask.clone() : null);
    setImageId(s.imageId);
    setBackend(s.backend);
    setLayers(s.layers.map(cloneLayer));
    setActiveLayer(s.activeLayer);
    setImgVer((v) => v + 1);
    setSamPoints([]);
    cancelLasso();
    cancelPen();
    setHistTick((n) => n + 1);
  };
  const undo = () => {
    const s = undoStack.current.pop();
    if (!s) return;
    redoStack.current.push(snapshot());
    restore(s);
  };
  const redo = () => {
    const s = redoStack.current.pop();
    if (!s) return;
    undoStack.current.push(snapshot());
    restore(s);
  };

  // --- export (composite + non-destructive crop/straighten) ---
  const exportPng = () => {
    const c = exportCanvas();
    if (!c) return;
    c.toBlob((b) => b && downloadBlob(b, "neuclip-export.png"), "image/png");
  };
  const exportCutout = () => {
    if (!img || !mask || mask.isEmpty() || !composite) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(composite, 0, 0);
    const id = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < mask.data.length; i++) id.data[i * 4 + 3] = mask.data[i] ? 255 : 0;
    ctx.putImageData(id, 0, 0);
    c.toBlob((b) => b && downloadBlob(b, "neuclip-cutout.png"), "image/png");
  };

  // --- layer ops ---
  const updateLayer = (id: string, patch: Partial<DocLayer>) =>
    setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const toggleVisible = (id: string) => {
    pushHistory();
    const cur = layers.find((l) => l.id === id);
    updateLayer(id, { visible: !cur?.visible });
    setImgVer((v) => v + 1);
  };
  const setLayerOpacity = (id: string, v: number) => {
    updateLayer(id, { opacity: v });
    setImgVer((x) => x + 1);
  };
  const setLayerBlend = (id: string, m: BlendMode) => {
    pushHistory();
    updateLayer(id, { blendMode: m });
    setImgVer((v) => v + 1);
  };
  const deleteLayer = (id: string) => {
    pushHistory();
    setLayers((ls) => ls.filter((l) => l.id !== id));
    if (activeLayer === id) setActiveLayer(null);
    setImgVer((v) => v + 1);
  };
  const reorderLayer = (id: string, dir: -1 | 1) => {
    pushHistory();
    setLayers((ls) => {
      const i = ls.findIndex((l) => l.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ls.length) return ls;
      const a = [...ls];
      [a[i], a[j]] = [a[j], a[i]];
      return a;
    });
    setImgVer((v) => v + 1);
  };
  const editLayer = (id: string) => {
    const L = layers.find((l) => l.id === id);
    if (!L || !img) return;
    setActiveLayer(id);
    if (L.source) setPrompt(L.source.prompt);
    if (L.mask) setMask(new MaskBuffer(img.naturalWidth, img.naturalHeight, new Uint8Array(L.mask)));
    setTool("select");
  };
  const addAdjustment = () => {
    if (!img) return;
    pushHistory();
    const id = newLayerId();
    const layer: DocLayer = {
      id,
      name: "Adjustment",
      visible: true,
      opacity: 1,
      blendMode: "normal",
      kind: "adjustment",
      adjust: { values: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, vibrance: 0 }, clip: false },
    };
    setLayers((ls) => [...ls, layer]);
    setActiveLayer(id);
    setImgVer((v) => v + 1);
  };
  const setLayerAdjust = (id: string, adjust: AdjustSpec) => {
    updateLayer(id, { adjust });
    setImgVer((v) => v + 1);
  };

  // --- project save / open (.neuclip) ---
  const imgToDataUrl = (image: HTMLImageElement): string => {
    const c = document.createElement("canvas");
    c.width = image.naturalWidth;
    c.height = image.naturalHeight;
    c.getContext("2d")!.drawImage(image, 0, 0);
    return c.toDataURL("image/png");
  };
  const saveProject = () => {
    if (!img) return;
    const json = serializeDoc(img.naturalWidth, img.naturalHeight, imgToDataUrl(img), layers, docTransform);
    downloadBlob(new Blob([json], { type: "application/json" }), "neuclip-project.neuclip");
  };
  const openProject = async (file: File) => {
    const text = await file.text();
    const d = await deserializeDoc(text);
    setImg(d.baseImg);
    setLayers(d.layers);
    layerImgs.current = d.layerImgs;
    setDocTransform(d.transform ?? { straighten: 0 });
    setMask(new MaskBuffer(d.width, d.height));
    setActiveLayer(null);
    setSamPoints([]);
    setT(fitTransform(d.width, d.height, vp.w, vp.h));
    setImgVer((v) => v + 1);
    undoStack.current = [];
    redoStack.current = [];
    const tc = document.createElement("canvas");
    const s = 80 / Math.max(d.width, d.height);
    tc.width = Math.max(1, Math.round(d.width * s));
    tc.height = Math.max(1, Math.round(d.height * s));
    tc.getContext("2d")!.drawImage(d.baseImg, 0, 0, tc.width, tc.height);
    setBaseThumb(tc.toDataURL("image/png"));
    // re-upload base so selection works on the restored project
    try {
      const r = await loadImageToSidecar(await b64ToFile(imgToDataUrl(d.baseImg)));
      setImageId(r.id);
      setBackend(r.backend);
    } catch (e) {
      console.error("re-upload base failed:", e);
    }
  };

  const applyAspectCrop = (ratio: number | null) => {
    if (!img) return;
    if (ratio === null) {
      setDocTransform((tr) => ({ ...tr, crop: undefined }));
      return;
    }
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    let cw = W;
    let ch = Math.round(W / ratio);
    if (ch > H) {
      ch = H;
      cw = Math.round(H * ratio);
    }
    const x0 = Math.round((W - cw) / 2);
    const y0 = Math.round((H - ch) / 2);
    setDocTransform((tr) => ({ ...tr, crop: [x0, y0, x0 + cw - 1, y0 + ch - 1] }));
  };

  // composite with the non-destructive crop/straighten applied (for export)
  const exportCanvas = (): HTMLCanvasElement | null => {
    const src = composite ?? null;
    if (!src) return null;
    let c: HTMLCanvasElement = src;
    if (docTransform.straighten) {
      const rad = (docTransform.straighten * Math.PI) / 180;
      const rc = document.createElement("canvas");
      rc.width = src.width;
      rc.height = src.height;
      const rx = rc.getContext("2d")!;
      rx.translate(src.width / 2, src.height / 2);
      rx.rotate(rad);
      rx.drawImage(src, -src.width / 2, -src.height / 2);
      c = rc;
    }
    if (docTransform.crop) {
      const [x0, y0, x1, y1] = docTransform.crop;
      const w = Math.max(1, x1 - x0 + 1);
      const h = Math.max(1, y1 - y0 + 1);
      const cc = document.createElement("canvas");
      cc.width = w;
      cc.height = h;
      cc.getContext("2d")!.drawImage(c, x0, y0, w, h, 0, 0, w, h);
      c = cc;
    }
    return c;
  };

  // crop -> (mock model) -> feathered composite; result becomes a new ai-edit layer.
  const generateNow = async () => {
    if (!imageId || !mask || mask.isEmpty()) return;
    pushHistory();
    const maskPng = maskToPngDataUrl(mask.data, mask.width, mask.height);
    setGenStatus("busy");
    try {
      const job = await generate(imageId, maskPng, prompt, { mock: true, harmonize });
      const done = await runToCompletion(job, (s) =>
        setGenStatus(s === "polling" ? "polling" : "busy")
      );
      if (done.status === "completed" && done.result_png && img && mask) {
        const im = await resultToImage(done.result_png);
        const id = newLayerId();
        layerImgs.current.set(id, im);
        const n = layers.filter((l) => l.kind === "ai-edit").length + 1;
        const layer: DocLayer = {
          id,
          name: `AI edit ${n}`,
          visible: true,
          opacity: 1,
          blendMode: "normal",
          kind: "ai-edit",
          mask: new Uint8Array(mask.data),
          resultUrl: `data:image/png;base64,${done.result_png}`,
          source: {
            model: done.mode === "mock" ? "mock" : "wavespeed",
            prompt,
            seed: 0,
            params: {},
            sendRegion: (done.region as [number, number, number, number]) ?? [0, 0, img.naturalWidth - 1, img.naturalHeight - 1],
          },
          harmonize: { ...harmonize },
        };
        setLayers((ls) => [...ls, layer]); // top of stack
        setActiveLayer(id);
        setImgVer((v) => v + 1);
        setHistory((h) =>
          [{ url: `data:image/png;base64,${done.result_png}`, prompt }, ...h].slice(0, 12)
        );
        // the selection is captured on the layer; clear the working mask
        setMask(new MaskBuffer(img.naturalWidth, img.naturalHeight));
        setSamPoints([]);
        setGenStatus("done");
      } else {
        setGenStatus("failed");
      }
    } catch (e) {
      console.error("generate failed:", e);
      setGenStatus("failed");
    }
  };

  const cursorStyle = !img
    ? "default"
    : panning
    ? "grabbing"
    : spaceHeld || tool === "hand"
    ? "grab"
    : "crosshair";

  return (
    <div style={{ flex: 1, display: "flex", minWidth: 0 }}>
      {img && (
        <LayersPanel
          layers={layers}
          activeId={activeLayer}
          thumbs={thumbs}
          baseThumb={baseThumb}
          onSelect={setActiveLayer}
          onToggleVisible={toggleVisible}
          onOpacity={setLayerOpacity}
          onBlend={setLayerBlend}
          onDelete={deleteLayer}
          onReorder={reorderLayer}
          onEdit={editLayer}
          onAdjust={setLayerAdjust}
        />
      )}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      <FileBar
        hasImage={!!img}
        onSave={saveProject}
        onOpenProject={openProject}
        onAddAdjustment={addAdjustment}
        straighten={docTransform.straighten}
        onStraighten={(deg) => setDocTransform((tr) => ({ ...tr, straighten: deg }))}
        onAspect={applyAspectCrop}
        hasCrop={!!docTransform.crop}
      />
      <ZoomBar
        zoom={t.scale}
        cursor={cursor}
        hasImage={!!img}
        tool={tool}
        onTool={setTool}
        lassoMode={lassoMode}
        onLassoMode={setLassoMode}
        selPct={mask && !mask.isEmpty() ? (mask.area() / (mask.width * mask.height)) * 100 : 0}
        onInvert={invertMask}
        backend={backend}
        busy={busy}
        canRefine={!!mask && !mask.isEmpty()}
        onRefine={runRefine}
        onClearSel={() => {
          if (mask && !mask.isEmpty()) {
            pushHistory();
            setMask(new MaskBuffer(mask.width, mask.height));
          }
          setSamPoints([]);
        }}
        canUndo={undoStack.current.length > 0}
        canRedo={redoStack.current.length > 0}
        onUndo={undo}
        onRedo={redo}
        onExport={exportPng}
        onExportCutout={exportCutout}
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
          onDblClick={() => {
            if (tool === "lasso" && lassoPts.length > 2) commitLasso(lassoPts);
            else if (tool === "pen" && pen.anchors.length > 2) commitPen();
          }}
          onMouseLeave={(e: any) => {
            setCursor(null);
            if (drag.current && drag.current.pan) endDrag(e);
          }}
          style={{ cursor: cursorStyle }}
        >
          <Layer imageSmoothingEnabled={t.scale < 4}>
            {img && composite && <KImage image={composite} x={0} y={0} />}
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
            {samPoints.map((p, i) => (
              <Circle
                key={i}
                x={p.x}
                y={p.y}
                radius={5 / t.scale}
                fill={p.label ? "#22d3ee" : "#ef4444"}
                stroke="#0a0c0f"
                strokeWidth={1.5 / t.scale}
                listening={false}
              />
            ))}
            {tool === "lasso" && lassoPts.length > 0 && (
              <>
                <Line
                  points={flatten(lassoDraw)}
                  stroke={COLOR_SELECTION}
                  strokeWidth={1.5 / t.scale}
                  listening={false}
                  perfectDrawEnabled={false}
                />
                {lassoMode !== "free" &&
                  lassoPts.map((p, i) => (
                    <Circle
                      key={i}
                      x={p.x}
                      y={p.y}
                      radius={3 / t.scale}
                      fill="#22d3ee"
                      listening={false}
                    />
                  ))}
                {lassoPts.length > 2 && (
                  <Circle
                    x={lassoPts[0].x}
                    y={lassoPts[0].y}
                    radius={6 / t.scale}
                    stroke={COLOR_SELECTION}
                    strokeWidth={1.5 / t.scale}
                    listening={false}
                  />
                )}
              </>
            )}
            {tool === "pen" && pen.anchors.length > 0 && (
              <>
                <Line
                  points={flatten(flattenPath({ ...pen, closed: pen.anchors.length > 2 }))}
                  stroke={COLOR_SELECTION}
                  strokeWidth={1.5 / t.scale}
                  closed={pen.anchors.length > 2}
                  listening={false}
                  perfectDrawEnabled={false}
                />
                {penSel >= 0 &&
                  pen.anchors[penSel] &&
                  (["hIn", "hOut"] as const).map((k) => {
                    const a = pen.anchors[penSel];
                    const h = a[k];
                    if (!h) return null;
                    return (
                      <Line
                        key={k}
                        points={[a.p.x, a.p.y, h.x, h.y]}
                        stroke="#94a3b8"
                        strokeWidth={1 / t.scale}
                        listening={false}
                      />
                    );
                  })}
                {penSel >= 0 &&
                  pen.anchors[penSel] &&
                  (["hIn", "hOut"] as const).map((k) => {
                    const h = pen.anchors[penSel][k];
                    if (!h) return null;
                    return (
                      <Circle key={k} x={h.x} y={h.y} radius={3.5 / t.scale} fill="#cbd5e1" listening={false} />
                    );
                  })}
                {pen.anchors.map((a, i) =>
                  a.smooth ? (
                    <Circle
                      key={i}
                      x={a.p.x}
                      y={a.p.y}
                      radius={4 / t.scale}
                      fill={i === penSel ? "#ffffff" : "#22d3ee"}
                      stroke="#0a0c0f"
                      strokeWidth={1 / t.scale}
                      listening={false}
                    />
                  ) : (
                    <Rect
                      key={i}
                      x={a.p.x - 3 / t.scale}
                      y={a.p.y - 3 / t.scale}
                      width={6 / t.scale}
                      height={6 / t.scale}
                      fill={i === penSel ? "#ffffff" : "#22d3ee"}
                      stroke="#0a0c0f"
                      strokeWidth={1 / t.scale}
                      listening={false}
                    />
                  )
                )}
              </>
            )}
          </Layer>
        </Stage>
      </div>

      <GenerateBar
        prompt={prompt}
        onPrompt={setPrompt}
        status={genStatus}
        canGenerate={!!imageId && !!mask && !mask.isEmpty() && genStatus !== "busy" && genStatus !== "polling"}
        onGenerate={generateNow}
        harmonize={harmonize}
        onHarmonize={setHarmonize}
        history={history}
        onPick={() => {
          /* layers are the source of truth now; result thumbnails are informational */
        }}
      />
      </div>
    </div>
  );
}

function GenerateBar({
  prompt,
  onPrompt,
  status,
  canGenerate,
  onGenerate,
  harmonize,
  onHarmonize,
  history,
  onPick,
}: {
  prompt: string;
  onPrompt: (v: string) => void;
  status: "idle" | "busy" | "polling" | "done" | "failed";
  canGenerate: boolean;
  onGenerate: () => void;
  harmonize: HarmonizeOpts;
  onHarmonize: (h: HarmonizeOpts) => void;
  history: { url: string; prompt: string }[];
  onPick: (url: string) => void;
}) {
  const A = COLOR_GENERATION;
  const chip =
    status === "polling"
      ? { c: "#eab308", t: "polling…" }
      : status === "busy"
      ? { c: "#eab308", t: "working…" }
      : status === "done"
      ? { c: "#22c55e", t: "done" }
      : status === "failed"
      ? { c: "#ef4444", t: "failed" }
      : null;
  return (
    <div
      style={{
        borderTop: `1px solid ${A}33`,
        background: "#15120b",
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: A, boxShadow: `0 0 6px ${A}` }} />
        <input
          value={prompt}
          onChange={(e) => onPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && canGenerate && onGenerate()}
          placeholder="Describe the edit for the selection (e.g. make the jacket red leather)…"
          style={{
            flex: 1,
            background: "#0d0f12",
            color: "#e2e8f0",
            border: "1px solid #2a2f37",
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 13,
          }}
        />
        <button
          onClick={onGenerate}
          disabled={!canGenerate}
          style={{
            padding: "8px 16px",
            borderRadius: 6,
            border: "none",
            cursor: canGenerate ? "pointer" : "default",
            fontWeight: 700,
            color: "#1a160e",
            background: A,
            opacity: canGenerate ? 1 : 0.5,
          }}
        >
          Generate
        </button>
        {chip && (
          <span style={{ fontSize: 11, color: chip.c, minWidth: 56 }}>{chip.t}</span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 10.5, color: "#9a8b6a" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={harmonize.on}
            onChange={(e) => onHarmonize({ ...harmonize, on: e.target.checked })}
            style={{ accentColor: A }}
          />
          Harmonize seam
        </label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={harmonize.strength}
          disabled={!harmonize.on}
          onChange={(e) => onHarmonize({ ...harmonize, strength: Number(e.target.value) })}
          style={{ width: 90, accentColor: A }}
        />
        <span style={{ width: 34 }}>{Math.round(harmonize.strength * 100)}%</span>
        <span style={{ color: "#7d7252" }}>
          color-match · relight · grain. Sends only a padded crop; the rest stays untouched.
        </span>
      </div>
      {history.length > 0 && (
        <div style={{ display: "flex", gap: 6, overflowX: "auto" }}>
          {history.map((h, i) => (
            <img
              key={i}
              src={h.url}
              title={h.prompt}
              onClick={() => onPick(h.url)}
              style={{ height: 44, borderRadius: 4, border: "1px solid #2a2f37", cursor: "pointer" }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FileBar({
  hasImage,
  onSave,
  onOpenProject,
  onAddAdjustment,
  straighten,
  onStraighten,
  onAspect,
  hasCrop,
}: {
  hasImage: boolean;
  onSave: () => void;
  onOpenProject: (f: File) => void;
  onAddAdjustment: () => void;
  straighten: number;
  onStraighten: (deg: number) => void;
  onAspect: (ratio: number | null) => void;
  hasCrop: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const btn: React.CSSProperties = {
    background: "#181c22",
    color: "#cbd5e1",
    border: "1px solid #2a2f37",
    borderRadius: 5,
    padding: "3px 9px",
    fontSize: 11.5,
    cursor: "pointer",
  };
  const ASPECTS: [string, number | null][] = [
    ["Free", null],
    ["1:1", 1],
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["4:3", 4 / 3],
    ["3:2", 3 / 2],
  ];
  return (
    <div
      style={{
        height: 32,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 10px",
        borderBottom: "1px solid #20242b",
        background: "#0d1014",
        font: "11.5px ui-monospace, monospace",
        color: "#94a3b8",
      }}
    >
      <input
        ref={fileRef}
        type="file"
        accept=".neuclip,application/json"
        hidden
        onChange={(e) => e.target.files?.[0] && onOpenProject(e.target.files[0])}
      />
      <button style={btn} onClick={() => fileRef.current?.click()}>
        Open .neuclip
      </button>
      <button style={btn} disabled={!hasImage} onClick={onSave}>
        Save .neuclip
      </button>
      <span style={{ width: 1, height: 16, background: "#2a2f37" }} />
      <button style={btn} disabled={!hasImage} onClick={onAddAdjustment} title="Add adjustment layer">
        + Adjustment
      </button>
      <span style={{ width: 1, height: 16, background: "#2a2f37" }} />
      <span>Crop</span>
      <select
        disabled={!hasImage}
        defaultValue="Free"
        onChange={(e) => {
          const a = [["Free", null], ["1:1", 1], ["16:9", 16 / 9], ["9:16", 9 / 16], ["4:3", 4 / 3], ["3:2", 3 / 2]].find((x) => x[0] === e.target.value);
          onAspect((a?.[1] as number | null) ?? null);
        }}
        style={{ ...btn, padding: "2px 4px" }}
      >
        {ASPECTS.map(([label]) => (
          <option key={label} value={label}>
            {label}
          </option>
        ))}
      </select>
      {hasCrop && <span style={{ color: "#22d3ee", fontSize: 10 }}>cropped</span>}
      <span style={{ marginLeft: 8 }}>Straighten</span>
      <input
        type="range"
        min={-15}
        max={15}
        step={0.5}
        value={straighten}
        disabled={!hasImage}
        onChange={(e) => onStraighten(Number(e.target.value))}
        style={{ width: 90, accentColor: "#22d3ee" }}
      />
      <span style={{ width: 36 }}>{straighten.toFixed(1)}°</span>
    </div>
  );
}

function ZoomBar({
  zoom,
  cursor,
  hasImage,
  tool,
  onTool,
  lassoMode,
  onLassoMode,
  selPct,
  onInvert,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onExport,
  onExportCutout,
  backend,
  busy,
  canRefine,
  onRefine,
  onClearSel,
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
  lassoMode: LassoMode;
  onLassoMode: (m: LassoMode) => void;
  selPct: number;
  onInvert: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  onExportCutout: () => void;
  backend: string | null;
  busy: boolean;
  canRefine: boolean;
  onRefine: () => void;
  onClearSel: () => void;
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
      <button
        style={toolBtn(tool === "lasso")}
        onClick={() => onTool("lasso")}
        title="Lasso — Shift+L cycles mode; Enter/double-click closes; Esc cancels"
      >
        ◠ Lasso
      </button>
      {tool === "lasso" && (
        <select
          value={lassoMode}
          onChange={(e) => onLassoMode(e.target.value as LassoMode)}
          style={{ ...btn, padding: "3px 6px" }}
          title="Lasso mode (Shift+L)"
        >
          <option value="free">Freehand</option>
          <option value="poly">Polygonal</option>
          <option value="magnetic">Magnetic</option>
        </select>
      )}
      <button
        style={toolBtn(tool === "pen")}
        onClick={() => onTool("pen")}
        title="Manual pen — click=corner, drag=curve, Alt-click=toggle smooth, Enter commits"
      >
        ✎ Pen
      </button>
      <button style={toolBtn(tool === "hand")} onClick={() => onTool("hand")} title="Hand — pan (H, or hold Space)">
        ✋ Hand
      </button>
      <button
        style={btn}
        disabled={!canRefine || busy}
        onClick={onRefine}
        title="Refine the selection edge (BiRefNet / matting)"
      >
        ✦ Refine
      </button>
      <button style={btn} disabled={!canRefine} onClick={onInvert} title="Invert selection (Cmd/Ctrl+Shift+I)">
        Invert
      </button>
      <button style={btn} disabled={!canRefine} onClick={onClearSel} title="Clear selection">
        Clear
      </button>
      {selPct > 0 && (
        <span style={{ fontSize: 10.5, color: "#22d3ee" }}>sel {selPct.toFixed(1)}%</span>
      )}
      <span style={{ width: 1, height: 18, background: "#2a2f37" }} />
      <button style={btn} disabled={!canUndo} onClick={onUndo} title="Undo (Cmd/Ctrl+Z)">
        ↶
      </button>
      <button style={btn} disabled={!canRedo} onClick={onRedo} title="Redo (Cmd/Ctrl+Shift+Z)">
        ↷
      </button>
      <button style={btn} disabled={!hasImage} onClick={onExport} title="Export PNG">
        Export
      </button>
      <button style={btn} disabled={!canRefine} onClick={onExportCutout} title="Export selection as transparent PNG">
        Cutout
      </button>
      {hasImage && backend && (
        <span
          style={{
            fontSize: 10.5,
            padding: "2px 7px",
            borderRadius: 4,
            border: `1px solid ${backend === "sam2" ? "#22c55e" : "#64748b"}`,
            color: backend === "sam2" ? "#22c55e" : "#94a3b8",
          }}
          title={backend === "sam2" ? "SAM 2 on GPU" : "Classical CPU fallback (no SAM weights)"}
        >
          {busy ? "…" : backend === "sam2" ? "SAM 2" : "CPU select"}
        </span>
      )}
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

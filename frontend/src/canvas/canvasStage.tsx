import { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Image as KImage, Line, Circle, Rect, Group } from "react-konva";
import { COLOR_SELECTION } from "../constants";
import {
  fitTransform,
  screenToImage,
  zoomAtPoint,
  type Pt,
  type ViewTransform,
} from "./coords";
import { MaskBuffer, opFromModifiers, type BoolOp } from "./maskBuffer";
import { rasterizeCoverage, featherCoverage, dist, constrain45, flatten, appendFreehand } from "./lasso";
import { stampCapsule, sampleHintPoints, gradientMag, localGrow, rawSnap } from "./brush";
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
  decompose,
  type SamPoint,
} from "../api/select";
import {
  generate,
  runToCompletion,
  maskToPngDataUrl,
  resultToImage,
  type GenJob,
  type GenOpts,
  type HarmonizeOpts,
} from "../api/generate";
import { COLOR_GENERATION } from "../constants";
import {
  composite as compositeDoc,
  layerContentCanvas,
  newLayerId,
  remapDuplicateLayerIds,
  serializeDoc,
  deserializeDoc,
  boundsFromMask,
  IDENTITY_TRANSFORM,
  pointHitsLayer,
  transformedBounds,
  unionBounds,
  rectsIntersect,
  type BlendMode,
  type Layer as DocLayer,
  type DocTransform,
  type LayerTransform,
  type LayerBounds,
  type LayerGroup,
  type AdjustSpec,
} from "./document";
import { b64ToFile, outpaint, finishImage, fillBehind } from "../api/generate";
import { saveFile } from "../api/saveFile";
import { runShootout, recordExemplar } from "../api/shootout";
import { synthesizeRemote, sendFeedback, type CompiledPrompt } from "../api/promptSynthesis";
import { TunedPromptDisclosure } from "../panels/tunedPrompts";
import { modelById } from "../api/referenceModels";
import { getGenConfig, useGenConfig } from "../state/genConfig";
import { toastError, toastSuccess, toast } from "../ui/toast";
import { emitMilestone } from "../state/milestones";
import { fireTip } from "../ui/coachmarks";
import { setViewState, useViewState } from "../state/viewState";
import { Menu, MenuItem, MenuRow, MenuDivider } from "../ui/menu";
import { HUE, NEUTRAL, RADII, TYPE, btn, field, divider } from "../ui/tokens";
import { Tip } from "../ui/tooltip";
import { LayersPanel } from "../panels/layersPanel";

type Tool = "select" | "lasso" | "pen" | "wand" | "magic-brush" | "move" | "hand";
type BrushMode = "brush" | "eraser";
type BrushSnap = "ai" | "local" | "off";
type LassoMode = "free" | "poly" | "magnetic";

interface ImgPx {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

// --- multi-model compare (shootout M3) ---
export interface ShootoutTile {
  modelId: string;
  slug: string | null;
  label: string;
  prompt: string;
  ruleNote: string;
  seed: number;
  status: "polling" | "done" | "failed";
  url?: string;
  latencyMs?: number;
  error?: string;
  jobId?: string | null;
}

export interface ShootoutState {
  runId: string;
  intent: string;
  maskData: Uint8Array; // selection frozen at run time (fairness + Keep after deselect)
  maskW: number;
  maskH: number;
  region: [number, number, number, number];
  tiles: ShootoutTile[];
  winner?: string;
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

/** Faint overlay of the magic-brush scribble hints: cyan = positive, warm red = negative. */
function hintsToCanvas(pos: Uint8Array, neg: Uint8Array | null, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const id = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (neg && neg[i]) {
      id.data[o] = 245; id.data[o + 1] = 110; id.data[o + 2] = 110; id.data[o + 3] = 120;
    } else if (pos[i]) {
      id.data[o] = 34; id.data[o + 1] = 211; id.data[o + 2] = 238; id.data[o + 3] = 90;
    }
  }
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
  const [tool, setTool] = useState<Tool>("select");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [imageId, setImageId] = useState<string | null>(null);
  const [backend, setBackend] = useState<string | null>(null);
  const [samPoints, setSamPoints] = useState<SamPoint[]>([]);
  // live marquee rectangle (image space) while the Select tool drags a box
  const [boxPreview, setBoxPreview] = useState<{ a: Pt; b: Pt } | null>(null);
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
  const [variations, setVariations] = useState<{ seed: number; url: string }[]>([]);
  const [varK, setVarK] = useState(4);
  const [shootoutRun, setShootoutRun] = useState<ShootoutState | null>(null);

  // prompt intelligence (PI Stage 6): the sidecar compiles the intent into a model-tuned
  // prompt; the disclosure under the prompt shows it. An edited disclosure (override) is
  // sent verbatim and skips the compiler's params/pad hints.
  const [compiled, setCompiled] = useState<CompiledPrompt | null>(null);
  const [promptOverride, setPromptOverride] = useState<string | null>(null);
  const [opOverride, setOpOverride] = useState<string | null>(null);
  const [lowChange, setLowChange] = useState(false);
  const synthSeq = useRef(0);
  const lastGenMask = useRef<MaskBuffer | null>(null);
  const liveCfg = useGenConfig();

  // layer document — `img` is the base (never replaced after open); edits become layers.
  const [layers, setLayers] = useState<DocLayer[]>([]);
  const layerImgs = useRef<Map<string, HTMLImageElement>>(new Map());
  const [imgVer, setImgVer] = useState(0); // bump when a layer image finishes loading
  const [activeLayer, setActiveLayer] = useState<string | null>(null);
  const [baseThumb, setBaseThumb] = useState<string | null>(null);
  const [decomposed, setDecomposed] = useState(false);
  const [decomposing, setDecomposing] = useState(false);
  const [groups, setGroups] = useState<LayerGroup[]>([]);
  // layer selection (Move tool) — distinct from the pixel mask selection
  const [selectedLayerIds, setSelectedLayerIds] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<LayerBounds | null>(null);
  const moveDrag = useRef<{
    mode: "translate" | "scale" | "marquee" | "rotate";
    start: Pt;
    startT: Map<string, LayerTransform>;
    center?: Pt;
    startDist?: number;
    startAngle?: number;
    shift?: boolean;
    pushed?: boolean; // history snapshot taken on FIRST movement, not on mousedown
  } | null>(null);
  const [docTransform, setDocTransform] = useState<DocTransform>({ straighten: 0 });
  const [cropEditing, setCropEditing] = useState(false); // crop rect handles visible
  const imgPx = useRef<ImgPx | null>(null); // cached base pixels for magic wand
  const [wandTol, setWandTol] = useState(0.15);
  const [wandContig, setWandContig] = useState(true);
  // shared selection-edge options (all lasso/wand/brush tools commit through commitMask)
  const [antialias, setAntialias] = useState(true);
  const [feather, setFeather] = useState(0); // px (Gaussian radius of the selection channel)

  // --- magic brush ---
  const [brushSize, setBrushSize] = useState(40); // image px, SHARED by brush + eraser
  const [brushMode, setBrushMode] = useState<BrushMode>("brush");
  const [brushSnap, setBrushSnap] = useState<BrushSnap>("ai");
  const [brushRefine, setBrushRefine] = useState(true);
  const posHints = useRef<Uint8Array | null>(null); // image-space positive scribble buffer
  const negHints = useRef<Uint8Array | null>(null); // negative scribble buffer
  const [hintVer, setHintVer] = useState(0); // bump to redraw the hint overlay
  const [brushPreview, setBrushPreview] = useState<MaskBuffer | null>(null);
  const brushOp = useRef<BoolOp>("replace");
  const brushErasing = useRef(false);
  const brushBusy = useRef(false);
  const brushQueued = useRef(false);
  const brushLast = useRef<Pt | null>(null);
  const gradCache = useRef<{ id: string; g: Uint8Array } | null>(null);
  const [semanticText, setSemanticText] = useState("");
  const [namedSel, setNamedSel] = useState<{ name: string; data: Uint8Array }[]>([]);
  const [selNote, setSelNote] = useState<string | null>(null);
  // view mode + swipe live in the shared view-state store (the StatusBar hosts the switch)
  const { viewMode, swipe } = useViewState();

  // Move-tool live drag: the dragged layers render as their own Konva nodes over a FROZEN
  // composite that excludes them, so the full document is NOT recomposited per mousemove.
  const [dragExclude, setDragExclude] = useState<string[]>([]);
  const frozenComposite = useRef<HTMLCanvasElement | null>(null);
  const dragCanvases = useRef<Map<string, HTMLCanvasElement>>(new Map());

  const composite = useMemo(() => {
    if (!img) return null;
    if (dragExclude.length && frozenComposite.current) return frozenComposite.current;
    return compositeDoc(img, img.naturalWidth, img.naturalHeight, layers, layerImgs.current, {
      drawBase: !decomposed,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, layers, imgVer, decomposed, dragExclude]);

  // True when the current selection overlaps an imported layer that isn't baked into the base
  // yet — the AI won't see those pixels until "Flatten for AI".
  const selectionOverlapsImport = useMemo(() => {
    if (!mask || mask.isEmpty()) return false;
    const mb = mask.bbox();
    if (!mb || !img) return false;
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    return layers.some(
      (L) => L.kind === "imported" && L.visible && rectsIntersect(mb, transformedBounds(L, W, H))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mask, layers, imgVer]);

  const thumbs = useMemo(() => {
    const m = new Map<string, string>();
    layers.forEach((L) => L.resultUrl && m.set(L.id, L.resultUrl));
    return m;
  }, [layers]);

  // changed-pixels diff overlay (composite vs base) — confirms the crop-only guarantee
  const diff = useMemo(() => {
    if (viewMode !== "diff" || !img || !composite || !imgPx.current) return null;
    const w = composite.width;
    const h = composite.height;
    if (imgPx.current.w !== w || imgPx.current.h !== h) return null;
    const cd = composite.getContext("2d")!.getImageData(0, 0, w, h).data;
    const bd = imgPx.current.data;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    const id = ctx.createImageData(w, h);
    let changed = 0;
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      const dd = Math.abs(cd[o] - bd[o]) + Math.abs(cd[o + 1] - bd[o + 1]) + Math.abs(cd[o + 2] - bd[o + 2]);
      if (dd > 6) {
        id.data[o] = 255;
        id.data[o + 2] = 255;
        id.data[o + 3] = 150;
        changed++;
      }
    }
    ctx.putImageData(id, 0, 0);
    return { canvas: c, pct: (changed / (w * h)) * 100 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, composite, img]);

  useEffect(() => {
    setViewState({ diffPct: diff?.pct ?? null });
  }, [diff]);

  // checkerboard shown through transparent holes when decomposed (honest occlusion)
  const checkerTile = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 16;
    c.height = 16;
    const x = c.getContext("2d")!;
    x.fillStyle = "#2a2f37";
    x.fillRect(0, 0, 16, 16);
    x.fillStyle = "#1f232b";
    x.fillRect(0, 0, 8, 8);
    x.fillRect(8, 8, 8, 8);
    return c;
  }, []);

  const cacheImgPx = (image: HTMLImageElement) => {
    const pc = document.createElement("canvas");
    pc.width = image.naturalWidth;
    pc.height = image.naturalHeight;
    const x = pc.getContext("2d")!;
    x.drawImage(image, 0, 0);
    imgPx.current = { data: x.getImageData(0, 0, pc.width, pc.height).data, w: pc.width, h: pc.height };
  };

  // gesture refs (avoid re-renders mid-drag)
  const drag = useRef<{ start: Pt; startT: ViewTransform; pan: boolean; moved: boolean; down: Pt } | null>(null);
  const openInputRef = useRef<HTMLInputElement>(null); // ⌘O target

  // onboarding/tutorial hooks: open the sample or the picker, accept a prompt suggestion
  useEffect(() => {
    const onSample = () => void openSample();
    const onOpen = () => openInputRef.current?.click();
    const onSuggest = (e: Event) => {
      const v = (e as CustomEvent<string>).detail;
      if (v) setPrompt((cur) => (cur.trim() ? cur : v));
    };
    const onSetTool = (e: Event) => {
      const t = (e as CustomEvent<Tool>).detail;
      if (t) setTool(t); // tutorial step 1 forces Select so the first click selects pixels
    };
    window.addEventListener("neuclip:open-sample", onSample);
    window.addEventListener("neuclip:open-image", onOpen);
    window.addEventListener("neuclip:suggest-prompt", onSuggest);
    window.addEventListener("neuclip:set-tool", onSetTool);
    return () => {
      window.removeEventListener("neuclip:open-sample", onSample);
      window.removeEventListener("neuclip:open-image", onOpen);
      window.removeEventListener("neuclip:suggest-prompt", onSuggest);
      window.removeEventListener("neuclip:set-tool", onSetTool);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // first-time coach marks per tool (one sentence, once ever, never during the tutorial)
  useEffect(() => {
    if (!img) return;
    if (tool === "lasso") fireTip("lasso");
    else if (tool === "magic-brush") fireTip("brush");
    else if (tool === "pen") fireTip("pen");
    else if (tool === "wand") fireTip("wand");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, img]);

  // a selection that sits unused for 5s → nudge toward Generate (once ever)
  useEffect(() => {
    if (!mask || mask.isEmpty() || genStatus !== "idle") return;
    const t5 = window.setTimeout(() => fireTip("ready-to-generate"), 5000);
    return () => window.clearTimeout(t5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mask, genStatus]);

  // publish status values the StatusBar renders (view-mode switch, readouts, backend badge)
  useEffect(() => {
    const hasSel = !!mask && !mask.isEmpty();
    setViewState({
      hasImage: !!img,
      cursor,
      backend,
      busy,
      selPct: hasSel ? (mask!.area() / (mask!.width * mask!.height)) * 100 : 0,
    });
    if (hasSel) {
      emitMilestone("select");
      fireTip("selection-ops");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, cursor, backend, busy, mask]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setVp({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // marching-ants animation — mutate the Konva nodes directly inside one RAF loop and
  // batchDraw, so the 3,000-line component does NOT re-render at 60 fps (Konva pattern).
  const antRefs = useRef<any[]>([]);
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    let raf = 0;
    let d = 0;
    const tick = () => {
      d = (d + 0.4) % 8;
      let konvaLayer: any = null;
      for (const node of antRefs.current) {
        if (node) {
          node.dashOffset(d / tRef.current.scale);
          konvaLayer = node.getLayer();
        }
      }
      konvaLayer?.batchDraw();
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
    const onBlur = () => setSpaceHeld(false); // window blur can eat the keyup
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
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
      if (cropEditing && e.key === "Enter") {
        e.preventDefault();
        setCropEditing(false); // crop stays non-destructive; Enter just commits the rect
        return;
      }
      if (mod && e.shiftKey && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        invertMask(); // Cmd/Ctrl+Shift+I — invert (subject -> background)
        return;
      }
      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault(); // Cmd/Ctrl+S — save .neuclip (don't trigger the browser save)
        saveProject();
        return;
      }
      if (mod && (e.key === "o" || e.key === "O")) {
        e.preventDefault(); // Cmd/Ctrl+O — open an image
        openInputRef.current?.click();
        return;
      }
      if (mod && (e.key === "j" || e.key === "J")) {
        e.preventDefault(); // Cmd/Ctrl+J — layer via copy (selection -> new layer)
        layerFromSelection();
        return;
      }
      if (mod && (e.key === "d" || e.key === "D")) {
        e.preventDefault(); // Cmd/Ctrl+D — deselect
        if (mask && !mask.isEmpty()) {
          pushHistory();
          setMask(new MaskBuffer(mask.width, mask.height));
        }
        setSamPoints([]);
        return;
      }
      if (mod && (e.key === "a" || e.key === "A")) {
        e.preventDefault(); // Cmd/Ctrl+A — select all
        if (mask) {
          pushHistory();
          const all = new MaskBuffer(mask.width, mask.height);
          all.data.fill(255);
          setMask(all);
        }
        return;
      }
      if (!mod && (e.key === "h" || e.key === "H")) {
        setTool("hand"); // H — Hand (pan) tool
        return;
      }
      // Delete/Backspace deletes the selected layer(s) when any are selected and we're not
      // mid lasso/pen gesture (those use Backspace to drop the last anchor).
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selectedLayerIds.length &&
        tool !== "lasso" &&
        tool !== "pen"
      ) {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if (e.key === "L" && e.shiftKey) {
        e.preventDefault();
        setTool("lasso");
        setLassoMode((m) => (m === "free" ? "poly" : m === "poly" ? "magnetic" : "free"));
        cancelLasso();
        return;
      }
      if (!mod && !e.shiftKey && (e.key === "l" || e.key === "L")) {
        setTool("lasso"); // L — lasso (Shift+L cycles its mode)
        return;
      }
      if (!e.metaKey && !e.ctrlKey && (e.key === "v" || e.key === "V")) {
        setTool("move");
        return;
      }
      if (!e.metaKey && !e.ctrlKey && (e.key === "m" || e.key === "M")) {
        setTool("select");
        return;
      }
      if (!e.metaKey && !e.ctrlKey && (e.key === "w" || e.key === "W")) {
        // W = Magic Brush; Shift+W cycles Magic Wand <-> Magic Brush (PS grouping)
        if (e.shiftKey) setTool((cur) => (cur === "wand" ? "magic-brush" : "wand"));
        else setTool("magic-brush");
        return;
      }
      if (tool === "move") {
        if ((e.key === "Delete" || e.key === "Backspace") && selectedLayerIds.length) {
          e.preventDefault();
          deleteSelected();
        }
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
      } else if (tool === "magic-brush") {
        if (e.key === "Enter") {
          e.preventDefault();
          void commitBrush();
        } else if (e.key === "Escape") {
          cancelBrush();
        } else if (e.key === "[") {
          setBrushSize((s) => Math.max(1, Math.round(s * 0.9)));
        } else if (e.key === "]") {
          setBrushSize((s) => Math.min(1000, Math.max(s + 1, Math.round(s * 1.1))));
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
      } else if (e.key === "Escape" && (tool === "select" || tool === "wand")) {
        // Esc = deselect everything (the marching ants disappear) — same as ⌘D
        if (mask && !mask.isEmpty()) {
          pushHistory();
          setMask(new MaskBuffer(mask.width, mask.height));
        }
        setSamPoints([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, lassoPts, lassoMode, pen, penSel, mask, selectedLayerIds, brushPreview, brushRefine, cropEditing]);

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
  useEffect(() => {
    antRefs.current.length = loops.length; // drop refs to unmounted ant nodes
  }, [loops]);
  const brushPreviewCanvas = useMemo(
    () => (brushPreview && !brushPreview.isEmpty() ? maskToCanvas(brushPreview) : null),
    [brushPreview]
  );
  const hintCanvas = useMemo(() => {
    if (tool !== "magic-brush" || !mask || !posHints.current) return null;
    return hintsToCanvas(posHints.current, negHints.current, mask.width, mask.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hintVer, tool, mask]);

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
      emitMilestone("image-open");
      fireTip("toolrail");
      setMask(new MaskBuffer(image.naturalWidth, image.naturalHeight));
      setT(fitTransform(image.naturalWidth, image.naturalHeight, vp.w, vp.h));
      setSamPoints([]);
      // reset the layer document for the new base
      setLayers([]);
      layerImgs.current.clear();
      setActiveLayer(null);
      setDecomposed(false);
      undoStack.current = [];
      redoStack.current = [];
      // base thumbnail for the layers panel
      const tc = document.createElement("canvas");
      const s = 80 / Math.max(image.naturalWidth, image.naturalHeight);
      tc.width = Math.max(1, Math.round(image.naturalWidth * s));
      tc.height = Math.max(1, Math.round(image.naturalHeight * s));
      tc.getContext("2d")!.drawImage(image, 0, 0, tc.width, tc.height);
      setBaseThumb(tc.toDataURL("image/png"));
      cacheImgPx(image);
      setNamedSel([]);
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
        // auto-separate subjects/background into editable layers (an editable proposal)
        void runDecompose("simple", r.id);
      })
      .catch((e) => {
        console.error("load to sidecar failed:", e);
        toastError("Couldn't send the image to the engine — selection tools are offline. Is the sidecar running?");
      });
  };

  // Import an extra image as a movable/scalable layer (collage). It is NOT baked into the
  // base, so AI edits (which crop from the base) won't touch it until you "Flatten for AI".
  const importImageAsLayer = (file: File) => {
    if (!img) return;
    const url = URL.createObjectURL(file);
    const im = new window.Image();
    im.onload = () => {
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      // initial placement: fit to ~60% of the smaller doc dimension, centered
      const target = 0.6 * Math.min(W, H);
      const s = Math.min(target / im.naturalWidth, target / im.naturalHeight, 1);
      const pw = Math.max(1, Math.round(im.naturalWidth * s));
      const ph = Math.max(1, Math.round(im.naturalHeight * s));
      const px = Math.round((W - pw) / 2);
      const py = Math.round((H - ph) / 2);
      // full-doc canvas with the image placed (layer pixels are full-doc sized, contract)
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      c.getContext("2d")!.drawImage(im, px, py, pw, ph);
      const dataUrl = c.toDataURL("image/png");
      // mask marks only the placed rect
      const m = new Uint8Array(W * H);
      for (let y = py; y < py + ph; y++) {
        const row = y * W;
        for (let x = px; x < px + pw; x++) m[row + x] = 255;
      }
      const placed = new window.Image();
      placed.onload = () => {
        pushHistory();
        emitMilestone("import");
        fireTip("import-flatten");
        const id = newLayerId();
        layerImgs.current.set(id, placed);
        const n = layers.filter((l) => l.kind === "imported").length + 1;
        const layer: DocLayer = {
          id,
          name: `Imported ${n}`,
          visible: true,
          opacity: 1,
          blendMode: "normal",
          kind: "imported",
          mask: m,
          resultUrl: dataUrl,
          bounds: [px, py, pw, ph],
          transform: { ...IDENTITY_TRANSFORM },
        };
        setLayers((ls) => [...ls, layer]);
        setActiveLayer(id);
        setSelectedLayerIds([id]);
        setTool("move"); // so it can be positioned immediately
        setImgVer((v) => v + 1);
        URL.revokeObjectURL(url);
      };
      placed.src = dataUrl;
    };
    im.src = url;
  };

  // Flatten the whole visible composite (base + all layers, incl. imports) into a NEW base and
  // re-upload it to the sidecar, so selections + AI generation now see the imported/edited
  // pixels. This bakes every layer (a deliberate commit; undoable).
  const flattenForAI = async () => {
    if (!img || !composite) return;
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    // composite may carry alpha (decomposed holes); flatten onto the current base so we never
    // introduce black holes when re-encoding to the RGB base.
    const flat = document.createElement("canvas");
    flat.width = W;
    flat.height = H;
    const fx = flat.getContext("2d")!;
    if (decomposed) fx.drawImage(img, 0, 0, W, H);
    fx.drawImage(composite, 0, 0);
    const dataUrl = flat.toDataURL("image/png");
    setGenStatus("busy");
    try {
      // upload FIRST — only swap the local document once the sidecar has the new base, so
      // a failed upload can never leave the frontend and sidecar images diverged.
      const up = await loadImageToSidecar(await b64ToFile(dataUrl.split(",")[1]));
      const im = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new window.Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = dataUrl;
      });
      pushHistory();
      setImg(im);
      setLayers([]);
      layerImgs.current.clear();
      setActiveLayer(null);
      setSelectedLayerIds([]);
      setDecomposed(false);
      setMask(new MaskBuffer(W, H));
      cacheImgPx(im);
      const tc = document.createElement("canvas");
      const s = 80 / Math.max(W, H);
      tc.width = Math.max(1, Math.round(W * s));
      tc.height = Math.max(1, Math.round(H * s));
      tc.getContext("2d")!.drawImage(im, 0, 0, tc.width, tc.height);
      setBaseThumb(tc.toDataURL("image/png"));
      setImageId(up.id);
      setBackend(up.backend);
      setImgVer((v) => v + 1);
      setGenStatus("idle");
      toastSuccess("Flattened for AI — edits now apply to the merged image.");
    } catch (e) {
      console.error("flatten failed:", e);
      toastError("Flatten for AI failed — nothing was changed (document and engine still agree).");
      setGenStatus("failed"); // state untouched — document and sidecar still agree
    }
  };

  // Flatten a single layer into the base (merge-down): bake the base + every layer up to and
  // including this one, keep the layers ABOVE it independent (preserves z-order and the final
  // pixels exactly). Makes that layer's pixels part of the sidecar base so AI edits apply.
  const flattenLayer = async (layerId: string) => {
    if (!img) return;
    const idx = layers.findIndex((l) => l.id === layerId);
    if (idx < 0) return;
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const lower = layers.slice(0, idx + 1);
    const upper = layers.slice(idx + 1);
    const baked = compositeDoc(img, W, H, lower, layerImgs.current, { drawBase: !decomposed });
    const flat = document.createElement("canvas");
    flat.width = W;
    flat.height = H;
    const fx = flat.getContext("2d")!;
    if (decomposed) fx.drawImage(img, 0, 0, W, H);
    fx.drawImage(baked, 0, 0);
    const dataUrl = flat.toDataURL("image/png");
    setGenStatus("busy");
    try {
      // upload FIRST (atomicity — see flattenForAI)
      const up = await loadImageToSidecar(await b64ToFile(dataUrl.split(",")[1]));
      const im = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new window.Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = dataUrl;
      });
      pushHistory();
      setImg(im);
      for (const L of lower) layerImgs.current.delete(L.id); // baked-in ids no longer needed
      setLayers(upper); // upper layers keep their pixel caches (same ids, same W×H)
      setActiveLayer(upper.length ? upper[upper.length - 1].id : null);
      setSelectedLayerIds([]);
      setDecomposed(upper.some((l) => l.kind === "decomposed"));
      setMask(new MaskBuffer(W, H));
      cacheImgPx(im);
      const tc = document.createElement("canvas");
      const s = 80 / Math.max(W, H);
      tc.width = Math.max(1, Math.round(W * s));
      tc.height = Math.max(1, Math.round(H * s));
      tc.getContext("2d")!.drawImage(im, 0, 0, tc.width, tc.height);
      setBaseThumb(tc.toDataURL("image/png"));
      setImageId(up.id);
      setBackend(up.backend);
      setImgVer((v) => v + 1);
      setGenStatus("idle");
    } catch (e) {
      console.error("flatten layer failed:", e);
      toastError("Flatten failed — nothing was changed.");
      setGenStatus("failed"); // state untouched — document and sidecar still agree
    }
  };

  // Run a smart-select. op="replace" swaps the working mask for the result; any other op
  // selects the clicked object/region independently and combines it through the shared
  // boolean pipeline — that's how Ctrl-click builds a multi-object selection.
  const runSelect = async (
    points: SamPoint[],
    box: [number, number, number, number] | null,
    op: BoolOp = "replace"
  ) => {
    if (!imageId || !mask) return;
    setBusy(true);
    try {
      const r = await smartSelect(imageId, points, box);
      if (op === "replace") {
        pushHistory();
        setSamPoints(points);
        setMask(new MaskBuffer(r.width, r.height, r.data));
      } else {
        commitMask(r.data, op); // add/subtract/intersect into the existing selection
        setSamPoints((sp) => [...sp, ...points.map((pt) => ({ ...pt, label: (op === "subtract" ? 0 : 1) as 0 | 1 }))]);
      }
      setBackend(r.backend);
    } catch (e) {
      console.error("select failed:", e);
      toastError("Selection failed — try again or use a different tool.");
    } finally {
      setBusy(false);
    }
  };

  // Select-tool modifier semantics (Adobe-style): Ctrl/Cmd or Shift = add another object,
  // Alt = remove one, Alt+Shift = intersect. Plain click = new selection.
  const selOpFrom = (evt: MouseEvent | KeyboardEvent): BoolOp => {
    const add = evt.ctrlKey || evt.metaKey || evt.shiftKey;
    if (evt.altKey && add) return "intersect";
    if (evt.altKey) return "subtract";
    if (add) return "add";
    return "replace";
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
      toastError("Edge refine failed — the selection is unchanged.");
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
    if (tool === "magic-brush" && mask) {
      const ip = screenToImage(p, t);
      if (!posHints.current) {
        posHints.current = new Uint8Array(mask.width * mask.height);
        negHints.current = new Uint8Array(mask.width * mask.height);
        brushOp.current = e.evt.shiftKey ? "add" : "replace"; // final combine (mode buttons/Shift)
      }
      brushErasing.current = brushMode === "eraser" || e.evt.altKey; // Alt = temp erase
      const buf = brushErasing.current ? negHints.current! : posHints.current!;
      stampBrush(buf, ip, ip);
      brushLast.current = ip;
      setHintVer((v) => v + 1);
    } else if (tool === "lasso" && lassoMode === "free") {
      // freehand: drag samples points; release closes
      const ip = screenToImage(p, t);
      lassoOp.current = opFromModifiers(e.evt.shiftKey, e.evt.altKey);
      freehand.current = true;
      setLassoPts([ip]);
    } else if (tool === "pen") {
      penDown(screenToImage(p, t), e);
    } else if (tool === "move") {
      moveDown(screenToImage(p, t), e);
    }
  };

  const onMouseMove = (e: any) => {
    shiftRef.current = !!e.evt.shiftKey;
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
    if (tool === "move" && ip && moveDrag.current) {
      moveMove(ip);
      return;
    }
    if (tool === "pen" && ip && penDrag.current) {
      penMove(ip);
      return;
    }
    if (tool === "magic-brush" && ip && drag.current && !drag.current.pan && brushLast.current) {
      const buf = brushErasing.current ? negHints.current! : posHints.current!;
      if (buf) {
        stampBrush(buf, brushLast.current, ip);
        brushLast.current = ip;
        setHintVer((v) => v + 1);
      }
      return;
    }
    if (tool === "select" && ip && d && !d.pan && d.moved) {
      // live marquee: the box the user is dragging is visible while they drag it
      setBoxPreview({ a: screenToImage(d.down, t), b: ip });
      return;
    }
    if (tool === "lasso" && ip) {
      // Polygonal: Shift shows the rubber-band already snapped to 45°, matching what a click
      // will place (PS parity). Otherwise the raw cursor.
      if (lassoMode === "poly" && e.evt.shiftKey && lassoPts.length > 0) {
        setLassoCursor(constrain45(lassoPts[lassoPts.length - 1], ip));
      } else {
        setLassoCursor(ip);
      }
      if (freehand.current) {
        // distance-thresholded sampling (1.5 screen px, constant on screen at any zoom) +
        // linear interpolation so a fast flick doesn't skip a straight jump.
        setLassoPts((pts) => appendFreehand(pts, ip, 1.5 / t.scale));
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
    setBoxPreview(null); // the marquee lives only while the mouse is down
    if (tool === "pen") {
      penDrag.current = null;
      return;
    }
    if (tool === "move") {
      moveEnd(p ? screenToImage(p, t) : null);
      return;
    }
    if (tool === "magic-brush") {
      brushLast.current = null;
      if (d && !d.pan) void runBrushSnap();
      return;
    }
    if (!d || d.pan || !p || !mask || !img) return;

    if (tool === "lasso") {
      const ip = screenToImage(p, t);
      if (lassoMode === "free" && freehand.current) {
        freehand.current = false;
        commitLasso([...lassoPts, ip]);
      } else if (!d.moved && e.evt.detail < 2) {
        // detail>=2 is the second click of a double-click — the dblclick handler commits;
        // adding an anchor here would leave a duplicate point on the path
        void lassoClick(ip, e);
      }
      return;
    }
    if (tool === "wand") {
      if (!d.moved) magicWand(screenToImage(p, t), opFromModifiers(e.evt.shiftKey, e.evt.altKey));
      return;
    }
    if (tool !== "select") return;

    const op = selOpFrom(e.evt);
    if (d.moved) {
      // box prompt → GrabCut / SAM box (modifiers add/subtract the region, Adobe-style)
      setBoxPreview(null);
      const a = screenToImage(d.down, t);
      const b = screenToImage(p, t);
      const box: [number, number, number, number] = [
        Math.min(a.x, b.x),
        Math.min(a.y, b.y),
        Math.max(a.x, b.x),
        Math.max(a.y, b.y),
      ];
      void runSelect([], box, op);
    } else {
      // point prompt: plain click = select the object; Ctrl/Cmd/Shift-click = ADD another
      // object to the selection; Alt-click = remove one (multi-object select)
      const ip = screenToImage(p, t);
      void runSelect([{ x: ip.x, y: ip.y, label: 1 }], null, op);
    }
  };

  // --- shared commit pipeline (invariant #3) ---
  // Every selection tool feeds a coverage mask (0–255) here: optional feather (Gaussian blur of
  // the selection channel) → boolean composite via the gesture-start op → ants/bbox refresh.
  // Anti-alias is decided at rasterization (rasterizeCoverage) so hard/soft edges share one path.
  const commitMask = (incoming: Uint8Array, op: BoolOp, snapshot = true) => {
    if (!mask) return;
    if (snapshot) pushHistory();
    const cov = feather > 0 ? featherCoverage(incoming, mask.width, mask.height, feather) : incoming;
    const next = mask.clone();
    next.apply(cov, op);
    setMask(next);
  };

  // --- magic brush ---
  const stampBrush = (buf: Uint8Array, a: Pt, b: Pt) => {
    if (!mask) return;
    stampCapsule(buf, mask.width, mask.height, a, b, brushSize / 2);
  };

  // Turn the accumulated hints into a snapped selection preview via the active engine.
  const runBrushSnap = async () => {
    if (!mask) return;
    const pos = posHints.current;
    const neg = negHints.current;
    if (!pos) return;
    const W = mask.width;
    const H = mask.height;
    const hasPos = pos.some((v) => v);
    if (!hasPos) {
      setBrushPreview(null);
      return;
    }

    if (brushSnap === "off") {
      setBrushPreview(new MaskBuffer(W, H, rawSnap(pos, neg!)));
      return;
    }
    if (brushSnap === "ai" && imageId) {
      if (brushBusy.current) {
        brushQueued.current = true; // trailing re-run — never silently drop a stroke
        return;
      }
      brushBusy.current = true;
      try {
        const pts = [
          ...sampleHintPoints(pos, W, 24).map((p) => ({ x: p.x, y: p.y, label: 1 as const })),
          ...sampleHintPoints(neg!, W, 16).map((p) => ({ x: p.x, y: p.y, label: 0 as const })),
        ];
        const r = await smartSelect(imageId, pts, null);
        setBrushPreview(new MaskBuffer(r.width, r.height, r.data));
        setSelNote(null);
        return;
      } catch (e) {
        console.warn("AI snap failed, using local:", e);
        setSelNote("AI snap unavailable — using local");
      } finally {
        brushBusy.current = false;
        if (brushQueued.current) {
          brushQueued.current = false;
          void runBrushSnap(); // a stroke landed while busy — snap it now
        }
      }
    }
    // local (or AI fallback)
    const px = imgPx.current;
    if (px && px.w === W && px.h === H) {
      if (!gradCache.current || gradCache.current.id !== imageId) {
        gradCache.current = { id: imageId ?? "", g: gradientMag(px.data, W, H) };
      }
      setBrushPreview(new MaskBuffer(W, H, Uint8Array.from(localGrow(px.data, gradCache.current.g, W, H, pos, neg!))));
    } else {
      setBrushPreview(new MaskBuffer(W, H, rawSnap(pos, neg!)));
    }
  };

  const commitBrush = async () => {
    if (!brushPreview || !mask) {
      cancelBrush();
      return;
    }
    let data = new Uint8Array(brushPreview.data);
    if (brushRefine && imageId) {
      try {
        data = new Uint8Array(await refineMask(imageId, data, mask.width, mask.height)); // BiRefNet edge crisp-up
      } catch (e) {
        console.warn("refine on commit failed:", e);
      }
    }
    commitMask(data, brushOp.current);
    cancelBrush();
  };
  const cancelBrush = () => {
    posHints.current = null;
    negHints.current = null;
    brushLast.current = null;
    setBrushPreview(null);
    setHintVer((v) => v + 1);
  };

  // --- lasso ---
  const commitLasso = (pts: Pt[]) => {
    if (!mask || pts.length < 3) {
      cancelLasso();
      return;
    }
    commitMask(rasterizeCoverage(pts, mask.width, mask.height, antialias), lassoOp.current);
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
      toastError("Magnetic lasso edge map failed — falling back to straight segments.");
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
    if (e.evt.detail >= 2) return; // second click of a double-click commits — no new anchor
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
    const poly = flattenPath({ ...pen, closed: true });
    commitMask(rasterizeCoverage(poly, mask.width, mask.height, antialias), penOp.current);
    cancelPen();
  };
  const invertMask = () => {
    if (!mask) return;
    pushHistory();
    const next = mask.clone();
    next.invert();
    setMask(next);
  };

  // --- stronger selection ---
  const magicWand = (ip: Pt, op: BoolOp) => {
    const px = imgPx.current;
    if (!px || !mask) return;
    const { data, w, h } = px;
    const sx = Math.min(w - 1, Math.max(0, Math.floor(ip.x)));
    const sy = Math.min(h - 1, Math.max(0, Math.floor(ip.y)));
    const i0 = (sy * w + sx) * 4;
    const r0 = data[i0], g0 = data[i0 + 1], b0 = data[i0 + 2];
    const tol = wandTol * 441.7; // max color distance
    const inc = new Uint8Array(w * h);
    const close = (i: number) =>
      Math.hypot(data[i * 4] - r0, data[i * 4 + 1] - g0, data[i * 4 + 2] - b0) <= tol;
    if (wandContig) {
      const stack = [sy * w + sx];
      const seen = new Uint8Array(w * h);
      while (stack.length) {
        const i = stack.pop()!;
        if (seen[i] || !close(i)) continue;
        seen[i] = 1;
        inc[i] = 255;
        const x = i % w, y = (i / w) | 0;
        if (x > 0) stack.push(i - 1);
        if (x < w - 1) stack.push(i + 1);
        if (y > 0) stack.push(i - w);
        if (y < h - 1) stack.push(i + w);
      }
    } else {
      for (let i = 0; i < w * h; i++) if (close(i)) inc[i] = 255;
    }
    commitMask(inc, op);
  };

  const modifySel = (fn: (m: MaskBuffer) => void) => {
    if (!mask || mask.isEmpty()) return;
    pushHistory();
    const next = mask.clone();
    fn(next);
    setMask(next);
  };

  // Layer via Copy (Photoshop Cmd/Ctrl+J): copy the current selection's base pixels into a new
  // movable layer, in place. No selection → no-op.
  const layerFromSelection = () => {
    if (!img || !mask || mask.isEmpty()) return;
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, W, H);
    const idata = ctx.getImageData(0, 0, W, H);
    const md = mask.data;
    for (let i = 0; i < md.length; i++) if (!md[i]) idata.data[i * 4 + 3] = 0; // clip to selection
    ctx.putImageData(idata, 0, 0);
    const dataUrl = c.toDataURL("image/png");
    const placed = new window.Image();
    placed.onload = () => {
      pushHistory();
      const lid = newLayerId();
      layerImgs.current.set(lid, placed);
      const n = layers.filter((l) => l.kind === "imported").length + 1;
      const layer: DocLayer = {
        id: lid,
        name: `Layer via copy ${n}`,
        visible: true,
        opacity: 1,
        blendMode: "normal",
        kind: "imported",
        mask: new Uint8Array(mask.data),
        resultUrl: dataUrl,
        bounds: boundsFromMask(mask.data, W, H) ?? undefined,
        transform: { ...IDENTITY_TRANSFORM },
      };
      setLayers((ls) => [...ls, layer]);
      setActiveLayer(lid);
      setSelectedLayerIds([lid]);
      setTool("move");
      setImgVer((v) => v + 1);
    };
    placed.src = dataUrl;
  };

  const selectSubject = async () => {
    if (!imageId || !mask) return;
    pushHistory();
    setBusy(true);
    setSelNote(null);
    try {
      const r = await smartSelect(imageId, [], null, { subject: true });
      setMask(new MaskBuffer(r.width, r.height, r.data));
    } catch (e) {
      console.error("select subject failed:", e);
      toastError("Couldn't find a subject — try clicking it with Select (M).");
    } finally {
      setBusy(false);
    }
  };

  const selectSemantic = async () => {
    if (!imageId || !mask || !semanticText.trim()) return;
    setBusy(true);
    setSelNote(null);
    try {
      const r = await smartSelect(imageId, [], null, { semantic: semanticText.trim() });
      const found = new MaskBuffer(r.width, r.height, r.data);
      if (found.isEmpty()) {
        // no match: keep whatever the user had selected and say why nothing happened
        setSelNote(r.note ?? "no match for that phrase");
      } else {
        pushHistory();
        setMask(found);
        setSamPoints([]);
        if (r.note) setSelNote(r.note);
      }
    } catch (e) {
      console.error("semantic select failed:", e);
      toastError("Select-by-text failed — try a simpler phrase.");
    } finally {
      setBusy(false);
    }
  };

  const saveSelection = () => {
    if (!mask || mask.isEmpty()) return;
    const name = window.prompt("Name this selection:", `Selection ${namedSel.length + 1}`);
    if (!name) return;
    setNamedSel((s) => [...s, { name, data: new Uint8Array(mask.data) }]);
  };
  const loadSelection = (idx: number) => {
    const s = namedSel[idx];
    if (!s || !mask) return;
    pushHistory();
    setMask(new MaskBuffer(mask.width, mask.height, new Uint8Array(s.data)));
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
  // Structural sharing: layer masks are never mutated in place (every edit allocates a new
  // Uint8Array), so history snapshots share the same buffer instead of copying ~W×H bytes
  // per layer per undo step.
  const cloneLayer = (L: DocLayer): DocLayer => ({ ...L });
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

  // --- finishing pass: upscale (+ face restore) then export ---
  const finishAndExport = async (scale: number, faceRestore: boolean) => {
    const c = exportCanvas();
    if (!c) return;
    setGenStatus("busy");
    try {
      const r = await finishImage(c.toDataURL("image/png"), {
        scale,
        face_restore: faceRestore,
        face_strength: 0.5,
      });
      const im = await resultToImage(r.image_png);
      const cc = document.createElement("canvas");
      cc.width = r.width;
      cc.height = r.height;
      cc.getContext("2d")!.drawImage(im, 0, 0);
      cc.toBlob((b) => b && void saveFile(b, `neuclip-${scale}x.png`), "image/png");
      setGenStatus("done");
    } catch (e) {
      console.error("finish failed:", e);
      toastError("Upscale/export failed — try again.");
      setGenStatus("failed");
    }
  };

  // --- export (composite + non-destructive crop/straighten) ---
  const exportPng = () => {
    const c = exportCanvas();
    if (!c) return;
    emitMilestone("save");
    fireTip("save-export");
    c.toBlob((b) => b && void saveFile(b, "neuclip-export.png"), "image/png");
  };
  const exportAs = (fmt: "png" | "jpeg" | "webp", quality: number) => {
    const c = exportCanvas();
    if (!c) return;
    const ext = fmt === "jpeg" ? "jpg" : fmt;
    c.toBlob(
      (b) => {
        if (b) void saveFile(b, `neuclip-export.${ext}`);
        else toastError(`This browser can't encode ${fmt.toUpperCase()} — try PNG.`);
      },
      `image/${fmt}`,
      fmt === "png" ? undefined : quality
    );
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
    c.toBlob((b) => b && void saveFile(b, "neuclip-cutout.png"), "image/png");
  };

  // --- auto-decomposition: AI separates subjects/background into editable layers ---
  // `imgRef` so the /load .then() (an older render's closure) still sees the loaded image.
  const imgRef = useRef<HTMLImageElement | null>(null);
  imgRef.current = img;
  const runDecompose = async (granularity: "simple" | "fine", id?: string) => {
    const useId = id ?? imageId;
    const im = imgRef.current;
    if (!useId || !im) return;
    setDecomposing(true);
    try {
      const r = await decompose(useId, granularity);
      const baseUrl = imgToDataUrl(im);
      const newLayers: DocLayer[] = r.regions.map((reg) => {
        const lid = newLayerId();
        layerImgs.current.set(lid, im); // decomposed layers draw the base pixels, clipped to their mask
        return {
          id: lid,
          name: reg.name,
          visible: true,
          opacity: 1,
          blendMode: "normal" as BlendMode,
          kind: "decomposed" as const,
          mask: reg.data,
          resultUrl: baseUrl,
          bounds: reg.bounds,
          transform: { ...IDENTITY_TRANSFORM },
        };
      });
      pushHistory();
      setLayers(newLayers);
      setDecomposed(true);
      setActiveLayer(newLayers[newLayers.length - 1]?.id ?? null);
      setImgVer((v) => v + 1);
      if (granularity === "fine" && r.backend === "fallback") {
        toast("Fine separation needs the GPU grounded model — using the simple subject/background split.", "info");
      }
    } catch (e) {
      console.error("decompose failed:", e);
      toastError("Auto-separate failed — the image is untouched.");
    } finally {
      setDecomposing(false);
    }
  };

  // Generation options derived from the shared inspector config (model + reference/pose +
  // LoRAs) — used identically by Generate, Vary ×K, and re-roll so they all hit the real
  // model when one is configured (mock only when none is).
  const genOptsFromConfig = (seed: number): GenOpts => {
    const cfg = getGenConfig();
    const params: Record<string, unknown> = {};
    if (cfg.referenceRole === "pose" || cfg.referenceRole === "style") {
      params.control_strength = cfg.controlStrength;
    }
    return {
      mock: !cfg.modelId,
      model_slug: cfg.modelId ?? undefined,
      reference_png: cfg.referencePng ?? undefined,
      // a role with no reference image attached is meaningless — never send it alone
      reference_role: cfg.referencePng ? cfg.referenceRole ?? undefined : undefined,
      params,
      loras: cfg.loras.length ? cfg.loras : undefined,
      harmonize,
      seed,
      // the shared selection feather reaches the sidecar's alpha (soft mask survives)
      feather: feather > 0 ? feather : 2.5,
    };
  };

  // --- iterate: re-roll a layer in place, seed variations into a tray ---
  const reroll = async (id: string) => {
    const L = layers.find((l) => l.id === id);
    if (!L || !L.source || !L.mask || !imageId || !img) return;
    const maskPng = maskToPngDataUrl(L.mask, img.naturalWidth, img.naturalHeight);
    pushHistory();
    setGenStatus("busy");
    // re-rolling = the previous result wasn't kept — local telemetry for picker badges
    if (L.source.model && L.source.model !== "mock") {
      void sendFeedback(L.source.model, false, L.source.operation);
    }
    try {
      // reuse the layer's stored source (model, prompt, params, reference presence) and
      // bump the seed; the current reference image rides along when the source had one.
      const cfg = getGenConfig();
      const seed = (L.source.seed || 0) + 1;
      const wasMock = !L.source.model || L.source.model === "mock";
      const job = await generate(imageId, maskPng, L.source.prompt, {
        mock: wasMock,
        model_slug: wasMock ? undefined : L.source.model,
        params: L.source.params,
        reference_png:
          L.source.reference?.present && cfg.referencePng ? cfg.referencePng : undefined,
        reference_role: L.source.reference?.present ? L.source.reference.role : undefined,
        loras: cfg.loras.length ? cfg.loras : undefined,
        harmonize: L.harmonize ?? harmonize,
        feather: feather > 0 ? feather : 2.5,
        seed,
      });
      const done = await runToCompletion(job);
      if (done.status === "completed" && done.result_png) {
        layerImgs.current.set(id, await resultToImage(done.result_png));
        updateLayer(id, {
          resultUrl: `data:image/png;base64,${done.result_png}`,
          source: { ...L.source, seed },
        });
        setImgVer((v) => v + 1);
        setGenStatus("done");
      } else setGenStatus("failed");
    } catch (e) {
      console.error("reroll failed:", e);
      toastError("Re-roll failed — the layer kept its previous result.");
      setGenStatus("failed");
    }
  };

  const runVariations = async () => {
    if (!imageId || !mask || mask.isEmpty()) return;
    const maskPng = maskToPngDataUrl(mask.data, mask.width, mask.height);
    setGenStatus("busy");
    setVariations([]);
    try {
      const out: { seed: number; url: string }[] = [];
      for (let i = 1; i <= varK; i++) {
        // real model + reference + LoRAs via the shared config; mock only when no model
        const job = await generate(imageId, maskPng, prompt, genOptsFromConfig(i));
        const done = await runToCompletion(job);
        if (done.status === "completed" && done.result_png)
          out.push({ seed: i, url: `data:image/png;base64,${done.result_png}` });
      }
      setVariations(out);
      setGenStatus(out.length ? "done" : "failed");
    } catch (e) {
      console.error("variations failed:", e);
      toastError("Variations failed — nothing was changed.");
      setGenStatus("failed");
    }
  };

  const pickVariation = async (v: { seed: number; url: string }) => {
    if (!img || !mask) return;
    const im = await resultToImage(v.url);
    const id = newLayerId();
    layerImgs.current.set(id, im);
    pushHistory();
    const n = layers.filter((l) => l.kind === "ai-edit").length + 1;
    const layer: DocLayer = {
      id,
      name: `AI edit ${n}`,
      visible: true,
      opacity: 1,
      blendMode: "normal",
      kind: "ai-edit",
      mask: new Uint8Array(mask.data),
      resultUrl: v.url,
      source: { model: "mock", prompt, seed: v.seed, params: {}, sendRegion: [0, 0, img.naturalWidth - 1, img.naturalHeight - 1] },
      harmonize: { ...harmonize },
      bounds: boundsFromMask(mask.data, img.naturalWidth, img.naturalHeight) ?? undefined,
      transform: { ...IDENTITY_TRANSFORM },
    };
    setLayers((ls) => [...ls, layer]);
    setActiveLayer(id);
    setImgVer((vv) => vv + 1);
    setVariations([]);
    setMask(new MaskBuffer(img.naturalWidth, img.naturalHeight));
    setSamPoints([]);
  };

  // --- occlusion fill: inpaint the Background hole behind a subject layer ---
  const fillBehindLayer = async (subjectId: string) => {
    if (!imageId || !img) return;
    const subj = layers.find((L) => L.id === subjectId);
    const bg = layers.find((L) => L.kind === "decomposed" && /^background/i.test(L.name));
    if (!subj?.mask || !bg) return;
    setDecomposing(true);
    try {
      const holePng = maskToPngDataUrl(subj.mask, img.naturalWidth, img.naturalHeight);
      const r = await fillBehind(imageId, holePng, { mock: true });
      if (r.status === "completed" && r.image_png) {
        const im = await resultToImage(r.image_png);
        layerImgs.current.set(bg.id, im);
        // the background now covers the hole too
        const W = img.naturalWidth;
        const H = img.naturalHeight;
        const newMask = bg.mask ? new Uint8Array(bg.mask) : new Uint8Array(W * H).fill(255);
        for (let i = 0; i < newMask.length; i++) if (subj.mask![i]) newMask[i] = 255;
        pushHistory();
        updateLayer(bg.id, {
          resultUrl: `data:image/png;base64,${r.image_png}`,
          mask: newMask,
          bounds: boundsFromMask(newMask, W, H) ?? undefined,
        });
        setImgVer((v) => v + 1);
      }
    } catch (e) {
      console.error("fill behind failed:", e);
      toastError("Fill-behind failed — the background layer is unchanged.");
    } finally {
      setDecomposing(false);
    }
  };

  // --- Move tool: layer selection + transform (distinct from pixel selection) ---
  const dims = (): [number, number] => [img?.naturalWidth ?? 0, img?.naturalHeight ?? 0];
  const layerAt = (ip: Pt): string | null => {
    const [W, H] = dims();
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      if (L.locked || !L.visible || L.kind === "adjustment") continue;
      if (pointHitsLayer(ip, L, W, H)) return L.id;
    }
    return null;
  };
  const selectionBox = (): LayerBounds | null => {
    const [W, H] = dims();
    return unionBounds(layers.filter((L) => selectedLayerIds.includes(L.id)), W, H);
  };
  const handleCorners = (box: LayerBounds): Pt[] => {
    const [x, y, w, h] = box;
    return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  };
  const hitHandle = (ip: Pt): number => {
    const box = selectionBox();
    if (!box) return -1;
    const r = 9 / t.scale;
    return handleCorners(box).findIndex((c) => Math.hypot(ip.x - c.x, ip.y - c.y) < r);
  };
  const hitRotate = (ip: Pt): boolean => {
    const box = selectionBox();
    if (!box) return false;
    const r = 9 / t.scale;
    return handleCorners(box).some((c) => {
      const d = Math.hypot(ip.x - c.x, ip.y - c.y);
      return d >= r && d < r * 2.6;
    });
  };
  const transformsOf = (ids: string[]): Map<string, LayerTransform> => {
    const m = new Map<string, LayerTransform>();
    layers.forEach((L) => ids.includes(L.id) && m.set(L.id, { ...(L.transform ?? IDENTITY_TRANSFORM) }));
    return m;
  };

  // Freeze a composite that excludes the dragged layers + cache their masked content, so
  // mousemoves only move Konva nodes. Falls back (returns false) when a dragged layer
  // needs stack-order blending (blend mode ≠ normal) or has no cached image.
  const beginLiveDrag = (ids: string[]) => {
    if (!img || viewMode !== "normal") return;
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const sel = layers.filter((L) => ids.includes(L.id) && L.kind !== "adjustment");
    if (!sel.length || sel.some((L) => L.blendMode !== "normal")) return;
    const canvases = new Map<string, HTMLCanvasElement>();
    for (const L of sel) {
      const src = layerImgs.current.get(L.id);
      if (!src) return;
      canvases.set(L.id, layerContentCanvas(L, src, W, H));
    }
    frozenComposite.current = compositeDoc(
      img, W, H,
      layers.filter((L) => !canvases.has(L.id)),
      layerImgs.current,
      { drawBase: !decomposed }
    );
    dragCanvases.current = canvases;
    setDragExclude([...canvases.keys()]);
  };
  const endLiveDrag = () => {
    if (frozenComposite.current || dragExclude.length) {
      frozenComposite.current = null;
      dragCanvases.current = new Map();
      setDragExclude([]); // one full recomposite on drop
    }
  };

  const moveDown = (ip: Pt, e: any) => {
    if (hitHandle(ip) >= 0 && selectedLayerIds.length) {
      const box = selectionBox()!;
      const c = { x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 };
      moveDrag.current = {
        mode: "scale",
        start: ip,
        startT: transformsOf(selectedLayerIds),
        center: c,
        startDist: Math.hypot(ip.x - c.x, ip.y - c.y) || 1,
      };
      beginLiveDrag(selectedLayerIds);
      return;
    }
    // just outside a corner handle = rotate zone (drag rotates about the box centre)
    if (selectedLayerIds.length && hitRotate(ip)) {
      const box = selectionBox()!;
      const c = { x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 };
      moveDrag.current = {
        mode: "rotate",
        start: ip,
        startT: transformsOf(selectedLayerIds),
        center: c,
        startAngle: Math.atan2(ip.y - c.y, ip.x - c.x),
      };
      beginLiveDrag(selectedLayerIds);
      return;
    }
    const lid = layerAt(ip);
    if (lid) {
      const sel = e.evt.shiftKey
        ? selectedLayerIds.includes(lid)
          ? selectedLayerIds.filter((x) => x !== lid)
          : [...selectedLayerIds, lid]
        : selectedLayerIds.includes(lid)
        ? selectedLayerIds
        : [lid];
      setSelectedLayerIds(sel);
      setActiveLayer(lid);
      moveDrag.current = { mode: "translate", start: ip, startT: transformsOf(sel) };
      beginLiveDrag(sel);
    } else {
      moveDrag.current = { mode: "marquee", start: ip, startT: new Map(), shift: e.evt.shiftKey };
      setMarquee([ip.x, ip.y, 0, 0]);
    }
  };

  const shiftRef = useRef(false); // live Shift state for rotate snapping
  // blend-mode fallback: coalesce full recomposites to one per animation frame
  const moveRaf = useRef(0);
  const pendingMove = useRef<Pt | null>(null);
  const moveMove = (ip: Pt) => {
    const md = moveDrag.current;
    if (!md) return;
    if ((md.mode === "translate" || md.mode === "scale") && dragExclude.length === 0) {
      pendingMove.current = ip;
      if (!moveRaf.current) {
        moveRaf.current = requestAnimationFrame(() => {
          moveRaf.current = 0;
          if (pendingMove.current && moveDrag.current) applyMove(pendingMove.current);
        });
      }
      return;
    }
    applyMove(ip);
  };

  const applyMove = (ip: Pt) => {
    const md = moveDrag.current;
    if (!md) return;
    if ((md.mode === "translate" || md.mode === "scale" || md.mode === "rotate") && !md.pushed) {
      pushHistory(); // only once a drag actually moves — a plain click stays off the stack
      md.pushed = true;
    }
    if (md.mode === "rotate") {
      let delta = Math.atan2(ip.y - md.center!.y, ip.x - md.center!.x) - md.startAngle!;
      if (shiftRef.current) {
        const snap = Math.PI / 12; // Shift snaps to 15°
        delta = Math.round(delta / snap) * snap;
      }
      setLayers((ls) =>
        ls.map((L) => {
          const s0 = md.startT.get(L.id);
          return s0 ? { ...L, transform: { ...s0, rotation: s0.rotation + delta } } : L;
        })
      );
      setImgVer((v) => v + 1);
      return;
    }
    if (md.mode === "translate") {
      const dx = ip.x - md.start.x;
      const dy = ip.y - md.start.y;
      setLayers((ls) =>
        ls.map((L) => {
          const s = md.startT.get(L.id);
          return s ? { ...L, transform: { ...s, tx: s.tx + dx, ty: s.ty + dy } } : L;
        })
      );
      setImgVer((v) => v + 1);
    } else if (md.mode === "scale") {
      const f = Math.hypot(ip.x - md.center!.x, ip.y - md.center!.y) / md.startDist!;
      setLayers((ls) =>
        ls.map((L) => {
          const s = md.startT.get(L.id);
          return s ? { ...L, transform: { ...s, scale: Math.max(0.05, s.scale * f) } } : L;
        })
      );
      setImgVer((v) => v + 1);
    } else {
      setMarquee([
        Math.min(md.start.x, ip.x),
        Math.min(md.start.y, ip.y),
        Math.abs(ip.x - md.start.x),
        Math.abs(ip.y - md.start.y),
      ]);
    }
  };

  const moveEnd = (ip: Pt | null) => {
    const md = moveDrag.current;
    moveDrag.current = null;
    setMarquee(null);
    if (moveRaf.current) {
      cancelAnimationFrame(moveRaf.current);
      moveRaf.current = 0;
      if (pendingMove.current && md && (md.mode === "translate" || md.mode === "scale")) {
        // apply the final coalesced move before committing
        moveDrag.current = md;
        applyMove(pendingMove.current);
        moveDrag.current = null;
      }
    }
    pendingMove.current = null;
    endLiveDrag();
    if (md?.mode === "marquee" && ip) {
      const [W, H] = dims();
      const rect: LayerBounds = [
        Math.min(md.start.x, ip.x),
        Math.min(md.start.y, ip.y),
        Math.abs(ip.x - md.start.x),
        Math.abs(ip.y - md.start.y),
      ];
      if (rect[2] > 2 || rect[3] > 2) {
        const sel = layers
          .filter((L) => L.visible && !L.locked && L.kind !== "adjustment" && rectsIntersect(transformedBounds(L, W, H), rect, false))
          .map((L) => L.id);
        setSelectedLayerIds(md.shift ? Array.from(new Set([...selectedLayerIds, ...sel])) : sel);
        if (sel.length) setActiveLayer(sel[sel.length - 1]);
      } else if (!md.shift) {
        setSelectedLayerIds([]); // empty click deselects
      }
    }
  };

  // --- multi-layer operations ---
  const groupSelected = () => {
    if (selectedLayerIds.length < 1) return;
    pushHistory();
    const gid = newLayerId();
    setGroups((g) => [...g, { id: gid, name: `Group ${g.length + 1}`, collapsed: false, layerIds: [...selectedLayerIds] }]);
    setLayers((ls) => ls.map((L) => (selectedLayerIds.includes(L.id) ? { ...L, groupId: gid } : L)));
  };
  const alignSelected = (mode: "left" | "cx" | "right" | "top" | "cy" | "bottom") => {
    if (selectedLayerIds.length < 2 || !img) return;
    const [W, H] = dims();
    const box = unionBounds(layers.filter((L) => selectedLayerIds.includes(L.id)), W, H);
    if (!box) return;
    const [ux, uy, uw, uh] = box;
    pushHistory();
    setLayers((ls) =>
      ls.map((L) => {
        if (!selectedLayerIds.includes(L.id)) return L;
        const tb = transformedBounds(L, W, H);
        const tr = { ...(L.transform ?? IDENTITY_TRANSFORM) };
        if (mode === "left") tr.tx += ux - tb[0];
        else if (mode === "cx") tr.tx += ux + uw / 2 - (tb[0] + tb[2] / 2);
        else if (mode === "right") tr.tx += ux + uw - (tb[0] + tb[2]);
        else if (mode === "top") tr.ty += uy - tb[1];
        else if (mode === "cy") tr.ty += uy + uh / 2 - (tb[1] + tb[3] / 2);
        else if (mode === "bottom") tr.ty += uy + uh - (tb[1] + tb[3]);
        return { ...L, transform: tr };
      })
    );
    setImgVer((v) => v + 1);
  };
  const duplicateSelected = () => {
    if (!selectedLayerIds.length) return;
    pushHistory();
    const sel = layers.filter((L) => selectedLayerIds.includes(L.id));
    const newIds: string[] = [];
    const dups = sel.map((L) => {
      const nid = newLayerId();
      newIds.push(nid);
      const src = layerImgs.current.get(L.id);
      if (src) layerImgs.current.set(nid, src);
      const tr = { ...(L.transform ?? IDENTITY_TRANSFORM) };
      return { ...cloneLayer(L), id: nid, name: `${L.name} copy`, transform: { ...tr, tx: tr.tx + 12, ty: tr.ty + 12 } };
    });
    setLayers((ls) => [...ls, ...dups]);
    setSelectedLayerIds(newIds);
    setImgVer((v) => v + 1);
  };
  const deleteSelected = () => {
    if (!selectedLayerIds.length) return;
    pushHistory();
    setLayers((ls) => ls.filter((L) => !selectedLayerIds.includes(L.id)));
    setSelectedLayerIds([]);
    // keep the active layer unless it was among the deleted
    if (activeLayer && selectedLayerIds.includes(activeLayer)) setActiveLayer(null);
    setImgVer((v) => v + 1);
  };
  const setSelOpacity = (v: number) => {
    setLayers((ls) => ls.map((L) => (selectedLayerIds.includes(L.id) ? { ...L, opacity: v } : L)));
    setImgVer((x) => x + 1);
  };

  // panel ↔ canvas selection sync (click / shift-range / cmd-add)
  const selectLayerRow = (id: string, additive: boolean, range: boolean) => {
    emitMilestone("layers");
    setActiveLayer(id);
    setTool("move");
    if (range && activeLayer) {
      const ids = layers.map((l) => l.id);
      const a = ids.indexOf(activeLayer);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelectedLayerIds(Array.from(new Set([...selectedLayerIds, ...ids.slice(lo, hi + 1)])));
        return;
      }
    }
    if (additive) {
      setSelectedLayerIds(
        selectedLayerIds.includes(id) ? selectedLayerIds.filter((x) => x !== id) : [...selectedLayerIds, id]
      );
      return;
    }
    setSelectedLayerIds([id]);
  };

  // --- layer ops ---
  const updateLayer = (id: string, patch: Partial<DocLayer>) =>
    setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const toggleVisible = (id: string, alt = false) => {
    emitMilestone("layers");
    pushHistory();
    if (alt) {
      // solo/isolate — show only this layer; alt-clicking again restores all
      const onlyThis = layers.every((L) => (L.id === id ? L.visible : !L.visible));
      setLayers((ls) => ls.map((L) => ({ ...L, visible: onlyThis ? true : L.id === id })));
      setImgVer((v) => v + 1);
      return;
    }
    const targets = selectedLayerIds.includes(id) && selectedLayerIds.length > 1 ? selectedLayerIds : [id];
    const cur = layers.find((l) => l.id === id)?.visible ?? true;
    setLayers((ls) => ls.map((L) => (targets.includes(L.id) ? { ...L, visible: !cur } : L)));
    setImgVer((v) => v + 1);
  };
  const setLayerOpacity = (id: string, v: number) => {
    emitMilestone("layers");
    updateLayer(id, { opacity: v });
    setImgVer((x) => x + 1);
  };
  const setLayerBlend = (id: string, m: BlendMode) => {
    pushHistory();
    updateLayer(id, { blendMode: m });
    setImgVer((v) => v + 1);
  };
  const deleteLayer = (id: string) => {
    emitMilestone("layers");
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
    emitMilestone("save");
    fireTip("save-export");
    const json = serializeDoc(img.naturalWidth, img.naturalHeight, imgToDataUrl(img), layers, docTransform, groups);
    void saveFile(new Blob([json], { type: "application/json" }), "neuclip-project.neuclip");
  };
  const openProject = async (file: File) => {
   try {
    const text = await file.text();
    const d = await deserializeDoc(text);
    // ids are UUIDs now, but re-map any duplicates from old counter-based files
    remapDuplicateLayerIds(d.layers, d.layerImgs, d.groups);
    setImg(d.baseImg);
    setLayers(d.layers);
    layerImgs.current = d.layerImgs;
    setDecomposed(d.layers.some((l) => l.kind === "decomposed"));
    setGroups(d.groups ?? []);
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
    cacheImgPx(d.baseImg);
    // re-upload base so selection works on the restored project
    try {
      const r = await loadImageToSidecar(await b64ToFile(imgToDataUrl(d.baseImg)));
      setImageId(r.id);
      setBackend(r.backend);
    } catch (e) {
      console.error("re-upload base failed:", e);
      toastError("Project opened, but re-connecting it to the engine failed — selection tools may be offline.");
    }
   } catch (e) {
    console.error("open project failed:", e);
    toastError("Couldn't open the project — is it a valid .neuclip file?");
   }
  };

  // outpaint: extend the canvas to a target aspect and generatively fill the new region.
  const outpaintTo = async (ratio: number) => {
    if (!img || !imageId) return;
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    let nw = W;
    let nh = H;
    if (W / H < ratio) nw = Math.round(H * ratio);
    else nh = Math.round(W / ratio);
    if (nw === W && nh === H) return;
    const dx = Math.round((nw - W) / 2);
    const dy = Math.round((nh - H) / 2);
    setGenStatus("busy");
    try {
      const r = await outpaint(imageId, { new_w: nw, new_h: nh, dx, dy, prompt, mock: true });
      if (r.status === "completed" && r.image_png) {
        // upload FIRST (atomicity — see flattenForAI), then swap the local base
        const up = await loadImageToSidecar(await b64ToFile(r.image_png));
        const im = await resultToImage(r.image_png);
        setImg(im); // extended image becomes the new base (outpaint resets the layer stack)
        setLayers([]);
        layerImgs.current.clear();
        setActiveLayer(null);
        setMask(new MaskBuffer(r.width, r.height));
        setT(fitTransform(r.width, r.height, vp.w, vp.h));
        cacheImgPx(im);
        const tc = document.createElement("canvas");
        const s = 80 / Math.max(r.width, r.height);
        tc.width = Math.max(1, Math.round(r.width * s));
        tc.height = Math.max(1, Math.round(r.height * s));
        tc.getContext("2d")!.drawImage(im, 0, 0, tc.width, tc.height);
        setBaseThumb(tc.toDataURL("image/png"));
        setImageId(up.id);
        setBackend(up.backend);
        setSamPoints([]);
        setImgVer((v) => v + 1);
        undoStack.current = [];
        redoStack.current = [];
        setGenStatus("done");
        toastSuccess("Canvas extended — the new region was filled.");
      } else setGenStatus("failed");
    } catch (e) {
      console.error("outpaint failed:", e);
      toastError("Extend failed — the canvas is unchanged.");
      setGenStatus("failed");
    }
  };

  const applyAspectCrop = (ratio: number | null) => {
    if (!img) return;
    if (ratio === null) {
      setDocTransform((tr) => ({ ...tr, crop: undefined }));
      setCropEditing(false);
      return;
    }
    setCropEditing(true); // aspect preset seeds the rect; handles then adjust it freely
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

  // --- prompt intelligence: debounced sidecar compile of the intent (PI Stage 6) ---
  // Model id for synthesis: the selected model, else the compiler's default instruction
  // profile (the mock path sees the same tuned prompt a real Kontext call would get).
  const synthModelId = liveCfg.modelId ?? "flux-kontext";
  // an operation correction applies to ONE parse — a new intent gets a fresh parse
  const prevIntent = useRef(prompt);
  useEffect(() => {
    if (prompt !== prevIntent.current) {
      prevIntent.current = prompt;
      setOpOverride(null);
    }
  }, [prompt]);
  useEffect(() => {
    setPromptOverride(null); // intent/model changed → any hand edit is stale
    if (!prompt.trim()) {
      setCompiled(null);
      setOpOverride(null);
      return;
    }
    const seq = ++synthSeq.current;
    const timer = window.setTimeout(async () => {
      try {
        const hasMask = !!(imageId && mask && !mask.isEmpty());
        const res = await synthesizeRemote({
          model_id: synthModelId,
          intent: prompt,
          reference_role: liveCfg.referencePng ? liveCfg.referenceRole ?? undefined : undefined,
          loras: liveCfg.loras.length ? liveCfg.loras : undefined,
          id: hasMask ? imageId! : undefined,
          mask_png: hasMask ? maskToPngDataUrl(mask!.data, mask!.width, mask!.height) : undefined,
          operation: opOverride ?? undefined,
        });
        if (seq === synthSeq.current) setCompiled(res);
      } catch {
        if (seq === synthSeq.current) setCompiled(null); // sidecar down → raw prompt is sent
      }
    }, 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt, synthModelId, liveCfg.referenceRole, liveCfg.referencePng, liveCfg.loras, opOverride]);

  // crop -> model -> feathered composite; result becomes a new ai-edit layer. The inspector's
  // model + reference/pose + LoRAs ride along via the shared genConfig store (reference M3).
  const generateNow = async (variant?: { strong?: boolean }) => {
    // the "stronger variant" retry runs after the selection was captured onto the layer
    // and cleared — fall back to the mask the last generation used
    const mb = mask && !mask.isEmpty() ? mask : lastGenMask.current;
    if (!imageId || !mb || mb.isEmpty()) return;
    pushHistory();
    const cfg = getGenConfig();
    const maskPng = maskToPngDataUrl(mb.data, mb.width, mb.height);
    setGenStatus("busy");
    setLowChange(false);
    try {
      // The compiled (model-tuned) prompt is what's sent; a hand-edited disclosure is
      // sent verbatim and skips the compiler's params/pad hints (user override).
      let sendPrompt = promptOverride ?? compiled?.prompt ?? prompt;
      let overrides: Record<string, unknown> =
        compiled && promptOverride == null ? compiled.params_overrides : {};
      let padHint = compiled && promptOverride == null ? compiled.send_region_pad : null;
      if (variant?.strong) {
        try {
          const strong = await synthesizeRemote({
            model_id: synthModelId,
            intent: prompt,
            reference_role: cfg.referencePng ? cfg.referenceRole ?? undefined : undefined,
            loras: cfg.loras.length ? cfg.loras : undefined,
            id: imageId,
            mask_png: maskPng,
            operation: opOverride ?? undefined,
            strength: "strong",
          });
          sendPrompt = strong.prompt;
          overrides = strong.params_overrides;
          padHint = strong.send_region_pad;
        } catch {
          /* stronger synth unavailable → re-send the last prompt with a new seed */
        }
      }
      // No model selected → mock path; otherwise the real model (the sidecar still falls
      // back to mock when no WaveSpeed key is set).
      const opts = genOptsFromConfig(variant?.strong ? 1 : 0);
      opts.params = { ...(opts.params ?? {}), ...overrides };
      if (padHint != null) opts.pad_frac = padHint; // known-failure mitigation: wider crop
      const params = opts.params ?? {};
      let job: GenJob;
      try {
        job = await generate(imageId, maskPng, sendPrompt, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // desktop resilience: a restarted sidecar forgets the uploaded image (409) —
        // silently re-upload the base and retry once instead of failing the first edit
        if (/409|active image/i.test(msg) && img) {
          const up = await loadImageToSidecar(await b64ToFile(imgToDataUrl(img)));
          setImageId(up.id);
          job = await generate(up.id, maskPng, sendPrompt, opts);
        } else {
          throw err;
        }
      }
      const done = await runToCompletion(job, (s) =>
        setGenStatus(s === "polling" ? "polling" : "busy")
      );
      if (done.status === "completed" && done.result_png && img) {
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
          mask: new Uint8Array(mb.data),
          resultUrl: `data:image/png;base64,${done.result_png}`,
          source: {
            model: done.mode === "mock" ? "mock" : cfg.modelId ?? "wavespeed",
            prompt: sendPrompt,
            operation: compiled?.edit_spec.operation,
            seed: variant?.strong ? 1 : 0,
            params: (params as Record<string, number>),
            sendRegion: (done.region as [number, number, number, number]) ?? [0, 0, img.naturalWidth - 1, img.naturalHeight - 1],
            reference: cfg.referencePng ? { role: cfg.referenceRole ?? "replace", present: true } : undefined,
            pose: cfg.pose,
          },
          harmonize: { ...harmonize },
          bounds: boundsFromMask(mb.data, img.naturalWidth, img.naturalHeight) ?? undefined,
          transform: { ...IDENTITY_TRANSFORM },
        };
        setLayers((ls) => [...ls, layer]); // top of stack
        setActiveLayer(id);
        setImgVer((v) => v + 1);
        setHistory((h) =>
          [{ url: `data:image/png;base64,${done.result_png}`, prompt: sendPrompt }, ...h].slice(0, 12)
        );
        // the selection is captured on the layer; clear the working mask (kept in
        // lastGenMask so the "stronger variant" retry can re-run the same region)
        lastGenMask.current = mb;
        setMask(new MaskBuffer(img.naturalWidth, img.naturalHeight));
        setSamPoints([]);
        setGenStatus("done");
        // no-change detection → offer a one-click stronger variant in the disclosure
        setLowChange(!!done.low_change && !variant?.strong);
        toastSuccess(`Edit complete — added layer "AI edit ${n}"`);
        emitMilestone("generate");
        fireTip("viewmodes");
        if (n >= 2) {
          emitMilestone("second-ai-edit");
          fireTip("layer-stack");
        }
      } else {
        setGenStatus("failed");
        const why = done.error ?? "the model returned no result";
        toastError(`Generation failed: ${why} — your selection and image are untouched.`);
        window.dispatchEvent(new CustomEvent("neuclip:generate-failed", { detail: why }));
      }
    } catch (e) {
      console.error("generate failed:", e);
      const why = e instanceof Error ? e.message : String(e);
      toastError(`Generation failed: ${why.slice(0, 120)} — your selection and image are untouched.`);
      window.dispatchEvent(new CustomEvent("neuclip:generate-failed", { detail: why }));
      setGenStatus("failed");
    }
  };

  // --- multi-model compare (shootout M3): fan the edit across the compare set ---
  const updateTile = (modelId: string, patch: Partial<ShootoutTile>) =>
    setShootoutRun((s) =>
      s ? { ...s, tiles: s.tiles.map((t) => (t.modelId === modelId ? { ...t, ...patch } : t)) } : s
    );

  const pollTile = (modelId: string, jobId: string, region: number[], t0: number) => {
    runToCompletion({
      job_id: jobId,
      status: "polling",
      mode: "wavespeed",
      region,
      result_png: null,
      error: null,
    })
      .then((done) =>
        updateTile(
          modelId,
          done.status === "completed" && done.result_png
            ? {
                status: "done",
                url: `data:image/png;base64,${done.result_png}`,
                latencyMs: Math.round(performance.now() - t0),
              }
            : { status: "failed", error: done.error ?? "generation failed" }
        )
      )
      .catch((e) => updateTile(modelId, { status: "failed", error: String(e) }));
  };

  const shootoutBody = (models: string[], intent: string, maskPng: string) => {
    const cfg = getGenConfig();
    const params: Record<string, unknown> = {};
    if (cfg.referenceRole === "pose" || cfg.referenceRole === "style") {
      params.control_strength = cfg.controlStrength;
    }
    return {
      id: imageId!,
      mask_png: maskPng,
      intent,
      reference_png: cfg.referencePng ?? undefined,
      reference_role: cfg.referenceRole ?? undefined,
      models,
      params,
      loras: cfg.loras.length ? cfg.loras : undefined,
      harmonize,
    };
  };

  const runShootoutNow = async () => {
    if (!imageId || !mask || mask.isEmpty()) return;
    const cfg = getGenConfig();
    if (cfg.compareSet.length < 2) return;
    const maskPng = maskToPngDataUrl(mask.data, mask.width, mask.height);
    const t0 = performance.now();
    setGenStatus("busy");
    try {
      const res = await runShootout(shootoutBody(cfg.compareSet, prompt, maskPng));
      const tiles: ShootoutTile[] = res.jobs.map((j) => ({
        modelId: j.model_id,
        slug: j.slug,
        label: modelById(j.model_id)?.label ?? j.model_id,
        prompt: j.prompt,
        ruleNote: j.rule_note,
        seed: j.seed,
        status: j.status === "completed" ? "done" : j.status === "failed" ? "failed" : "polling",
        url: j.result_png ? `data:image/png;base64,${j.result_png}` : undefined,
        latencyMs: j.status === "completed" ? Math.round(performance.now() - t0) : undefined,
        error: j.error ?? undefined,
        jobId: j.job_id,
      }));
      setShootoutRun({
        runId: res.run_id,
        intent: prompt,
        maskData: new Uint8Array(mask.data),
        maskW: mask.width,
        maskH: mask.height,
        region: res.region,
        tiles,
      });
      setGenStatus("idle");
      // independent per-tile poll loops — one tile failing never blocks the rest
      for (const tile of tiles) {
        if (tile.status === "polling" && tile.jobId) pollTile(tile.modelId, tile.jobId, res.region, t0);
      }
    } catch (e) {
      console.error("shootout failed:", e);
      toastError("Shootout failed to start — nothing was run.");
      setGenStatus("failed");
    }
  };

  const retryShootoutTile = async (modelId: string) => {
    const s = shootoutRun;
    if (!s || !imageId) return;
    updateTile(modelId, { status: "polling", error: undefined });
    const maskPng = maskToPngDataUrl(s.maskData, s.maskW, s.maskH);
    const t0 = performance.now();
    try {
      const res = await runShootout(shootoutBody([modelId], s.intent, maskPng));
      const j = res.jobs[0];
      if (j.status === "completed" && j.result_png) {
        updateTile(modelId, {
          status: "done",
          url: `data:image/png;base64,${j.result_png}`,
          prompt: j.prompt,
          latencyMs: Math.round(performance.now() - t0),
        });
      } else if (j.status === "polling" && j.job_id) {
        updateTile(modelId, { prompt: j.prompt, jobId: j.job_id });
        pollTile(modelId, j.job_id, res.region, t0);
      } else {
        updateTile(modelId, { status: "failed", error: j.error ?? "generation failed" });
      }
    } catch (e) {
      updateTile(modelId, { status: "failed", error: String(e) });
    }
  };

  // "Keep" a tile: composite it as an ai-edit layer (exactly like generateNow), record the
  // winner, and feed (intent → winning prompt) back into the model's profile exemplars.
  const keepShootoutTile = async (tile: ShootoutTile) => {
    const s = shootoutRun;
    if (!s || !img || !tile.url) return;
    const im = await resultToImage(tile.url);
    const id = newLayerId();
    layerImgs.current.set(id, im);
    pushHistory();
    const n = layers.filter((l) => l.kind === "ai-edit").length + 1;
    const layer: DocLayer = {
      id,
      name: `AI edit ${n} · ${tile.label}`,
      visible: true,
      opacity: 1,
      blendMode: "normal",
      kind: "ai-edit",
      mask: new Uint8Array(s.maskData),
      resultUrl: tile.url,
      source: {
        model: tile.slug ?? tile.modelId,
        prompt: tile.prompt,
        seed: tile.seed,
        params: {},
        sendRegion: s.region,
      },
      harmonize: { ...harmonize },
      bounds: boundsFromMask(s.maskData, s.maskW, s.maskH) ?? undefined,
      transform: { ...IDENTITY_TRANSFORM },
    };
    setLayers((ls) => [...ls, layer]);
    setActiveLayer(id);
    setImgVer((v) => v + 1);
    setShootoutRun((cur) => (cur ? { ...cur, winner: tile.modelId } : cur));
    void recordExemplar(tile.modelId, s.intent, tile.prompt);
    toastSuccess(`Kept ${tile.label} — added as a layer and recorded as the winner.`);
    emitMilestone("generate");
    if (mask) {
      setMask(new MaskBuffer(mask.width, mask.height));
      setSamPoints([]);
    }
    setGenStatus("done");
  };

  // cursor semantics: crosshair only for selection tools; move = arrow; pen = precise
  // crosshair; brush hides the OS cursor (the ring is the cursor); hand/space = grab.
  const cursorStyle = !img
    ? "default"
    : panning
    ? "grabbing"
    : spaceHeld || tool === "hand"
    ? "grab"
    : tool === "move"
    ? "default"
    : tool === "magic-brush"
    ? "none"
    : "crosshair";

  // sample image (bundled at /sample.jpg) — the zero-friction demo path
  const openSample = async () => {
    try {
      const res = await fetch("/sample.jpg");
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      openFile(new File([blob], "sample.jpg", { type: "image/jpeg" }));
    } catch (e) {
      console.error("sample load failed:", e);
      toastError("Couldn't load the sample image.");
    }
  };

  // drop an image anywhere: opens it (or imports as a layer when one is already open)
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    if (f.name.endsWith(".neuclip")) void openProject(f);
    else if (f.type.startsWith("image/")) img ? importImageAsLayer(f) : openFile(f);
  };

  return (
    <div style={{ flex: 1, display: "flex", minWidth: 0 }}>
      <input
        ref={openInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) openFile(e.target.files[0]);
          e.currentTarget.value = "";
        }}
      />
      <ToolRail
        tool={tool}
        onTool={setTool}
        lassoMode={lassoMode}
        onLassoMode={setLassoMode}
        hasImage={!!img}
        zoom={t.scale}
        onIn={() => setT((c) => zoomAtPoint(c, { x: vp.w / 2, y: vp.h / 2 }, 1.25))}
        onOut={() => setT((c) => zoomAtPoint(c, { x: vp.w / 2, y: vp.h / 2 }, 1 / 1.25))}
        onFit={() => img && setT(fitTransform(img.naturalWidth, img.naturalHeight, vp.w, vp.h))}
        onActual={() => setT((c) => zoomAtPoint(c, { x: vp.w / 2, y: vp.h / 2 }, 1 / c.scale))}
      />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      <FileBar
        canUndo={undoStack.current.length > 0}
        canRedo={redoStack.current.length > 0}
        onUndo={undo}
        onRedo={redo}
        hasImage={!!img}
        onOpen={openFile}
        onSave={saveProject}
        onOpenProject={openProject}
        onImport={importImageAsLayer}
        onFlatten={flattenForAI}
        canFlatten={!!img && layers.length > 0}
        onAddAdjustment={addAdjustment}
        straighten={docTransform.straighten}
        onStraighten={(deg) => setDocTransform((tr) => ({ ...tr, straighten: deg }))}
        onAspect={applyAspectCrop}
        hasCrop={!!docTransform.crop}
        onExtend={outpaintTo}
        onFinish={finishAndExport}
        decomposing={decomposing}
        onDecompose={runDecompose}
        onExport={exportPng}
        onExportAs={exportAs}
        onExportCutout={exportCutout}
        canExportCutout={!!mask && !mask.isEmpty()}
      />
      {img && (
        <OptionsBar
          tool={tool}
          busy={busy}
          canRefine={!!mask && !mask.isEmpty()}
          onSubject={selectSubject}
          onRefine={runRefine}
          onInvert={invertMask}
          onClearSel={() => {
            if (mask && !mask.isEmpty()) {
              pushHistory();
              setMask(new MaskBuffer(mask.width, mask.height));
            }
            setSamPoints([]);
          }}
          antialias={antialias}
          onAntialias={setAntialias}
          feather={feather}
          onFeather={setFeather}
          onGrow={() => modifySel((m) => m.grow(3))}
          onShrink={() => modifySel((m) => m.shrink(3))}
          onSmooth={() => modifySel((m) => m.smooth())}
          semanticText={semanticText}
          onSemanticText={setSemanticText}
          onSemantic={selectSemantic}
          onSaveSel={saveSelection}
          named={namedSel.map((s) => s.name)}
          onLoadSel={loadSelection}
          note={selNote}
          wandTol={wandTol}
          onWandTol={setWandTol}
          wandContig={wandContig}
          onWandContig={setWandContig}
          lassoMode={lassoMode}
          onLassoMode={setLassoMode}
          brushSize={brushSize}
          onBrushSize={setBrushSize}
          brushMode={brushMode}
          onBrushMode={setBrushMode}
          brushSnap={brushSnap}
          onBrushSnap={setBrushSnap}
          brushRefine={brushRefine}
          onBrushRefine={setBrushRefine}
          hasBrushPreview={!!brushPreview}
          onBrushCommit={() => void commitBrush()}
          onBrushClear={cancelBrush}
          selectedLayerCount={selectedLayerIds.length}
        />
      )}
      <div
        ref={wrapRef}
        data-tour="canvas"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        style={{ flex: 1, position: "relative", background: "#0a0c0f", minHeight: 0 }}
      >
        {!img && <EmptyState onOpen={openFile} onSample={openSample} />}
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
          onContextMenu={(e: any) => {
            // macOS: Ctrl-click is a secondary click — keep it usable as "add to selection"
            if (tool === "select") e.evt.preventDefault();
          }}
          onDblClick={() => {
            if (cropEditing) setCropEditing(false);
            else if (tool === "lasso" && lassoPts.length > 2) commitLasso(lassoPts);
            else if (tool === "pen" && pen.anchors.length > 2) commitPen();
          }}
          onMouseLeave={(e: any) => {
            setCursor(null);
            if (drag.current && drag.current.pan) endDrag(e);
          }}
          style={{ cursor: cursorStyle }}
        >
          <Layer imageSmoothingEnabled={t.scale < 4}>
            {decomposed && img && viewMode === "normal" && (
              <Rect
                x={0}
                y={0}
                width={img.naturalWidth}
                height={img.naturalHeight}
                fillPatternImage={checkerTile as unknown as HTMLImageElement}
                listening={false}
              />
            )}
            {img && composite && viewMode === "split" ? (
              <>
                <KImage image={img} x={0} y={0} listening={false} />
                <Group
                  clipX={swipe * img.naturalWidth}
                  clipY={0}
                  clipWidth={img.naturalWidth - swipe * img.naturalWidth}
                  clipHeight={img.naturalHeight}
                >
                  <KImage image={composite} x={0} y={0} listening={false} />
                </Group>
                <Line
                  points={[swipe * img.naturalWidth, 0, swipe * img.naturalWidth, img.naturalHeight]}
                  stroke="#ffffff"
                  strokeWidth={2 / t.scale}
                  listening={false}
                />
              </>
            ) : (
              img && composite && <KImage image={composite} x={0} y={0} />
            )}
            {/* live-dragged layers ride as their own nodes over the frozen composite */}
            {img &&
              viewMode === "normal" &&
              dragExclude.map((id) => {
                const L = layers.find((l) => l.id === id);
                const c = dragCanvases.current.get(id);
                if (!L || !c || !L.visible) return null;
                const [bx, by, bw, bh] = L.bounds ?? [0, 0, img.naturalWidth, img.naturalHeight];
                const cx = bx + bw / 2;
                const cy = by + bh / 2;
                const tr = L.transform ?? IDENTITY_TRANSFORM;
                return (
                  <KImage
                    key={id}
                    image={c}
                    x={cx + tr.tx}
                    y={cy + tr.ty}
                    offsetX={cx}
                    offsetY={cy}
                    scaleX={tr.scale}
                    scaleY={tr.scale}
                    rotation={(tr.rotation * 180) / Math.PI}
                    opacity={L.opacity}
                    listening={false}
                  />
                );
              })}
            {viewMode === "diff" && diff && <KImage image={diff.canvas} x={0} y={0} listening={false} />}
            {tool === "move" && marquee && (
              <Rect
                x={marquee[0]}
                y={marquee[1]}
                width={marquee[2]}
                height={marquee[3]}
                stroke="#cbd5e1"
                strokeWidth={1 / t.scale}
                dash={[3 / t.scale, 3 / t.scale]}
                fill="#cbd5e122"
                listening={false}
              />
            )}
            {tool === "move" && img && (() => {
              const box = unionBounds(layers.filter((L) => selectedLayerIds.includes(L.id)), img.naturalWidth, img.naturalHeight);
              if (!box) return null;
              const [x, y, w, h] = box;
              const hs = 5 / t.scale;
              const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
              return (
                <>
                  <Rect x={x} y={y} width={w} height={h} stroke="#e9ecf2" strokeWidth={1.5 / t.scale} listening={false} />
                  {corners.map(([cx, cy], i) => (
                    <Rect key={i} x={cx - hs} y={cy - hs} width={hs * 2} height={hs * 2} fill="#e9ecf2" stroke="#121419" strokeWidth={1 / t.scale} listening={false} />
                  ))}
                </>
              );
            })()}
            {docTransform.crop && img && (() => {
              const [cx0, cy0, cx1, cy1] = docTransform.crop!;
              const W = img.naturalWidth;
              const H = img.naturalHeight;
              const hs = 6 / t.scale;
              const dim = "rgba(0,0,0,0.55)";
              const clampCrop = (a: number, b: number, c: number, d: number) => {
                const x0 = Math.round(Math.max(0, Math.min(a, c - 8)));
                const y0 = Math.round(Math.max(0, Math.min(b, d - 8)));
                const x1 = Math.round(Math.min(W - 1, Math.max(c, a + 8)));
                const y1 = Math.round(Math.min(H - 1, Math.max(d, b + 8)));
                setDocTransform((tr) => ({ ...tr, crop: [x0, y0, x1, y1] }));
              };
              const corners: [number, number][] = [
                [cx0, cy0],
                [cx1, cy0],
                [cx1, cy1],
                [cx0, cy1],
              ];
              return (
                <>
                  <Rect x={0} y={0} width={W} height={cy0} fill={dim} listening={false} />
                  <Rect x={0} y={cy1} width={W} height={Math.max(0, H - cy1)} fill={dim} listening={false} />
                  <Rect x={0} y={cy0} width={cx0} height={cy1 - cy0} fill={dim} listening={false} />
                  <Rect x={cx1} y={cy0} width={Math.max(0, W - cx1)} height={cy1 - cy0} fill={dim} listening={false} />
                  <Rect
                    x={cx0}
                    y={cy0}
                    width={cx1 - cx0}
                    height={cy1 - cy0}
                    stroke="#22d3ee"
                    strokeWidth={1.5 / t.scale}
                    dash={cropEditing ? undefined : [5 / t.scale, 4 / t.scale]}
                    listening={false}
                  />
                  {cropEditing &&
                    corners.map(([hx, hy], i) => (
                      <Rect
                        key={i}
                        x={hx - hs}
                        y={hy - hs}
                        width={hs * 2}
                        height={hs * 2}
                        fill="#22d3ee"
                        stroke="#0a0c0f"
                        strokeWidth={1 / t.scale}
                        draggable
                        onMouseDown={(e: any) => {
                          e.cancelBubble = true; // don't let the active tool see this press
                        }}
                        onDragMove={(e: any) => {
                          const nx = e.target.x() + hs;
                          const ny = e.target.y() + hs;
                          let [a, b, c, d] = docTransform.crop!;
                          if (i === 0) {
                            a = nx;
                            b = ny;
                          } else if (i === 1) {
                            c = nx;
                            b = ny;
                          } else if (i === 2) {
                            c = nx;
                            d = ny;
                          } else {
                            a = nx;
                            d = ny;
                          }
                          clampCrop(a, b, c, d);
                        }}
                      />
                    ))}
                </>
              );
            })()}
            {viewMode === "normal" && maskCanvas && <KImage image={maskCanvas} x={0} y={0} listening={false} />}
            {viewMode === "normal" && tool === "magic-brush" && hintCanvas && (
              <KImage image={hintCanvas} x={0} y={0} listening={false} opacity={0.9} />
            )}
            {viewMode === "normal" && tool === "magic-brush" && brushPreviewCanvas && (
              <KImage image={brushPreviewCanvas} x={0} y={0} listening={false} />
            )}
            {tool === "magic-brush" && cursor && !panning && (
              <Circle
                x={cursor.x}
                y={cursor.y}
                radius={brushSize / 2}
                stroke={brushMode === "eraser" ? "#f26e6e" : "#22d3ee"}
                strokeWidth={1.5 / t.scale}
                dash={[4 / t.scale, 3 / t.scale]}
                listening={false}
              />
            )}
            {loops.map((loop, i) => (
              <Line
                key={i}
                ref={(n: any) => {
                  antRefs.current[i] = n;
                }}
                points={loop.flatMap((p) => [p.x, p.y])}
                closed
                stroke={COLOR_SELECTION}
                strokeWidth={1 / t.scale}
                dash={[4 / t.scale, 4 / t.scale]}
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
            {boxPreview && (
              // live marquee while the Select tool drags a box (Adobe-style visible bounds)
              <Rect
                x={Math.min(boxPreview.a.x, boxPreview.b.x)}
                y={Math.min(boxPreview.a.y, boxPreview.b.y)}
                width={Math.abs(boxPreview.b.x - boxPreview.a.x)}
                height={Math.abs(boxPreview.b.y - boxPreview.a.y)}
                stroke={COLOR_SELECTION}
                strokeWidth={1.5 / t.scale}
                dash={[6 / t.scale, 4 / t.scale]}
                fill="rgba(34, 211, 238, 0.10)"
                listening={false}
                perfectDrawEnabled={false}
              />
            )}
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
        onPrompt={(v) => {
          setPrompt(v);
          if (v.trim()) emitMilestone("prompt");
        }}
        compiled={compiled}
        promptOverride={promptOverride}
        onOverride={setPromptOverride}
        opOverride={opOverride}
        onOpOverride={setOpOverride}
        lowChange={lowChange}
        onStronger={() => void generateNow({ strong: true })}
        hasSelection={!!mask && !mask.isEmpty()}
        status={genStatus}
        canGenerate={!!imageId && !!mask && !mask.isEmpty() && genStatus !== "busy" && genStatus !== "polling"}
        onGenerate={() => void generateNow()}
        onShootout={runShootoutNow}
        shootout={shootoutRun}
        onKeepTile={keepShootoutTile}
        onRetryTile={retryShootoutTile}
        onDismissShootout={() => setShootoutRun(null)}
        overlapsImport={selectionOverlapsImport}
        onFlatten={flattenForAI}
        harmonize={harmonize}
        onHarmonize={setHarmonize}
        varK={varK}
        onVarK={setVarK}
        onVary={runVariations}
        variations={variations}
        onPickVariation={pickVariation}
        history={history}
        onPick={() => {
          /* layers are the source of truth now; result thumbnails are informational */
        }}
      />
      </div>
      {/* right-side story (redesign A2): Layers first, then the AI panel (App renders the
          inspector immediately to our right) */}
      {img && (
        <LayersPanel
          layers={layers}
          activeId={activeLayer}
          selectedIds={selectedLayerIds}
          thumbs={thumbs}
          baseThumb={baseThumb}
          onSelect={(id, additive, range) => selectLayerRow(id, additive, range)}
          onToggleVisible={toggleVisible}
          onOpacity={setLayerOpacity}
          onBlend={setLayerBlend}
          onDelete={deleteLayer}
          onReorder={reorderLayer}
          onEdit={editLayer}
          onAdjust={setLayerAdjust}
          onReroll={reroll}
          onGroup={groupSelected}
          onAlign={alignSelected}
          onDuplicateSel={duplicateSelected}
          onDeleteSel={deleteSelected}
          onSelOpacity={setSelOpacity}
          onFillBehind={fillBehindLayer}
          onFlattenLayer={flattenLayer}
        />
      )}
    </div>
  );
}

function GenerateBar({
  prompt,
  onPrompt,
  compiled,
  promptOverride,
  onOverride,
  opOverride,
  onOpOverride,
  lowChange,
  onStronger,
  hasSelection,
  status,
  canGenerate,
  onGenerate,
  onShootout,
  shootout,
  onKeepTile,
  onRetryTile,
  onDismissShootout,
  overlapsImport,
  onFlatten,
  harmonize,
  onHarmonize,
  varK,
  onVarK,
  onVary,
  variations,
  onPickVariation,
  history,
  onPick,
}: {
  prompt: string;
  onPrompt: (v: string) => void;
  compiled: CompiledPrompt | null;
  promptOverride: string | null;
  onOverride: (v: string | null) => void;
  opOverride: string | null;
  onOpOverride: (op: string | null) => void;
  lowChange: boolean;
  onStronger: () => void;
  hasSelection: boolean;
  status: "idle" | "busy" | "polling" | "done" | "failed";
  canGenerate: boolean;
  onGenerate: () => void;
  onShootout: () => void;
  shootout: ShootoutState | null;
  onKeepTile: (t: ShootoutTile) => void;
  onRetryTile: (id: string) => void;
  onDismissShootout: () => void;
  overlapsImport: boolean;
  onFlatten: () => void;
  harmonize: HarmonizeOpts;
  onHarmonize: (h: HarmonizeOpts) => void;
  varK: number;
  onVarK: (k: number) => void;
  onVary: () => void;
  variations: { seed: number; url: string }[];
  onPickVariation: (v: { seed: number; url: string }) => void;
  history: { url: string; prompt: string }[];
  onPick: (url: string) => void;
}) {
  const A = COLOR_GENERATION;
  const cfg = useGenConfig();
  // inline progress on the Generate button itself (spinner + elapsed seconds)
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (status !== "busy" && status !== "polling") {
      setElapsed(0);
      return;
    }
    const t0 = Date.now();
    const iv = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    return () => window.clearInterval(iv);
  }, [status]);
  const running = status === "busy" || status === "polling";
  const compare = cfg.compareMode && cfg.compareSet.length >= 2;
  const compareCost = cfg.compareSet.reduce(
    (s, id) => s + (modelById(id)?.estCostCents ?? 1),
    0
  );
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
  const dimmed = !hasSelection && !shootout && variations.length === 0 && !running;
  return (
    <div
      data-tour="generate"
      style={{
        borderTop: `1px solid ${A}33`,
        background: "#15120b",
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        position: "relative",
      }}
    >
      {dimmed && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            zIndex: 2,
            color: "#8a7f63",
            fontSize: 12.5,
            pointerEvents: "none",
          }}
        >
          Select something to edit — click your subject with ⬚ Select (M)
        </div>
      )}
      <div style={{ opacity: dimmed ? 0.35 : 1, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 10.5, color: "#8a7f63", display: "flex", alignItems: "center", gap: 6, paddingLeft: 16 }}>
        <span>→ {cfg.modelLabel ?? "mock (no model selected)"}</span>
        {cfg.referenceRole && cfg.referencePng && (
          <span style={{ color: A }}>· {cfg.referenceRole} reference{cfg.referenceRole === "pose" ? ` (${Math.round(cfg.controlStrength * 100)}%)` : ""}</span>
        )}
        {cfg.loras.length > 0 && <span style={{ color: A }}>· {cfg.loras.length} LoRA</span>}
      </div>
      {overlapsImport && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 11,
            color: "#f2c078",
            background: "#2a1e0b",
            border: "1px solid #f2a33c55",
            borderRadius: 6,
            padding: "5px 9px",
          }}
        >
          <span>⚠ Your selection overlaps an imported image the AI can't see yet.</span>
          <button
            onClick={onFlatten}
            style={{ border: "none", background: A, color: "#1a160e", borderRadius: 5, padding: "3px 9px", cursor: "pointer", fontWeight: 700, fontSize: 11 }}
          >
            ⤵ Flatten for AI
          </button>
        </div>
      )}
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
            borderLeft: `3px solid ${A}`,
            borderRadius: 6,
            padding: "9px 10px",
            fontSize: 13.5,
          }}
        />
        <button
          onClick={compare ? onShootout : onGenerate}
          disabled={!canGenerate}
          title={
            compare
              ? "Fan this edit out across the comparison set — one tuned prompt per model, everything else held identical"
              : undefined
          }
          style={{
            padding: "8px 16px",
            borderRadius: 6,
            border: "none",
            cursor: canGenerate ? "pointer" : "default",
            fontWeight: 700,
            color: "#1a160e",
            background: A,
            opacity: canGenerate ? 1 : 0.5,
            whiteSpace: "nowrap",
          }}
        >
          {running
            ? `⟳ ${status === "polling" ? "polling" : "working"} · ${elapsed}s`
            : compare
            ? `Run shootout (${cfg.compareSet.length} models · ~${compareCost.toFixed(1)}¢)`
            : "Generate"}
        </button>
        <button
          onClick={onVary}
          disabled={!canGenerate}
          title="Run K seed variations into the candidate tray"
          style={{ padding: "8px 10px", borderRadius: 6, border: `1px solid ${A}`, background: "transparent", color: A, cursor: canGenerate ? "pointer" : "default", fontWeight: 700, opacity: canGenerate ? 1 : 0.5 }}
        >
          Vary ×
        </button>
        <input
          type="number"
          min={2}
          max={6}
          value={varK}
          onChange={(e) => onVarK(Math.max(2, Math.min(6, Number(e.target.value))))}
          style={{ width: 40, background: "#0d0f12", color: "#e2e8f0", border: "1px solid #2a2f37", borderRadius: 5, padding: "6px 4px", fontSize: 12 }}
        />
        {chip && (
          <span style={{ fontSize: 11, color: chip.c, minWidth: 56 }}>{chip.t}</span>
        )}
      </div>

      {/* prompt intelligence: the compiled, model-tuned prompt + rationale + corrections */}
      {!compare && (
        <TunedPromptDisclosure
          compiled={prompt.trim() ? compiled : null}
          modelLabel={cfg.modelLabel ?? "FLUX Kontext (default profile)"}
          override={promptOverride}
          onOverride={onOverride}
          operation={opOverride}
          onOperation={onOpOverride}
          onQuickAnswer={(ans) => onPrompt(`${prompt.trim().replace(/[.!?]+$/, "")}, ${ans}`)}
          lowChange={lowChange}
          onStronger={onStronger}
          busy={running}
        />
      )}

      {shootout && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            border: `1px solid ${A}44`,
            borderRadius: 8,
            padding: 8,
            background: "#191509",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: A }}>
            <b>Shootout</b>
            <span style={{ color: "#8a7f63" }}>“{shootout.intent}”</span>
            <span style={{ marginLeft: "auto", color: "#7d7252", fontSize: 10 }}>
              seeds locked per model for re-runs; not comparable across models
            </span>
            <button
              onClick={onDismissShootout}
              title="Dismiss results"
              style={{ border: "none", background: "transparent", color: "#8a7f63", cursor: "pointer", fontSize: 13 }}
            >
              ✕
            </button>
          </div>
          <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>
            {shootout.tiles.map((t) => (
              <div
                key={t.modelId}
                style={{
                  flex: "0 0 auto",
                  width: 190,
                  border: `1px solid ${shootout.winner === t.modelId ? A : "#3a3320"}`,
                  borderRadius: 7,
                  background: "#12100a",
                  padding: 6,
                  display: "flex",
                  flexDirection: "column",
                  gap: 5,
                }}
              >
                <div
                  style={{
                    height: 100,
                    borderRadius: 5,
                    background: "#0a0c0f",
                    display: "grid",
                    placeItems: "center",
                    overflow: "hidden",
                  }}
                >
                  {t.status === "done" && t.url ? (
                    <img src={t.url} alt={t.label} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
                  ) : t.status === "failed" ? (
                    <span style={{ fontSize: 10, color: "#ef4444", padding: 6, textAlign: "center" }}>
                      ✕ {t.error ?? "failed"}
                    </span>
                  ) : (
                    <span style={{ fontSize: 10.5, color: "#eab308" }}>polling…</span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10.5 }}>
                  <b style={{ color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.label}
                  </b>
                  {t.latencyMs != null && (
                    <span style={{ marginLeft: "auto", color: "#7d8694" }}>{(t.latencyMs / 1000).toFixed(1)}s</span>
                  )}
                </div>
                <details style={{ fontSize: 9.5, color: "#9a8b6a" }}>
                  <summary style={{ cursor: "pointer" }}>prompt</summary>
                  <div style={{ whiteSpace: "pre-wrap", marginTop: 3 }}>{t.prompt}</div>
                  {t.ruleNote && <div style={{ color: "#6b6248", marginTop: 3 }}>{t.ruleNote}</div>}
                </details>
                <div style={{ display: "flex", gap: 5 }}>
                  {t.status === "done" && (
                    <button
                      onClick={() => onKeepTile(t)}
                      style={{
                        flex: 1,
                        border: "none",
                        background: shootout.winner === t.modelId ? "#22c55e" : A,
                        color: "#1a160e",
                        borderRadius: 5,
                        padding: "4px 0",
                        fontWeight: 700,
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      {shootout.winner === t.modelId ? "✓ Kept" : "Keep"}
                    </button>
                  )}
                  {t.status === "failed" && (
                    <button
                      onClick={() => onRetryTile(t.modelId)}
                      style={{ flex: 1, border: `1px solid ${A}`, background: "transparent", color: A, borderRadius: 5, padding: "4px 0", fontSize: 11, cursor: "pointer" }}
                    >
                      ↻ Retry
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {variations.length > 0 && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", overflowX: "auto" }}>
          <span style={{ fontSize: 10.5, color: A }}>candidates →</span>
          {variations.map((v) => (
            <img
              key={v.seed}
              src={v.url}
              title={`seed ${v.seed} — click to keep`}
              onClick={() => onPickVariation(v)}
              style={{ height: 56, borderRadius: 5, border: `1px solid ${A}66`, cursor: "pointer" }}
            />
          ))}
        </div>
      )}
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
    </div>
  );
}

function FileBar({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  hasImage,
  onOpen,
  onSave,
  onOpenProject,
  onImport,
  onFlatten,
  canFlatten,
  onAddAdjustment,
  straighten,
  onStraighten,
  onAspect,
  hasCrop,
  onExtend,
  onFinish,
  decomposing,
  onDecompose,
  onExport,
  onExportAs,
  onExportCutout,
  canExportCutout,
}: {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  hasImage: boolean;
  onOpen: (f: File) => void;
  onSave: () => void;
  onOpenProject: (f: File) => void;
  onImport: (f: File) => void;
  onFlatten: () => void;
  canFlatten: boolean;
  onAddAdjustment: () => void;
  straighten: number;
  onStraighten: (deg: number) => void;
  onAspect: (ratio: number | null) => void;
  hasCrop: boolean;
  onExtend: (ratio: number) => void;
  onFinish: (scale: number, faceRestore: boolean) => void;
  decomposing: boolean;
  onDecompose: (g: "simple" | "fine") => void;
  onExport: () => void;
  onExportAs: (fmt: "png" | "jpeg" | "webp", quality: number) => void;
  onExportCutout: () => void;
  canExportCutout: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const openRef = useRef<HTMLInputElement>(null);
  const [finishFace, setFinishFace] = useState(false);
  const [exportFmt, setExportFmt] = useState<"png" | "jpeg" | "webp">("png");
  const [exportQuality, setExportQuality] = useState(0.92);
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
      data-tour="filebar"
      style={{
        minHeight: 32,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        padding: "3px 10px",
        borderBottom: "1px solid #20242b",
        background: "#0d1014",
        font: "11.5px ui-monospace, monospace",
        color: "#94a3b8",
      }}
    >
      {/* hidden pickers shared by the menus */}
      <input
        ref={openRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) onOpen(e.target.files[0]);
          e.currentTarget.value = "";
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept=".neuclip,application/json"
        hidden
        onChange={(e) => e.target.files?.[0] && onOpenProject(e.target.files[0])}
      />
      <input
        ref={importRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) onImport(e.target.files[0]);
          e.currentTarget.value = "";
        }}
      />

      <Menu label="File" dataTour="filemenu">
        <MenuItem label="Open image…" onClick={() => openRef.current?.click()} />
        <MenuItem label="Open project (.neuclip)…" onClick={() => fileRef.current?.click()} />
        <MenuItem label="Save project (.neuclip)" hint="⌘S" disabled={!hasImage} onClick={onSave} />
        <MenuItem
          label="Import image as layer…"
          disabled={!hasImage}
          onClick={() => importRef.current?.click()}
        />
        <MenuDivider />
        <MenuItem label="Export PNG" disabled={!hasImage} onClick={onExport} />
        <MenuItem
          label="Export cutout (selection only)"
          disabled={!canExportCutout}
          onClick={onExportCutout}
        />
        <MenuRow label="Export as">
          <select
            value={exportFmt}
            onChange={(e) => setExportFmt(e.target.value as "png" | "jpeg" | "webp")}
            style={{ background: "#181c22", color: "#cbd5e1", border: "1px solid #2a2f37", borderRadius: 5, padding: "2px 4px", fontSize: 11 }}
          >
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WebP</option>
          </select>
          {exportFmt !== "png" && (
            <>
              <input
                type="range"
                min={0.4}
                max={1}
                step={0.02}
                value={exportQuality}
                onChange={(e) => setExportQuality(Number(e.target.value))}
                title="Quality"
                style={{ flex: 1, accentColor: "#22d3ee" }}
              />
              <span style={{ width: 30, textAlign: "right" }}>{Math.round(exportQuality * 100)}</span>
            </>
          )}
        </MenuRow>
        <MenuItem
          label={`Export ${exportFmt.toUpperCase()}…`}
          disabled={!hasImage}
          onClick={() => onExportAs(exportFmt, exportQuality)}
        />
        <MenuDivider />
        <MenuRow label="Finish">
          <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={finishFace}
              onChange={(e) => setFinishFace(e.target.checked)}
              style={{ accentColor: "#22d3ee" }}
            />
            restore faces
          </label>
        </MenuRow>
        <MenuItem label="Upscale 2× and export" disabled={!hasImage} onClick={() => onFinish(2, finishFace)} />
        <MenuItem label="Upscale 4× and export" disabled={!hasImage} onClick={() => onFinish(4, finishFace)} />
      </Menu>

      <Menu label="Image" width={250}>
        <MenuRow label="Crop">
          <select
            disabled={!hasImage}
            defaultValue="Free"
            onChange={(e) => {
              const a = ASPECTS.find((x) => x[0] === e.target.value);
              onAspect((a?.[1] as number | null) ?? null);
            }}
            style={{ ...btn, padding: "2px 4px", flex: 1 }}
          >
            {ASPECTS.map(([label]) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
          {hasCrop && <span style={{ color: "#22d3ee", fontSize: 10 }}>cropped</span>}
        </MenuRow>
        <MenuRow label="Extend">
          <select
            disabled={!hasImage}
            defaultValue=""
            onChange={(e) => {
              const r = Number(e.target.value);
              if (r) onExtend(r);
              e.target.value = "";
            }}
            style={{ ...btn, padding: "2px 4px", flex: 1 }}
            title="Outpaint: extend the canvas to a new aspect and fill the new region"
          >
            <option value="">to…</option>
            <option value={1}>1:1</option>
            <option value={16 / 9}>16:9</option>
            <option value={9 / 16}>9:16</option>
            <option value={4 / 3}>4:3</option>
            <option value={3 / 2}>3:2</option>
          </select>
        </MenuRow>
        <MenuRow label="Straighten">
          <input
            type="range"
            min={-15}
            max={15}
            step={0.5}
            value={straighten}
            disabled={!hasImage}
            onChange={(e) => onStraighten(Number(e.target.value))}
            style={{ flex: 1, accentColor: "#22d3ee" }}
          />
          <span style={{ width: 36, textAlign: "right" }}>{straighten.toFixed(1)}°</span>
        </MenuRow>
        <MenuDivider />
        <MenuItem
          label={decomposing ? "Separating…" : "Auto-separate into layers"}
          accent="#f2a33c"
          disabled={!hasImage || decomposing}
          onClick={() => onDecompose("simple")}
        />
        <MenuItem
          label="Flatten for AI (bake all layers)"
          accent="#f2a33c"
          disabled={!canFlatten}
          onClick={onFlatten}
        />
        <MenuItem label="Add adjustment layer" disabled={!hasImage} onClick={onAddAdjustment} />
      </Menu>

      <span style={{ width: 1, height: 16, background: "#2a2f37" }} />
      <button
        style={{ ...btn, borderColor: "#f2a33c55", color: "#f2a33c" }}
        disabled={!canFlatten}
        onClick={onFlatten}
        title="Bake all layers (incl. imported images) into the base so AI edits apply to them"
      >
        ⤵ Flatten for AI
      </button>
      <button
        style={{ ...btn, borderColor: "#f2a33c55", color: "#f2a33c" }}
        disabled={!hasImage || decomposing}
        onClick={() => onDecompose("simple")}
        title="AI auto-separate subjects + background into editable layers"
      >
        {decomposing ? "separating…" : "⛶ Auto-separate"}
      </button>
      <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
        <Tip name="Undo" keys="⌘Z" side="bottom">
          <button style={{ ...btn, width: 28, padding: "3px 0", textAlign: "center" }} disabled={!canUndo} onClick={onUndo}>↶</button>
        </Tip>
        <Tip name="Redo" keys="⌘⇧Z" side="bottom">
          <button style={{ ...btn, width: 28, padding: "3px 0", textAlign: "center" }} disabled={!canRedo} onClick={onRedo}>↷</button>
        </Tip>
      </span>
    </div>
  );
}

// --- tools (redesign A2): vertical rail, icon-only, flyout for lasso modes -----------
const TOOL_DEFS: { id: Tool; icon: string; name: string; desc: string; key: string }[] = [
  { id: "move", icon: "✥", name: "Move", desc: "Move and transform layers; drag from empty space to select several", key: "V" },
  { id: "select", icon: "⬚", name: "Select", desc: "Click an object to select it · Ctrl-click adds another · Alt-click removes · drag a box", key: "M" },
  { id: "lasso", icon: "◠", name: "Lasso", desc: "Draw a selection by hand — long-press for Freehand / Polygon / Magnetic", key: "L" },
  { id: "pen", icon: "✎", name: "Pen", desc: "Click = corner, drag = curve, Alt-click toggles smooth, Enter commits", key: "P" },
  { id: "wand", icon: "✦", name: "Magic Wand", desc: "Click to select similar colors", key: "Shift+W" },
  { id: "magic-brush", icon: "🖌", name: "Magic Brush", desc: "Paint roughly — AI snaps it to the subject", key: "W" },
  { id: "hand", icon: "✋", name: "Hand", desc: "Pan the view (or hold Space with any tool)", key: "H" },
];

const LASSO_MODES: { id: LassoMode; label: string; desc: string }[] = [
  { id: "free", label: "Freehand", desc: "Draw the outline by dragging" },
  { id: "poly", label: "Polygon", desc: "Click straight-line corners" },
  { id: "magnetic", label: "Magnetic", desc: "Snaps to edges as you go" },
];

function ToolRail({
  tool,
  onTool,
  lassoMode,
  onLassoMode,
  hasImage,
  zoom,
  onIn,
  onOut,
  onFit,
  onActual,
}: {
  tool: Tool;
  onTool: (t: Tool) => void;
  lassoMode: LassoMode;
  onLassoMode: (m: LassoMode) => void;
  hasImage: boolean;
  zoom: number;
  onIn: () => void;
  onOut: () => void;
  onFit: () => void;
  onActual: () => void;
}) {
  const [flyout, setFlyout] = useState(false);
  const press = useRef(0);
  const railBtn = (active: boolean): React.CSSProperties => ({
    width: 32,
    height: 30,
    display: "grid",
    placeItems: "center",
    border: `1px solid ${active ? HUE.selection : "transparent"}`,
    borderRadius: RADII.control,
    background: active ? `${HUE.selection}22` : "transparent",
    color: active ? HUE.selection : "#aeb9c9",
    fontSize: 14,
    cursor: "pointer",
  });
  return (
    <div
      data-tour="tools"
      style={{
        width: 44,
        flex: "0 0 44px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 3,
        paddingTop: 8,
        borderRight: `1px solid ${NEUTRAL.n5}`,
        background: NEUTRAL.n1,
        position: "relative",
      }}
    >
      {TOOL_DEFS.map((d) => (
        <span key={d.id} style={{ position: "relative" }}>
          <Tip name={d.name} desc={d.desc} keys={d.key} side="right">
            <button
              style={railBtn(tool === d.id)}
              onClick={() => {
                onTool(d.id);
                if (d.id !== "lasso") setFlyout(false);
              }}
              onContextMenu={(e) => {
                if (d.id === "lasso") {
                  e.preventDefault();
                  onTool("lasso");
                  setFlyout(true);
                }
              }}
              onMouseDown={() => {
                if (d.id === "lasso") {
                  press.current = window.setTimeout(() => setFlyout(true), 450);
                }
              }}
              onMouseUp={() => window.clearTimeout(press.current)}
              onMouseLeave={() => window.clearTimeout(press.current)}
            >
              {d.icon}
              {d.id === "lasso" && (
                <span style={{ position: "absolute", right: 2, bottom: 0, fontSize: 7, color: "#5c6473" }}>◢</span>
              )}
            </button>
          </Tip>
          {d.id === "lasso" && flyout && (
            <div
              style={{
                position: "absolute",
                left: 40,
                top: 0,
                zIndex: 1200,
                background: NEUTRAL.n3,
                border: `1px solid ${NEUTRAL.n6}`,
                borderRadius: RADII.card,
                padding: 4,
                display: "flex",
                flexDirection: "column",
                gap: 2,
                boxShadow: "0 8px 24px #000a",
                minWidth: 150,
              }}
              onMouseLeave={() => setFlyout(false)}
            >
              {LASSO_MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    onLassoMode(m.id);
                    onTool("lasso");
                    setFlyout(false);
                  }}
                  style={{
                    textAlign: "left",
                    border: "none",
                    borderRadius: RADII.control,
                    background: lassoMode === m.id ? `${HUE.selection}22` : "transparent",
                    color: lassoMode === m.id ? HUE.selection : "#cbd5e1",
                    padding: "5px 8px",
                    fontSize: 11.5,
                    cursor: "pointer",
                  }}
                >
                  {m.label}
                  <span style={{ display: "block", fontSize: 9.5, color: "#7d8694" }}>{m.desc}</span>
                </button>
              ))}
            </div>
          )}
        </span>
      ))}
      <span style={{ width: 24, height: 1, background: NEUTRAL.n6, margin: "6px 0" }} />
      <Tip name="Zoom in" keys="⌘ +" side="right">
        <button style={railBtn(false)} disabled={!hasImage} onClick={onIn}>+</button>
      </Tip>
      <span style={{ fontSize: 9, color: "#7d8694" }}>{(zoom * 100).toFixed(0)}%</span>
      <Tip name="Zoom out" keys="⌘ −" side="right">
        <button style={railBtn(false)} disabled={!hasImage} onClick={onOut}>−</button>
      </Tip>
      <Tip name="Fit to window" keys="⌘ 0" side="right">
        <button style={{ ...railBtn(false), fontSize: 11 }} disabled={!hasImage} onClick={onFit}>⤢</button>
      </Tip>
      <Tip name="Actual pixels" keys="⌘ 1" side="right">
        <button style={{ ...railBtn(false), fontSize: 9 }} disabled={!hasImage} onClick={onActual}>1:1</button>
      </Tip>
    </div>
  );
}

// --- contextual options bar (redesign A2): ONLY the active tool's options ------------
function OptionsBar(props: {
  tool: Tool;
  busy: boolean;
  canRefine: boolean;
  onSubject: () => void;
  onRefine: () => void;
  onInvert: () => void;
  onClearSel: () => void;
  antialias: boolean;
  onAntialias: (v: boolean) => void;
  feather: number;
  onFeather: (v: number) => void;
  onGrow: () => void;
  onShrink: () => void;
  onSmooth: () => void;
  semanticText: string;
  onSemanticText: (v: string) => void;
  onSemantic: () => void;
  onSaveSel: () => void;
  named: string[];
  onLoadSel: (idx: number) => void;
  note: string | null;
  wandTol: number;
  onWandTol: (v: number) => void;
  wandContig: boolean;
  onWandContig: (v: boolean) => void;
  lassoMode: LassoMode;
  onLassoMode: (m: LassoMode) => void;
  brushSize: number;
  onBrushSize: (v: number) => void;
  brushMode: BrushMode;
  onBrushMode: (m: BrushMode) => void;
  brushSnap: BrushSnap;
  onBrushSnap: (s: BrushSnap) => void;
  brushRefine: boolean;
  onBrushRefine: (v: boolean) => void;
  hasBrushPreview: boolean;
  onBrushCommit: () => void;
  onBrushClear: () => void;
  selectedLayerCount: number;
}) {
  const C = HUE.selection;
  const [more, setMore] = useState(false);
  const small: React.CSSProperties = { ...btn, padding: "3px 8px", fontSize: 11 };
  const seg = (active: boolean): React.CSSProperties => ({
    ...small,
    background: active ? C : NEUTRAL.n4,
    color: active ? "#08222b" : "#cbd5e1",
    fontWeight: active ? 700 : 400,
  });
  const bar: React.CSSProperties = {
    minHeight: 36,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 7,
    padding: "3px 10px",
    borderBottom: `1px solid ${NEUTRAL.n5}`,
    background: "#0c1113",
    font: "11px ui-monospace, monospace",
    color: "#7da3ab",
  };
  const featherCtl = (
    <Tip name="Feather" desc="Softens the selection edge — Gaussian blur of the selection channel, like Photoshop" side="bottom">
      <label style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10.5 }}>
        feather
        <input
          type="number"
          min={0}
          max={1000}
          value={props.feather}
          onChange={(e) => props.onFeather(Math.max(0, Math.min(1000, Number(e.target.value) || 0)))}
          style={{ ...field, width: 42, padding: "2px 4px", fontSize: 11 }}
        />
      </label>
    </Tip>
  );
  const refineCtl = (
    <Tip
      name="Refine edge"
      desc="Snaps the selection edge to fine detail (hair, fur)"
      reason={!props.canRefine ? "Make a selection first — try clicking your subject with Select (M)" : undefined}
      side="bottom"
    >
      <button style={small} disabled={!props.canRefine || props.busy} onClick={props.onRefine}>
        ✦ Refine edge
      </button>
    </Tip>
  );
  const moreCtl = (
    <>
      <button style={{ ...small, color: more ? C : "#7da3ab" }} onClick={() => setMore((v) => !v)} title="More selection options">
        ⋯ More
      </button>
      {more && (
        <>
          <label style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10.5, cursor: "pointer" }} title="Anti-alias the selection edge (sub-pixel coverage)">
            <input type="checkbox" checked={props.antialias} onChange={(e) => props.onAntialias(e.target.checked)} style={{ accentColor: C }} />
            AA
          </label>
          <button style={small} disabled={!props.canRefine} onClick={props.onGrow} title="Grow selection 3px">Grow</button>
          <button style={small} disabled={!props.canRefine} onClick={props.onShrink} title="Shrink selection 3px">Shrink</button>
          <button style={small} disabled={!props.canRefine} onClick={props.onSmooth} title="Smooth selection edges">Smooth</button>
          <button style={small} disabled={!props.canRefine} onClick={props.onInvert} title="Invert selection (⌘⇧I)">Invert</button>
          <button style={small} disabled={!props.canRefine} onClick={props.onClearSel} title="Deselect (⌘D)">Deselect</button>
          <button style={small} disabled={!props.canRefine} onClick={props.onSaveSel} title="Save current selection by name">Save sel</button>
          {props.named.length > 0 && (
            <select defaultValue="" onChange={(e) => e.target.value !== "" && props.onLoadSel(Number(e.target.value))} style={{ ...small, padding: "2px 4px" }}>
              <option value="">load…</option>
              {props.named.map((n, i) => (
                <option key={i} value={i}>{n}</option>
              ))}
            </select>
          )}
        </>
      )}
    </>
  );

  const deselectCtl = (
    <Tip name="Deselect" desc="Clear the whole selection" keys="Esc / ⌘D" side="bottom">
      <button
        style={{ ...small, opacity: props.canRefine ? 1 : 0.45 }}
        disabled={!props.canRefine}
        onClick={props.onClearSel}
      >
        ✕ Deselect
      </button>
    </Tip>
  );

  let content: React.ReactNode = null;
  if (props.tool === "select") {
    content = (
      <>
        <Tip name="Select subject" desc="One click finds the main subject" side="bottom">
          <button style={{ ...seg(false), borderColor: `${C}66`, color: C }} disabled={props.busy} onClick={props.onSubject}>
            ⊙ Select subject
          </button>
        </Tip>
        <input
          value={props.semanticText}
          onChange={(e) => props.onSemanticText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && props.onSemantic()}
          placeholder="select by text (e.g. the red ball)"
          style={{ ...field, width: 170, padding: "3px 6px", fontSize: 11 }}
        />
        <button style={small} disabled={props.busy} onClick={props.onSemantic}>Find</button>
        <Tip name="Multi-select" desc="Click = select an object · Ctrl-click adds another · Alt-click removes one · drag = box" side="bottom">
          <span style={{ color: "#5c6473", cursor: "help" }}>Ctrl adds</span>
        </Tip>
        <span style={divider} />
        {refineCtl}
        {featherCtl}
        {deselectCtl}
        {moreCtl}
      </>
    );
  } else if (props.tool === "wand") {
    content = (
      <>
        <Tip name="Tolerance" desc="How similar colors must be to join the selection" side="bottom">
          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
            tolerance
            <input type="range" min={0.01} max={0.6} step={0.01} value={props.wandTol} onChange={(e) => props.onWandTol(Number(e.target.value))} style={{ width: 90, accentColor: C }} />
          </label>
        </Tip>
        <label style={{ display: "flex", alignItems: "center", gap: 3, cursor: "pointer" }} title="Uncheck to grab matching colors everywhere in the image">
          <input type="checkbox" checked={props.wandContig} onChange={(e) => props.onWandContig(e.target.checked)} style={{ accentColor: C }} />
          contiguous
        </label>
        <span style={divider} />
        {refineCtl}
        {featherCtl}
        {deselectCtl}
        {moreCtl}
      </>
    );
  } else if (props.tool === "lasso") {
    content = (
      <>
        {LASSO_MODES.map((m) => (
          <button key={m.id} style={seg(props.lassoMode === m.id)} onClick={() => props.onLassoMode(m.id)} title={m.desc}>
            {m.label}
          </button>
        ))}
        <span style={{ color: "#5c6473" }}>Enter/double-click closes · Esc cancels · Shift adds, Alt subtracts</span>
        <span style={divider} />
        {refineCtl}
        {featherCtl}
        {moreCtl}
      </>
    );
  } else if (props.tool === "pen") {
    content = (
      <>
        <span style={{ color: "#5c6473" }}>Click = corner · drag = curve · Alt-click toggles smooth · Enter commits</span>
        <span style={divider} />
        {featherCtl}
        {moreCtl}
      </>
    );
  } else if (props.tool === "magic-brush") {
    content = (
      <>
        <span style={{ color: C, fontWeight: 700 }}>🖌 Magic Brush</span>
        <span>Size</span>
        <input type="range" min={1} max={300} value={Math.min(300, props.brushSize)} onChange={(e) => props.onBrushSize(Number(e.target.value))} style={{ width: 100, accentColor: C }} />
        <input type="number" min={1} max={1000} value={props.brushSize} onChange={(e) => props.onBrushSize(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))} style={{ ...field, width: 52, padding: "2px 4px", fontSize: 11 }} />
        <span style={{ color: "#5c6473" }}>[ ]</span>
        <button style={seg(props.brushMode === "brush")} onClick={() => props.onBrushMode("brush")} title="Brush — paint the subject">Brush +</button>
        <button style={seg(props.brushMode === "eraser")} onClick={() => props.onBrushMode("eraser")} title="Eraser — subtract (Alt does this temporarily)">Eraser −</button>
        <span>Snap</span>
        {(["ai", "local", "off"] as BrushSnap[]).map((sv) => (
          <button key={sv} style={seg(props.brushSnap === sv)} onClick={() => props.onBrushSnap(sv)} title={sv === "ai" ? "AI — snaps your scribble to the subject" : sv === "local" ? "Local edge-grow (works offline)" : "Off — raw paint"}>
            {sv === "ai" ? "AI" : sv === "local" ? "Local" : "Off"}
          </button>
        ))}
        <label style={{ display: "flex", alignItems: "center", gap: 3, cursor: "pointer" }} title="Refine edges on commit">
          <input type="checkbox" checked={props.brushRefine} onChange={(e) => props.onBrushRefine(e.target.checked)} style={{ accentColor: C }} />
          Refine edges
        </label>
        <button
          style={{ ...seg(false), color: props.hasBrushPreview ? "#08222b" : "#5c6473", background: props.hasBrushPreview ? C : NEUTRAL.n4, fontWeight: 700 }}
          disabled={!props.hasBrushPreview}
          onClick={props.onBrushCommit}
          title="Commit selection (Enter)"
        >
          Commit ⏎
        </button>
        <button style={small} disabled={!props.hasBrushPreview} onClick={props.onBrushClear} title="Clear hints + preview (Esc)">Clear</button>
      </>
    );
  } else if (props.tool === "move") {
    content = (
      <span style={{ color: "#5c6473" }}>
        {props.selectedLayerCount
          ? `${props.selectedLayerCount} layer${props.selectedLayerCount > 1 ? "s" : ""} selected — drag to move · corners scale · just outside a corner rotates (Shift snaps 15°)`
          : "Click a layer to select it · drag from empty space to select several"}
      </span>
    );
  } else if (props.tool === "hand") {
    content = <span style={{ color: "#5c6473" }}>Drag to pan — or hold Space with any tool</span>;
  }

  return (
    <div data-tour="optionsbar" style={bar}>
      {content}
      {props.note && <span style={{ color: "#eab308", fontSize: 10.5 }}>{props.note}</span>}
    </div>
  );
}

// --- empty state (redesign A2): a drop-zone card that teaches --------------------------
function EmptyState({ onOpen, onSample }: { onOpen: (f: File) => void; onSample: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 14,
          border: `1.5px dashed ${NEUTRAL.n6}`,
          borderRadius: RADII.modal,
          padding: "44px 64px",
          background: "#0d101466",
        }}
      >
        <span style={{ fontSize: 40, color: "#3f4753" }}>⤓</span>
        <div style={{ fontSize: TYPE.title, color: NEUTRAL.n9, fontWeight: 600 }}>
          Drop an image anywhere
        </div>
        <input
          ref={ref}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => e.target.files?.[0] && onOpen(e.target.files[0])}
        />
        <button
          data-tour="open"
          onClick={() => ref.current?.click()}
          style={{ ...btn, borderColor: HUE.file, color: HUE.file, padding: "7px 18px", fontSize: 13 }}
        >
          or Open image (⌘O)
        </button>
        <button
          onClick={onSample}
          style={{ background: "transparent", border: "none", color: "#7d8694", fontSize: 12, cursor: "pointer", textDecoration: "underline" }}
        >
          Try the sample image
        </button>
      </div>
    </div>
  );
}


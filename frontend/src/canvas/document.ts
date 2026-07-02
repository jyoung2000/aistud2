// Non-destructive edit stack (Tier-1 Phase 1). A Document is a base image + an ordered list
// of layers. The base is NEVER mutated; the visible image is the composite of base → layers.
// AI edits become re-editable `ai-edit` layers carrying their full source spec.

export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "soft-light"
  | "darken"
  | "lighten"
  | "difference";

export type LayerKind = "base" | "ai-edit" | "adjustment" | "outpaint" | "decomposed" | "imported";

export type Region = [number, number, number, number]; // x0,y0,x1,y1 image space
export type LayerBounds = [number, number, number, number]; // x,y,w,h image space

/** Non-destructive per-layer transform, applied at composite around the layer's bounds centre. */
export interface LayerTransform {
  tx: number;
  ty: number;
  scale: number;
  rotation: number; // radians
}

export const IDENTITY_TRANSFORM: LayerTransform = { tx: 0, ty: 0, scale: 1, rotation: 0 };

/** A folder/group of layers. */
export interface LayerGroup {
  id: string;
  name: string;
  collapsed: boolean;
  layerIds: string[];
}

export interface RefSpec {
  role: string;
  // (reference image bytes live with the edit; a thumb ref is enough for the doc)
  present: boolean;
}

export interface LayerSource {
  model: string;
  prompt: string;
  seed: number;
  params: Record<string, number>;
  sendRegion: Region;
  reference?: RefSpec;
  /** Pose-role edits carry the hand-edited skeleton so the rig is re-editable on later passes
   *  (stored as the Pose JSON; see pose/poseModel.ts). control_strength lives in params. */
  pose?: unknown;
}

export interface HarmonizeSpec {
  on: boolean;
  colorMatch: boolean;
  relight: boolean;
  grainMatch: boolean;
  strength: number;
}

export type AdjustType = "exposure" | "contrast" | "saturation" | "temperature" | "vibrance";

export interface AdjustSpec {
  // a single adjustment layer can carry several values at once
  values: Partial<Record<AdjustType, number>>; // each -1..1
  clip: boolean; // clip to the layer directly below (else affects all below)
}

export interface DocTransform {
  straighten: number; // degrees
  crop?: Region; // image-space crop rect (subset of doc bounds)
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number; // 0..1
  blendMode: BlendMode;
  kind: LayerKind;
  /** Re-editable region as an image-space binary alpha (full-doc length). Absent = whole doc. */
  mask?: Uint8Array;
  /** Cached generated pixels for ai-edit / outpaint layers (data URL, full-doc sized). */
  resultUrl?: string;
  /** Full re-roll/re-mask spec for ai-edit / outpaint. */
  source?: LayerSource;
  /** Seam harmonization (Phase 3). */
  harmonize?: HarmonizeSpec;
  /** Adjustment-layer spec (kind === 'adjustment'). */
  adjust?: AdjustSpec;
  // --- auto-layer / move-tool additions ---
  /** Image-space bbox [x,y,w,h] of the layer's content, for marquee hit-testing. */
  bounds?: LayerBounds;
  /** Non-destructive transform applied at composite (moving never alters pixels). */
  transform?: LayerTransform;
  locked?: boolean;
  /** Membership in a Document.groups folder. */
  groupId?: string;
}

export interface NeuDocument {
  width: number;
  height: number;
  baseImageRef: string; // data URL or sidecar id of the base (never mutated)
  layers: Layer[];
  groups?: LayerGroup[];
  selections?: { name: string; mask: number[] }[]; // named selections (Phase 5)
}

/** Derive a layer's image-space bbox [x,y,w,h] from its mask. Null if empty. */
export function boundsFromMask(mask: Uint8Array, w: number, h: number): LayerBounds | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

/** Bounds for a layer; falls back to the full document when it has no mask. */
export function layerBounds(layer: Layer, docW: number, docH: number): LayerBounds {
  if (layer.bounds) return layer.bounds;
  if (layer.mask) return boundsFromMask(layer.mask, docW, docH) ?? [0, 0, docW, docH];
  return [0, 0, docW, docH];
}

function hasTransform(t?: LayerTransform): t is LayerTransform {
  return !!t && (t.tx !== 0 || t.ty !== 0 || t.scale !== 1 || t.rotation !== 0);
}

interface Pt2 {
  x: number;
  y: number;
}

function center(layer: Layer, w: number, h: number): Pt2 {
  const [bx, by, bw, bh] = layerBounds(layer, w, h);
  return { x: bx + bw / 2, y: by + bh / 2 };
}

/** Forward map a layer-space point through the layer transform → image space. */
export function forwardPoint(p: Pt2, layer: Layer, w: number, h: number): Pt2 {
  const t = layer.transform ?? IDENTITY_TRANSFORM;
  const c = center(layer, w, h);
  let x = (p.x - c.x) * t.scale;
  let y = (p.y - c.y) * t.scale;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  return { x: x * cos - y * sin + c.x + t.tx, y: x * sin + y * cos + c.y + t.ty };
}

/** Inverse map an image-space point back into the layer's untransformed space. */
export function inversePoint(q: Pt2, layer: Layer, w: number, h: number): Pt2 {
  const t = layer.transform ?? IDENTITY_TRANSFORM;
  const c = center(layer, w, h);
  let x = q.x - (c.x + t.tx);
  let y = q.y - (c.y + t.ty);
  const cos = Math.cos(-t.rotation);
  const sin = Math.sin(-t.rotation);
  const rx = (x * cos - y * sin) / t.scale;
  const ry = (x * sin + y * cos) / t.scale;
  return { x: rx + c.x, y: ry + c.y };
}

/** True if an image-space point lands on the layer's (transformed) non-zero mask. */
export function pointHitsLayer(q: Pt2, layer: Layer, w: number, h: number): boolean {
  if (!layer.visible) return false;
  const p = inversePoint(q, layer, w, h);
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  if (!layer.mask) return true; // whole-doc layer
  return layer.mask[y * w + x] !== 0;
}

/** Axis-aligned bbox [x,y,w,h] of the layer's transformed bounds. */
export function transformedBounds(layer: Layer, w: number, h: number): LayerBounds {
  const [bx, by, bw, bh] = layerBounds(layer, w, h);
  const corners: Pt2[] = [
    { x: bx, y: by },
    { x: bx + bw, y: by },
    { x: bx + bw, y: by + bh },
    { x: bx, y: by + bh },
  ].map((p) => forwardPoint(p, layer, w, h));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0];
}

/** Union bbox of several layers' transformed bounds. */
export function unionBounds(layers: Layer[], w: number, h: number): LayerBounds | null {
  if (!layers.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const L of layers) {
    const [x, y, bw, bh] = transformedBounds(L, w, h);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + bw);
    y1 = Math.max(y1, y + bh);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/** Rect intersection test for marquee layer-selection. */
export function rectsIntersect(a: LayerBounds, b: LayerBounds, contained = false): boolean {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  if (contained) {
    // a fully inside b
    return ax >= bx && ay >= by && ax + aw <= bx + bw && ay + ah <= by + bh;
  }
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

let _idc = 0;
export function newLayerId(): string {
  // Globally unique — a module counter resets on app reload and collides with ids restored
  // from a saved project, corrupting the layer-image cache.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `L_${crypto.randomUUID()}`;
  }
  _idc += 1;
  return `L_${Date.now().toString(36)}_${_idc}`;
}

/**
 * Belt-and-braces for project open: re-map any duplicate layer ids (e.g. a file edited by
 * hand, or ids from an old counter-based build) to fresh unique ids, keeping the image
 * cache and group membership consistent.
 */
export function remapDuplicateLayerIds(
  layers: Layer[],
  layerImgs: Map<string, HTMLImageElement>,
  groups: LayerGroup[]
): void {
  const seen = new Set<string>();
  for (const L of layers) {
    if (seen.has(L.id)) {
      const oldId = L.id;
      const nid = newLayerId();
      if (import.meta.env.DEV) console.warn(`duplicate layer id ${oldId} → remapped to ${nid}`);
      const img = layerImgs.get(oldId);
      if (img && !layerImgs.has(nid)) layerImgs.set(nid, img);
      for (const g of groups) {
        const i = g.layerIds.indexOf(oldId);
        if (i >= 0) g.layerIds[i] = nid;
      }
      L.id = nid;
    }
    seen.add(L.id);
  }
}

const BLEND_OP: Record<BlendMode, GlobalCompositeOperation> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  "soft-light": "soft-light",
  darken: "darken",
  lighten: "lighten",
  difference: "difference",
};

function maskCanvas(mask: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const id = ctx.createImageData(w, h);
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    id.data[o] = id.data[o + 1] = id.data[o + 2] = 255;
    id.data[o + 3] = mask[i] ? 255 : 0;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

/**
 * Composite the document to a canvas: base first, then each visible layer's pixels clipped
 * to its mask, at its opacity + blend mode. `images` maps layer id → its loaded result image.
 */
export function composite(
  base: CanvasImageSource,
  width: number,
  height: number,
  layers: Layer[],
  images: Map<string, HTMLImageElement>,
  opts: { drawBase?: boolean } = {}
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d")!;
  // When decomposed, the base is reconstructed by the layers (Background + subjects); the
  // base image itself is NOT drawn, so hiding a subject reveals an honest transparent hole.
  if (opts.drawBase !== false) ctx.drawImage(base, 0, 0, width, height);

  for (const L of layers) {
    if (!L.visible || L.opacity <= 0) continue;

    if (L.kind === "adjustment" && L.adjust) {
      // affects everything composited so far (clip-to-below is a future refinement)
      if (L.opacity >= 0.999) {
        applyAdjust(out, L.adjust);
      } else {
        const before = document.createElement("canvas");
        before.width = width;
        before.height = height;
        before.getContext("2d")!.drawImage(out, 0, 0);
        applyAdjust(out, L.adjust);
        ctx.globalAlpha = 1 - L.opacity;
        ctx.drawImage(before, 0, 0);
        ctx.globalAlpha = 1;
      }
      continue;
    }

    const img = images.get(L.id);
    if (!img) continue;

    // layer pixels masked into a scratch canvas
    const tmp = document.createElement("canvas");
    tmp.width = width;
    tmp.height = height;
    const tctx = tmp.getContext("2d")!;
    tctx.drawImage(img, 0, 0, width, height);
    if (L.mask) {
      tctx.globalCompositeOperation = "destination-in";
      tctx.drawImage(maskCanvas(L.mask, width, height), 0, 0);
      tctx.globalCompositeOperation = "source-over";
    }

    ctx.globalAlpha = L.opacity;
    ctx.globalCompositeOperation = BLEND_OP[L.blendMode] ?? "source-over";
    if (hasTransform(L.transform)) {
      // move/scale/rotate the masked layer content around its bounds centre — pixels in
      // `tmp` (and the base) are never mutated; only the draw is transformed.
      const [bx, by, bw, bh] = L.bounds ?? [0, 0, width, height];
      const cx = bx + bw / 2;
      const cy = by + bh / 2;
      const tr = L.transform;
      ctx.save();
      ctx.translate(cx + tr.tx, cy + tr.ty);
      ctx.rotate(tr.rotation);
      ctx.scale(tr.scale, tr.scale);
      ctx.translate(-cx, -cy);
      ctx.drawImage(tmp, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(tmp, 0, 0);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
  return out;
}

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

export function applyAdjust(canvas: HTMLCanvasElement, adjust: AdjustSpec): void {
  const ctx = canvas.getContext("2d")!;
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = id.data;
  const v = adjust.values;
  const exposure = v.exposure ?? 0; // stops: factor 2^exposure
  const contrast = v.contrast ?? 0;
  const saturation = v.saturation ?? 0;
  const temperature = v.temperature ?? 0;
  const vibrance = v.vibrance ?? 0;
  const expF = Math.pow(2, exposure);
  const cAmt = contrast * 128;
  const cF = (259 * (cAmt + 255)) / (255 * (259 - cAmt));
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] * expF;
    let g = d[i + 1] * expF;
    let b = d[i + 2] * expF;
    r = cF * (r - 128) + 128;
    g = cF * (g - 128) + 128;
    b = cF * (b - 128) + 128;
    if (temperature) {
      r += temperature * 30;
      b -= temperature * 30;
    }
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    if (saturation) {
      r = gray + (r - gray) * (1 + saturation);
      g = gray + (g - gray) * (1 + saturation);
      b = gray + (b - gray) * (1 + saturation);
    }
    if (vibrance) {
      // boost less-saturated pixels more
      const mx = Math.max(r, g, b);
      const sat = (mx - Math.min(r, g, b)) / 255;
      const amt = vibrance * (1 - sat);
      r = gray + (r - gray) * (1 + amt);
      g = gray + (g - gray) * (1 + amt);
      b = gray + (b - gray) * (1 + amt);
    }
    d[i] = clamp8(r);
    d[i + 1] = clamp8(g);
    d[i + 2] = clamp8(b);
  }
  ctx.putImageData(id, 0, 0);
}

// --- .neuclip serialization -------------------------------------------------

interface SerLayer extends Omit<Layer, "mask"> {
  maskPng?: string;
}
interface SerDoc {
  version: 1;
  width: number;
  height: number;
  base: string; // data URL
  transform?: DocTransform;
  groups?: LayerGroup[];
  layers: SerLayer[];
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = src;
  });
}

function maskToPng(mask: Uint8Array, w: number, h: number): string {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const id = ctx.createImageData(w, h);
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    id.data[o] = id.data[o + 1] = id.data[o + 2] = mask[i] ? 255 : 0;
    id.data[o + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return c.toDataURL("image/png");
}

async function pngToMask(src: string, w: number, h: number): Promise<Uint8Array> {
  const img = await loadImg(src);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] > 127 ? 255 : 0;
  return out;
}

export function serializeDoc(
  width: number,
  height: number,
  baseDataUrl: string,
  layers: Layer[],
  transform?: DocTransform,
  groups?: LayerGroup[]
): string {
  const sl: SerLayer[] = layers.map((L) => {
    const { mask, ...rest } = L;
    return { ...rest, maskPng: mask ? maskToPng(mask, width, height) : undefined };
  });
  const doc: SerDoc = { version: 1, width, height, base: baseDataUrl, transform, groups, layers: sl };
  return JSON.stringify(doc);
}

export async function deserializeDoc(json: string): Promise<{
  width: number;
  height: number;
  baseImg: HTMLImageElement;
  transform?: DocTransform;
  groups: LayerGroup[];
  layers: Layer[];
  layerImgs: Map<string, HTMLImageElement>;
}> {
  const doc = JSON.parse(json) as SerDoc;
  if (doc.version !== 1) throw new Error("unsupported .neuclip version");
  const baseImg = await loadImg(doc.base);
  const layers: Layer[] = [];
  const layerImgs = new Map<string, HTMLImageElement>();
  for (const sl of doc.layers) {
    const { maskPng, ...rest } = sl;
    const layer: Layer = {
      ...rest,
      mask: maskPng ? await pngToMask(maskPng, doc.width, doc.height) : undefined,
    };
    layers.push(layer);
    if (layer.resultUrl) layerImgs.set(layer.id, await loadImg(layer.resultUrl));
  }
  return { width: doc.width, height: doc.height, baseImg, transform: doc.transform, groups: doc.groups ?? [], layers, layerImgs };
}

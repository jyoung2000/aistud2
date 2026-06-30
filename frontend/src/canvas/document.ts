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

export type LayerKind = "base" | "ai-edit" | "adjustment" | "outpaint";

export type Region = [number, number, number, number]; // x0,y0,x1,y1 image space

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
}

export interface HarmonizeSpec {
  on: boolean;
  colorMatch: boolean;
  relight: boolean;
  grainMatch: boolean;
  strength: number;
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
}

export interface NeuDocument {
  width: number;
  height: number;
  baseImageRef: string; // data URL or sidecar id of the base (never mutated)
  layers: Layer[];
  selections?: { name: string; mask: number[] }[]; // named selections (Phase 5)
}

let _idc = 0;
export function newLayerId(): string {
  // monotonic — Math.random is unavailable in some contexts; a counter is deterministic.
  _idc += 1;
  return `L${_idc}_${_idc * 2654435761 % 100000}`;
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
  images: Map<string, HTMLImageElement>
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d")!;
  ctx.drawImage(base, 0, 0, width, height);

  for (const L of layers) {
    if (!L.visible || L.opacity <= 0) continue;
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
    ctx.drawImage(tmp, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
  return out;
}

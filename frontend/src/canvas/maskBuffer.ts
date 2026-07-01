// Contract #2 — ONE shared image-space mask buffer + boolean ops.
//
// All select tools (SAM points, lasso raster, manual-pen raster, brush) write into this one
// buffer via a modifier-chosen op. Marching ants, edge-refine, crop-bbox, and the cost card
// all read from it. Stored as a flat 0/255 Uint8Array in image space.

import type { Pt } from "./coords";

export type BoolOp = "replace" | "add" | "subtract" | "intersect";

/** none = replace, Shift = add, Alt = subtract, Shift+Alt = intersect. */
export function opFromModifiers(shift: boolean, alt: boolean): BoolOp {
  if (shift && alt) return "intersect";
  if (shift) return "add";
  if (alt) return "subtract";
  return "replace";
}

/** Separable box max-filter (window 2r+1) — dilation. */
function boxMax(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < w && src[row + xx] > m) m = src[row + xx];
      }
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < h) {
          const v = tmp[yy * w + x];
          if (v > m) m = v;
        }
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

export class MaskBuffer {
  readonly width: number;
  readonly height: number;
  data: Uint8Array;

  constructor(width: number, height: number, data?: Uint8Array) {
    this.width = width;
    this.height = height;
    this.data = data ?? new Uint8Array(width * height);
  }

  clone(): MaskBuffer {
    return new MaskBuffer(this.width, this.height, new Uint8Array(this.data));
  }

  clear(): void {
    this.data.fill(0);
  }

  private idx(x: number, y: number): number {
    return y * this.width + x;
  }

  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.data[this.idx(x, y)];
  }

  /**
   * Composite an incoming coverage mask (0–255 fractional alpha; binary 0/255 is the common case)
   * into this buffer via the boolean op. Fractional-aware so anti-aliased/feathered edges survive:
   *   replace = b · add = max(a,b) · subtract = a·(1−b) · intersect = min(a,b)
   * For binary inputs this reduces exactly to the old union/subtract/intersect behavior.
   */
  apply(incoming: Uint8Array, op: BoolOp): void {
    const d = this.data;
    if (incoming.length !== d.length) {
      throw new Error("mask size mismatch");
    }
    for (let i = 0; i < d.length; i++) {
      const a = d[i];
      const b = incoming[i];
      let r: number;
      switch (op) {
        case "replace":
          r = b;
          break;
        case "add":
          r = a > b ? a : b;
          break;
        case "subtract":
          r = (a * (255 - b) + 127) / 255;
          break;
        case "intersect":
          r = a < b ? a : b;
          break;
      }
      d[i] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
    }
  }

  isEmpty(): boolean {
    return !this.data.some((v) => v !== 0);
  }

  /** Invert the selection in place (subject ↔ background), coverage-preserving. */
  invert(): void {
    const d = this.data;
    for (let i = 0; i < d.length; i++) d[i] = 255 - d[i];
  }

  /** Dilate (grow) by r px (separable box). */
  grow(r: number): void {
    if (r > 0) this.data = boxMax(this.data, this.width, this.height, r);
  }
  /** Erode (shrink) by r px. */
  shrink(r: number): void {
    if (r <= 0) return;
    const inv = new Uint8Array(this.data.length);
    for (let i = 0; i < inv.length; i++) inv[i] = this.data[i] ? 0 : 255;
    const d = boxMax(inv, this.width, this.height, r);
    for (let i = 0; i < d.length; i++) this.data[i] = d[i] ? 0 : 255;
  }
  /** Smooth jagged edges (morphological close then open at r=1). */
  smooth(): void {
    this.grow(1);
    this.shrink(2);
    this.grow(1);
  }

  area(): number {
    let n = 0;
    const d = this.data;
    for (let i = 0; i < d.length; i++) if (d[i]) n++;
    return n;
  }

  /** Tight bounding box [x0, y0, x1, y1] (inclusive). null if empty. */
  bbox(): [number, number, number, number] | null {
    let x0 = this.width,
      y0 = this.height,
      x1 = -1,
      y1 = -1;
    for (let y = 0; y < this.height; y++) {
      const row = y * this.width;
      for (let x = 0; x < this.width; x++) {
        if (this.data[row + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    return x1 < 0 ? null : [x0, y0, x1, y1];
  }

  /**
   * Marching-ants outline: closed polylines tracing the selection boundary in image space
   * (along pixel edges). Each inner array is a closed loop of corner points.
   */
  outline(): Pt[][] {
    const W = this.width;
    const key = (x: number, y: number) => y * (W + 1) + x;

    // Collect boundary edges as directed corner-to-corner unit segments.
    type Edge = [number, number]; // [fromKey, toKey]
    const edges: Edge[] = [];
    // Trace the ~50%-coverage contour so anti-aliased fringes don't wander the ants.
    const filled = (x: number, y: number) => this.get(x, y) >= 128;

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < W; x++) {
        if (!filled(x, y)) continue;
        if (!filled(x, y - 1)) edges.push([key(x, y), key(x + 1, y)]); // top
        if (!filled(x + 1, y)) edges.push([key(x + 1, y), key(x + 1, y + 1)]); // right
        if (!filled(x, y + 1)) edges.push([key(x + 1, y + 1), key(x, y + 1)]); // bottom
        if (!filled(x - 1, y)) edges.push([key(x, y + 1), key(x, y)]); // left
      }
    }
    if (edges.length === 0) return [];

    // Adjacency: fromKey -> list of edge indices.
    const out = new Map<number, number[]>();
    edges.forEach(([f], i) => {
      const a = out.get(f);
      if (a) a.push(i);
      else out.set(f, [i]);
    });
    const used = new Array(edges.length).fill(false);
    const toPt = (k: number): Pt => ({ x: k % (W + 1), y: Math.floor(k / (W + 1)) });

    const loops: Pt[][] = [];
    for (let start = 0; start < edges.length; start++) {
      if (used[start]) continue;
      const loop: Pt[] = [];
      let cur = start;
      while (cur !== -1 && !used[cur]) {
        used[cur] = true;
        const [, to] = edges[cur];
        loop.push(toPt(edges[cur][0]));
        const cands = out.get(to);
        cur = -1;
        if (cands) {
          for (const ei of cands) {
            if (!used[ei]) {
              cur = ei;
              break;
            }
          }
        }
      }
      if (loop.length > 1) loops.push(loop);
    }
    return loops;
  }

  /** Pack to RGBA where set pixels take `color` at `alpha` (for an overlay image). */
  toRGBA(color: [number, number, number], alpha = 110): Uint8ClampedArray {
    const rgba = new Uint8ClampedArray(this.data.length * 4);
    const [r, g, b] = color;
    for (let i = 0; i < this.data.length; i++) {
      const cov = this.data[i];
      if (cov) {
        const o = i * 4;
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = (alpha * cov) / 255; // scale overlay by coverage → AA edges read softly
      }
    }
    return rgba;
  }
}

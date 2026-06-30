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

  /** Combine an incoming binary mask (same dims; any non-zero = set) via the op. */
  apply(incoming: Uint8Array, op: BoolOp): void {
    const d = this.data;
    if (incoming.length !== d.length) {
      throw new Error("mask size mismatch");
    }
    for (let i = 0; i < d.length; i++) {
      const a = d[i] ? 1 : 0;
      const b = incoming[i] ? 1 : 0;
      let r: number;
      switch (op) {
        case "replace":
          r = b;
          break;
        case "add":
          r = a | b;
          break;
        case "subtract":
          r = a & (b ? 0 : 1);
          break;
        case "intersect":
          r = a & b;
          break;
      }
      d[i] = r ? 255 : 0;
    }
  }

  isEmpty(): boolean {
    return !this.data.some((v) => v !== 0);
  }

  /** Invert the selection in place (subject ↔ background). */
  invert(): void {
    const d = this.data;
    for (let i = 0; i < d.length; i++) d[i] = d[i] ? 0 : 255;
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
    const filled = (x: number, y: number) => this.get(x, y) !== 0;

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
      if (this.data[i]) {
        const o = i * 4;
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = alpha;
      }
    }
    return rgba;
  }
}

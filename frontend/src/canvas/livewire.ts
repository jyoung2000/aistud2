// Magnetic-lasso live-wire (Mortensen–Barrett). Holds the sidecar cost map; a fastening
// point runs bounded single-source Dijkstra building a came-from map, and each cursor move
// backtraces it instantly. Cost grid may be downscaled (`scale`); image↔grid via `scale`.
import type { Pt } from "./coords";

class MinHeap {
  private d: number[] = []; // dist
  private n: number[] = []; // node idx
  size() {
    return this.n.length;
  }
  push(dist: number, node: number) {
    this.d.push(dist);
    this.n.push(node);
    let i = this.n.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.d[p] <= this.d[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.n[0];
    const lastD = this.d.pop()!;
    const lastN = this.n.pop()!;
    if (this.n.length) {
      this.d[0] = lastD;
      this.n[0] = lastN;
      let i = 0;
      const len = this.n.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < len && this.d[l] < this.d[s]) s = l;
        if (r < len && this.d[r] < this.d[s]) s = r;
        if (s === i) break;
        this.swap(i, s);
        i = s;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.d[a], this.d[b]] = [this.d[b], this.d[a]];
    [this.n[a], this.n[b]] = [this.n[b], this.n[a]];
  }
}

export class LiveWire {
  readonly w: number;
  readonly h: number;
  readonly scale: number;
  private cost: Uint8Array; // 0 = strongest edge (cheapest)
  private came: Int32Array;
  private seed: number | null = null;
  /** Search radius in grid px (maps to the Photoshop "Width" option). */
  windowRadius = 240;

  constructor(cost: Uint8Array, w: number, h: number, scale: number) {
    this.cost = cost;
    this.w = w;
    this.h = h;
    this.scale = scale;
    this.came = new Int32Array(w * h).fill(-1);
  }

  private gx(p: Pt) {
    return Math.min(this.w - 1, Math.max(0, Math.round(p.x * this.scale)));
  }
  private gy(p: Pt) {
    return Math.min(this.h - 1, Math.max(0, Math.round(p.y * this.scale)));
  }

  setSeed(p: Pt): void {
    const sx = this.gx(p);
    const sy = this.gy(p);
    const seed = sy * this.w + sx;
    this.seed = seed;
    const { w, h, cost, came, windowRadius: R } = this;
    came.fill(-1);
    const distArr = new Float32Array(w * h).fill(Infinity);
    const heap = new MinHeap();
    distArr[seed] = 0;
    came[seed] = seed;
    heap.push(0, seed);
    const x0 = Math.max(0, sx - R),
      x1 = Math.min(w - 1, sx + R),
      y0 = Math.max(0, sy - R),
      y1 = Math.min(h - 1, sy + R);
    while (heap.size()) {
      const u = heap.pop();
      const ux = u % w;
      const uy = (u / w) | 0;
      const du = distArr[u];
      for (let dy = -1; dy <= 1; dy++) {
        const ny = uy + dy;
        if (ny < y0 || ny > y1) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = ux + dx;
          if (nx < x0 || nx > x1) continue;
          const v = ny * w + nx;
          const diag = dx !== 0 && dy !== 0 ? 1.41421356 : 1;
          const nd = du + (cost[v] + 1) * diag;
          if (nd < distArr[v]) {
            distArr[v] = nd;
            came[v] = u;
            heap.push(nd, v);
          }
        }
      }
    }
  }

  /** Backtrace the least-cost path seed→p in image space. null if unreached (draw straight). */
  pathTo(p: Pt): Pt[] | null {
    if (this.seed == null) return null;
    let cur = this.gy(p) * this.w + this.gx(p);
    if (this.came[cur] === -1) return null;
    const pts: Pt[] = [];
    let guard = this.w * this.h;
    while (cur !== this.seed && guard-- > 0) {
      pts.push({ x: (cur % this.w) / this.scale, y: ((cur / this.w) | 0) / this.scale });
      cur = this.came[cur];
    }
    pts.push({ x: (this.seed % this.w) / this.scale, y: ((this.seed / this.w) | 0) / this.scale });
    pts.reverse();
    return pts;
  }
}

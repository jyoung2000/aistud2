// Lasso helpers: rasterize a closed image-space path to a binary mask (even-odd), plus
// geometry utilities shared by freehand / polygonal / magnetic modes.
import type { Pt } from "./coords";

export function rasterizePolygon(points: Pt[], width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  if (points.length < 3) return out;
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
  ctx.fill("evenodd");
  const d = ctx.getImageData(0, 0, width, height).data;
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3] > 127 ? 255 : 0;
  return out;
}

/**
 * Rasterize a closed polygon to a COVERAGE mask (0–255). With `antialias`, the canvas's native
 * edge anti-aliasing is read straight from the alpha channel (sub-pixel coverage on the boundary);
 * without it, a hard 0/255 threshold. Shared fractional-alpha commit path (all select tools).
 */
export function rasterizeCoverage(points: Pt[], width: number, height: number, antialias: boolean): Uint8Array {
  const out = new Uint8Array(width * height);
  if (points.length < 3) return out;
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
  ctx.fill("evenodd");
  const d = ctx.getImageData(0, 0, width, height).data;
  if (antialias) for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
  else for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3] > 127 ? 255 : 0;
  return out;
}

/**
 * Feather a coverage channel by a Gaussian of `radius` px — exactly what Photoshop "feather" does
 * (blur of the selection channel). Approximated by three successive box blurs (fast, separable).
 */
export function featherCoverage(cov: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return cov;
  // three box passes whose combined sigma ≈ radius
  const boxR = Math.max(1, Math.round(radius / 3 * 1.2));
  let src = boxBlur(Float32Array.from(cov), width, height, boxR);
  for (let pass = 1; pass < 3; pass++) src = boxBlur(src, width, height, boxR);
  const out = new Uint8Array(cov.length);
  for (let i = 0; i < out.length; i++) out[i] = src[i] < 0 ? 0 : src[i] > 255 ? 255 : Math.round(src[i]);
  return out;
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const norm = 1 / (2 * r + 1);
  // horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * norm;
      const add = src[row + Math.min(w - 1, x + r + 1)];
      const sub = src[row + Math.max(0, x - r)];
      acc += add - sub;
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * norm;
      const add = tmp[Math.min(h - 1, y + r + 1) * w + x];
      const sub = tmp[Math.max(0, y - r) * w + x];
      acc += add - sub;
    }
  }
  return out;
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Freehand sampling: append `to` only once the cursor has moved ≥ `step` image px from the last
 * vertex, and interpolate intermediate vertices along the segment so a fast flick (a big jump
 * between mousemove events) still yields a continuous path instead of a straight skip.
 */
export function appendFreehand(pts: Pt[], to: Pt, step: number): Pt[] {
  if (pts.length === 0) return [to];
  const last = pts[pts.length - 1];
  const d = dist(last, to);
  if (d < step) return pts; // hasn't moved far enough → no new vertex
  const out = pts.slice();
  const n = Math.floor(d / step);
  for (let i = 1; i <= n; i++) {
    const f = (i * step) / d;
    out.push({ x: last.x + (to.x - last.x) * f, y: last.y + (to.y - last.y) * f });
  }
  if (dist(out[out.length - 1], to) > 1e-3) out.push(to);
  return out;
}

/** Snap `to` onto the nearest 45° ray from `from` (Shift constrain). */
export function constrain45(from: Pt, to: Pt): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return { x: from.x + Math.cos(ang) * len, y: from.y + Math.sin(ang) * len };
}

export function flatten(points: Pt[]): number[] {
  const a: number[] = [];
  for (const p of points) {
    a.push(p.x, p.y);
  }
  return a;
}

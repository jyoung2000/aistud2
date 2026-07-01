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

// Manual pen-grade selection: an editable, uncommitted Bézier path in image space.
// Anchors carry optional in/out handles (absolute image coords). Commit flattens to a
// polyline and rasterizes via the shared lasso rasterizer.
import type { Pt } from "./coords";

export interface Anchor {
  p: Pt;
  hIn: Pt | null;
  hOut: Pt | null;
  smooth: boolean;
}

export interface PenPath {
  anchors: Anchor[];
  closed: boolean;
}

export function emptyPath(): PenPath {
  return { anchors: [], closed: false };
}

export function mirror(center: Pt, h: Pt): Pt {
  return { x: 2 * center.x - h.x, y: 2 * center.y - h.y };
}

function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/** Flatten the path to a polyline in image space. */
export function flattenPath(path: PenPath, perSeg = 18): Pt[] {
  const a = path.anchors;
  if (a.length < 2) return a.map((an) => an.p);
  const out: Pt[] = [a[0].p];
  const last = path.closed ? a.length : a.length - 1;
  for (let i = 0; i < last; i++) {
    const cur = a[i];
    const nxt = a[(i + 1) % a.length];
    const c1 = cur.hOut ?? cur.p;
    const c2 = nxt.hIn ?? nxt.p;
    const straight = !cur.hOut && !nxt.hIn;
    if (straight) {
      out.push(nxt.p);
    } else {
      for (let s = 1; s <= perSeg; s++) out.push(cubic(cur.p, c1, c2, nxt.p, s / perSeg));
    }
  }
  return out;
}

function d2(a: Pt, b: Pt): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function nearestAnchor(path: PenPath, p: Pt, r: number): number {
  let best = -1;
  let bd = r * r;
  path.anchors.forEach((a, i) => {
    const dd = d2(a.p, p);
    if (dd <= bd) {
      bd = dd;
      best = i;
    }
  });
  return best;
}

export function nearestHandle(
  path: PenPath,
  p: Pt,
  r: number
): { index: number; which: "in" | "out" } | null {
  let res: { index: number; which: "in" | "out" } | null = null;
  let bd = r * r;
  path.anchors.forEach((a, i) => {
    if (a.hIn) {
      const dd = d2(a.hIn, p);
      if (dd <= bd) {
        bd = dd;
        res = { index: i, which: "in" };
      }
    }
    if (a.hOut) {
      const dd = d2(a.hOut, p);
      if (dd <= bd) {
        bd = dd;
        res = { index: i, which: "out" };
      }
    }
  });
  return res;
}

/** Nearest point on a flattened segment, for insert-on-segment. Returns the segment's
 *  starting-anchor index and the hit point. */
export function nearestSegment(
  path: PenPath,
  p: Pt,
  r: number
): { index: number; point: Pt } | null {
  const a = path.anchors;
  if (a.length < 2) return null;
  let best: { index: number; point: Pt } | null = null;
  let bd = r * r;
  const last = path.closed ? a.length : a.length - 1;
  for (let i = 0; i < last; i++) {
    const s = a[i].p;
    const e = a[(i + 1) % a.length].p;
    const proj = projectToSeg(p, s, e);
    const dd = d2(p, proj);
    if (dd <= bd) {
      bd = dd;
      best = { index: i, point: proj };
    }
  }
  return best;
}

function projectToSeg(p: Pt, s: Pt, e: Pt): Pt {
  const dx = e.x - s.x;
  const dy = e.y - s.y;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((p.x - s.x) * dx + (p.y - s.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: s.x + t * dx, y: s.y + t * dy };
}

export function bbox(pts: Pt[]): [number, number, number, number] | null {
  if (!pts.length) return null;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return [x0, y0, x1, y1];
}

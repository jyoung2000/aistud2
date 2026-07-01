// Magic Brush helpers — stroke stamping (image space) and the offline snap engines. Kept pure
// so they're unit-testable; the AI engine lives in the component (it calls the SAM sidecar).
import type { Pt } from "./coords";

// Pixel buffers may arrive as clamped (from getImageData) or plain arrays.
type Px = Uint8Array | Uint8ClampedArray;

/** Stamp a filled disc of radius r (image px) into a coverage buffer (255 inside). */
export function stampDisc(buf: Uint8Array, w: number, h: number, cx: number, cy: number, r: number): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(h - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= r2) buf[y * w + x] = 255;
    }
  }
}

/** Stamp overlapping discs along a→b so a fast drag paints a continuous capsule, not dots. */
export function stampCapsule(buf: Uint8Array, w: number, h: number, a: Pt, b: Pt, r: number): void {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const step = Math.max(1, r * 0.4);
  const n = Math.max(1, Math.ceil(d / step));
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    stampDisc(buf, w, h, a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, r);
  }
}

/** Representative points from a scribble buffer (grid-subsampled set pixels) for SAM prompts. */
export function sampleHintPoints(buf: Uint8Array, w: number, maxPts = 24): Pt[] {
  const set: Pt[] = [];
  for (let i = 0; i < buf.length; i++) if (buf[i]) set.push({ x: i % w, y: (i / w) | 0 });
  if (set.length <= maxPts) return set;
  const out: Pt[] = [];
  const stepN = set.length / maxPts;
  for (let k = 0; k < maxPts; k++) out.push(set[Math.floor(k * stepN)]);
  return out;
}

/** Per-pixel gradient magnitude (0–255) from RGBA pixels — the edge barrier for region grow. */
export function gradientMag(px: Px, w: number, h: number) {
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const gx = lum[i + (x < w - 1 ? 1 : 0)] - lum[i - (x > 0 ? 1 : 0)];
      const gy = lum[i + (y < h - 1 ? w : 0)] - lum[i - (y > 0 ? w : 0)];
      const m = Math.hypot(gx, gy);
      g[i] = m > 255 ? 255 : m;
    }
  }
  return g;
}

/**
 * Local (offline) snap — Quick-Selection parity. Region-grow from positive-hint pixels, admitting
 * neighbors whose color is close to the seed mean AND that don't cross a strong gradient (edge
 * barrier). Negative-hint pixels are hard-excluded and act as barriers. Returns a coverage mask.
 */
export function localGrow(
  px: Px,
  grad: Uint8Array,
  w: number,
  h: number,
  pos: Uint8Array,
  neg: Uint8Array,
  opts: { colorTol?: number; edge?: number } = {}
) {
  const colorTol = opts.colorTol ?? 42;
  const edge = opts.edge ?? 32;
  const out = new Uint8Array(w * h);
  // seed mean color from the positive hints
  let sr = 0, sg = 0, sb = 0, sn = 0;
  const stack: number[] = [];
  for (let i = 0; i < pos.length; i++) {
    if (pos[i] && !neg[i]) {
      sr += px[i * 4]; sg += px[i * 4 + 1]; sb += px[i * 4 + 2]; sn++;
      out[i] = 255;
      stack.push(i);
    }
  }
  if (sn === 0) return out;
  const mr = sr / sn, mg = sg / sn, mb = sb / sn;
  const seen = new Uint8Array(w * h);
  for (const s of stack) seen[s] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i / w) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) {
      if (j < 0 || seen[j] || neg[j]) continue;
      seen[j] = 1;
      if (grad[j] > edge) continue; // don't cross a strong edge
      const cd = Math.max(
        Math.abs(px[j * 4] - mr),
        Math.abs(px[j * 4 + 1] - mg),
        Math.abs(px[j * 4 + 2] - mb)
      );
      if (cd <= colorTol) {
        out[j] = 255;
        stack.push(j);
      }
    }
  }
  return out;
}

/** Off/raw snap: positive hints minus negative hints, straight coverage. */
export function rawSnap(pos: Uint8Array, neg: Uint8Array) {
  const out = new Uint8Array(pos.length);
  for (let i = 0; i < out.length; i++) out[i] = pos[i] && !neg[i] ? 255 : 0;
  return out;
}

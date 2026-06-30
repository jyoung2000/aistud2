// Contract #1 — two coordinate spaces, never conflated.
//
// View space  = Konva Stage transform (scale + position). Zoom/pan touch ONLY this.
// Image space = original pixel grid. Every selection artifact is stored in image space.
//
// A click on the same pixel must map to the IDENTICAL image-space coord at any zoom.

export interface ViewTransform {
  /** Uniform stage scale (view px per image px). */
  scale: number;
  /** Stage position (top-left of the image in screen px). */
  x: number;
  y: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** Screen/stage point → image-space point. Inverse of imageToScreen. */
export function screenToImage(p: Pt, t: ViewTransform): Pt {
  return { x: (p.x - t.x) / t.scale, y: (p.y - t.y) / t.scale };
}

/** Image-space point → screen/stage point. Inverse of screenToImage. */
export function imageToScreen(p: Pt, t: ViewTransform): Pt {
  return { x: p.x * t.scale + t.x, y: p.y * t.scale + t.y };
}

/** Clamp a point to the image bounds (inclusive of the far edge). */
export function clampToImage(p: Pt, width: number, height: number): Pt {
  return {
    x: Math.min(Math.max(p.x, 0), width),
    y: Math.min(Math.max(p.y, 0), height),
  };
}

/** Floor an image-space point to an integer pixel index, clamped to [0, dim). */
export function toPixel(p: Pt, width: number, height: number): Pt {
  return {
    x: Math.min(Math.max(Math.floor(p.x), 0), width - 1),
    y: Math.min(Math.max(Math.floor(p.y), 0), height - 1),
  };
}

export const ZOOM_MIN = 0.01; // 1%
export const ZOOM_MAX = 32; // 3200%

export function clampZoom(scale: number): number {
  return Math.min(Math.max(scale, ZOOM_MIN), ZOOM_MAX);
}

/**
 * Zoom toward a fixed screen point (the pixel under the cursor stays put).
 * Returns the new transform. `factor` > 1 zooms in.
 */
export function zoomAtPoint(t: ViewTransform, screenPoint: Pt, factor: number): ViewTransform {
  const img = screenToImage(screenPoint, t);
  const scale = clampZoom(t.scale * factor);
  return {
    scale,
    x: screenPoint.x - img.x * scale,
    y: screenPoint.y - img.y * scale,
  };
}

/** Fit an image of (w,h) into a viewport of (vw,vh), centered, with optional padding. */
export function fitTransform(
  w: number,
  h: number,
  vw: number,
  vh: number,
  pad = 0.04
): ViewTransform {
  const usable = 1 - pad * 2;
  const scale = clampZoom(Math.min((vw * usable) / w, (vh * usable) / h));
  return { scale, x: (vw - w * scale) / 2, y: (vh - h * scale) / 2 };
}

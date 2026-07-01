// Pose skeleton model (mirrors sidecar/app/pose.py). Keypoints live in IMAGE SPACE
// (contract #1) so every editor gesture round-trips through screenToImage/imageToScreen.
// The EDITED rig — not the raw extraction — becomes the pose ControlNet signal.

export type KeypointGroup = "body" | "face" | "handL" | "handR";

export interface Keypoint {
  id: string;
  x: number;
  y: number;
  visible: boolean;
  confidence: number; // 0..1 from the estimator; ~0 for synthetic mannequin joints
  group: KeypointGroup;
}

export interface PoseTransform {
  tx: number;
  ty: number;
  scale: number;
  rotation: number; // degrees
}

export interface Figure {
  id: string;
  keypoints: Keypoint[];
  bones: [string, string][];
  /** Per-limb depth/occlusion index (higher = further back, drawn first). Keyed `${a}|${b}`. */
  limbOrder: Record<string, number>;
  transform: PoseTransform;
}

export interface Pose {
  figures: Figure[];
  backend?: string;
  width?: number;
  height?: number;
}

// COCO-18 body topology — matches OpenPose so a real estimator maps 1:1.
export const BODY_NAMES = [
  "nose", "neck", "r_shoulder", "r_elbow", "r_wrist", "l_shoulder", "l_elbow",
  "l_wrist", "r_hip", "r_knee", "r_ankle", "l_hip", "l_knee", "l_ankle",
  "r_eye", "l_eye", "r_ear", "l_ear",
];

const APOSE: [number, number][] = [
  [0.5, 0.09], [0.5, 0.18], [0.42, 0.2], [0.36, 0.32], [0.32, 0.44],
  [0.58, 0.2], [0.64, 0.32], [0.68, 0.44], [0.455, 0.5], [0.45, 0.7],
  [0.45, 0.92], [0.545, 0.5], [0.55, 0.7], [0.55, 0.92], [0.47, 0.075],
  [0.53, 0.075], [0.44, 0.09], [0.56, 0.09],
];

export const BODY_LIMBS: [number, number][] = [
  [1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10],
  [1, 11], [11, 12], [12, 13], [1, 0], [0, 14], [14, 16], [0, 15], [15, 17],
];

// OpenPose limb colors (RGB), one per BODY_LIMBS entry.
export const LIMB_COLORS: [number, number, number][] = [
  [153, 0, 0], [153, 51, 0], [153, 102, 0], [153, 153, 0], [102, 153, 0],
  [51, 153, 0], [0, 153, 0], [0, 153, 51], [0, 153, 102], [0, 153, 153],
  [0, 102, 153], [0, 51, 153], [0, 0, 153], [51, 0, 153], [102, 0, 153],
  [153, 0, 153], [153, 0, 102],
];
export const POINT_COLORS: [number, number, number][] = [
  [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0],
  [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255],
  [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255],
  [255, 0, 255], [255, 0, 170], [255, 0, 85],
];

export const boneKey = (a: string, b: string) => `${a}|${b}`;
export const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;

const kpId = (figureId: string, group: KeypointGroup, i: number) => `${figureId}:${group}:${i}`;

/** Body index encoded in a keypoint id (":body:<n>"), or null for face/hand joints. */
export function bodyIndex(id: string): number | null {
  const parts = id.split(":");
  if (parts.length === 3 && parts[1] === "body") {
    const n = Number(parts[2]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Color for a keypoint dot (by body index; white for non-body groups). */
export function pointColor(id: string): [number, number, number] {
  const i = bodyIndex(id);
  return i === null ? [255, 255, 255] : POINT_COLORS[i % POINT_COLORS.length];
}

/** A plausible A-pose mannequin centered in the image; low confidence flags every joint. */
export function defaultFigure(
  width: number,
  height: number,
  figureId = "fig1",
  opts: { cx?: number; cy?: number; scale?: number; confidence?: number } = {}
): Figure {
  const { cx = 0.5, cy = 0.5, scale = 0.82, confidence = 0 } = opts;
  const boxH = scale * height;
  const boxW = boxH * 0.55;
  const x0 = cx * width - boxW / 2;
  const y0 = cy * height - boxH / 2;
  const keypoints: Keypoint[] = APOSE.map(([nx, ny], i) => ({
    id: kpId(figureId, "body", i),
    x: Math.round((x0 + nx * boxW) * 100) / 100,
    y: Math.round((y0 + ny * boxH) * 100) / 100,
    visible: true,
    confidence,
    group: "body",
  }));
  const bones: [string, string][] = BODY_LIMBS.map(([a, b]) => [keypoints[a].id, keypoints[b].id]);
  const limbOrder: Record<string, number> = {};
  for (const [a, b] of BODY_LIMBS) limbOrder[boneKey(keypoints[a].id, keypoints[b].id)] = 0;
  return { id: figureId, keypoints, bones, limbOrder, transform: { tx: 0, ty: 0, scale: 1, rotation: 0 } };
}

/** Figure centroid (image space) — the pivot for whole-rig transform. */
export function figureCenter(fig: Figure): { x: number; y: number } {
  const ks = fig.keypoints;
  if (!ks.length) return { x: 0, y: 0 };
  return {
    x: ks.reduce((s, k) => s + k.x, 0) / ks.length,
    y: ks.reduce((s, k) => s + k.y, 0) / ks.length,
  };
}

/** Apply a figure's transform to a raw image-space point (about the figure centre). */
export function applyFigureTransform(
  p: { x: number; y: number },
  tf: PoseTransform,
  center: { x: number; y: number }
): { x: number; y: number } {
  const s = tf.scale || 1;
  const rot = ((tf.rotation || 0) * Math.PI) / 180;
  const dx = (p.x - center.x) * s;
  const dy = (p.y - center.y) * s;
  return {
    x: center.x + (dx * Math.cos(rot) - dy * Math.sin(rot)) + (tf.tx || 0),
    y: center.y + (dx * Math.sin(rot) + dy * Math.cos(rot)) + (tf.ty || 0),
  };
}

/** Effective (post-transform) position of a keypoint in image space. */
export function keypointPos(fig: Figure, kp: Keypoint): { x: number; y: number } {
  return applyFigureTransform(kp, fig.transform, figureCenter(fig));
}

export function clonePose(p: Pose): Pose {
  return JSON.parse(JSON.stringify(p));
}

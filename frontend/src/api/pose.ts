// Pose editor client — extract a skeleton from the active image and render its OpenPose
// control image. See sidecar /pose/extract and /pose/render.
import { baseUrl } from "./sidecar";
import type { Pose } from "../pose/poseModel";

export async function extractPose(imageId: string): Promise<Pose> {
  const res = await fetch(`${await baseUrl()}/pose/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: imageId }),
  });
  if (!res.ok) throw new Error(`/pose/extract ${res.status}`);
  return (await res.json()) as Pose;
}

/** Render the OpenPose control image; returns a `data:image/png;base64,…` URL. */
export async function renderControlImage(pose: Pose, width: number, height: number): Promise<string> {
  const res = await fetch(`${await baseUrl()}/pose/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pose, width, height }),
  });
  if (!res.ok) throw new Error(`/pose/render ${res.status}`);
  const j = (await res.json()) as { control_png: string };
  return `data:image/png;base64,${j.control_png}`;
}

/** Extract a skeleton from an uploaded pose-reference image (data URL or raw base64). */
export async function extractPoseFromUpload(imagePng: string): Promise<Pose> {
  const res = await fetch(`${await baseUrl()}/pose/extract_upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_png: imagePng }),
  });
  if (!res.ok) throw new Error(`/pose/extract_upload ${res.status}`);
  return (await res.json()) as Pose;
}

export interface SavedPose {
  id: string;
  name: string;
  pose: Pose;
  w: number;
  h: number;
}

export async function listPoses(): Promise<SavedPose[]> {
  const res = await fetch(`${await baseUrl()}/pose/library`);
  if (!res.ok) throw new Error(`/pose/library ${res.status}`);
  return ((await res.json()) as { poses: SavedPose[] }).poses;
}

export async function savePose(name: string, pose: Pose, w: number, h: number): Promise<SavedPose[]> {
  const res = await fetch(`${await baseUrl()}/pose/library`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, pose, w, h }),
  });
  if (!res.ok) throw new Error(`/pose/library POST ${res.status}`);
  return ((await res.json()) as { poses: SavedPose[] }).poses;
}

export async function removePose(id: string): Promise<SavedPose[]> {
  const res = await fetch(`${await baseUrl()}/pose/library/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(`/pose/library/remove ${res.status}`);
  return ((await res.json()) as { poses: SavedPose[] }).poses;
}

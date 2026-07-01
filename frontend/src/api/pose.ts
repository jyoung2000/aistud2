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

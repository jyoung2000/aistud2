// Generate (crop → model → composite) client + queue polling.
import { baseUrl } from "./sidecar";

export interface GenJob {
  job_id: string;
  status: "queued" | "polling" | "completed" | "failed";
  mode: string;
  region: number[];
  result_png: string | null;
  error: string | null;
}

export interface HarmonizeOpts {
  on: boolean;
  colorMatch: boolean;
  relight: boolean;
  grainMatch: boolean;
  strength: number;
}

export interface GenOpts {
  mock?: boolean;
  model_slug?: string;
  params?: Record<string, unknown>;
  pad_frac?: number;
  feather?: number;
  harmonize?: HarmonizeOpts;
  reference_png?: string;
  reference_role?: string;
  seed?: number;
}

export async function generate(
  id: string,
  maskPng: string,
  prompt: string,
  opts: GenOpts = {}
): Promise<GenJob> {
  const res = await fetch(`${await baseUrl()}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, mask_png: maskPng, prompt, ...opts }),
  });
  if (!res.ok) throw new Error(`/generate ${res.status}: ${await res.text()}`);
  return (await res.json()) as GenJob;
}

export async function pollJob(jobId: string): Promise<GenJob> {
  const res = await fetch(`${await baseUrl()}/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId }),
  });
  if (!res.ok) throw new Error(`/poll ${res.status}`);
  return (await res.json()) as GenJob;
}

/** Run a job to completion with capped exponential backoff (mock returns immediately). */
export async function runToCompletion(
  job: GenJob,
  onTick?: (status: string) => void,
  timeoutMs = 180000
): Promise<GenJob> {
  let cur = job;
  let delay = 800;
  const start = Date.now();
  while (cur.status === "polling" || cur.status === "queued") {
    if (Date.now() - start > timeoutMs) throw new Error("generation timed out");
    onTick?.(cur.status);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 4000);
    cur = await pollJob(cur.job_id);
  }
  return cur;
}

export function maskToPngDataUrl(mask: Uint8Array, width: number, height: number): string {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d")!;
  const id = ctx.createImageData(width, height);
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ? 255 : 0;
    const o = i * 4;
    id.data[o] = id.data[o + 1] = id.data[o + 2] = v;
    id.data[o + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return c.toDataURL("image/png");
}

export function resultToImage(b64: string): Promise<HTMLImageElement> {
  const src = b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`;
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

export interface OutpaintResult {
  status: string;
  image_png?: string;
  width: number;
  height: number;
  dx: number;
  dy: number;
  job_id?: string;
}

export async function outpaint(
  id: string,
  p: { new_w: number; new_h: number; dx: number; dy: number; prompt?: string; mock?: boolean; model_slug?: string }
): Promise<OutpaintResult> {
  const res = await fetch(`${await baseUrl()}/outpaint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...p }),
  });
  if (!res.ok) throw new Error(`/outpaint ${res.status}: ${await res.text()}`);
  return (await res.json()) as OutpaintResult;
}

export async function b64ToFile(b64: string, name = "edit.png"): Promise<File> {
  const src = b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`;
  const blob = await (await fetch(src)).blob();
  return new File([blob], name, { type: "image/png" });
}

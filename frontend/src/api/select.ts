// Smart-select + refine client. The sidecar returns masks as base64 PNG (grayscale); we
// decode to a binary Uint8Array for the shared MaskBuffer and encode back for /refine.
import { baseUrl } from "./sidecar";

export interface LoadResult {
  id: string;
  width: number;
  height: number;
  backend: string; // "sam2" | "fallback"
}

export interface SamPoint {
  x: number;
  y: number;
  label: 0 | 1; // 1 positive, 0 negative
}

export async function loadImageToSidecar(file: File): Promise<LoadResult> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${await baseUrl()}/load`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`/load ${res.status}`);
  return (await res.json()) as LoadResult;
}

interface MaskResponse {
  mask_png: string;
  width: number;
  height: number;
  backend: string;
}

export async function smartSelect(
  id: string,
  points: SamPoint[],
  box: [number, number, number, number] | null
): Promise<{ data: Uint8Array; width: number; height: number; backend: string }> {
  const res = await fetch(`${await baseUrl()}/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      points: points.map((p) => [p.x, p.y]),
      labels: points.map((p) => p.label),
      box,
    }),
  });
  if (!res.ok) throw new Error(`/select ${res.status}`);
  const j = (await res.json()) as MaskResponse;
  const data = await pngToMask(j.mask_png, j.width, j.height);
  return { data, width: j.width, height: j.height, backend: j.backend };
}

export async function refineMask(
  id: string,
  mask: Uint8Array,
  width: number,
  height: number
): Promise<Uint8Array> {
  const png = maskToPng(mask, width, height);
  const res = await fetch(`${await baseUrl()}/refine`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, mask_png: png }),
  });
  if (!res.ok) throw new Error(`/refine ${res.status}`);
  const j = (await res.json()) as MaskResponse;
  return pngToMask(j.mask_png, width, height);
}

export async function fetchCostMap(
  id: string,
  contrast = 1
): Promise<{ cost: Uint8Array; w: number; h: number; scale: number }> {
  const res = await fetch(`${await baseUrl()}/livewire/costmap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, contrast }),
  });
  if (!res.ok) throw new Error(`/livewire/costmap ${res.status}`);
  const j = (await res.json()) as { cost_png: string; cost_w: number; cost_h: number; scale: number };
  const cost = await pngToGray(j.cost_png, j.cost_w, j.cost_h);
  return { cost, w: j.cost_w, h: j.cost_h, scale: j.scale };
}

// --- codec helpers ---

async function pngToGray(b64: string, width: number, height: number): Promise<Uint8Array> {
  const src = b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`;
  const img = await loadImg(src);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4]; // raw value 0..255
  return out;
}

function maskToPng(mask: Uint8Array, width: number, height: number): string {
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
  return c.toDataURL("image/png"); // sidecar strips the data: prefix
}

async function pngToMask(b64: string, width: number, height: number): Promise<Uint8Array> {
  const src = b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`;
  const img = await loadImg(src);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4] > 127 ? 255 : 0;
  return out;
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

// LoRA library client. LoRAs are registered locally (paths) or as hosted refs/URLs/ids for
// WaveSpeed endpoints. Attach up to a model's max_loras with a weight; triggers are injected
// into the synthesized prompt by the sidecar.
import { baseUrl } from "./sidecar";

export interface Lora {
  id: string;
  name: string;
  trigger_words: string[];
  ref: string;
  compatible_base: string;
  weight_default: number;
  thumb?: string | null;
}

/** A LoRA attached to the current generation, with its chosen weight. */
export interface AttachedLora {
  ref: string;
  weight: number;
  trigger_words: string[];
  name: string;
}

export async function listLoras(): Promise<Lora[]> {
  const res = await fetch(`${await baseUrl()}/loras`);
  if (!res.ok) throw new Error(`/loras ${res.status}`);
  return ((await res.json()).loras ?? []) as Lora[];
}

export async function registerLora(l: {
  name: string;
  trigger_words: string[];
  ref: string;
  compatible_base?: string;
  weight_default?: number;
}): Promise<Lora[]> {
  const res = await fetch(`${await baseUrl()}/loras`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(l),
  });
  if (!res.ok) throw new Error(`/loras POST ${res.status}`);
  return ((await res.json()).loras ?? []) as Lora[];
}

export async function removeLora(id: string): Promise<Lora[]> {
  const res = await fetch(`${await baseUrl()}/loras/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(`/loras/remove ${res.status}`);
  return ((await res.json()).loras ?? []) as Lora[];
}

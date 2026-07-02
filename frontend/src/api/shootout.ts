// Multi-model compare (shootout M3) client. One POST fans the edit out across the
// comparison set; each real job then polls independently via /poll (partial failure of
// one tile never blocks the rest). The mock path returns terminal tiles inline.
import { baseUrl } from "./sidecar";
import type { HarmonizeOpts } from "./generate";

export interface ShootoutJobOut {
  model_id: string;
  slug: string | null;
  prompt: string;
  rule_note: string;
  paradigm: string;
  seed: number;
  status: "polling" | "completed" | "failed";
  job_id: string | null;
  result_png: string | null;
  error: string | null;
}

export interface ShootoutResponse {
  run_id: string;
  region: [number, number, number, number];
  jobs: ShootoutJobOut[];
}

export async function runShootout(body: {
  id: string;
  mask_png: string;
  intent: string;
  subject?: string;
  reference_png?: string;
  reference_role?: string;
  models: string[];
  params?: Record<string, unknown>;
  loras?: { ref: string; weight: number; trigger_words: string[] }[];
  harmonize?: HarmonizeOpts;
}): Promise<ShootoutResponse> {
  const res = await fetch(`${await baseUrl()}/shootout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/shootout ${res.status}: ${await res.text()}`);
  return (await res.json()) as ShootoutResponse;
}

/** Record the winning (intent → prompt) pair on the model's user profile layer. */
export async function recordExemplar(modelId: string, intent: string, prompt: string): Promise<void> {
  try {
    await fetch(`${await baseUrl()}/profiles/exemplar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: modelId, intent, prompt }),
    });
  } catch (e) {
    console.warn("exemplar record failed:", e); // advisory — never blocks the keep
  }
}

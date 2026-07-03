// Reference-image role model — see CLAUDE.md "Reference roles".
//
// A reference image is not one input; it has a ROLE, and each role wires up differently.
// This is the frontend-facing shape of the per-model capabilities. In M1 it is backed by
// the STUB registry below; in M2 it is replaced by the real model registry pulled from
// each model card's API tab (sidecar `/models`). Keep the type stable so the swap is local.

import { baseUrl } from "./sidecar";

export type ReferenceRole = "replace" | "pose" | "style";

/** How the processed reference is attached to the model request. */
export type ReferenceInput = "controlnet" | "multi_image";

export interface ModelRefCaps {
  id: string;
  label: string;
  /** Generation paradigm — drives prompt synthesis (instruction | inpaint | controlnet |
   *  reference/character). Shown as a badge in the picker. */
  paradigm: string;
  /** Rough per-generation cost estimate in cents. */
  estCostCents: number;
  /** Roles this model supports, in preference order (first = best supported). */
  reference_roles: ReferenceRole[];
  /** Per-role: which input field the adapter attaches the processed reference to. */
  reference_inputs: Partial<Record<ReferenceRole, ReferenceInput>>;
  // Phase 7 registry flags (present when loaded from the sidecar /models).
  slug?: string;
  needs_mask?: boolean;
  instruction_based?: boolean;
  confirmed_slug?: boolean;
  supports_lora?: boolean;
  max_loras?: number;
  /** True for models pulled live from the WaveSpeed catalog (vs. the curated static set). */
  dynamic?: boolean;
  /** Short model type/description surfaced by the live catalog. */
  type?: string;
  description?: string;
}

/** Metadata from the last /models fetch — lets the UI show "N live models" / refresh errors. */
export interface ModelsMeta {
  dynamicCount: number;
  dynamicError: string | null;
  hasKey: boolean;
}

let LAST_META: ModelsMeta = { dynamicCount: 0, dynamicError: null, hasKey: false };

export function modelsMeta(): ModelsMeta {
  return LAST_META;
}

/** Local keep/reroll telemetry per model (from /models `feedback`) — picker badges. */
export interface ModelFeedback {
  keeps: number;
  rerolls: number;
  keep_rate: number;
  by_operation: Record<string, { keep: number; reroll: number }>;
}

let FEEDBACK: Record<string, ModelFeedback> = {};

export function feedbackFor(modelId: string): ModelFeedback | undefined {
  return FEEDBACK[modelId];
}

/** Max models in a comparison set (shootout). Comparison is intentional spend. */
export const MAX_COMPARE = 6;

export const ROLE_LABELS: Record<ReferenceRole, string> = {
  replace: "Replace",
  pose: "Match pose",
  style: "Match style",
};

export const ROLE_BLURB: Record<ReferenceRole, string> = {
  replace: "Place the reference's subject into the selected region.",
  pose: "Keep the original subject's identity; match only the reference's pose.",
  style: "Adopt the reference's look/palette; keep the original content.",
};

// --- STUB registry (M1). Confirmed-capable models wired first per the build prompt. ---
// Capabilities here are placeholders until M2 pulls them from each model card.
export const STUB_MODELS: ModelRefCaps[] = [
  {
    id: "qwen-image-edit-plus",
    label: "Qwen-Image-Edit-Plus",
    paradigm: "instruction",
    estCostCents: 0.9,
    reference_roles: ["replace", "pose"],
    reference_inputs: { replace: "multi_image", pose: "multi_image" },
  },
  {
    id: "qwen-image-edit-2511",
    label: "Qwen-Image-Edit",
    paradigm: "instruction",
    estCostCents: 0.8,
    reference_roles: ["replace"],
    reference_inputs: { replace: "multi_image" },
  },
  {
    id: "flux-fill",
    label: "FLUX Fill",
    paradigm: "inpaint",
    estCostCents: 1.2,
    reference_roles: [],
    reference_inputs: {},
  },
  {
    id: "flux-kontext",
    label: "FLUX Kontext",
    paradigm: "instruction",
    estCostCents: 1.0,
    reference_roles: [],
    reference_inputs: {},
  },
  {
    id: "ideogram-character",
    label: "Ideogram Character",
    paradigm: "reference/character",
    estCostCents: 1.1,
    reference_roles: ["replace"],
    reference_inputs: { replace: "multi_image" },
  },
  {
    id: "zimage-controlnet-pose",
    label: "Z-Image-Turbo ControlNet (pose)",
    paradigm: "controlnet",
    estCostCents: 0.7,
    reference_roles: ["pose"],
    reference_inputs: { pose: "controlnet" },
  },
];

// Live registry — seeded with the stub, replaced by the sidecar /models on load.
let MODELS: ModelRefCaps[] = STUB_MODELS;

export function getModels(): ModelRefCaps[] {
  return MODELS;
}

export function modelById(id: string): ModelRefCaps | undefined {
  return MODELS.find((m) => m.id === id);
}

/** Load the real model registry from the sidecar; falls back to the stub on failure. */
export async function loadModels(force = false): Promise<ModelRefCaps[]> {
  try {
    const res = await fetch(`${await baseUrl()}/models${force ? "?refresh=true" : ""}`);
    if (!res.ok) throw new Error(`/models ${res.status}`);
    const j = (await res.json()) as {
      models: ModelRefCaps[];
      dynamic_count?: number;
      dynamic_error?: string | null;
      has_key?: boolean;
      feedback?: Record<string, ModelFeedback>;
    };
    if (Array.isArray(j.models) && j.models.length) MODELS = j.models;
    if (j.feedback) FEEDBACK = j.feedback;
    LAST_META = {
      dynamicCount: j.dynamic_count ?? 0,
      dynamicError: j.dynamic_error ?? null,
      hasKey: !!j.has_key,
    };
    return MODELS;
  } catch {
    return MODELS; // stub
  }
}

/** The role a model "best supports" — first entry in its reference_roles. */
export function defaultRoleFor(model: ModelRefCaps): ReferenceRole {
  return model.reference_roles[0] ?? "replace";
}

/** First model (from the given registry) that supports a role — for the M2 switch hint. */
export function findModelForRole(
  role: ReferenceRole,
  models: ModelRefCaps[] = getModels()
): ModelRefCaps | undefined {
  return models.find((m) => m.reference_roles.includes(role));
}

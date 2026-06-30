// Reference-image role model — see CLAUDE.md "Reference roles".
//
// A reference image is not one input; it has a ROLE, and each role wires up differently.
// This is the frontend-facing shape of the per-model capabilities. In M1 it is backed by
// the STUB registry below; in M2 it is replaced by the real model registry pulled from
// each model card's API tab (sidecar `/models`). Keep the type stable so the swap is local.

export type ReferenceRole = "replace" | "pose" | "style";

/** How the processed reference is attached to the model request. */
export type ReferenceInput = "controlnet" | "multi_image";

export interface ModelRefCaps {
  id: string;
  label: string;
  /** Roles this model supports, in preference order (first = best supported). */
  reference_roles: ReferenceRole[];
  /** Per-role: which input field the adapter attaches the processed reference to. */
  reference_inputs: Partial<Record<ReferenceRole, ReferenceInput>>;
}

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
    reference_roles: ["replace", "pose"],
    reference_inputs: { replace: "multi_image", pose: "multi_image" },
  },
  {
    id: "ideogram-character",
    label: "Ideogram Character",
    reference_roles: ["replace"],
    reference_inputs: { replace: "multi_image" },
  },
  {
    id: "zimage-controlnet-pose",
    label: "Z-Image-Turbo ControlNet (pose)",
    reference_roles: ["pose"],
    reference_inputs: { pose: "controlnet" },
  },
];

/** The role a model "best supports" — first entry in its reference_roles. */
export function defaultRoleFor(model: ModelRefCaps): ReferenceRole {
  return model.reference_roles[0] ?? "replace";
}

/** First model (from the given registry) that supports a role — for the M2 switch hint. */
export function findModelForRole(
  role: ReferenceRole,
  models: ModelRefCaps[] = STUB_MODELS
): ModelRefCaps | undefined {
  return models.find((m) => m.reference_roles.includes(role));
}

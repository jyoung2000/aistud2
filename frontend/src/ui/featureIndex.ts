// Feature index — the single registry the Feature Finder ("where is X?") and the shortcut
// overlay are generated from, so neither can drift from the app.
//
// RULE: every new feature ships with an entry here + a data-tour attribute on its UI
// element (+ optionally a coach mark in ui/coachmarks.tsx). No entry, no merge.

export interface FeatureEntry {
  key: string;
  name: string;
  keywords: string[];
  /** data-tour id of the element the finder spotlights. */
  tourTarget: string;
  blurb: string;
  shortcut?: string;
  group: "Tools" | "Selection" | "Layers" | "AI" | "View" | "File";
}

export const FEATURE_INDEX: FeatureEntry[] = [
  // --- Tools ---
  { key: "move", name: "Move tool", keywords: ["move", "transform", "drag", "scale", "rotate"], tourTarget: "tools", blurb: "Move, scale, and rotate layers; drag from empty space to select several.", shortcut: "V", group: "Tools" },
  { key: "smart-select", name: "Smart Select", keywords: ["select", "subject", "sam", "click"], tourTarget: "tools", blurb: "Click your subject to select it; drag a box for a region.", shortcut: "M", group: "Tools" },
  { key: "lasso", name: "Lasso (freehand/polygon/magnetic)", keywords: ["lasso", "freehand", "polygon", "magnetic", "outline"], tourTarget: "tools", blurb: "Draw a selection by hand — Magnetic snaps to edges.", shortcut: "L · Shift+L cycles", group: "Tools" },
  { key: "pen", name: "Pen (editable curves)", keywords: ["pen", "bezier", "path", "curve", "anchor"], tourTarget: "tools", blurb: "Click = corner, drag = curve; every anchor stays editable.", shortcut: "Enter commits", group: "Tools" },
  { key: "wand", name: "Magic Wand", keywords: ["wand", "color", "flood", "tolerance"], tourTarget: "tools", blurb: "Select similar colors with one click; tolerance is in the options bar.", shortcut: "Shift+W", group: "Tools" },
  { key: "magic-brush", name: "Magic Brush", keywords: ["brush", "scribble", "paint", "snap"], tourTarget: "tools", blurb: "Paint roughly over a subject — AI snaps it to a precise selection.", shortcut: "W · [ ] size", group: "Tools" },
  { key: "hand", name: "Hand (pan)", keywords: ["hand", "pan", "navigate"], tourTarget: "tools", blurb: "Pan the view — or hold Space with any tool.", shortcut: "H / Space", group: "Tools" },
  { key: "zoom", name: "Zoom", keywords: ["zoom", "fit", "100%", "magnify"], tourTarget: "tools", blurb: "Zoom controls live at the bottom of the tool rail; the wheel zooms to your cursor.", shortcut: "⌘+ ⌘− ⌘0 ⌘1", group: "Tools" },
  // --- Selection ---
  { key: "select-subject", name: "Select subject (one click)", keywords: ["subject", "auto", "person"], tourTarget: "optionsbar", blurb: "One click finds the main subject.", group: "Selection" },
  { key: "refine-edge", name: "Refine edge", keywords: ["refine", "matting", "hair", "edge"], tourTarget: "optionsbar", blurb: "Snaps the selection edge to fine detail like hair and fur.", group: "Selection" },
  { key: "feather", name: "Feather", keywords: ["feather", "soft", "blur", "edge"], tourTarget: "optionsbar", blurb: "Softens the selection edge — Gaussian blur of the selection channel, like Photoshop.", group: "Selection" },
  { key: "boolean-ops", name: "Select multiple things (add / subtract)", keywords: ["ctrl", "shift", "alt", "add", "subtract", "intersect", "boolean", "multiple", "multi"], tourTarget: "optionsbar", blurb: "Ctrl-click adds another object to the selection, Alt-click removes one, Ctrl+Alt intersects. Works with clicks, boxes, and lassos.", shortcut: "Ctrl / Alt", group: "Selection" },
  { key: "deselect-all", name: "Deselect everything", keywords: ["deselect", "clear", "unselect", "escape", "none"], tourTarget: "optionsbar", blurb: "The ✕ Deselect button, Esc, or ⌘D clears the whole selection.", shortcut: "Esc / ⌘D", group: "Selection" },
  { key: "select-by-text", name: "Find (select by text)", keywords: ["find", "text", "semantic", "search", "describe"], tourTarget: "optionsbar", blurb: "Type what to select and hit Find — colors, 'person', and 'background' work everywhere; full phrases use the GPU build.", group: "Selection" },
  { key: "invert", name: "Invert selection", keywords: ["invert", "background"], tourTarget: "optionsbar", blurb: "Flip the selection to everything else (great for backgrounds).", shortcut: "⌘⇧I", group: "Selection" },
  { key: "select-all", name: "Select all", keywords: ["all", "everything", "whole image"], tourTarget: "optionsbar", blurb: "Select the whole image.", shortcut: "⌘A", group: "Selection" },
  { key: "saved-selections", name: "Saved selections", keywords: ["save", "named", "selection", "load"], tourTarget: "optionsbar", blurb: "Save a selection by name and reload it later (behind ⋯ More).", group: "Selection" },
  // --- Layers ---
  { key: "layers-panel", name: "Layers panel", keywords: ["layers", "stack", "visibility", "opacity", "blend"], tourTarget: "layers", blurb: "Every edit lands as a re-editable layer: hide, reorder, blend, re-roll, or delete.", group: "Layers" },
  { key: "layer-via-copy", name: "Layer via copy", keywords: ["copy", "duplicate", "extract"], tourTarget: "layers", blurb: "Copies the selection into a new movable layer.", shortcut: "⌘J", group: "Layers" },
  { key: "auto-separate", name: "Auto-separate", keywords: ["decompose", "separate", "subjects", "background"], tourTarget: "filebar", blurb: "AI splits the photo into subject + background layers (an editable proposal).", group: "Layers" },
  { key: "fill-behind", name: "Fill behind (occlusion fill)", keywords: ["fill", "inpaint", "hole", "background"], tourTarget: "layers", blurb: "Inpaints the background hole behind a subject so it moves freely.", group: "Layers" },
  { key: "adjustment-layers", name: "Adjustment layers", keywords: ["adjustment", "exposure", "contrast", "saturation", "clip"], tourTarget: "filebar", blurb: "Non-destructive exposure/contrast/saturation, optionally clipped to the layer below.", group: "Layers" },
  { key: "flatten-ai", name: "Flatten for AI", keywords: ["flatten", "bake", "merge"], tourTarget: "filebar", blurb: "Bakes layers into the base so AI edits see them (imports are invisible until then).", group: "Layers" },
  { key: "import-image", name: "Import image as layer", keywords: ["import", "collage", "second image"], tourTarget: "filemenu", blurb: "Drops another photo in as a movable layer (or just drag one onto the canvas).", group: "Layers" },
  { key: "groups-align", name: "Group / align layers", keywords: ["group", "align", "distribute"], tourTarget: "layers", blurb: "Multi-select layers to group, align, duplicate, or fade them together.", group: "Layers" },
  // --- AI ---
  { key: "generate", name: "Generate (AI edit)", keywords: ["generate", "prompt", "edit", "ai"], tourTarget: "generate", blurb: "Describe a change for the selection — only that crop is sent; the rest stays identical.", shortcut: "Enter", group: "AI" },
  { key: "model-picker", name: "Model picker", keywords: ["model", "qwen", "flux", "pick"], tourTarget: "inspector", blurb: "Choose which image model runs your edit; unverified models are labeled.", group: "AI" },
  { key: "reference", name: "Reference image & roles", keywords: ["reference", "replace", "pose", "style", "role"], tourTarget: "inspector", blurb: "Attach a reference: Replace swaps the subject in, Pose copies only the posture, Style borrows the look.", group: "AI" },
  { key: "pose-editor", name: "Pose Editor", keywords: ["pose", "skeleton", "rig", "openpose"], tourTarget: "inspector", blurb: "Hand-edit the extracted skeleton — the edited rig becomes the control signal.", group: "AI" },
  { key: "lora", name: "LoRA stack", keywords: ["lora", "style", "weights", "trigger"], tourTarget: "inspector", blurb: "Attach LoRAs with weights on supporting models; trigger words are injected automatically.", group: "AI" },
  { key: "compare", name: "Compare (multi-model shootout)", keywords: ["compare", "shootout", "models", "versus"], tourTarget: "inspector", blurb: "Run one edit across several models, compare tiles, keep the best.", group: "AI" },
  { key: "vary", name: "Vary ×K (seed variations)", keywords: ["vary", "variations", "seeds", "candidates"], tourTarget: "generate", blurb: "Generates K candidates of the same edit; click one to keep it.", group: "AI" },
  { key: "harmonize", name: "Harmonize seam", keywords: ["harmonize", "seam", "color match", "grain"], tourTarget: "generate", blurb: "Color-matches, relights, and grain-matches the edit into its surroundings.", group: "AI" },
  { key: "reroll", name: "Re-roll a layer", keywords: ["reroll", "retry", "seed"], tourTarget: "layers", blurb: "Re-runs a layer's edit with a new seed, in place (↻ on the layer row).", group: "AI" },
  { key: "tuned-prompt", name: "Tuned prompt (prompt intelligence)", keywords: ["tuned", "compiled", "prompt", "rationale", "operation", "intent", "ambiguity"], tourTarget: "tuned-prompt", blurb: "Your intent is compiled into a model-tuned prompt — hover a clause for its sourced reason, correct the parsed operation, or edit the text to send it verbatim.", group: "AI" },
  { key: "medium", name: "Image medium (photo / drawn / 3D)", keywords: ["medium", "anime", "cartoon", "drawn", "drawing", "photo", "render", "cg", "style lock"], tourTarget: "medium", blurb: "Auto-detected on open: photo, drawing/animation, or CG render — prompts are styled to match and never cross mediums. Correct it here (or via the chip above the prompt) if the detection is wrong.", group: "AI" },
  // --- View ---
  { key: "view-modes", name: "A|B & Diff views", keywords: ["before", "after", "swipe", "diff", "compare view"], tourTarget: "viewmodes", blurb: "A|B swipes before/after; Diff highlights exactly which pixels changed.", group: "View" },
  { key: "undo", name: "Undo / redo", keywords: ["undo", "redo", "history"], tourTarget: "filebar", blurb: "50 steps deep; zoom and pan stay off the history.", shortcut: "⌘Z / ⌘⇧Z", group: "View" },
  // --- File ---
  { key: "open-image", name: "Open image", keywords: ["open", "load", "photo"], tourTarget: "filemenu", blurb: "Open a photo — or just drop one anywhere on the canvas.", shortcut: "⌘O", group: "File" },
  { key: "save-project", name: "Save project (.neuclip)", keywords: ["save", "project", "neuclip"], tourTarget: "filemenu", blurb: ".neuclip keeps every layer editable; Export flattens to a normal image.", shortcut: "⌘S", group: "File" },
  { key: "export", name: "Export (PNG/JPEG/WebP/cutout)", keywords: ["export", "png", "jpeg", "webp", "cutout", "transparent"], tourTarget: "filemenu", blurb: "Export the picture, a format of your choice, or the selection as a transparent cutout.", group: "File" },
  { key: "crop-straighten", name: "Crop & straighten", keywords: ["crop", "straighten", "aspect", "rotate"], tourTarget: "filebar", blurb: "Non-destructive crop with draggable handles + straighten, applied at export.", group: "File" },
  { key: "extend", name: "Extend canvas (outpaint)", keywords: ["extend", "outpaint", "aspect", "expand"], tourTarget: "filebar", blurb: "Grows the canvas to a new aspect ratio and fills the new region generatively.", group: "File" },
  { key: "finish", name: "Finish (upscale + faces)", keywords: ["upscale", "finish", "face", "restore", "2x", "4x"], tourTarget: "filemenu", blurb: "Upscale 2×/4× with optional face restoration on export.", group: "File" },
  { key: "settings", name: "Settings & API keys", keywords: ["settings", "keys", "api", "gpu"], tourTarget: "settings", blurb: "API keys, compute device, the live model list, and the walkthrough live here.", group: "File" },
  { key: "shortcuts-remap", name: "Keyboard shortcuts (view & remap)", keywords: ["keyboard", "shortcuts", "keybind", "keybinds", "remap", "hotkey", "rebind"], tourTarget: "settings", blurb: "Press ? for the shortcuts panel — click any remappable key to rebind it.", shortcut: "?", group: "File" },
];

export function searchFeatures(q: string): FeatureEntry[] {
  const t = q.trim().toLowerCase();
  if (!t) return FEATURE_INDEX;
  return FEATURE_INDEX.filter(
    (f) =>
      f.name.toLowerCase().includes(t) ||
      f.keywords.some((k) => k.includes(t)) ||
      f.blurb.toLowerCase().includes(t)
  );
}

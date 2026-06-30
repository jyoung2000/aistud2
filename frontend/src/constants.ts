// Single renameable app-name constant (mirrors sidecar/app/constants.py).
export const APP_NAME = "Neuclip Studio";

// Contract #5 — color logic. Cyan = selection, amber = AI-generation.
export const COLOR_SELECTION = "#22d3ee"; // cyan
export const COLOR_GENERATION = "#f59e0b"; // amber

// Fixed-with-fallback sidecar port (matches sidecar DEFAULT_PORT). Used only when the
// Tauri `sidecar_port` command is unavailable (e.g. browser dev).
export const DEFAULT_SIDECAR_PORT = 8756;

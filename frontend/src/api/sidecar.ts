// Sidecar client. Discovers the port from the Tauri Rust parent (which read it from the
// sidecar's stdout); falls back to the default port for plain browser dev.
import { DEFAULT_SIDECAR_PORT } from "../constants";

export interface HealthResponse {
  status: string;
  app: string;
  device: "cuda" | "cpu";
  gpu_name: string | null;
  cuda: boolean;
  torch: boolean;
  torch_version: string | null;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let cachedPort: number | null = null;

export async function getSidecarPort(): Promise<number> {
  if (cachedPort != null) return cachedPort;
  if (inTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      cachedPort = await invoke<number>("sidecar_port");
      return cachedPort;
    } catch {
      // fall through to default
    }
  }
  const fromEnv = Number(import.meta.env?.VITE_SIDECAR_PORT);
  cachedPort = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_SIDECAR_PORT;
  return cachedPort;
}

export async function baseUrl(): Promise<string> {
  return `http://127.0.0.1:${await getSidecarPort()}`;
}

export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch(`${await baseUrl()}/health`);
  if (!res.ok) throw new Error(`/health ${res.status}`);
  return (await res.json()) as HealthResponse;
}

/** Poll /health until it answers or `timeoutMs` elapses. */
export async function waitForSidecar(timeoutMs = 30000): Promise<HealthResponse> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      return await getHealth();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`sidecar not reachable: ${String(lastErr)}`);
}

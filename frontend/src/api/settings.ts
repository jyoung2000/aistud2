import { baseUrl } from "./sidecar";

export interface SecretStatus {
  set: boolean;
  source: "config" | "env" | null;
  hint: string | null;
}

export interface SettingsStatus {
  config_path: string;
  secrets: Record<string, SecretStatus>;
}

export interface SettingsUpdate {
  wavespeed_api_key?: string;
  anthropic_api_key?: string;
}

export async function getSettings(): Promise<SettingsStatus> {
  const res = await fetch(`${await baseUrl()}/settings`);
  if (!res.ok) throw new Error(`/settings ${res.status}`);
  return (await res.json()) as SettingsStatus;
}

export async function saveSettings(updates: SettingsUpdate): Promise<SettingsStatus> {
  const res = await fetch(`${await baseUrl()}/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`/settings POST ${res.status}`);
  return (await res.json()) as SettingsStatus;
}

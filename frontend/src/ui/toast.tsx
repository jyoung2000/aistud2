// Tiny toast system (bottom-center, auto-dismiss). Every user action gets visible
// success/failure feedback instead of a silent console.error. Same external-store
// pattern as state/genConfig.ts; <Toasts/> is mounted once in App.
import { useSyncExternalStore } from "react";

export type ToastKind = "error" | "success" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function toast(message: string, kind: ToastKind = "info", ttlMs = 4200): void {
  const t: Toast = { id: nextId++, kind, message };
  toasts = [...toasts.slice(-3), t]; // at most 4 visible
  emit();
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    emit();
  }, ttlMs);
}

export const toastError = (m: string) => toast(m, "error", 6000);
export const toastSuccess = (m: string) => toast(m, "success");

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
const get = () => toasts;

const KIND_STYLE: Record<ToastKind, { border: string; color: string; icon: string }> = {
  error: { border: "#ef4444", color: "#fecaca", icon: "✕" },
  success: { border: "#22c55e", color: "#bbf7d0", icon: "✓" },
  info: { border: "#38bdf8", color: "#bae6fd", icon: "ℹ" },
};

export function Toasts() {
  const list = useSyncExternalStore(subscribe, get, get);
  if (!list.length) return null;
  return (
    <div
      style={{
        position: "fixed",
        bottom: 44,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 4000,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        pointerEvents: "none",
      }}
    >
      {list.map((t) => {
        const s = KIND_STYLE[t.kind];
        return (
          <div
            key={t.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              maxWidth: 520,
              background: "#14171cee",
              border: `1px solid ${s.border}66`,
              borderLeft: `3px solid ${s.border}`,
              borderRadius: 8,
              padding: "8px 14px",
              color: "#e2e8f0",
              font: "12.5px ui-sans-serif, system-ui, sans-serif",
              boxShadow: "0 8px 24px #000a",
            }}
          >
            <span style={{ color: s.color, fontWeight: 700 }}>{s.icon}</span>
            <span>{t.message}</span>
          </div>
        );
      })}
    </div>
  );
}

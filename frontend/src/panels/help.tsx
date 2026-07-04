// Persistent help layer (B3): the "?" menu, the ⌘K Feature Finder (spotlights any
// feature's UI location via the shared spotlight), and the "?"-key shortcut overlay —
// both generated FROM ui/featureIndex.ts so they can't drift from the app.
import { useEffect, useMemo, useRef, useState } from "react";
import { Menu, MenuItem } from "../ui/menu";
import { FEATURE_INDEX, searchFeatures, type FeatureEntry } from "../ui/featureIndex";
import { spotlight } from "../ui/spotlight";
import { startTutorial } from "../state/tutorial";
import { FIXED_BINDS, REMAPPABLE, keyFor, resetKeymap, setKeyFor, useKeymap } from "../state/keymap";

export function HelpMenu({ onShowTour }: { onShowTour: () => void }) {
  const [finder, setFinder] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);

  // ⌘K opens the finder; "?" (outside inputs) opens the shortcut overlay; Settings and
  // other panels open it via the "neuclip:open-shortcuts" event
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setFinder((v) => !v);
      } else if (e.key === "?" && !typing) {
        e.preventDefault();
        setShortcuts((v) => !v);
      }
    };
    const onOpen = () => setShortcuts(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("neuclip:open-shortcuts", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("neuclip:open-shortcuts", onOpen);
    };
  }, []);

  return (
    <>
      <Menu label="? Help" width={250}>
        <MenuItem label="Replay guided first edit" hint="learn by doing" onClick={() => startTutorial()} />
        <MenuItem label="Show interface tour" hint="45s" onClick={onShowTour} />
        <MenuItem label="Keyboard shortcuts — view & remap" hint="?" onClick={() => setShortcuts(true)} />
        <MenuItem label="Feature finder — where is…?" hint="⌘K" onClick={() => setFinder(true)} />
      </Menu>
      {finder && <FeatureFinder onClose={() => setFinder(false)} />}
      {shortcuts && <ShortcutOverlay onClose={() => setShortcuts(false)} />}
    </>
  );
}

function FeatureFinder({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchFeatures(q), [q]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setIdx(0), [q]);

  const pick = (f: FeatureEntry) => {
    onClose();
    // let the palette unmount first so the spotlight measures the real UI
    window.setTimeout(() => spotlight(f.tourTarget, f.name, f.blurb, f.shortcut), 60);
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 3200, background: "rgba(4,8,14,0.55)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          left: "50%",
          top: "14%",
          transform: "translateX(-50%)",
          width: 460,
          maxWidth: "92vw",
          background: "#12151a",
          border: "1px solid #2f3540",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 24px 70px #000c",
          font: "13px ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") setIdx((i) => Math.min(i + 1, results.length - 1));
            else if (e.key === "ArrowUp") setIdx((i) => Math.max(i - 1, 0));
            else if (e.key === "Enter" && results[idx]) pick(results[idx]);
          }}
          placeholder="Where is… (try “pose”, “feather”, “compare”, “outpaint”)"
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "#0d0f12",
            color: "#e2e8f0",
            border: "none",
            borderBottom: "1px solid #262c36",
            padding: "13px 16px",
            fontSize: 14,
            outline: "none",
          }}
        />
        <div style={{ maxHeight: 340, overflowY: "auto", padding: 6 }}>
          {results.length === 0 && (
            <div style={{ padding: 14, color: "#5c6473" }}>No feature matches “{q}”.</div>
          )}
          {results.map((f, i) => (
            <button
              key={f.key}
              onClick={() => pick(f)}
              onMouseEnter={() => setIdx(i)}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                width: "100%",
                textAlign: "left",
                border: "none",
                borderRadius: 7,
                background: i === idx ? "#20262f" : "transparent",
                color: "#dbe3ee",
                padding: "8px 10px",
                cursor: "pointer",
              }}
            >
              <span style={{ fontWeight: 600 }}>{f.name}</span>
              <span style={{ flex: 1, color: "#7d8694", fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {f.blurb}
              </span>
              <span style={{ fontSize: 10, color: "#5c6473" }}>{f.group}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const GROUPS: FeatureEntry["group"][] = ["Tools", "Selection", "Layers", "AI", "View", "File"];

function ShortcutOverlay({ onClose }: { onClose: () => void }) {
  useKeymap(); // live re-render on remaps
  // which action is waiting for its new key ("press a key…")
  const [capturing, setCapturing] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (capturing) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") {
          setCapturing(null);
          return;
        }
        // single printable characters only — chords stay platform-fixed
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== " ") {
          const stolen = setKeyFor(capturing, e.key);
          const label = REMAPPABLE.find((a) => a.id === capturing)?.label;
          setNote(
            stolen
              ? `${e.key.toUpperCase()} → ${label} (taken from ${REMAPPABLE.find((a) => a.id === stolen)?.label} — rebind it below)`
              : `${e.key.toUpperCase()} → ${label}`
          );
          setCapturing(null);
        }
        return;
      }
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey, true); // capture phase beats app shortcuts
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, capturing]);
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 3200,
        background: "rgba(4,8,14,0.82)",
        display: "grid",
        placeItems: "center",
        font: "12.5px ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 860, maxWidth: "94vw", maxHeight: "86vh", overflowY: "auto", background: "#12151a", border: "1px solid #2f3540", borderRadius: 14, padding: 22 }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <b style={{ fontSize: 16, color: "#e2e8f0" }}>Keyboard shortcuts</b>
          <span style={{ marginLeft: 10, color: "#5c6473", fontSize: 11 }}>click a key to rebind it — press Esc to close</span>
          <button onClick={onClose} style={{ marginLeft: "auto", border: "none", background: "transparent", color: "#8b94a3", cursor: "pointer", fontSize: 15 }}>✕</button>
        </div>

        {/* --- remappable keys --- */}
        <div style={{ border: "1px solid #262c36", borderRadius: 10, padding: "12px 14px", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 10.5, letterSpacing: 1, color: "#64748b", fontWeight: 700 }}>REMAPPABLE KEYS</span>
            {note && <span style={{ marginLeft: 10, fontSize: 11, color: "#38bdf8" }}>{note}</span>}
            <button
              onClick={() => {
                resetKeymap();
                setNote("defaults restored");
              }}
              style={{ marginLeft: "auto", border: "1px solid #2a2f37", background: "transparent", color: "#8b94a3", borderRadius: 6, padding: "2px 10px", fontSize: 11, cursor: "pointer" }}
            >
              Reset to defaults
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "4px 18px" }}>
            {REMAPPABLE.map((a) => {
              const k = keyFor(a.id);
              const isCapturing = capturing === a.id;
              return (
                <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", color: "#c8d0dc" }}>
                  <span style={{ flex: 1 }}>
                    {a.label}
                    {a.note && <span style={{ color: "#5c6473", fontSize: 10.5 }}> — {a.note}</span>}
                  </span>
                  <button
                    onClick={() => {
                      setNote(null);
                      setCapturing(isCapturing ? null : a.id);
                    }}
                    title="Click, then press the new key (Esc cancels)"
                    style={{
                      minWidth: 34,
                      fontSize: 11,
                      color: isCapturing ? "#0b1116" : k ? "#cfe6ff" : "#f2c078",
                      background: isCapturing ? "#38bdf8" : "#181d24",
                      border: `1px solid ${isCapturing ? "#38bdf8" : "#333a45"}`,
                      borderRadius: 5,
                      padding: "2px 8px",
                      cursor: "pointer",
                      fontWeight: 700,
                    }}
                  >
                    {isCapturing ? "press a key…" : k ? k.toUpperCase() : "unbound"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* --- fixed shortcuts (platform conventions; not remappable) --- */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: "2px 18px", marginBottom: 18 }}>
          {FIXED_BINDS.map((b, i) => (
            <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "3px 0", color: "#c8d0dc" }}>
              <span style={{ flex: 1 }}>{b.label}</span>
              <span style={{ fontSize: 10.5, color: "#8fa0b5", border: "1px solid #333a45", borderRadius: 4, padding: "0 5px", whiteSpace: "nowrap" }}>{b.keys}</span>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 10.5, letterSpacing: 1, color: "#64748b", fontWeight: 700, margin: "4px 0 8px" }}>
          EVERYTHING ELSE — ⌘K FINDS ANY FEATURE
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 18 }}>
          {GROUPS.map((g) => (
            <div key={g}>
              <div style={{ fontSize: 10.5, letterSpacing: 1, color: "#64748b", fontWeight: 700, marginBottom: 6 }}>
                {g.toUpperCase()}
              </div>
              {FEATURE_INDEX.filter((f) => f.group === g).map((f) => (
                <div key={f.key} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "3px 0", color: "#c8d0dc" }}>
                  <span style={{ flex: 1 }}>{f.name}</span>
                  {f.shortcut && (
                    <span style={{ fontSize: 10.5, color: "#8fa0b5", border: "1px solid #333a45", borderRadius: 4, padding: "0 5px", whiteSpace: "nowrap" }}>
                      {f.shortcut}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

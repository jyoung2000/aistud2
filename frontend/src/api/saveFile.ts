// Save-to-disk that works everywhere. `<a download>` is ignored by WebKitGTK (Linux Tauri
// webview), so inside the Tauri shell we go through the native save dialog + fs plugins;
// in a plain browser / the single-file app we fall back to the anchor download.

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function anchorDownload(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Save a blob as `name`. Returns false if the user cancelled the native dialog. */
export async function saveFile(blob: Blob, name: string): Promise<boolean> {
  if (inTauri()) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({ defaultPath: name });
      if (!path) return false; // user cancelled
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      return true;
    } catch (e) {
      console.warn("native save failed, falling back to anchor download:", e);
    }
  }
  anchorDownload(blob, name);
  return true;
}

mod sidecar;

use tauri::{Manager, RunEvent, WindowEvent};

use sidecar::SidecarState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // native save-dialog + file write — WebKitGTK ignores <a download>, so exports go
        // through these plugins when running inside the Tauri shell (api/saveFile.ts)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![sidecar::sidecar_port])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(e) = sidecar::spawn(&handle) {
                eprintln!("failed to start sidecar: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                sidecar::shutdown(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Neuclip Studio")
        .run(|app_handle, event| {
            // Catch every exit path so the sidecar never orphans.
            if let RunEvent::ExitRequested { .. } = event {
                sidecar::shutdown(app_handle);
            }
        });
}

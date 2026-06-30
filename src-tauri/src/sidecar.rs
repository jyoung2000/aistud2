//! Spawns the Python sidecar as a Tauri `externalBin`, discovers the port it prints on
//! stdout (`NEUCLIP_SIDECAR_PORT=<port>`), and owns its lifecycle so it is killed on exit
//! (no orphans).

use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const SIDECAR_BIN: &str = "neuclip-sidecar";
const PORT_PREFIX: &str = "NEUCLIP_SIDECAR_PORT=";

/// Shared state: the discovered port and the running child handle.
#[derive(Default)]
pub struct SidecarState {
    pub port: Mutex<Option<u16>>,
    pub child: Mutex<Option<CommandChild>>,
}

fn parse_port(line: &str) -> Option<u16> {
    line.trim()
        .strip_prefix(PORT_PREFIX)
        .and_then(|p| p.trim().parse::<u16>().ok())
}

/// Spawn the sidecar and stream its output. Stores the child handle and, when the port
/// line appears, records the port into shared state.
pub fn spawn(app: &AppHandle) -> Result<(), String> {
    let sidecar = app
        .shell()
        .sidecar(SIDECAR_BIN)
        .map_err(|e| format!("sidecar lookup failed: {e}"))?;

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("sidecar spawn failed: {e}"))?;

    {
        let state = app.state::<SidecarState>();
        *state.child.lock().unwrap() = Some(child);
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    if let Some(port) = parse_port(&line) {
                        let state = app.state::<SidecarState>();
                        *state.port.lock().unwrap() = Some(port);
                        eprintln!("sidecar port discovered: {port}");
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprint!("[sidecar] {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("sidecar terminated: {payload:?}");
                    let state = app.state::<SidecarState>();
                    *state.child.lock().unwrap() = None;
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// Kill the sidecar child if it is still running. Called on window close / app exit.
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let child = state.child.lock().unwrap().take();
    if let Some(child) = child {
        let _ = child.kill();
        eprintln!("sidecar killed on shutdown");
    }
}

/// Tauri command: the frontend asks for the discovered sidecar port.
#[tauri::command]
pub fn sidecar_port(state: tauri::State<SidecarState>) -> Result<u16, String> {
    state
        .port
        .lock()
        .unwrap()
        .ok_or_else(|| "sidecar port not yet discovered".to_string())
}

//! Bridge that forwards Rust log lines to the webview's JavaScript console
//! via a Tauri event. Lines still go to stderr too (visible when launching
//! the app from a terminal); the bridge just makes them visible inside the
//! built-in dev tools as well.
//!
//! Wiring:
//!   - `init` is called once during `tauri::Builder::setup` with a clone of
//!     the AppHandle. It stashes the handle in a `OnceLock`.
//!   - The `gh_log!` and `sync_log!` macros in github.rs / sync.rs both call
//!     `forward` after their eprintln, which emits a `log://line` event with
//!     the formatted line as payload.
//!   - The frontend installs a single `listen("log://line", ...)` listener
//!     and pipes each payload to `console.log`.

use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();

pub const LOG_EVENT: &str = "log://line";

pub fn init(app: AppHandle) {
    let _ = APP.set(app);
}

/// Best-effort forward: drops the line silently if the bridge isn't
/// initialized yet (early-startup logs) or if emitting fails. Logs are
/// purely diagnostic, never load-bearing.
pub fn forward(line: &str) {
    if let Some(app) = APP.get() {
        let _ = app.emit(LOG_EVENT, line.to_string());
    }
}

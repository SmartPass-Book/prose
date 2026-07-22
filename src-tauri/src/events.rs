use tauri::{AppHandle, Emitter};

// Event name constants emitted from Rust to the frontend.
pub const CACHE_THREADS_UPDATED: &str = "cache:threads-updated";
pub const CACHE_PR_UPDATED: &str = "cache:pr-updated";
pub const OUTBOX_SETTLED: &str = "outbox:settled";
pub const OUTBOX_FAILED: &str = "outbox:failed";

#[derive(serde::Serialize, Clone, Debug)]
pub struct ThreadsUpdated {
    pub repo: String,
    pub number: u64,
}

/// Tell the frontend a PR's cached threads changed; its listener refetches
/// from the cache. Fire-and-forget: a lost event only delays the refresh
/// until the next poll tick.
pub fn emit_threads_updated(app: &AppHandle, repo: &str, number: u64) {
    let _ = app.emit(
        CACHE_THREADS_UPDATED,
        ThreadsUpdated {
            repo: repo.to_string(),
            number,
        },
    );
}

// Payloads cross the IPC boundary as JSON; the frontend reads camelCase keys
// (e.g. `ev.payload.headRefOid` in App.tsx), so every multi-word field must
// be renamed or the frontend silently reads `undefined`.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrUpdated {
    pub repo: String,
    pub number: u64,
    pub head_ref_oid: String,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OutboxSettled {
    pub op_id: String,
    pub kind: String,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OutboxFailed {
    pub op_id: String,
    pub kind: String,
    pub error: String,
    pub attempts: i64,
}

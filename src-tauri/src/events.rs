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

#[derive(serde::Serialize, Clone, Debug)]
pub struct PrUpdated {
    pub repo: String,
    pub number: u64,
    pub head_ref_oid: String,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct OutboxSettled {
    pub op_id: String,
    pub kind: String,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct OutboxFailed {
    pub op_id: String,
    pub kind: String,
    pub error: String,
    pub attempts: i64,
}

use crate::db;
use crate::events::{
    OutboxFailed, OutboxSettled, PrUpdated, ThreadsUpdated, CACHE_PR_UPDATED,
    CACHE_THREADS_UPDATED, OUTBOX_FAILED, OUTBOX_SETTLED,
};
use crate::github::{
    dispatch_delete_comment, dispatch_post_comment, dispatch_reply, dispatch_resolve,
    fetch_pr_network, fetch_pr_summary, fetch_threads_graphql, AppState,
};
use chrono::Utc;
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Notify, RwLock};

macro_rules! sync_log {
    ($tag:expr, $($arg:tt)*) => {{
        let __line = format!("[sync] {} {}", $tag, format!($($arg)*));
        eprintln!("{}", __line);
        $crate::logging::forward(&__line);
    }};
}

#[derive(Default, Debug, Clone)]
pub struct ActivePr {
    pub repo: Option<String>,
    pub number: Option<u64>,
}

#[derive(Default)]
pub struct PollState {
    pub active: RwLock<ActivePr>,
    pub focused: RwLock<bool>,
}

impl PollState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            active: RwLock::new(ActivePr::default()),
            focused: RwLock::new(true),
        })
    }
}

/// Spawn the background poll loop. Reads the currently-active PR from
/// `PollState` and refreshes its threads cache, emitting events when content
/// changes.
/// Every Nth poll forces a full thread fetch so we eventually catch state
/// changes that don't bump `pullRequest.updatedAt` (notably, resolve /
/// unresolveReviewThread mutations from teammates - verified empirically).
const FORCE_FULL_EVERY: u64 = 5;

pub fn spawn_poll_loop(app: AppHandle, poll: Arc<PollState>) {
    tauri::async_runtime::spawn(async move {
        let mut tick: u64 = 0;
        let mut last_active: Option<(String, u64)> = None;
        loop {
            let (repo, number, focused) = {
                let a = poll.active.read().await;
                let f = *poll.focused.read().await;
                (a.repo.clone(), a.number, f)
            };

            if let (Some(repo), Some(number)) = (repo.as_ref(), number) {
                // Reset the tick counter when the active PR changes so the
                // first poll for a new PR is always a full fetch.
                let now_active = (repo.clone(), number);
                if last_active.as_ref() != Some(&now_active) {
                    tick = 0;
                    last_active = Some(now_active);
                }
                let force_full = tick % FORCE_FULL_EVERY == 0;
                if let Err(e) = poll_once(&app, repo, number, force_full).await {
                    eprintln!("poll error: {e}");
                }
                tick = tick.wrapping_add(1);
            }

            let delay = if focused { 8 } else { 60 };
            tokio::time::sleep(Duration::from_secs(delay)).await;
        }
    });
}

async fn poll_once(
    app: &AppHandle,
    repo: &str,
    number: u64,
    force_full: bool,
) -> Result<(), String> {
    sync_log!(
        "POLL",
        "begin repo={repo} pr=#{number} force_full={force_full}"
    );
    let started = Instant::now();
    let state: tauri::State<'_, AppState> = app.state();
    let guard = state.ensure().await.map_err(|e| e.to_string())?;
    let octo = &guard.as_ref().unwrap().octo;
    let pool = state
        .db
        .get()
        .ok_or_else(|| "db pool not initialized".to_string())?;

    // Cheap probe: skip the paginated thread fetch when nothing visible to
    // `updatedAt` has changed and we're not on a forced-full tick.
    let cached_pr = db::get_pr_cached(pool, repo, number as i64)
        .ok()
        .flatten();
    let prev_updated = cached_pr
        .as_ref()
        .and_then(|v| v.get("updatedAt").and_then(|s| s.as_str()))
        .unwrap_or("")
        .to_string();
    let prev_head = cached_pr
        .as_ref()
        .and_then(|v| v.get("headRefOid").and_then(|s| s.as_str()))
        .unwrap_or("")
        .to_string();

    if !force_full {
        match fetch_pr_summary(octo, repo, number).await {
            Ok(probe) => {
                let new_updated = probe
                    .get("updatedAt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let new_head = probe
                    .get("headRefOid")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let updated_changed = !prev_updated.is_empty() && new_updated != prev_updated;
                let head_changed = !prev_head.is_empty() && new_head != prev_head;
                if !updated_changed && !head_changed && !prev_updated.is_empty() {
                    sync_log!(
                        "POLL",
                        "skip_unchanged repo={repo} pr=#{number} updated_at={new_updated} elapsed_ms={}",
                        started.elapsed().as_millis()
                    );
                    return Ok(());
                }
                let reason = if updated_changed {
                    "updated_at_changed"
                } else if head_changed {
                    "head_changed"
                } else {
                    "no_cache_baseline"
                };
                sync_log!(
                    "POLL",
                    "full_fetch repo={repo} pr=#{number} reason={reason}"
                );
            }
            Err(e) => {
                sync_log!(
                    "POLL",
                    "probe_failed repo={repo} pr=#{number} falling_back_to_full error={e}"
                );
            }
        }
    } else {
        sync_log!("POLL", "full_fetch repo={repo} pr=#{number} reason=force_tick");
    }

    let response = fetch_threads_graphql(octo, repo, number)
        .await
        .map_err(|e| e.to_string())?;

    let nodes_owned: Vec<Value> = response
        .pointer("/data/repository/pullRequest/reviewThreads/nodes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    db::replace_threads(pool, repo, number as i64, &nodes_owned).map_err(|e| e.to_string())?;

    app.emit(
        CACHE_THREADS_UPDATED,
        ThreadsUpdated {
            repo: repo.to_string(),
            number,
        },
    )
    .map_err(|e| e.to_string())?;

    // Refresh PR detail too. If the head SHA moved (commits pushed), the
    // frontend needs to re-render the file; without this the cached PR detail
    // pins headRefOid forever and threads on the new commit show as STALE.
    let prev_head = db::get_pr_cached(pool, repo, number as i64)
        .ok()
        .flatten()
        .and_then(|v| {
            v.get("headRefOid")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        });
    match fetch_pr_network(octo, repo, number).await {
        Ok(pr) => {
            let _ = db::put_pr(pool, repo, number as i64, &pr);
            let new_head = pr
                .get("headRefOid")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            if !new_head.is_empty() && prev_head.as_deref() != Some(new_head.as_str()) {
                let _ = app.emit(
                    CACHE_PR_UPDATED,
                    PrUpdated {
                        repo: repo.to_string(),
                        number,
                        head_ref_oid: new_head,
                    },
                );
            }
        }
        Err(e) => {
            sync_log!("POLL", "refresh_pr failed repo={repo} pr=#{number} error={e}");
        }
    }
    sync_log!(
        "POLL",
        "end repo={repo} pr=#{number} threads={} elapsed_ms={}",
        nodes_owned.len(),
        started.elapsed().as_millis()
    );
    Ok(())
}

// ---- Outbox worker -----------------------------------------------------

#[derive(Default)]
pub struct OutboxState {
    pub notify: Notify,
}

impl OutboxState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            notify: Notify::new(),
        })
    }
}

pub fn spawn_outbox_loop(app: AppHandle, outbox: Arc<OutboxState>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let pool_opt = {
                let state: tauri::State<'_, AppState> = app.state();
                state.db.get().cloned()
            };
            let Some(pool) = pool_opt else {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            };

            let claimed = match db::claim_next_outbox(&pool) {
                Ok(c) => c,
                Err(e) => {
                    sync_log!("OUTBOX", "claim_failed error={e}");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
            };

            if let Some(op) = claimed {
                sync_log!(
                    "OUTBOX",
                    "claim id={} kind={} attempt={}",
                    op.id,
                    op.kind,
                    op.attempts + 1
                );
                let _ = run_op(&app, &pool, &op).await;
                // Loop tightly: there might be more ready ops.
                continue;
            }

            // Nothing ready. Wait for either a kick (new enqueue) or a 5s tick.
            tokio::select! {
                _ = outbox.notify.notified() => {},
                _ = tokio::time::sleep(Duration::from_secs(5)) => {},
            }
        }
    });
}

fn backoff_seconds(attempt: i64) -> i64 {
    match attempt {
        1 => 1,
        2 => 4,
        3 => 15,
        4 => 60,
        _ => 300,
    }
}

const MAX_ATTEMPTS: i64 = 5;

async fn run_op(
    app: &AppHandle,
    pool: &db::DbPool,
    op: &db::OutboxRow,
) -> Result<(), String> {
    let started = Instant::now();
    let result = dispatch_op(app, op).await;
    match result {
        Ok(()) => {
            sync_log!(
                "OUTBOX",
                "dispatch_ok id={} kind={} elapsed_ms={}",
                op.id,
                op.kind,
                started.elapsed().as_millis()
            );
            settle_success(app, pool, op).await
        }
        Err(err) => {
            sync_log!(
                "OUTBOX",
                "dispatch_err id={} kind={} elapsed_ms={} error={err}",
                op.id,
                op.kind,
                started.elapsed().as_millis()
            );
            settle_failure(app, pool, op, &err).await
        }
    }
}

async fn dispatch_op(app: &AppHandle, op: &db::OutboxRow) -> Result<(), String> {
    let state: tauri::State<'_, AppState> = app.state();
    let guard = state.ensure().await.map_err(|e| e.to_string())?;
    let octo = &guard.as_ref().unwrap().octo;

    match op.kind.as_str() {
        "resolve" | "unresolve" => {
            let thread_id = op
                .payload
                .get("threadId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing threadId".to_string())?;
            let resolved = op.kind == "resolve";
            dispatch_resolve(octo, thread_id, resolved)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        "delete_comment" => {
            let repo = op
                .payload
                .get("repo")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing repo".to_string())?;
            let cid = op
                .payload
                .get("commentId")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| "missing commentId".to_string())?;
            dispatch_delete_comment(octo, repo, cid)
                .await
                .map_err(|e| e.to_string())
        }
        "post_comment" => {
            let repo = op.payload.get("repo").and_then(|v| v.as_str())
                .ok_or_else(|| "missing repo".to_string())?;
            let number = op.payload.get("number").and_then(|v| v.as_u64())
                .ok_or_else(|| "missing number".to_string())?;
            let commit_id = op.payload.get("commitId").and_then(|v| v.as_str())
                .ok_or_else(|| "missing commitId".to_string())?;
            let path = op.payload.get("path").and_then(|v| v.as_str())
                .ok_or_else(|| "missing path".to_string())?;
            let line = op.payload.get("line").and_then(|v| v.as_u64())
                .ok_or_else(|| "missing line".to_string())?;
            let start_line = op.payload.get("startLine").and_then(|v| v.as_u64());
            let body = op.payload.get("body").and_then(|v| v.as_str())
                .ok_or_else(|| "missing body".to_string())?;
            dispatch_post_comment(octo, repo, number, commit_id, path, line, start_line, body)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        "reply" => {
            let repo = op.payload.get("repo").and_then(|v| v.as_str())
                .ok_or_else(|| "missing repo".to_string())?;
            let number = op.payload.get("number").and_then(|v| v.as_u64())
                .ok_or_else(|| "missing number".to_string())?;
            let in_reply_to = op.payload.get("inReplyTo").and_then(|v| v.as_u64())
                .ok_or_else(|| "missing inReplyTo".to_string())?;
            let body = op.payload.get("body").and_then(|v| v.as_str())
                .ok_or_else(|| "missing body".to_string())?;
            dispatch_reply(octo, repo, number, in_reply_to, body)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        other => Err(format!("unknown op kind '{other}'")),
    }
}

async fn force_refresh_threads(app: &AppHandle, repo: &str, number: u64) {
    if let Err(e) = poll_once(app, repo, number, true).await {
        eprintln!("post-settle refresh failed: {e}");
    }
}

async fn settle_success(
    app: &AppHandle,
    pool: &db::DbPool,
    op: &db::OutboxRow,
) -> Result<(), String> {
    db::mark_outbox_done(pool, &op.id).map_err(|e| e.to_string())?;

    // Per-op cleanup of pending markers + emit cache event.
    if op.kind == "resolve" || op.kind == "unresolve" {
        if let Some(thread_id) = op.payload.get("threadId").and_then(|v| v.as_str()) {
            let _ = db::clear_pending_op(pool, thread_id, &op.id);
            if let Ok(Some((repo, number))) = db::get_thread_pr(pool, thread_id) {
                let _ = app.emit(
                    CACHE_THREADS_UPDATED,
                    ThreadsUpdated {
                        repo,
                        number: number as u64,
                    },
                );
            }
        }
    } else if op.kind == "delete_comment" {
        if let Ok(Some((repo, number))) = db::finalize_delete_comment(pool, &op.id) {
            let _ = app.emit(
                CACHE_THREADS_UPDATED,
                ThreadsUpdated {
                    repo,
                    number: number as u64,
                },
            );
        }
    } else if op.kind == "post_comment" {
        if let Ok(Some((repo, number))) = db::finalize_post_comment(pool, &op.id) {
            // Trigger immediate refresh so the tmp thread gets replaced with
            // the canonical server thread (correct node id, real comments, etc).
            force_refresh_threads(app, &repo, number as u64).await;
            let _ = app.emit(
                CACHE_THREADS_UPDATED,
                ThreadsUpdated {
                    repo,
                    number: number as u64,
                },
            );
        }
    } else if op.kind == "reply" {
        if let Ok(Some((repo, number))) = db::finalize_reply(pool, &op.id) {
            force_refresh_threads(app, &repo, number as u64).await;
            let _ = app.emit(
                CACHE_THREADS_UPDATED,
                ThreadsUpdated {
                    repo,
                    number: number as u64,
                },
            );
        }
    }

    let _ = app.emit(
        OUTBOX_SETTLED,
        OutboxSettled {
            op_id: op.id.clone(),
            kind: op.kind.clone(),
        },
    );
    Ok(())
}

async fn settle_failure(
    app: &AppHandle,
    pool: &db::DbPool,
    op: &db::OutboxRow,
    err: &str,
) -> Result<(), String> {
    let attempts = op.attempts + 1;
    if attempts >= MAX_ATTEMPTS {
        sync_log!(
            "OUTBOX",
            "give_up id={} kind={} attempts={attempts} reverting_optimistic error={err}",
            op.id,
            op.kind
        );
        db::mark_outbox_failed(pool, &op.id, err).map_err(|e| e.to_string())?;
        // Revert optimistic effect for this op.
        if op.kind == "resolve" || op.kind == "unresolve" {
            if let Some(thread_id) = op.payload.get("threadId").and_then(|v| v.as_str()) {
                let prior = op
                    .payload
                    .get("priorResolved")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if let Ok(Some((repo, number))) =
                    db::revert_optimistic_resolve(pool, thread_id, prior, &op.id)
                {
                    let _ = app.emit(
                        CACHE_THREADS_UPDATED,
                        ThreadsUpdated {
                            repo,
                            number: number as u64,
                        },
                    );
                }
            }
        } else if op.kind == "delete_comment" {
            if let Ok(Some((repo, number))) = db::revert_optimistic_delete_comment(pool, &op.id) {
                let _ = app.emit(
                    CACHE_THREADS_UPDATED,
                    ThreadsUpdated {
                        repo,
                        number: number as u64,
                    },
                );
            }
        } else if op.kind == "post_comment" {
            if let Ok(Some((repo, number))) = db::revert_optimistic_post_comment(pool, &op.id) {
                let _ = app.emit(
                    CACHE_THREADS_UPDATED,
                    ThreadsUpdated {
                        repo,
                        number: number as u64,
                    },
                );
            }
        } else if op.kind == "reply" {
            if let Ok(Some((repo, number))) = db::revert_optimistic_reply(pool, &op.id) {
                let _ = app.emit(
                    CACHE_THREADS_UPDATED,
                    ThreadsUpdated {
                        repo,
                        number: number as u64,
                    },
                );
            }
        }
        let _ = app.emit(
            OUTBOX_FAILED,
            OutboxFailed {
                op_id: op.id.clone(),
                kind: op.kind.clone(),
                error: err.to_string(),
                attempts,
            },
        );
        return Ok(());
    }

    // Schedule retry.
    let backoff = backoff_seconds(attempts);
    sync_log!(
        "OUTBOX",
        "retry_scheduled id={} kind={} attempts={attempts} backoff_s={backoff} error={err}",
        op.id,
        op.kind
    );
    let next_at = (Utc::now() + chrono::Duration::seconds(backoff)).to_rfc3339();
    db::mark_outbox_retry(pool, &op.id, attempts, &next_at, err).map_err(|e| e.to_string())?;
    Ok(())
}

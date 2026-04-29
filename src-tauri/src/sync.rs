use crate::db;
use crate::events::{
    OutboxFailed, OutboxSettled, PrUpdated, ThreadsUpdated, CACHE_PR_UPDATED,
    CACHE_THREADS_UPDATED, OUTBOX_FAILED, OUTBOX_SETTLED,
};
use crate::github::{
    dispatch_delete_comment, dispatch_post_comment, dispatch_reply, dispatch_resolve,
    fetch_pr_network, fetch_threads_graphql, AppState,
};
use chrono::Utc;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Notify, RwLock};

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
pub fn spawn_poll_loop(app: AppHandle, poll: Arc<PollState>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let (repo, number, focused) = {
                let a = poll.active.read().await;
                let f = *poll.focused.read().await;
                (a.repo.clone(), a.number, f)
            };

            if let (Some(repo), Some(number)) = (repo.as_ref(), number) {
                if let Err(e) = poll_once(&app, repo, number).await {
                    eprintln!("poll error: {e}");
                }
            }

            let delay = if focused { 8 } else { 60 };
            tokio::time::sleep(Duration::from_secs(delay)).await;
        }
    });
}

async fn poll_once(app: &AppHandle, repo: &str, number: u64) -> Result<(), String> {
    let state: tauri::State<'_, AppState> = app.state();
    let guard = state.ensure().await.map_err(|e| e.to_string())?;
    let octo = &guard.as_ref().unwrap().octo;
    let response = fetch_threads_graphql(octo, repo, number)
        .await
        .map_err(|e| e.to_string())?;
    let pool = state
        .db
        .get()
        .ok_or_else(|| "db pool not initialized".to_string())?;

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
            eprintln!("poll: refresh_pr failed: {e}");
        }
    }
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
                    eprintln!("outbox claim failed: {e}");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
            };

            if let Some(op) = claimed {
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
    let result = dispatch_op(app, op).await;
    match result {
        Ok(()) => settle_success(app, pool, op).await,
        Err(err) => settle_failure(app, pool, op, &err).await,
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
    if let Err(e) = poll_once(app, repo, number).await {
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
    let next_at = (Utc::now() + chrono::Duration::seconds(backoff_seconds(attempts))).to_rfc3339();
    db::mark_outbox_retry(pool, &op.id, attempts, &next_at, err).map_err(|e| e.to_string())?;
    Ok(())
}

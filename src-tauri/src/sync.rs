use crate::db;
use crate::events::{
    emit_threads_updated, OutboxFailed, OutboxSettled, PrUpdated, CACHE_PR_UPDATED, OUTBOX_FAILED,
    OUTBOX_SETTLED,
};
use crate::github::{
    dispatch_delete_comment, dispatch_post_comment, dispatch_reply, dispatch_resolve,
    fetch_pr_network, fetch_pr_signature, fetch_threads_graphql, store_threads_response, AppState,
};
use chrono::Utc;
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
/// changes. Every tick runs a cheap signature probe (see
/// `github::fetch_pr_signature`) that detects comments, replies, deletes,
/// resolves, and pushes; the expensive paginated thread fetch only runs when
/// the signature actually changed.
pub fn spawn_poll_loop(app: AppHandle, poll: Arc<PollState>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let (repo, number, focused) = {
                let a = poll.active.read().await;
                let f = *poll.focused.read().await;
                (a.repo.clone(), a.number, f)
            };

            if let (Some(repo), Some(number)) = (repo.as_ref(), number) {
                if let Err(e) = poll_once(&app, repo, number, false).await {
                    eprintln!("poll error: {e}");
                }
            }

            // 5s focused keeps two reviewers sitting side by side within one
            // beat of each other; affordable because the per-tick probe is a
            // single ~2-3 rate-limit-point GraphQL request.
            let delay = if focused { 5 } else { 60 };
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
    let client = state.ensure().await.map_err(|e| e.to_string())?;
    let octo = &client.octo;
    let pool = state
        .db
        .get()
        .ok_or_else(|| "db pool not initialized".to_string())?;

    // Cheap probe: one signature request that sees comments, replies,
    // deletes, resolves, and pushes. Skip the full paginated fetch when the
    // signature matches what the last full fetch stored.
    if !force_full {
        match fetch_pr_signature(octo, repo, number).await {
            Ok(sig) => {
                let prev_sig = db::get_threads_sig(pool, repo, number as i64)
                    .ok()
                    .flatten();
                if prev_sig.as_deref() == Some(sig.as_str()) {
                    sync_log!(
                        "POLL",
                        "skip_unchanged repo={repo} pr=#{number} sig={sig} elapsed_ms={}",
                        started.elapsed().as_millis()
                    );
                    return Ok(());
                }
                let reason = if prev_sig.is_none() {
                    "no_cache_baseline"
                } else {
                    "signature_changed"
                };
                sync_log!("POLL", "full_fetch repo={repo} pr=#{number} reason={reason}");
            }
            Err(e) => {
                sync_log!(
                    "POLL",
                    "probe_failed repo={repo} pr=#{number} falling_back_to_full error={e}"
                );
            }
        }
    } else {
        sync_log!("POLL", "full_fetch repo={repo} pr=#{number} reason=forced");
    }

    let response = fetch_threads_graphql(octo, repo, number)
        .await
        .map_err(|e| e.to_string())?;
    let thread_count =
        store_threads_response(pool, repo, number, &response).map_err(|e| e.to_string())?;

    emit_threads_updated(app, repo, number);

    // PR detail (title, file list, head SHA) only needs its two REST calls
    // when the head moved (commits pushed - the frontend must re-render file
    // content or threads on the new commit show as STALE) or when there's no
    // cached detail yet. Comment/resolve traffic never touches it.
    let new_head = response
        .pointer("/data/repository/pullRequest/headRefOid")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let prev_head = db::get_pr_cached(pool, repo, number as i64)
        .ok()
        .flatten()
        .and_then(|v| {
            v.get("headRefOid")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        });
    let head_moved = !new_head.is_empty() && prev_head.as_deref() != Some(new_head.as_str());
    if head_moved || prev_head.is_none() {
        match fetch_pr_network(octo, repo, number).await {
            Ok(pr) => {
                let _ = db::put_pr(pool, repo, number as i64, &pr);
                let fetched_head = pr
                    .get("headRefOid")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string();
                if !fetched_head.is_empty() && prev_head.as_deref() != Some(fetched_head.as_str())
                {
                    let _ = app.emit(
                        CACHE_PR_UPDATED,
                        PrUpdated {
                            repo: repo.to_string(),
                            number,
                            head_ref_oid: fetched_head,
                        },
                    );
                }
            }
            Err(e) => {
                sync_log!("POLL", "refresh_pr failed repo={repo} pr=#{number} error={e}");
            }
        }
    }
    sync_log!(
        "POLL",
        "end repo={repo} pr=#{number} threads={thread_count} elapsed_ms={}",
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
    let client = state.ensure().await.map_err(|e| e.to_string())?;
    let octo = &client.octo;

    match op.kind.as_str() {
        "resolve" | "unresolve" => {
            let thread_key = op
                .payload
                .get("threadId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing threadId".to_string())?;
            // The payload holds the thread's client_key; translate to the
            // GraphQL id at dispatch time so a resolve queued while the post
            // was still unconfirmed picks up the id once promotion fills it
            // in. A payload value with no matching row is a legacy op that
            // stored the GraphQL id directly - use it as-is.
            let pool = state
                .db
                .get()
                .ok_or_else(|| "db pool not initialized".to_string())?;
            let github_id = match db::get_thread_github_id(pool, thread_key)
                .map_err(|e| e.to_string())?
            {
                Some(Some(gid)) => gid,
                Some(None) => {
                    return Err("thread not yet confirmed on GitHub; retrying".to_string())
                }
                None => thread_key.to_string(),
            };
            let resolved = op.kind == "resolve";
            dispatch_resolve(octo, &github_id, resolved)
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
            // `line` is absent for a file-level comment (selection outside the
            // PR diff); dispatch_post_comment switches on that.
            let line = op.payload.get("line").and_then(|v| v.as_u64());
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
    match op.kind.as_str() {
        "resolve" | "unresolve" => {
            if let Some(thread_id) = op.payload.get("threadId").and_then(|v| v.as_str()) {
                let _ = db::clear_pending_op(pool, thread_id, &op.id);
                if let Ok(Some((repo, number))) = db::get_thread_pr(pool, thread_id) {
                    emit_threads_updated(app, &repo, number as u64);
                }
            }
        }
        "delete_comment" => {
            if let Ok(Some((repo, number))) = db::finalize_delete_comment(pool, &op.id) {
                emit_threads_updated(app, &repo, number as u64);
            }
        }
        "post_comment" | "reply" => {
            let finalized = if op.kind == "post_comment" {
                db::finalize_post_comment(pool, &op.id)
            } else {
                db::finalize_reply(pool, &op.id)
            };
            if let Ok(Some((repo, number))) = finalized {
                // Trigger immediate refresh so the local row gets promoted to
                // the canonical server one (correct node id, real comments).
                force_refresh_threads(app, &repo, number as u64).await;
                emit_threads_updated(app, &repo, number as u64);
            }
        }
        _ => {}
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
            "give_up id={} kind={} attempts={attempts} error={err}",
            op.id,
            op.kind
        );
        db::mark_outbox_failed(pool, &op.id, err).map_err(|e| e.to_string())?;
        // Revert the optimistic effect for this op. For post_comment and
        // reply the rows are NOT deleted - they're re-tagged failed:<op-id>
        // so the UI shows a failed card with Retry/Discard instead of
        // silently losing the user's comment text.
        let reverted = match op.kind.as_str() {
            "resolve" | "unresolve" => {
                op.payload
                    .get("threadId")
                    .and_then(|v| v.as_str())
                    .and_then(|thread_id| {
                        let prior = op
                            .payload
                            .get("priorResolved")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        db::revert_optimistic_resolve(pool, thread_id, prior, &op.id)
                            .ok()
                            .flatten()
                    })
            }
            "delete_comment" => db::revert_optimistic_delete_comment(pool, &op.id).ok().flatten(),
            "post_comment" => db::mark_optimistic_post_failed(pool, &op.id).ok().flatten(),
            "reply" => db::mark_optimistic_reply_failed(pool, &op.id).ok().flatten(),
            _ => None,
        };
        if let Some((repo, number)) = reverted {
            emit_threads_updated(app, &repo, number as u64);
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

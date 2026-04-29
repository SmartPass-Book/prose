mod db;
mod events;
mod github;
mod sync;

use github::{fetch_scopes, missing_scopes, AppState};
use std::sync::Arc;
use sync::{ActivePr, OutboxState, PollState};
use tauri::{
    menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    Emitter, Manager,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[tauri::command]
async fn mutate_post_comment(
    repo: String,
    number: u64,
    commit_id: String,
    path: String,
    line: u64,
    start_line: Option<u64>,
    body: String,
    state: tauri::State<'_, AppState>,
    outbox: tauri::State<'_, Arc<OutboxState>>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let pool = state
        .db
        .get()
        .ok_or_else(|| "cache not available".to_string())?;
    // Resolve current user for the optimistic comment author.
    let author = {
        let guard = state.ensure().await.map_err(|e| e.to_string())?;
        guard.as_ref().unwrap().user.clone()
    };
    let payload = serde_json::json!({
        "repo": repo,
        "number": number,
        "commitId": commit_id,
        "path": path,
        "line": line,
        "startLine": start_line,
        "body": body,
    });
    let op_id = db::enqueue_outbox(pool, "post_comment", &payload).map_err(|e| e.to_string())?;
    let _ = db::apply_optimistic_post_comment(
        pool,
        &repo,
        number as i64,
        &path,
        line as i64,
        start_line.map(|v| v as i64),
        &body,
        &author,
        &op_id,
    )
    .map_err(|e| e.to_string())?;
    let _ = app.emit(
        events::CACHE_THREADS_UPDATED,
        events::ThreadsUpdated { repo, number },
    );
    outbox.notify.notify_one();
    Ok(op_id)
}

#[tauri::command]
async fn mutate_reply(
    thread_id: String,
    repo: String,
    number: u64,
    in_reply_to: u64,
    body: String,
    state: tauri::State<'_, AppState>,
    outbox: tauri::State<'_, Arc<OutboxState>>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let pool = state
        .db
        .get()
        .ok_or_else(|| "cache not available".to_string())?;
    let author = {
        let guard = state.ensure().await.map_err(|e| e.to_string())?;
        guard.as_ref().unwrap().user.clone()
    };
    let payload = serde_json::json!({
        "repo": repo,
        "number": number,
        "inReplyTo": in_reply_to,
        "body": body,
    });
    let op_id = db::enqueue_outbox(pool, "reply", &payload).map_err(|e| e.to_string())?;
    if let Some((_, repo_evt, num)) =
        db::apply_optimistic_reply(pool, &thread_id, &body, &author, &op_id)
            .map_err(|e| e.to_string())?
    {
        let _ = app.emit(
            events::CACHE_THREADS_UPDATED,
            events::ThreadsUpdated {
                repo: repo_evt,
                number: num as u64,
            },
        );
    }
    outbox.notify.notify_one();
    Ok(op_id)
}

#[tauri::command]
async fn mutate_delete_comment(
    repo: String,
    comment_id: u64,
    state: tauri::State<'_, AppState>,
    outbox: tauri::State<'_, Arc<OutboxState>>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let pool = state
        .db
        .get()
        .ok_or_else(|| "cache not available".to_string())?;
    let payload = serde_json::json!({
        "repo": repo,
        "commentId": comment_id,
    });
    let op_id = db::enqueue_outbox(pool, "delete_comment", &payload).map_err(|e| e.to_string())?;
    if let Some((repo_evt, number)) =
        db::apply_optimistic_delete_comment(pool, comment_id as i64, &op_id)
            .map_err(|e| e.to_string())?
    {
        let _ = app.emit(
            events::CACHE_THREADS_UPDATED,
            events::ThreadsUpdated {
                repo: repo_evt,
                number: number as u64,
            },
        );
    }
    outbox.notify.notify_one();
    Ok(op_id)
}

#[tauri::command]
async fn mutate_resolve(
    thread_id: String,
    resolved: bool,
    state: tauri::State<'_, AppState>,
    outbox: tauri::State<'_, Arc<OutboxState>>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let pool = state
        .db
        .get()
        .ok_or_else(|| "cache not available".to_string())?;
    let prior = db::get_thread_resolved(pool, &thread_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("unknown thread {thread_id}"))?;
    let kind = if resolved { "resolve" } else { "unresolve" };
    let payload = serde_json::json!({
        "threadId": thread_id,
        "resolved": resolved,
        "priorResolved": prior,
    });
    let op_id = db::enqueue_outbox(pool, kind, &payload).map_err(|e| e.to_string())?;
    if let Some((repo, number)) =
        db::apply_optimistic_resolve(pool, &thread_id, resolved, &op_id)
            .map_err(|e| e.to_string())?
    {
        let _ = app.emit(
            events::CACHE_THREADS_UPDATED,
            events::ThreadsUpdated {
                repo,
                number: number as u64,
            },
        );
    }
    outbox.notify.notify_one();
    Ok(op_id)
}

#[tauri::command]
async fn set_active_pr(
    repo: Option<String>,
    number: Option<u64>,
    poll: tauri::State<'_, Arc<PollState>>,
) -> Result<(), String> {
    let mut a = poll.active.write().await;
    *a = ActivePr { repo, number };
    Ok(())
}

#[tauri::command]
async fn set_focus(visible: bool, poll: tauri::State<'_, Arc<PollState>>) -> Result<(), String> {
    let mut f = poll.focused.write().await;
    *f = visible;
    Ok(())
}

#[tauri::command]
async fn force_refresh(
    repo: String,
    number: u64,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let guard = state.ensure().await.map_err(|e| e.to_string())?;
    let octo = &guard.as_ref().unwrap().octo;
    let response = github::fetch_threads_graphql(octo, &repo, number)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(pool) = state.db.get() {
        let nodes: Vec<serde_json::Value> = response
            .pointer("/data/repository/pullRequest/reviewThreads/nodes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        db::replace_threads(pool, &repo, number as i64, &nodes).map_err(|e| e.to_string())?;
        let _ = tauri::Emitter::emit(
            &app,
            events::CACHE_THREADS_UPDATED,
            events::ThreadsUpdated { repo, number },
        );
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .menu(|app| {
            let about = AboutMetadataBuilder::new()
                .name(Some("Prose"))
                .version(Some(app.package_info().version.to_string()))
                .build();
            let check_updates = MenuItemBuilder::with_id("check_for_updates", "Check for Updates...")
                .build(app)?;
            let app_menu = SubmenuBuilder::new(app, "Prose")
                .about(Some(about))
                .item(&check_updates)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let view_menu = SubmenuBuilder::new(app, "View").fullscreen().build()?;
            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .separator()
                .close_window()
                .build()?;
            MenuBuilder::new(app)
                .items(&[&app_menu, &edit_menu, &view_menu, &window_menu])
                .build()
        })
        .on_menu_event(|app, event| {
            if event.id() == "check_for_updates" {
                let _ = app.emit("menu://check-for-updates", ());
            }
        })
        .manage(AppState::default())
        .manage(PollState::new())
        .manage(OutboxState::new())
        .setup(|app| {
            // Initialize SQLite cache. If this fails the app keeps working (cache is
            // an optimization layer, not a hard dependency yet); we just log.
            match app
                .path()
                .app_data_dir()
                .map_err(|e| format!("app_data_dir: {e}"))
                .and_then(|d| {
                    db::init(&d.join("cache.sqlite")).map_err(|e| format!("db init: {e}"))
                }) {
                Ok(pool) => {
                    let state: tauri::State<'_, AppState> = app.state();
                    if state.db.set(pool).is_err() {
                        eprintln!("db pool already set");
                    }
                }
                Err(e) => {
                    eprintln!("cache init failed (continuing without cache): {e}");
                }
            }

            // Background poll loop. Activates whenever a PR is set via
            // set_active_pr; idles otherwise.
            {
                let poll: tauri::State<'_, Arc<PollState>> = app.state();
                sync::spawn_poll_loop(app.handle().clone(), poll.inner().clone());
            }
            // Outbox worker. Drains pending mutations against GitHub.
            {
                let outbox: tauri::State<'_, Arc<OutboxState>> = app.state();
                sync::spawn_outbox_loop(app.handle().clone(), outbox.inner().clone());
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Pre-warm the client; if it fails we don't crash, the dialog informs the user.
                let state: tauri::State<'_, AppState> = handle.state();
                let init = state.ensure().await;
                match init {
                    Ok(_) => {
                        // Check scopes
                        match fetch_scopes() {
                            Ok(scopes) => {
                                let missing = missing_scopes(&scopes);
                                if !missing.is_empty() {
                                    let scopes_str = missing.join(",");
                                    let msg = format!(
                                        "Prose needs the following GitHub scope(s): {}\n\nRun this in a terminal and restart the app:\n\n  gh auth refresh -s {}",
                                        scopes_str, scopes_str
                                    );
                                    handle
                                        .dialog()
                                        .message(msg)
                                        .title("Missing GitHub scopes")
                                        .kind(MessageDialogKind::Warning)
                                        .buttons(MessageDialogButtons::Ok)
                                        .show(|_| {});
                                }
                            }
                            Err(e) => {
                                eprintln!("scope check failed: {e}");
                            }
                        }
                    }
                    Err(e) => {
                        let msg = format!(
                            "Couldn't authenticate with GitHub.\n\nMake sure the gh CLI is installed and signed in:\n\n  gh auth login\n\nDetails: {e}"
                        );
                        handle
                            .dialog()
                            .message(msg)
                            .title("Authentication failed")
                            .kind(MessageDialogKind::Error)
                            .buttons(MessageDialogButtons::Ok)
                            .show(|_| {});
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            github::get_gh_token,
            github::get_current_user,
            github::list_prs,
            github::get_pr,
            github::get_file_content,
            github::get_review_threads,
            github::post_review_comment,
            github::reply_to_comment,
            github::delete_comment,
            github::resolve_thread,
            github::refresh_prs,
            github::refresh_pr,
            set_active_pr,
            set_focus,
            force_refresh,
            mutate_resolve,
            mutate_delete_comment,
            mutate_post_comment,
            mutate_reply,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

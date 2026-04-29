use octocrab::Octocrab;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;
use tauri::State;
use thiserror::Error;
use tokio::sync::Mutex;

/// Locate the `gh` binary. GUI apps launched from Finder don't inherit the
/// user's shell PATH, so `Command::new("gh")` fails even when gh is installed
/// via Homebrew. Search common install locations explicitly.
fn gh_command() -> Command {
    const CANDIDATES: &[&str] = &[
        "/opt/homebrew/bin/gh", // Apple Silicon Homebrew
        "/usr/local/bin/gh",    // Intel Homebrew
        "/usr/bin/gh",
        "/home/linuxbrew/.linuxbrew/bin/gh",
    ];
    for c in CANDIDATES {
        if PathBuf::from(c).exists() {
            return Command::new(c);
        }
    }
    Command::new("gh")
}

#[derive(Debug, Error)]
pub enum GhError {
    #[error("not authenticated with gh CLI: {0}")]
    NotAuthed(String),
    #[error("octocrab: {0}")]
    Octocrab(#[from] octocrab::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for GhError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub const REQUIRED_SCOPES: &[&str] = &["repo"];

pub fn fetch_token() -> Result<String, GhError> {
    let out = gh_command().args(["auth", "token"]).output()?;
    if !out.status.success() {
        return Err(GhError::NotAuthed(
            String::from_utf8_lossy(&out.stderr).into(),
        ));
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if token.is_empty() {
        return Err(GhError::NotAuthed("empty token".into()));
    }
    Ok(token)
}

pub fn fetch_scopes() -> Result<Vec<String>, GhError> {
    let out = gh_command().args(["auth", "status"]).output()?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let combined = format!("{stdout}\n{stderr}");
    for line in combined.lines() {
        let trimmed = line.trim();
        let rest = trimmed
            .strip_prefix("- Token scopes:")
            .or_else(|| trimmed.strip_prefix("Token scopes:"));
        if let Some(rest) = rest {
            return Ok(rest
                .split(',')
                .map(|s| s.trim().trim_matches('\'').trim_matches('"').to_string())
                .filter(|s| !s.is_empty())
                .collect());
        }
    }
    Ok(vec![])
}

pub fn missing_scopes(have: &[String]) -> Vec<&'static str> {
    REQUIRED_SCOPES
        .iter()
        .copied()
        .filter(|req| !have.iter().any(|s| s == req))
        .collect()
}

pub struct Client {
    pub octo: Octocrab,
    pub user: String,
}

impl Client {
    pub async fn new() -> Result<Self, GhError> {
        let token = fetch_token()?;
        let octo = Octocrab::builder().personal_token(token).build()?;
        let user = octo.current().user().await?.login;
        Ok(Self { octo, user })
    }
}

pub struct AppState {
    pub client: Mutex<Option<Client>>,
    pub db: std::sync::OnceLock<crate::db::DbPool>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            client: Mutex::new(None),
            db: std::sync::OnceLock::new(),
        }
    }
}

impl AppState {
    pub async fn ensure(&self) -> Result<tokio::sync::MutexGuard<'_, Option<Client>>, GhError> {
        let mut guard = self.client.lock().await;
        if guard.is_none() {
            *guard = Some(Client::new().await?);
        }
        Ok(guard)
    }
}

fn split_repo(repo: &str) -> Result<(&str, &str), GhError> {
    repo.split_once('/')
        .ok_or_else(|| GhError::Other("repo must be owner/name".into()))
}

// ---- Tauri commands -----------------------------------------------------

#[tauri::command]
pub async fn get_current_user(state: State<'_, AppState>) -> Result<String, GhError> {
    let guard = state.ensure().await?;
    Ok(guard.as_ref().unwrap().user.clone())
}

async fn fetch_prs_network(octo: &octocrab::Octocrab, repo: &str) -> Result<Value, GhError> {
    let (owner, name) = split_repo(repo)?;
    let page = octo
        .pulls(owner, name)
        .list()
        .state(octocrab::params::State::Open)
        .per_page(100)
        .send()
        .await?;
    let items: Vec<Value> = page
        .items
        .into_iter()
        .map(|pr| {
            json!({
                "number": pr.number,
                "title": pr.title.unwrap_or_default(),
                "headRefName": pr.head.ref_field,
                "baseRefName": pr.base.ref_field,
                "updatedAt": pr.updated_at,
                "author": { "login": pr.user.map(|u| u.login).unwrap_or_default() },
                "isDraft": pr.draft.unwrap_or(false),
            })
        })
        .collect();
    Ok(Value::Array(items))
}

#[tauri::command]
pub async fn list_prs(repo: String, state: State<'_, AppState>) -> Result<Value, GhError> {
    if let Some(pool) = state.db.get() {
        if let Ok(Some(v)) = crate::db::get_pr_list_cached(pool, &repo) {
            return Ok(v);
        }
    }
    let guard = state.ensure().await?;
    let octo = &guard.as_ref().unwrap().octo;
    let value = fetch_prs_network(octo, &repo).await?;
    if let Some(pool) = state.db.get() {
        let _ = crate::db::put_pr_list(pool, &repo, &value);
    }
    Ok(value)
}

#[tauri::command]
pub async fn refresh_prs(repo: String, state: State<'_, AppState>) -> Result<Value, GhError> {
    let guard = state.ensure().await?;
    let octo = &guard.as_ref().unwrap().octo;
    let value = fetch_prs_network(octo, &repo).await?;
    if let Some(pool) = state.db.get() {
        let _ = crate::db::put_pr_list(pool, &repo, &value);
    }
    Ok(value)
}

#[tauri::command]
pub async fn refresh_pr(
    repo: String,
    number: u64,
    state: State<'_, AppState>,
) -> Result<Value, GhError> {
    let guard = state.ensure().await?;
    let octo = &guard.as_ref().unwrap().octo;
    let value = fetch_pr_network(octo, &repo, number).await?;
    if let Some(pool) = state.db.get() {
        let _ = crate::db::put_pr(pool, &repo, number as i64, &value);
    }
    Ok(value)
}

async fn fetch_pr_network(
    octo: &octocrab::Octocrab,
    repo: &str,
    number: u64,
) -> Result<Value, GhError> {
    let (owner, name) = split_repo(repo)?;
    let pr = octo.pulls(owner, name).get(number).await?;
    let files_path = format!("/repos/{owner}/{name}/pulls/{number}/files?per_page=100");
    let files_raw: Value = octo.get(&files_path, None::<&()>).await?;
    let files = match &files_raw {
        Value::Array(arr) => arr
            .iter()
            .map(|f| {
                json!({
                    "path": f.get("filename").and_then(|v| v.as_str()).unwrap_or_default(),
                    "additions": f.get("additions").and_then(|v| v.as_u64()).unwrap_or(0),
                    "deletions": f.get("deletions").and_then(|v| v.as_u64()).unwrap_or(0),
                })
            })
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    Ok(json!({
        "number": pr.number,
        "title": pr.title.unwrap_or_default(),
        "body": pr.body.unwrap_or_default(),
        "headRefName": pr.head.ref_field,
        "baseRefName": pr.base.ref_field,
        "headRefOid": pr.head.sha,
        "baseRefOid": pr.base.sha,
        "state": format!("{:?}", pr.state.unwrap_or(octocrab::models::IssueState::Open)).to_uppercase(),
        "url": pr.html_url.map(|u| u.to_string()).unwrap_or_default(),
        "author": { "login": pr.user.map(|u| u.login).unwrap_or_default() },
        "updatedAt": pr.updated_at,
        "files": files,
    }))
}

#[tauri::command]
pub async fn get_pr(
    repo: String,
    number: u64,
    state: State<'_, AppState>,
) -> Result<Value, GhError> {
    if let Some(pool) = state.db.get() {
        if let Ok(Some(v)) = crate::db::get_pr_cached(pool, &repo, number as i64) {
            return Ok(v);
        }
    }
    let guard = state.ensure().await?;
    let octo = &guard.as_ref().unwrap().octo;
    let value = fetch_pr_network(octo, &repo, number).await?;
    if let Some(pool) = state.db.get() {
        let _ = crate::db::put_pr(pool, &repo, number as i64, &value);
    }
    Ok(value)
}

#[tauri::command]
pub async fn get_file_content(
    repo: String,
    git_ref: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<String, GhError> {
    // File contents at a given ref are immutable, so cache forever per (repo, ref, path).
    if let Some(pool) = state.db.get() {
        if let Ok(Some(content)) = crate::db::get_file_cached(pool, &repo, &git_ref, &path) {
            return Ok(content);
        }
    }
    let guard = state.ensure().await?;
    let octo = &guard.as_ref().unwrap().octo;
    let (owner, name) = split_repo(&repo)?;
    let mut content_items = octo
        .repos(owner, name)
        .get_content()
        .path(&path)
        .r#ref(&git_ref)
        .send()
        .await?;
    let item = content_items
        .items
        .pop()
        .ok_or_else(|| GhError::Other(format!("no content for {path}")))?;
    let content = item
        .decoded_content()
        .ok_or_else(|| GhError::Other(format!("could not decode content for {path}")))?;
    if let Some(pool) = state.db.get() {
        let _ = crate::db::put_file(pool, &repo, &git_ref, &path, &content);
    }
    Ok(content)
}

/// Fetch review threads via GraphQL. Returns the full envelope shape
/// `{data: {repository: {pullRequest: {reviewThreads: {nodes: [...]}}}}}`,
/// matching what the frontend expects.
pub async fn fetch_threads_graphql(
    octo: &octocrab::Octocrab,
    repo: &str,
    number: u64,
) -> Result<Value, GhError> {
    let (owner, name) = split_repo(repo)?;
    let query = format!(
        r#"query {{
          repository(owner: "{owner}", name: "{name}") {{
            pullRequest(number: {number}) {{
              reviewThreads(first: 100) {{
                nodes {{
                  id
                  isResolved
                  isOutdated
                  path
                  line
                  startLine
                  originalLine
                  diffSide
                  comments(first: 50) {{
                    nodes {{
                      id
                      databaseId
                      body
                      author {{ login }}
                      createdAt
                      url
                    }}
                  }}
                }}
              }}
            }}
          }}
        }}"#
    );
    let body = json!({ "query": query });
    let inner: Value = octo.graphql(&body).await?;
    Ok(json!({ "data": inner }))
}

#[tauri::command]
pub async fn get_review_threads(
    repo: String,
    number: u64,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Value, GhError> {
    // Cache-first: if we have any cached threads for this PR, return them
    // immediately. Otherwise fall through to a synchronous network fetch
    // (and populate the cache so subsequent calls are instant).
    if let Some(pool) = state.db.get() {
        match crate::db::count_threads(pool, &repo, number as i64) {
            Ok(n) if n > 0 => {
                return crate::db::get_threads(pool, &repo, number as i64)
                    .map_err(|e| GhError::Other(e.to_string()));
            }
            Ok(_) => { /* empty cache: fall through */ }
            Err(e) => eprintln!("cache count failed, falling through: {e}"),
        }
    }

    let guard = state.ensure().await?;
    let octo = &guard.as_ref().unwrap().octo;
    let response = fetch_threads_graphql(octo, &repo, number).await?;
    if let Some(pool) = state.db.get() {
        let nodes: Vec<Value> = response
            .pointer("/data/repository/pullRequest/reviewThreads/nodes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        if let Err(e) = crate::db::replace_threads(pool, &repo, number as i64, &nodes) {
            eprintln!("cache write failed: {e}");
        }
        // Notify any listeners that the cache changed. Best-effort; ignore
        // emit errors (window may not be ready yet).
        let _ = tauri::Emitter::emit(
            &app,
            crate::events::CACHE_THREADS_UPDATED,
            crate::events::ThreadsUpdated {
                repo: repo.clone(),
                number,
            },
        );
    }
    Ok(response)
}

pub async fn dispatch_post_comment(
    octo: &octocrab::Octocrab,
    repo: &str,
    number: u64,
    commit_id: &str,
    path: &str,
    line: u64,
    start_line: Option<u64>,
    body: &str,
) -> Result<Value, GhError> {
    let (owner, name) = split_repo(repo)?;
    let mut payload = json!({
        "body": body,
        "commit_id": commit_id,
        "path": path,
        "line": line,
        "side": "RIGHT",
    });
    if let Some(sl) = start_line {
        if sl != line {
            payload["start_line"] = json!(sl);
            payload["start_side"] = json!("RIGHT");
        }
    }
    let endpoint = format!("/repos/{owner}/{name}/pulls/{number}/comments");
    let res: Value = octo.post(&endpoint, Some(&payload)).await?;
    Ok(res)
}

pub async fn dispatch_reply(
    octo: &octocrab::Octocrab,
    repo: &str,
    number: u64,
    in_reply_to: u64,
    body: &str,
) -> Result<Value, GhError> {
    let (owner, name) = split_repo(repo)?;
    let payload = json!({ "body": body, "in_reply_to": in_reply_to });
    let endpoint = format!("/repos/{owner}/{name}/pulls/{number}/comments");
    let res: Value = octo.post(&endpoint, Some(&payload)).await?;
    Ok(res)
}

#[tauri::command]
pub async fn post_review_comment(
    repo: String,
    number: u64,
    commit_id: String,
    path: String,
    line: u64,
    start_line: Option<u64>,
    body: String,
    state: State<'_, AppState>,
) -> Result<Value, GhError> {
    let guard = state.ensure().await?;
    let octo = &guard.as_ref().unwrap().octo;
    dispatch_post_comment(octo, &repo, number, &commit_id, &path, line, start_line, &body).await
}

#[tauri::command]
pub async fn reply_to_comment(
    repo: String,
    number: u64,
    in_reply_to: u64,
    body: String,
    state: State<'_, AppState>,
) -> Result<Value, GhError> {
    let guard = state.ensure().await?;
    let octo = &guard.as_ref().unwrap().octo;
    dispatch_reply(octo, &repo, number, in_reply_to, &body).await
}

/// Free function: DELETE the review comment via REST.
pub async fn dispatch_delete_comment(
    octo: &octocrab::Octocrab,
    repo: &str,
    comment_id: u64,
) -> Result<(), GhError> {
    let (owner, name) = split_repo(repo)?;
    let endpoint = format!("/repos/{owner}/{name}/pulls/comments/{comment_id}");
    match octo._delete(&endpoint, None::<&()>).await {
        Ok(_) => Ok(()),
        Err(octocrab::Error::GitHub { source, .. }) if source.status_code.as_u16() == 404 => {
            // Already deleted server-side: treat as success.
            Ok(())
        }
        Err(e) => Err(GhError::Octocrab(e)),
    }
}

#[tauri::command]
pub async fn delete_comment(
    repo: String,
    comment_id: u64,
    state: State<'_, AppState>,
) -> Result<(), GhError> {
    let guard = state.ensure().await?;
    let octo = &guard.as_ref().unwrap().octo;
    dispatch_delete_comment(octo, &repo, comment_id).await
}

/// Free function that issues the GraphQL mutation. Used by the outbox worker.
pub async fn dispatch_resolve(
    octo: &octocrab::Octocrab,
    thread_id: &str,
    resolved: bool,
) -> Result<Value, GhError> {
    let mutation = if resolved {
        "resolveReviewThread"
    } else {
        "unresolveReviewThread"
    };
    let query = format!(
        r#"mutation {{ {mutation}(input: {{ threadId: "{thread_id}" }}) {{ thread {{ id isResolved }} }} }}"#
    );
    let body = json!({ "query": query });
    let response: Value = octo.graphql(&body).await?;
    Ok(json!({ "data": response }))
}

#[tauri::command]
pub async fn resolve_thread(
    thread_id: String,
    resolved: bool,
    state: State<'_, AppState>,
) -> Result<Value, GhError> {
    let guard = state.ensure().await?;
    let octo = &guard.as_ref().unwrap().octo;
    dispatch_resolve(octo, &thread_id, resolved).await
}

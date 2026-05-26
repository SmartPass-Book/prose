use octocrab::Octocrab;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;
use std::time::Instant;
use tauri::State;
use thiserror::Error;
use tokio::sync::Mutex;

/// Lightweight tagged logger so all GitHub API traffic is greppable in
/// console / Console.app output. Format:
///   [gh] {tag} {msg}
macro_rules! gh_log {
    ($tag:expr, $($arg:tt)*) => {{
        let __line = format!("[gh] {} {}", $tag, format!($($arg)*));
        eprintln!("{}", __line);
        $crate::logging::forward(&__line);
    }};
}

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

/// Percent-encode each `/`-delimited segment of a repo file path so it can be
/// safely substituted into a GitHub Contents API URL. Slashes are preserved.
fn encode_path_segments(path: &str) -> String {
    path.split('/')
        .map(|seg| {
            let mut out = String::with_capacity(seg.len());
            for b in seg.bytes() {
                match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                        out.push(b as char);
                    }
                    _ => out.push_str(&format!("%{:02X}", b)),
                }
            }
            out
        })
        .collect::<Vec<_>>()
        .join("/")
}

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
    gh_log!("READ", "list_prs repo={repo}");
    let started = Instant::now();
    let page = match octo
        .pulls(owner, name)
        .list()
        .state(octocrab::params::State::Open)
        .per_page(100)
        .send()
        .await
    {
        Ok(p) => {
            gh_log!(
                "READ",
                "list_prs repo={repo} ok count={} elapsed_ms={}",
                p.items.len(),
                started.elapsed().as_millis()
            );
            p
        }
        Err(e) => {
            gh_log!(
                "READ",
                "list_prs repo={repo} err elapsed_ms={} error={e}",
                started.elapsed().as_millis()
            );
            return Err(e.into());
        }
    };
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
            gh_log!("CACHE", "list_prs repo={repo} hit");
            return Ok(v);
        }
    }
    gh_log!("CACHE", "list_prs repo={repo} miss");
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
    gh_log!("READ", "refresh_prs repo={repo}");
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
    gh_log!("READ", "refresh_pr repo={repo} pr=#{number}");
    let guard = state.ensure().await?;
    let octo = &guard.as_ref().unwrap().octo;
    let value = fetch_pr_network(octo, &repo, number).await?;
    if let Some(pool) = state.db.get() {
        let _ = crate::db::put_pr(pool, &repo, number as i64, &value);
    }
    Ok(value)
}

pub async fn fetch_pr_network(
    octo: &octocrab::Octocrab,
    repo: &str,
    number: u64,
) -> Result<Value, GhError> {
    let (owner, name) = split_repo(repo)?;
    gh_log!("READ", "fetch_pr repo={repo} pr=#{number}");
    let started = Instant::now();
    let pr = match octo.pulls(owner, name).get(number).await {
        Ok(v) => v,
        Err(e) => {
            gh_log!(
                "READ",
                "fetch_pr repo={repo} pr=#{number} err elapsed_ms={} error={e}",
                started.elapsed().as_millis()
            );
            return Err(e.into());
        }
    };
    let files_path = format!("/repos/{owner}/{name}/pulls/{number}/files?per_page=100");
    gh_log!("READ", "fetch_pr_files repo={repo} pr=#{number}");
    let files_started = Instant::now();
    let files_raw: Value = match octo.get(&files_path, None::<&()>).await {
        Ok(v) => {
            gh_log!(
                "READ",
                "fetch_pr_files repo={repo} pr=#{number} ok elapsed_ms={}",
                files_started.elapsed().as_millis()
            );
            v
        }
        Err(e) => {
            gh_log!(
                "READ",
                "fetch_pr_files repo={repo} pr=#{number} err elapsed_ms={} error={e}",
                files_started.elapsed().as_millis()
            );
            return Err(e.into());
        }
    };
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
    let files_count = files.len();
    let result = json!({
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
    });
    gh_log!(
        "READ",
        "fetch_pr repo={repo} pr=#{number} ok files={} elapsed_ms={}",
        files_count,
        started.elapsed().as_millis()
    );
    Ok(result)
}

#[tauri::command]
pub async fn get_pr(
    repo: String,
    number: u64,
    state: State<'_, AppState>,
) -> Result<Value, GhError> {
    if let Some(pool) = state.db.get() {
        if let Ok(Some(v)) = crate::db::get_pr_cached(pool, &repo, number as i64) {
            gh_log!("CACHE", "get_pr repo={repo} pr=#{number} hit");
            return Ok(v);
        }
    }
    gh_log!("CACHE", "get_pr repo={repo} pr=#{number} miss");
    let guard = state.ensure().await?;
    let octo = &guard.as_ref().unwrap().octo;
    let value = fetch_pr_network(octo, &repo, number).await?;
    if let Some(pool) = state.db.get() {
        let _ = crate::db::put_pr(pool, &repo, number as i64, &value);
    }
    Ok(value)
}

/// Returns the ISO-8601 timestamp at which the PR detail was last fetched
/// from GitHub and written to the local cache. None if there's no cached
/// row yet.
#[tauri::command]
pub async fn get_pr_fetched_at(
    repo: String,
    number: u64,
    state: State<'_, AppState>,
) -> Result<Option<String>, GhError> {
    if let Some(pool) = state.db.get() {
        return crate::db::get_pr_fetched_at(pool, &repo, number as i64)
            .map_err(|e| GhError::Other(e.to_string()));
    }
    Ok(None)
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
            gh_log!("CACHE", "get_file_content repo={repo} ref={git_ref} path={path} hit");
            return Ok(content);
        }
    }
    gh_log!("CACHE", "get_file_content repo={repo} ref={git_ref} path={path} miss");
    let guard = state.ensure().await?;
    let octo = &guard.as_ref().unwrap().octo;
    let (owner, name) = split_repo(&repo)?;
    gh_log!("READ", "fetch_file repo={repo} ref={git_ref} path={path}");
    let started = Instant::now();
    // octocrab's `get_content().path()` interpolates the path verbatim into
    // the URL, so spaces or other reserved characters produce an invalid
    // `http::Uri`. Pre-encode each segment.
    let encoded_path = encode_path_segments(&path);
    let mut content_items = match octo
        .repos(owner, name)
        .get_content()
        .path(&encoded_path)
        .r#ref(&git_ref)
        .send()
        .await
    {
        Ok(c) => c,
        Err(e) => {
            gh_log!(
                "READ",
                "fetch_file repo={repo} ref={git_ref} path={path} err elapsed_ms={} error={e}",
                started.elapsed().as_millis()
            );
            return Err(e.into());
        }
    };
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
    gh_log!(
        "READ",
        "fetch_file repo={repo} ref={git_ref} path={path} ok bytes={} elapsed_ms={}",
        content.len(),
        started.elapsed().as_millis()
    );
    Ok(content)
}

/// Cheap probe: just `updatedAt` + `headRefOid` for a PR. Used by the poll
/// loop to decide whether the expensive paginated thread fetch is needed.
/// Note: GitHub does NOT bump `updatedAt` for resolve/unresolveReviewThread
/// (verified empirically), so callers must still occasionally do a full
/// fetch to catch resolution changes from collaborators.
pub async fn fetch_pr_summary(
    octo: &octocrab::Octocrab,
    repo: &str,
    number: u64,
) -> Result<Value, GhError> {
    let (owner, name) = split_repo(repo)?;
    let query = format!(
        r#"query {{
          repository(owner: "{owner}", name: "{name}") {{
            pullRequest(number: {number}) {{
              updatedAt
              headRefOid
            }}
          }}
        }}"#
    );
    let body = json!({ "query": query });
    gh_log!("READ", "fetch_pr_summary repo={repo} pr=#{number}");
    let started = Instant::now();
    let inner: Value = match octo.graphql(&body).await {
        Ok(v) => v,
        Err(e) => {
            gh_log!(
                "READ",
                "fetch_pr_summary repo={repo} pr=#{number} err elapsed_ms={} error={e}",
                started.elapsed().as_millis()
            );
            return Err(e.into());
        }
    };
    let pr = inner
        .pointer("/repository/pullRequest")
        .cloned()
        .unwrap_or(Value::Null);
    gh_log!(
        "READ",
        "fetch_pr_summary repo={repo} pr=#{number} ok elapsed_ms={}",
        started.elapsed().as_millis()
    );
    Ok(pr)
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
    let started = Instant::now();
    let mut all_nodes: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut page = 0usize;
    // Hard cap to avoid runaway loops on pathological PRs. 50 pages * 100
    // threads = 5000 review threads, well above anything realistic.
    const MAX_PAGES: usize = 50;

    loop {
        page += 1;
        if page > MAX_PAGES {
            gh_log!(
                "READ",
                "fetch_threads_graphql repo={repo} pr=#{number} bailout_max_pages pages={page}"
            );
            break;
        }
        let after_clause = match cursor.as_deref() {
            Some(c) => format!(", after: \"{c}\""),
            None => String::new(),
        };
        let query = format!(
            r#"query {{
              repository(owner: "{owner}", name: "{name}") {{
                pullRequest(number: {number}) {{
                  reviewThreads(first: 100{after_clause}) {{
                    pageInfo {{ hasNextPage endCursor }}
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
        gh_log!(
            "READ",
            "fetch_threads_graphql repo={repo} pr=#{number} page={page} cursor={:?}",
            cursor
        );
        let page_started = Instant::now();
        let inner: Value = match octo.graphql(&body).await {
            Ok(v) => v,
            Err(e) => {
                gh_log!(
                    "READ",
                    "fetch_threads_graphql repo={repo} pr=#{number} page={page} err elapsed_ms={} error={e}",
                    page_started.elapsed().as_millis()
                );
                return Err(e.into());
            }
        };
        let nodes: Vec<Value> = inner
            .pointer("/repository/pullRequest/reviewThreads/nodes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let has_next = inner
            .pointer("/repository/pullRequest/reviewThreads/pageInfo/hasNextPage")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let end_cursor = inner
            .pointer("/repository/pullRequest/reviewThreads/pageInfo/endCursor")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        gh_log!(
            "READ",
            "fetch_threads_graphql repo={repo} pr=#{number} page={page} ok n={} has_next={has_next} elapsed_ms={}",
            nodes.len(),
            page_started.elapsed().as_millis()
        );
        all_nodes.extend(nodes);
        if !has_next {
            break;
        }
        match end_cursor {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }

    gh_log!(
        "READ",
        "fetch_threads_graphql repo={repo} pr=#{number} done total_threads={} pages={page} elapsed_ms={}",
        all_nodes.len(),
        started.elapsed().as_millis()
    );
    Ok(json!({
        "data": {
            "repository": {
                "pullRequest": {
                    "reviewThreads": {
                        "nodes": all_nodes
                    }
                }
            }
        }
    }))
}

#[tauri::command]
pub async fn get_review_threads(
    repo: String,
    number: u64,
    state: State<'_, AppState>,
    _app: tauri::AppHandle,
) -> Result<Value, GhError> {
    // Cache-first: if we've ever successfully fetched threads for this PR,
    // serve from cache - even if the cache is empty (a PR with zero
    // threads). Without this, every call to a thread-less PR refetches,
    // and pairing that with the cache:threads-updated event the frontend
    // listens for produces a tight infinite refetch loop.
    if let Some(pool) = state.db.get() {
        match crate::db::threads_ever_fetched(pool, &repo, number as i64) {
            Ok(true) => {
                let n = crate::db::count_threads(pool, &repo, number as i64).unwrap_or(0);
                gh_log!("CACHE", "get_review_threads repo={repo} pr=#{number} hit n={n}");
                return crate::db::get_threads(pool, &repo, number as i64)
                    .map_err(|e| GhError::Other(e.to_string()));
            }
            Ok(false) => {
                gh_log!("CACHE", "get_review_threads repo={repo} pr=#{number} miss");
            }
            Err(e) => eprintln!("[gh] CACHE get_review_threads marker check failed: {e}"),
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
        // Intentionally do NOT emit cache:threads-updated here - the caller
        // already has the freshly-fetched data via the return value, and
        // emitting would prompt the frontend listener to call this command
        // again, looping forever (the cache is now warm but its content
        // hasn't changed from the caller's perspective). The poll loop is
        // the only place that should emit - it's the one whose data the
        // frontend hasn't seen yet.
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
    gh_log!(
        "WRITE",
        "post_comment repo={repo} pr=#{number} path={path} line={line} start_line={:?} body_len={}",
        start_line,
        body.len()
    );
    let started = Instant::now();
    let res: Value = match octo.post(&endpoint, Some(&payload)).await {
        Ok(v) => v,
        Err(e) => {
            gh_log!(
                "WRITE",
                "post_comment repo={repo} pr=#{number} err elapsed_ms={} error={e}",
                started.elapsed().as_millis()
            );
            return Err(e.into());
        }
    };
    gh_log!(
        "WRITE",
        "post_comment repo={repo} pr=#{number} ok comment_id={} elapsed_ms={}",
        res.get("id").and_then(|v| v.as_u64()).unwrap_or(0),
        started.elapsed().as_millis()
    );
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
    gh_log!(
        "WRITE",
        "reply repo={repo} pr=#{number} in_reply_to={in_reply_to} body_len={}",
        body.len()
    );
    let started = Instant::now();
    let res: Value = match octo.post(&endpoint, Some(&payload)).await {
        Ok(v) => v,
        Err(e) => {
            gh_log!(
                "WRITE",
                "reply repo={repo} pr=#{number} err elapsed_ms={} error={e}",
                started.elapsed().as_millis()
            );
            return Err(e.into());
        }
    };
    gh_log!(
        "WRITE",
        "reply repo={repo} pr=#{number} ok comment_id={} elapsed_ms={}",
        res.get("id").and_then(|v| v.as_u64()).unwrap_or(0),
        started.elapsed().as_millis()
    );
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
    gh_log!("WRITE", "delete_comment repo={repo} comment_id={comment_id}");
    let started = Instant::now();
    match octo._delete(&endpoint, None::<&()>).await {
        Ok(_) => {
            gh_log!(
                "WRITE",
                "delete_comment repo={repo} comment_id={comment_id} ok elapsed_ms={}",
                started.elapsed().as_millis()
            );
            Ok(())
        }
        Err(octocrab::Error::GitHub { source, .. }) if source.status_code.as_u16() == 404 => {
            gh_log!(
                "WRITE",
                "delete_comment repo={repo} comment_id={comment_id} 404_treated_as_ok elapsed_ms={}",
                started.elapsed().as_millis()
            );
            Ok(())
        }
        Err(e) => {
            gh_log!(
                "WRITE",
                "delete_comment repo={repo} comment_id={comment_id} err elapsed_ms={} error={e}",
                started.elapsed().as_millis()
            );
            Err(GhError::Octocrab(e))
        }
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
    gh_log!(
        "WRITE",
        "{mutation} thread_id={thread_id}"
    );
    let started = Instant::now();
    let response: Value = match octo.graphql(&body).await {
        Ok(v) => v,
        Err(e) => {
            gh_log!(
                "WRITE",
                "{mutation} thread_id={thread_id} err elapsed_ms={} error={e}",
                started.elapsed().as_millis()
            );
            return Err(e.into());
        }
    };
    gh_log!(
        "WRITE",
        "{mutation} thread_id={thread_id} ok elapsed_ms={}",
        started.elapsed().as_millis()
    );
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

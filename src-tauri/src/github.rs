use octocrab::Octocrab;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;
use std::time::Instant;
use tauri::State;
use thiserror::Error;
use tokio::sync::OnceCell;

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
    #[error("{}", describe_gh_error(.0))]
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

/// Render an octocrab error usefully. The default Display for
/// `octocrab::Error::GitHub` prints just "GitHub", which reaches the outbox
/// (and the user) as the useless string "octocrab: GitHub". GitHub puts the
/// actionable part in `errors[0].message` - for a review comment on a line
/// outside the diff that reads "line must be part of the diff".
pub fn describe_gh_error(e: &octocrab::Error) -> String {
    let octocrab::Error::GitHub { source, .. } = e else {
        return e.to_string();
    };
    let detail = source
        .errors
        .as_ref()
        .and_then(|errs| errs.first())
        .and_then(|first| {
            first
                .get("message")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        });
    match detail {
        Some(d) if d != source.message => {
            format!("GitHub {}: {} ({})", source.status_code.as_u16(), source.message, d)
        }
        _ => format!("GitHub {}: {}", source.status_code.as_u16(), source.message),
    }
}

/// Parse a unified-diff patch into the new-side (RIGHT) line ranges that
/// GitHub will accept a line-anchored review comment on.
///
/// Only context and added lines exist on the new side, and both advance the
/// new-side counter, so a hunk's commentable span is exactly the `+c,d` range
/// in its `@@` header. Anything outside these ranges gets a 422, which for a
/// prose PR is nearly the whole chapter - hence the file-level fallback.
pub fn commentable_ranges_from_patch(patch: &str) -> Vec<(u64, u64)> {
    let mut ranges = Vec::new();
    for line in patch.lines() {
        let Some(rest) = line.strip_prefix("@@ ") else {
            continue;
        };
        let Some(plus) = rest.split_whitespace().find(|t| t.starts_with('+')) else {
            continue;
        };
        let spec = &plus[1..];
        let (start, count) = match spec.split_once(',') {
            Some((s, c)) => (s.parse::<u64>().ok(), c.parse::<u64>().ok()),
            None => (spec.parse::<u64>().ok(), Some(1)),
        };
        let (Some(start), Some(count)) = (start, count) else {
            continue;
        };
        // A pure-deletion hunk has nothing on the new side to comment on.
        if count == 0 {
            continue;
        }
        ranges.push((start, start + count - 1));
    }
    ranges
}

/// Whether a selection sits entirely inside a single commentable hunk.
/// GitHub requires both ends of a multi-line comment to be in the same hunk,
/// so a range straddling two hunks has to go to the file level.
pub fn range_is_commentable(ranges: &[(u64, u64)], start: u64, end: u64) -> bool {
    let (lo, hi) = if start <= end { (start, end) } else { (end, start) };
    ranges.iter().any(|(s, e)| lo >= *s && hi <= *e)
}

/// Pull the cached commentable ranges for one path out of a stored PR detail
/// blob. Returns None when the PR detail predates this field, which callers
/// treat as "unknown" and therefore file-level.
pub fn commentable_for_path(pr: &Value, path: &str) -> Option<Vec<(u64, u64)>> {
    let file = pr
        .get("files")?
        .as_array()?
        .iter()
        .find(|f| f.get("path").and_then(|v| v.as_str()) == Some(path))?;
    let arr = file.get("commentable")?.as_array()?;
    Some(
        arr.iter()
            .filter_map(|pair| {
                let p = pair.as_array()?;
                Some((p.first()?.as_u64()?, p.get(1)?.as_u64()?))
            })
            .collect(),
    )
}

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
    pub client: OnceCell<Client>,
    pub db: std::sync::OnceLock<crate::db::DbPool>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            client: OnceCell::new(),
            db: std::sync::OnceLock::new(),
        }
    }
}

impl AppState {
    // The client is built once (a network round-trip to resolve the user) and
    // is immutable afterward, so reads are lock-free `&Client` references.
    // Concurrent first-callers all await the same initialization.
    pub async fn ensure(&self) -> Result<&Client, GhError> {
        self.client.get_or_try_init(Client::new).await
    }
}

fn split_repo(repo: &str) -> Result<(&str, &str), GhError> {
    repo.split_once('/')
        .ok_or_else(|| GhError::Other("repo must be owner/name".into()))
}

// ---- Tauri commands -----------------------------------------------------

#[tauri::command]
pub async fn get_current_user(state: State<'_, AppState>) -> Result<String, GhError> {
    let client = state.ensure().await?;
    Ok(client.user.clone())
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
    let client = state.ensure().await?;
    let octo = &client.octo;
    let value = fetch_prs_network(octo, &repo).await?;
    if let Some(pool) = state.db.get() {
        let _ = crate::db::put_pr_list(pool, &repo, &value);
    }
    Ok(value)
}

#[tauri::command]
pub async fn refresh_prs(repo: String, state: State<'_, AppState>) -> Result<Value, GhError> {
    gh_log!("READ", "refresh_prs repo={repo}");
    let client = state.ensure().await?;
    let octo = &client.octo;
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
    let client = state.ensure().await?;
    let octo = &client.octo;
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
                // `commentable` is the set of line ranges GitHub will accept a
                // line-anchored comment on. Derived here so posting can decide
                // line vs file level from cache, with no extra request and no
                // speculative 422.
                let commentable: Vec<Value> = f
                    .get("patch")
                    .and_then(|v| v.as_str())
                    .map(|p| {
                        commentable_ranges_from_patch(p)
                            .into_iter()
                            .map(|(s, e)| json!([s, e]))
                            .collect()
                    })
                    .unwrap_or_default();
                json!({
                    "path": f.get("filename").and_then(|v| v.as_str()).unwrap_or_default(),
                    "additions": f.get("additions").and_then(|v| v.as_u64()).unwrap_or(0),
                    "deletions": f.get("deletions").and_then(|v| v.as_u64()).unwrap_or(0),
                    "commentable": commentable,
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
    let client = state.ensure().await?;
    let octo = &client.octo;
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
    let client = state.ensure().await?;
    let octo = &client.octo;
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

/// Per-thread contribution to the change signature: id, resolved bit, total
/// comment count. Together with `updatedAt` and `headRefOid` this covers every
/// mutation class the poll loop must react to: new threads (id set), resolve /
/// unresolve (bit - GitHub does NOT bump `updatedAt` for those, verified
/// empirically), replies and deletes (count), pushes (head), everything else
/// that touches the PR (updatedAt).
fn signature_parts(nodes: &[Value]) -> Vec<String> {
    let mut parts: Vec<String> = nodes
        .iter()
        .map(|t| {
            let id = t.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let resolved = t
                .get("isResolved")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let count = t
                .pointer("/comments/totalCount")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            format!("{id}:{}:{count}", resolved as u8)
        })
        .collect();
    parts.sort();
    parts
}

/// Stable digest of the server-side thread state. Equal signatures mean the
/// expensive paginated thread fetch can be skipped. DefaultHasher is only
/// guaranteed stable within a Rust release; a toolchain bump costs at most one
/// redundant full fetch per PR.
pub fn thread_signature(updated_at: &str, head_ref_oid: &str, nodes: &[Value]) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    updated_at.hash(&mut h);
    head_ref_oid.hash(&mut h);
    for p in signature_parts(nodes) {
        p.hash(&mut h);
    }
    format!("{:016x}", h.finish())
}

/// Cheap change probe used every poll tick: fetches only `updatedAt`,
/// `headRefOid`, and per-thread (id, isResolved, comment totalCount), and
/// returns the resulting `thread_signature`. Costs ~2-3 GraphQL rate-limit
/// points per 100 threads vs ~51 for the full fetch, yet detects comments,
/// replies, deletes, resolves, and pushes.
pub async fn fetch_pr_signature(
    octo: &octocrab::Octocrab,
    repo: &str,
    number: u64,
) -> Result<String, GhError> {
    let (owner, name) = split_repo(repo)?;
    let started = Instant::now();
    let mut all_nodes: Vec<Value> = Vec::new();
    let mut updated_at = String::new();
    let mut head_ref_oid = String::new();
    let mut cursor: Option<String> = None;
    let mut page = 0usize;
    const MAX_PAGES: usize = 50;

    loop {
        page += 1;
        if page > MAX_PAGES {
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
                  updatedAt
                  headRefOid
                  reviewThreads(first: 100{after_clause}) {{
                    pageInfo {{ hasNextPage endCursor }}
                    nodes {{
                      id
                      isResolved
                      comments(first: 1) {{ totalCount }}
                    }}
                  }}
                }}
              }}
            }}"#
        );
        let body = json!({ "query": query });
        let inner: Value = match octo.graphql(&body).await {
            Ok(v) => v,
            Err(e) => {
                gh_log!(
                    "READ",
                    "fetch_pr_signature repo={repo} pr=#{number} page={page} err elapsed_ms={} error={e}",
                    started.elapsed().as_millis()
                );
                return Err(e.into());
            }
        };
        let pr = inner.pointer("/repository/pullRequest");
        if page == 1 {
            updated_at = pr
                .and_then(|p| p.get("updatedAt"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            head_ref_oid = pr
                .and_then(|p| p.get("headRefOid"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
        }
        let nodes: Vec<Value> = pr
            .and_then(|p| p.pointer("/reviewThreads/nodes"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        all_nodes.extend(nodes);
        let has_next = pr
            .and_then(|p| p.pointer("/reviewThreads/pageInfo/hasNextPage"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let end_cursor = pr
            .and_then(|p| p.pointer("/reviewThreads/pageInfo/endCursor"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if !has_next {
            break;
        }
        match end_cursor {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }

    let signature = thread_signature(&updated_at, &head_ref_oid, &all_nodes);
    gh_log!(
        "READ",
        "fetch_pr_signature repo={repo} pr=#{number} ok threads={} sig={signature} elapsed_ms={}",
        all_nodes.len(),
        started.elapsed().as_millis()
    );
    Ok(signature)
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
    let mut updated_at = String::new();
    let mut head_ref_oid = String::new();
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
        // updatedAt / headRefOid / comment totalCount feed thread_signature,
        // so a full fetch refreshes the stored probe baseline too.
        let query = format!(
            r#"query {{
              repository(owner: "{owner}", name: "{name}") {{
                pullRequest(number: {number}) {{
                  updatedAt
                  headRefOid
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
                      subjectType
                      comments(first: 50) {{
                        totalCount
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
        if page == 1 {
            updated_at = inner
                .pointer("/repository/pullRequest/updatedAt")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            head_ref_oid = inner
                .pointer("/repository/pullRequest/headRefOid")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
        }
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
                    "updatedAt": updated_at,
                    "headRefOid": head_ref_oid,
                    "reviewThreads": {
                        "nodes": all_nodes
                    }
                }
            }
        }
    }))
}

/// Persist a full thread fetch: replace cached rows and store the response's
/// change signature so subsequent probes can no-op. Returns the thread count.
pub fn store_threads_response(
    pool: &crate::db::DbPool,
    repo: &str,
    number: u64,
    response: &Value,
) -> Result<usize, crate::db::DbError> {
    let pr = response.pointer("/data/repository/pullRequest");
    let nodes: Vec<Value> = pr
        .and_then(|p| p.pointer("/reviewThreads/nodes"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    crate::db::replace_threads(pool, repo, number as i64, &nodes)?;
    let updated_at = pr
        .and_then(|p| p.get("updatedAt"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let head_ref_oid = pr
        .and_then(|p| p.get("headRefOid"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let sig = thread_signature(updated_at, head_ref_oid, &nodes);
    crate::db::put_threads_sig(pool, repo, number as i64, &sig)?;
    Ok(nodes.len())
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

    let client = state.ensure().await?;
    let octo = &client.octo;
    let response = fetch_threads_graphql(octo, &repo, number).await?;
    if let Some(pool) = state.db.get() {
        if let Err(e) = store_threads_response(pool, &repo, number, &response) {
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

/// Post a review comment. `line` is None for a file-level comment
/// (`subject_type: file`), which GitHub accepts anywhere in the file and
/// still threads and resolves like a normal review thread. Prose uses it for
/// any selection outside the diff, with the nr:v1 anchor in the body carrying
/// the true position.
pub async fn dispatch_post_comment(
    octo: &octocrab::Octocrab,
    repo: &str,
    number: u64,
    commit_id: &str,
    path: &str,
    line: Option<u64>,
    start_line: Option<u64>,
    body: &str,
) -> Result<Value, GhError> {
    let (owner, name) = split_repo(repo)?;
    let mut payload = json!({
        "body": body,
        "commit_id": commit_id,
        "path": path,
    });
    match line {
        Some(line) => {
            payload["line"] = json!(line);
            payload["side"] = json!("RIGHT");
            if let Some(sl) = start_line {
                if sl != line {
                    payload["start_line"] = json!(sl);
                    payload["start_side"] = json!("RIGHT");
                }
            }
        }
        None => {
            payload["subject_type"] = json!("file");
        }
    }
    let endpoint = format!("/repos/{owner}/{name}/pulls/{number}/comments");
    gh_log!(
        "WRITE",
        "post_comment repo={repo} pr=#{number} path={path} level={} line={:?} start_line={:?} body_len={}",
        if line.is_some() { "line" } else { "file" },
        line,
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
    let client = state.ensure().await?;
    let octo = &client.octo;
    dispatch_post_comment(
        octo,
        &repo,
        number,
        &commit_id,
        &path,
        Some(line),
        start_line,
        &body,
    )
    .await
}

#[tauri::command]
pub async fn reply_to_comment(
    repo: String,
    number: u64,
    in_reply_to: u64,
    body: String,
    state: State<'_, AppState>,
) -> Result<Value, GhError> {
    let client = state.ensure().await?;
    let octo = &client.octo;
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
    let client = state.ensure().await?;
    let octo = &client.octo;
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
    let client = state.ensure().await?;
    let octo = &client.octo;
    dispatch_resolve(octo, &thread_id, resolved).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, resolved: bool, count: i64) -> Value {
        json!({
            "id": id,
            "isResolved": resolved,
            "comments": { "totalCount": count }
        })
    }

    #[test]
    fn thread_signature_is_order_insensitive() {
        let a = thread_signature("t1", "sha1", &[node("A", false, 2), node("B", true, 1)]);
        let b = thread_signature("t1", "sha1", &[node("B", true, 1), node("A", false, 2)]);
        assert_eq!(a, b);
    }

    #[test]
    fn thread_signature_sees_every_change_class() {
        let base = thread_signature("t1", "sha1", &[node("A", false, 2)]);
        // resolve flip
        assert_ne!(base, thread_signature("t1", "sha1", &[node("A", true, 2)]));
        // reply / delete (comment count)
        assert_ne!(base, thread_signature("t1", "sha1", &[node("A", false, 3)]));
        // new thread
        assert_ne!(
            base,
            thread_signature("t1", "sha1", &[node("A", false, 2), node("B", false, 1)])
        );
        // push (head) and any other PR activity (updatedAt)
        assert_ne!(base, thread_signature("t1", "sha2", &[node("A", false, 2)]));
        assert_ne!(base, thread_signature("t2", "sha1", &[node("A", false, 2)]));
    }

    // The real shape of the problem: PR #61 appends two lines to an 867-line
    // chapter, so only the tail is line-commentable.
    const TAIL_PATCH: &str = "@@ -863,3 +863,5 @@ some heading\n context\n context\n context\n+\n+";

    #[test]
    fn commentable_ranges_parses_hunk_header() {
        assert_eq!(commentable_ranges_from_patch(TAIL_PATCH), vec![(863, 867)]);
    }

    #[test]
    fn commentable_ranges_handles_multiple_and_single_line_hunks() {
        let patch = "@@ -1,2 +1,3 @@\n a\n+b\n a\n@@ -40 +42 @@\n-old\n+new\n";
        assert_eq!(commentable_ranges_from_patch(patch), vec![(1, 3), (42, 42)]);
    }

    #[test]
    fn commentable_ranges_skips_pure_deletion_hunks() {
        // "+10,0" means the new side has no lines here, so nothing to comment on.
        assert!(commentable_ranges_from_patch("@@ -10,4 +10,0 @@\n-gone\n").is_empty());
    }

    #[test]
    fn range_is_commentable_matches_only_inside_one_hunk() {
        let ranges = commentable_ranges_from_patch(TAIL_PATCH);
        assert!(range_is_commentable(&ranges, 865, 865));
        assert!(range_is_commentable(&ranges, 863, 867));
        // The body of the chapter: what the user actually wants to comment on.
        assert!(!range_is_commentable(&ranges, 3, 3));
        // Straddling the hunk boundary must not be line-anchored: GitHub needs
        // both ends of a multi-line comment inside the same hunk.
        assert!(!range_is_commentable(&ranges, 860, 865));
    }

    #[test]
    fn range_is_commentable_normalizes_reversed_selections() {
        let ranges = vec![(10, 20)];
        assert!(range_is_commentable(&ranges, 15, 12));
    }

    #[test]
    fn commentable_for_path_reads_cached_pr_detail() {
        let pr = json!({
            "files": [
                { "path": "a.md", "commentable": [[863, 867], [900, 901]] },
                { "path": "b.md" }
            ]
        });
        assert_eq!(
            commentable_for_path(&pr, "a.md"),
            Some(vec![(863, 867), (900, 901)])
        );
        // No `commentable` key (PR detail cached before this shipped) reads as
        // unknown, which callers treat as file-level rather than guessing.
        assert_eq!(commentable_for_path(&pr, "b.md"), None);
        assert_eq!(commentable_for_path(&pr, "missing.md"), None);
    }
}

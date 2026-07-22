use chrono::Utc;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;
use uuid::Uuid;

pub type DbPool = Pool<SqliteConnectionManager>;

const MIGRATION_V1: &str = r#"
-- Identity model: rows are keyed by client_key, a locally-minted uuid that
-- never changes for the lifetime of the thread/comment. github_id is the
-- server-assigned id, NULL until GitHub has confirmed the row. "Optimistic"
-- is therefore just github_id IS NULL, and promotion is an UPDATE that fills
-- github_id in - the row (and every piece of UI state keyed on client_key)
-- stays put.
CREATE TABLE IF NOT EXISTS threads (
  client_key TEXT PRIMARY KEY,
  github_id TEXT UNIQUE,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  is_resolved INTEGER NOT NULL,
  is_outdated INTEGER NOT NULL,
  path TEXT,
  line INTEGER,
  start_line INTEGER,
  original_line INTEGER,
  diff_side TEXT,
  updated_at TEXT NOT NULL,
  pending_op TEXT
);
CREATE INDEX IF NOT EXISTS idx_threads_pr ON threads(repo, pr_number);

CREATE TABLE IF NOT EXISTS comments (
  client_key TEXT PRIMARY KEY,
  github_id TEXT UNIQUE,
  database_id INTEGER,
  thread_key TEXT NOT NULL REFERENCES threads(client_key) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author TEXT,
  created_at TEXT NOT NULL,
  url TEXT,
  pending_op TEXT,
  soft_deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(thread_key);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_outbox_ready ON outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS file_contents (
  repo TEXT NOT NULL,
  git_ref TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (repo, git_ref, path)
);

CREATE TABLE IF NOT EXISTS pr_detail (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);

CREATE TABLE IF NOT EXISTS pr_summaries (
  repo TEXT NOT NULL PRIMARY KEY,
  json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- Tracks "we have successfully fetched threads for this PR at least once",
-- including the case where the fetch returned zero threads. Without this,
-- get_review_threads can't distinguish "no threads ever fetched" (must hit
-- network) from "we fetched and there genuinely are none" (return empty,
-- avoid refetch loops).
CREATE TABLE IF NOT EXISTS thread_fetches (
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (repo, pr_number)
);
"#;

const SCHEMA_VERSION: i32 = 3;

// Rebuild for DBs created before the client_key-primary-key model (schema
// v1/v2, where threads.id / comments.id held either the GitHub id or a
// placeholder `tmp:<uuid>`). Data is carried over so in-flight and failed
// optimistic rows (the user's only copy of unsent text) survive the upgrade.
const MIGRATION_V3_REBUILD: &str = r#"
PRAGMA foreign_keys=OFF;

CREATE TABLE threads_v3 (
  client_key TEXT PRIMARY KEY,
  github_id TEXT UNIQUE,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  is_resolved INTEGER NOT NULL,
  is_outdated INTEGER NOT NULL,
  path TEXT,
  line INTEGER,
  start_line INTEGER,
  original_line INTEGER,
  diff_side TEXT,
  updated_at TEXT NOT NULL,
  pending_op TEXT
);
INSERT INTO threads_v3 (client_key, github_id, repo, pr_number, is_resolved, is_outdated, path, line, start_line, original_line, diff_side, updated_at, pending_op)
  SELECT COALESCE(client_key, id),
         CASE WHEN id LIKE 'tmp:%' THEN NULL ELSE id END,
         repo, pr_number, is_resolved, is_outdated, path, line, start_line, original_line, diff_side, updated_at, pending_op
  FROM threads;

CREATE TABLE comments_v3 (
  client_key TEXT PRIMARY KEY,
  github_id TEXT UNIQUE,
  database_id INTEGER,
  thread_key TEXT NOT NULL REFERENCES threads(client_key) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author TEXT,
  created_at TEXT NOT NULL,
  url TEXT,
  pending_op TEXT,
  soft_deleted INTEGER NOT NULL DEFAULT 0
);
INSERT INTO comments_v3 (client_key, github_id, database_id, thread_key, body, author, created_at, url, pending_op, soft_deleted)
  SELECT c.id,
         CASE WHEN c.id LIKE 'tmp:%' THEN NULL ELSE c.id END,
         c.database_id,
         (SELECT COALESCE(t.client_key, t.id) FROM threads t WHERE t.id = c.thread_id),
         c.body, c.author, c.created_at, c.url, c.pending_op, c.soft_deleted
  FROM comments c
  WHERE c.thread_id IN (SELECT id FROM threads);

DROP TABLE comments;
DROP TABLE threads;
ALTER TABLE threads_v3 RENAME TO threads;
ALTER TABLE comments_v3 RENAME TO comments;
CREATE INDEX IF NOT EXISTS idx_threads_pr ON threads(repo, pr_number);
CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(thread_key);

PRAGMA foreign_keys=ON;
"#;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("r2d2: {0}")]
    Pool(#[from] r2d2::Error),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

pub fn init(db_path: &Path) -> Result<DbPool, DbError> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let manager = SqliteConnectionManager::file(db_path).with_init(|conn| {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             PRAGMA synchronous=NORMAL;",
        )
    });
    let pool = Pool::builder().max_size(8).build(manager)?;
    migrate(&pool)?;
    recover_inflight_outbox(&pool)?;
    Ok(pool)
}

/// Reset ops orphaned in status='inflight' back to 'pending'. An op is
/// flipped to inflight when the worker claims it; if the app dies between
/// claim and settle, nothing would ever pick it up again (the worker only
/// claims pending rows) and the comment would show "sending" forever. Runs
/// once at startup, before the outbox worker can claim anything.
pub fn recover_inflight_outbox(pool: &DbPool) -> Result<usize, DbError> {
    let conn = pool.get()?;
    let n = conn.execute(
        "UPDATE outbox SET status='pending' WHERE status='inflight'",
        [],
    )?;
    Ok(n)
}

fn migrate(pool: &DbPool) -> Result<(), DbError> {
    let conn = pool.get()?;
    // Old-shape DBs (v1/v2) have a threads.id column; rebuild them into the
    // client_key model before MIGRATION_V1's CREATE IF NOT EXISTS runs, so
    // the batch below only ever creates fresh new-shape tables.
    let has_old_shape = conn
        .prepare("SELECT 1 FROM pragma_table_info('threads') WHERE name = 'id'")?
        .exists([])?;
    if has_old_shape {
        // v1 lacks the client_key column the rebuild SELECTs from; add it so
        // one rebuild script covers both v1 and v2.
        let has_client_key = conn
            .prepare("SELECT 1 FROM pragma_table_info('threads') WHERE name = 'client_key'")?
            .exists([])?;
        if !has_client_key {
            conn.execute("ALTER TABLE threads ADD COLUMN client_key TEXT", [])?;
        }
        conn.execute_batch(MIGRATION_V3_REBUILD)?;
    }
    conn.execute_batch(MIGRATION_V1)?;
    // The prs table was created by early schema versions but never written;
    // pr_summaries and pr_detail are the real PR caches. Drop the orphan.
    conn.execute("DROP TABLE IF EXISTS prs", [])?;
    conn.execute(
        "INSERT OR REPLACE INTO meta(k, v) VALUES ('schema_version', ?1)",
        rusqlite::params![SCHEMA_VERSION.to_string()],
    )?;
    Ok(())
}

/// Extract the client key from a comment body's nr:v1 marker, if present.
/// The frontend embeds `{"key": "<uuid>", ...anchor fields}` in an HTML
/// comment when posting; GitHub stores the body verbatim, so the key comes
/// back with every fetch and identifies which optimistic post this is.
fn embedded_client_key(body: &str) -> Option<String> {
    let start = body.find("<!-- nr:v1")?;
    let rest = &body[start + "<!-- nr:v1".len()..];
    let end = rest.find("-->")?;
    let payload: Value = serde_json::from_str(rest[..end].trim()).ok()?;
    payload.get("key")?.as_str().map(|s| s.to_string())
}

/// Replace cached threads + comments for a (repo, pr) with a fresh GraphQL
/// response. Pending (optimistic) rows are preserved and not overwritten.
pub fn replace_threads(
    pool: &DbPool,
    repo: &str,
    pr_number: i64,
    thread_nodes: &[Value],
) -> Result<(), DbError> {
    let mut conn = pool.get()?;
    let tx = conn.transaction()?;
    let now = Utc::now().to_rfc3339();

    // Github ids present in this response, for the stale-thread prune after
    // the loop. Coordinates likewise, for the leftover-local sweep.
    let mut seen_github_ids: Vec<String> = Vec::new();
    let mut seen_coords: Vec<(Option<String>, Option<i64>, Option<i64>)> = Vec::new();

    for t in thread_nodes {
        let id = t.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let is_resolved = t.get("isResolved").and_then(|v| v.as_bool()).unwrap_or(false);
        let is_outdated = t.get("isOutdated").and_then(|v| v.as_bool()).unwrap_or(false);
        let path = t.get("path").and_then(|v| v.as_str());
        // GraphQL reports file-level threads (subjectType FILE) with line: 1
        // rather than null, even though they aren't anchored to any line.
        // Normalize back to line-less at ingestion: a phantom L1 breaks the
        // leftover-local sweep (coordinates never match the null-line local
        // row, so a marker-less duplicate would linger) and sends the anchor
        // walker hunting around line 1, which brands the thread STALE.
        let is_file_level =
            t.get("subjectType").and_then(|v| v.as_str()) == Some("FILE");
        let line = if is_file_level {
            None
        } else {
            t.get("line").and_then(|v| v.as_i64())
        };
        let start_line = if is_file_level {
            None
        } else {
            t.get("startLine").and_then(|v| v.as_i64())
        };
        let original_line = if is_file_level {
            None
        } else {
            t.get("originalLine").and_then(|v| v.as_i64())
        };
        let diff_side = t.get("diffSide").and_then(|v| v.as_str());

        seen_github_ids.push(id.to_string());
        seen_coords.push((path.map(str::to_string), line, start_line));

        // Resolve which local row this server thread is. Three cases:
        //  1. We've seen this github_id before - update that row.
        //  2. The first comment's nr:v1 marker carries a client key and a
        //     settled local row holds it - this is the optimistic post
        //     arriving back; promotion fills github_id in on that row.
        //  3. Neither - a thread born outside this cache; adopt the embedded
        //     key when present (keeps identity consistent across machines),
        //     else key it by its github id.
        // An in-flight or failed local row holding the key (pending_op set)
        // is never adopted: it's the user's only copy of the text, and its
        // op will settle it. Skip the server node until then.
        let embedded_key = t
            .get("comments")
            .and_then(|c| c.get("nodes"))
            .and_then(|n| n.as_array())
            .and_then(|nodes| nodes.first())
            .and_then(|c| c.get("body"))
            .and_then(|v| v.as_str())
            .and_then(embedded_client_key);
        let by_github: Option<String> = tx
            .query_row(
                "SELECT client_key FROM threads WHERE github_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        let client_key = match by_github {
            Some(k) => k,
            None => match &embedded_key {
                Some(k) => {
                    let pending: Option<Option<String>> = tx
                        .query_row(
                            "SELECT pending_op FROM threads WHERE client_key = ?1",
                            params![k],
                            |r| r.get(0),
                        )
                        .optional()?;
                    match pending {
                        Some(Some(_)) => continue,
                        _ => k.clone(),
                    }
                }
                None => id.to_string(),
            },
        };
        tx.execute(
            "INSERT INTO threads (client_key, github_id, repo, pr_number, is_resolved, is_outdated, path, line, start_line, original_line, diff_side, updated_at, pending_op)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL)
             ON CONFLICT(client_key) DO UPDATE SET
                github_id = excluded.github_id,
                is_resolved = excluded.is_resolved,
                is_outdated = excluded.is_outdated,
                path = excluded.path,
                line = excluded.line,
                start_line = excluded.start_line,
                original_line = excluded.original_line,
                diff_side = excluded.diff_side,
                updated_at = excluded.updated_at,
                pending_op = NULL
             WHERE pending_op IS NULL",
            params![
                client_key,
                id,
                repo,
                pr_number,
                is_resolved as i64,
                is_outdated as i64,
                path,
                line,
                start_line,
                original_line,
                diff_side,
                now
            ],
        )?;

        // Replace this thread's confirmed comments with the response's set.
        // Local rows (github_id IS NULL: settled or in-flight optimistic
        // replies) are preserved; a settled one whose marker key comes back
        // in this response is promoted in place by the upsert below.
        tx.execute(
            "DELETE FROM comments
             WHERE thread_key = ?1
               AND pending_op IS NULL
               AND github_id IS NOT NULL",
            params![client_key],
        )?;
        if let Some(comment_nodes) = t.get("comments").and_then(|c| c.get("nodes")).and_then(|n| n.as_array()) {
            for c in comment_nodes {
                let cid = c.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if cid.is_empty() {
                    continue;
                }
                let database_id = c.get("databaseId").and_then(|v| v.as_i64());
                let body = c.get("body").and_then(|v| v.as_str()).unwrap_or("");
                let author = c
                    .get("author")
                    .and_then(|a| a.get("login"))
                    .and_then(|v| v.as_str());
                let created_at = c.get("createdAt").and_then(|v| v.as_str()).unwrap_or("");
                let url = c.get("url").and_then(|v| v.as_str());
                let comment_key = embedded_client_key(body).unwrap_or_else(|| cid.to_string());
                tx.execute(
                    "INSERT INTO comments (client_key, github_id, database_id, thread_key, body, author, created_at, url, pending_op, soft_deleted)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, 0)
                     ON CONFLICT(client_key) DO UPDATE SET
                        github_id = excluded.github_id,
                        database_id = excluded.database_id,
                        thread_key = excluded.thread_key,
                        body = excluded.body,
                        author = excluded.author,
                        created_at = excluded.created_at,
                        url = excluded.url,
                        pending_op = NULL
                     WHERE pending_op IS NULL",
                    params![comment_key, cid, database_id, client_key, body, author, created_at, url],
                )?;
            }
        }
    }

    // Prune confirmed threads that the server no longer reports (resolved
    // away, deleted, or moved). Local rows (github_id IS NULL) and rows with
    // an op in flight are untouched.
    {
        let confirmed: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT github_id FROM threads
                 WHERE repo = ?1 AND pr_number = ?2
                   AND github_id IS NOT NULL AND pending_op IS NULL",
            )?;
            let rows = stmt.query_map(params![repo, pr_number], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for gid in confirmed {
            if !seen_github_ids.contains(&gid) {
                tx.execute("DELETE FROM threads WHERE github_id = ?1", params![gid])?;
            }
        }
    }
    // Sweep: a settled local thread (github_id NULL, no op in flight) still
    // sitting at coordinates a confirmed thread now occupies was missed by
    // the key match (e.g. the body's marker was edited away on GitHub).
    // Delete it so it doesn't shadow the canonical row forever. Runs after
    // the whole loop so it can't race promotion - an unrelated
    // same-coordinate thread must not consume a row that a later node in
    // the same response will claim by key.
    for (path, line, start_line) in &seen_coords {
        tx.execute(
            "DELETE FROM threads
             WHERE repo = ?1 AND pr_number = ?2
               AND github_id IS NULL AND pending_op IS NULL
               AND path IS ?3 AND line IS ?4
               AND COALESCE(start_line, line) IS COALESCE(?5, ?4)",
            params![repo, pr_number, path, line, start_line],
        )?;
    }

    // Stamp that we've successfully synced threads for this PR. Lets
    // `get_review_threads` distinguish "never fetched" from "fetched, zero
    // threads" so we don't refetch in a loop on a thread-less PR.
    tx.execute(
        "INSERT INTO thread_fetches (repo, pr_number, fetched_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(repo, pr_number) DO UPDATE SET fetched_at = excluded.fetched_at",
        params![repo, pr_number, now],
    )?;
    tx.commit()?;
    Ok(())
}

/// Whether we've ever successfully fetched threads for this PR (regardless
/// of whether the fetch returned any threads).
pub fn threads_ever_fetched(
    pool: &DbPool,
    repo: &str,
    pr_number: i64,
) -> Result<bool, DbError> {
    let conn = pool.get()?;
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM thread_fetches WHERE repo=?1 AND pr_number=?2",
        params![repo, pr_number],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Read cached threads for a PR, returning the same shape the GraphQL endpoint
/// produces so the frontend type/parsing stays unchanged.
pub fn get_threads(pool: &DbPool, repo: &str, pr_number: i64) -> Result<Value, DbError> {
    let conn = pool.get()?;
    let mut tstmt = conn.prepare(
        "SELECT COALESCE(github_id, client_key) AS id, is_resolved, is_outdated, path, line, start_line, original_line, diff_side, pending_op,
                client_key
         FROM threads WHERE repo = ?1 AND pr_number = ?2 ORDER BY rowid",
    )?;
    let thread_rows = tstmt
        .query_map(params![repo, pr_number], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)? != 0,
                r.get::<_, i64>(2)? != 0,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<i64>>(4)?,
                r.get::<_, Option<i64>>(5)?,
                r.get::<_, Option<i64>>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, Option<String>>(8)?,
                r.get::<_, String>(9)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut cstmt = conn.prepare(
        "SELECT COALESCE(github_id, client_key) AS id, database_id, body, author, created_at, url, pending_op FROM comments
         WHERE thread_key = ?1 AND soft_deleted = 0 ORDER BY created_at, rowid",
    )?;

    let mut nodes = Vec::with_capacity(thread_rows.len());
    for (id, is_resolved, is_outdated, path, line, start_line, original_line, diff_side, pending_op, client_key) in
        thread_rows
    {
        let comments = cstmt
            .query_map(params![&client_key], |c| {
                Ok(json!({
                    "id": c.get::<_, String>(0)?,
                    "databaseId": c.get::<_, Option<i64>>(1)?,
                    "body": c.get::<_, String>(2)?,
                    "author": { "login": c.get::<_, Option<String>>(3)?.unwrap_or_default() },
                    "createdAt": c.get::<_, String>(4)?,
                    "url": c.get::<_, Option<String>>(5)?,
                    "pendingOp": c.get::<_, Option<String>>(6)?,
                }))
            })?
            .filter_map(Result::ok)
            .collect::<Vec<Value>>();
        // Drop threads whose visible comments are all soft-deleted (e.g. user
        // just deleted the only comment in a thread).
        if comments.is_empty() {
            continue;
        }
        nodes.push(json!({
            "id": id,
            "clientKey": client_key,
            "isResolved": is_resolved,
            "isOutdated": is_outdated,
            "path": path,
            "line": line,
            "startLine": start_line,
            "originalLine": original_line,
            "diffSide": diff_side,
            "pendingOp": pending_op,
            "comments": { "nodes": comments },
        }));
    }
    Ok(json!({
        "data": {
            "repository": {
                "pullRequest": {
                    "reviewThreads": { "nodes": nodes }
                }
            }
        }
    }))
}

// ---- Thread change signature -----
//
// The poll loop stores a digest of the last server thread state (see
// github::thread_signature) so a cheap probe can no-op when nothing changed.
// Keyed into the existing meta table to avoid a schema migration.

fn threads_sig_key(repo: &str, pr_number: i64) -> String {
    format!("threads_sig:{repo}#{pr_number}")
}

pub fn get_threads_sig(
    pool: &DbPool,
    repo: &str,
    pr_number: i64,
) -> Result<Option<String>, DbError> {
    let conn = pool.get()?;
    let v: Option<String> = conn
        .query_row(
            "SELECT v FROM meta WHERE k = ?1",
            params![threads_sig_key(repo, pr_number)],
            |r| r.get(0),
        )
        .optional()?;
    Ok(v)
}

pub fn put_threads_sig(
    pool: &DbPool,
    repo: &str,
    pr_number: i64,
    sig: &str,
) -> Result<(), DbError> {
    let conn = pool.get()?;
    conn.execute(
        "INSERT OR REPLACE INTO meta(k, v) VALUES (?1, ?2)",
        params![threads_sig_key(repo, pr_number), sig],
    )?;
    Ok(())
}

// ---- Cached GitHub login -----
//
// Stored on every successful client init so optimistic mutations can stamp
// the author without awaiting the (possibly still network-blocked) client.

pub fn get_cached_user(pool: &DbPool) -> Result<Option<String>, DbError> {
    let conn = pool.get()?;
    let v: Option<String> = conn
        .query_row(
            "SELECT v FROM meta WHERE k = 'current_user'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(v)
}

pub fn put_cached_user(pool: &DbPool, login: &str) -> Result<(), DbError> {
    let conn = pool.get()?;
    conn.execute(
        "INSERT OR REPLACE INTO meta(k, v) VALUES ('current_user', ?1)",
        params![login],
    )?;
    Ok(())
}

pub fn count_threads(pool: &DbPool, repo: &str, pr_number: i64) -> Result<i64, DbError> {
    let conn = pool.get()?;
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM threads WHERE repo = ?1 AND pr_number = ?2",
        params![repo, pr_number],
        |r| r.get(0),
    )?;
    Ok(n)
}

// ---- Outbox -----

#[derive(Debug, Clone)]
pub struct OutboxRow {
    pub id: String,
    pub kind: String,
    pub payload: Value,
    pub attempts: i64,
}

pub fn enqueue_outbox(pool: &DbPool, kind: &str, payload: &Value) -> Result<String, DbError> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let conn = pool.get()?;
    conn.execute(
        "INSERT INTO outbox (id, kind, payload_json, created_at, attempts, next_attempt_at, status)
         VALUES (?1, ?2, ?3, ?4, 0, ?4, 'pending')",
        params![id, kind, payload.to_string(), now],
    )?;
    Ok(id)
}

/// Atomically claim the next ready op (status='pending' AND next_attempt_at <= now),
/// flipping it to 'inflight'. Returns None if nothing's ready.
pub fn claim_next_outbox(pool: &DbPool) -> Result<Option<OutboxRow>, DbError> {
    let mut conn = pool.get()?;
    let tx = conn.transaction()?;
    let now = Utc::now().to_rfc3339();
    let row: Option<OutboxRow> = tx
        .query_row(
            "SELECT id, kind, payload_json, attempts FROM outbox
             WHERE status='pending' AND next_attempt_at <= ?1
             ORDER BY next_attempt_at LIMIT 1",
            params![now],
            |r| {
                let payload_str: String = r.get(2)?;
                Ok(OutboxRow {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    payload: serde_json::from_str(&payload_str).unwrap_or(Value::Null),
                    attempts: r.get(3)?,
                })
            },
        )
        .optional()?;
    if let Some(ref row) = row {
        tx.execute(
            "UPDATE outbox SET status='inflight' WHERE id=?1",
            params![row.id],
        )?;
    }
    tx.commit()?;
    Ok(row)
}

pub fn mark_outbox_done(pool: &DbPool, id: &str) -> Result<(), DbError> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE outbox SET status='done', last_error=NULL WHERE id=?1",
        params![id],
    )?;
    Ok(())
}

pub fn mark_outbox_retry(
    pool: &DbPool,
    id: &str,
    attempts: i64,
    next_at: &str,
    last_error: &str,
) -> Result<(), DbError> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE outbox SET status='pending', attempts=?2, next_attempt_at=?3, last_error=?4 WHERE id=?1",
        params![id, attempts, next_at, last_error],
    )?;
    Ok(())
}

pub fn mark_outbox_failed(pool: &DbPool, id: &str, last_error: &str) -> Result<(), DbError> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE outbox SET status='failed', last_error=?2 WHERE id=?1",
        params![id, last_error],
    )?;
    Ok(())
}

// Most optimistic-mutation functions return (repo, pr_number) so their
// caller can emit a cache:threads-updated event for the affected PR. These
// helpers are the three ways of resolving that pair.

/// (repo, pr_number) of the thread with this client_key.
fn thread_pr_of(
    conn: &rusqlite::Connection,
    thread_key: &str,
) -> rusqlite::Result<Option<(String, i64)>> {
    conn.query_row(
        "SELECT repo, pr_number FROM threads WHERE client_key=?1",
        params![thread_key],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

/// (repo, pr_number) of the thread tagged with this pending_op.
fn thread_pr_by_pending_op(
    conn: &rusqlite::Connection,
    op_tag: &str,
) -> rusqlite::Result<Option<(String, i64)>> {
    conn.query_row(
        "SELECT repo, pr_number FROM threads WHERE pending_op=?1",
        params![op_tag],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

/// (repo, pr_number) of the thread hosting the comment tagged with this
/// pending_op.
fn comment_pr_by_pending_op(
    conn: &rusqlite::Connection,
    op_tag: &str,
) -> rusqlite::Result<Option<(String, i64)>> {
    conn.query_row(
        "SELECT t.repo, t.pr_number
         FROM comments c JOIN threads t ON t.client_key = c.thread_key
         WHERE c.pending_op=?1",
        params![op_tag],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

/// Optimistically flip is_resolved on a thread + tag with pending_op id.
/// Returns (repo, pr_number) so the caller can emit an event.
pub fn apply_optimistic_resolve(
    pool: &DbPool,
    thread_key: &str,
    resolved: bool,
    op_id: &str,
) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    let updated = conn.execute(
        "UPDATE threads SET is_resolved=?2, pending_op=?3 WHERE client_key=?1",
        params![thread_key, resolved as i64, op_id],
    )?;
    if updated == 0 {
        return Ok(None);
    }
    Ok(thread_pr_of(&conn, thread_key)?)
}

/// Clear pending_op once an op settles successfully. Subsequent poll cycles
/// will reconcile to authoritative server state.
pub fn clear_pending_op(pool: &DbPool, thread_key: &str, op_id: &str) -> Result<(), DbError> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE threads SET pending_op=NULL WHERE client_key=?1 AND pending_op=?2",
        params![thread_key, op_id],
    )?;
    Ok(())
}

/// On op failure, restore the thread's pre-op resolve state and clear the op tag.
pub fn revert_optimistic_resolve(
    pool: &DbPool,
    thread_key: &str,
    prior_resolved: bool,
    op_id: &str,
) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    let updated = conn.execute(
        "UPDATE threads SET is_resolved=?2, pending_op=NULL WHERE client_key=?1 AND pending_op=?3",
        params![thread_key, prior_resolved as i64, op_id],
    )?;
    if updated == 0 {
        return Ok(None);
    }
    Ok(thread_pr_of(&conn, thread_key)?)
}

/// Insert an optimistic thread + comment. `client_key` is the frontend-minted
/// identity, also embedded in the body's nr:v1 marker so replace_threads can
/// promote the row (fill github_id in) by exact key match when the real
/// server thread arrives. Returns (thread_key, comment_key).
pub fn apply_optimistic_post_comment(
    pool: &DbPool,
    repo: &str,
    pr_number: i64,
    path: &str,
    line: Option<i64>,
    start_line: Option<i64>,
    body: &str,
    author: &str,
    op_id: &str,
    client_key: &str,
) -> Result<(String, String), DbError> {
    // The comment row carries the same key the frontend embedded in the body
    // marker (one marker, one key). Ingestion resolves incoming comments by
    // that embedded key, so the row must be keyed by it or the echoed server
    // comment would insert alongside the optimistic one as a duplicate.
    let comment_key = client_key.to_string();
    let now = Utc::now().to_rfc3339();
    let conn = pool.get()?;
    conn.execute(
        "INSERT INTO threads (client_key, github_id, repo, pr_number, is_resolved, is_outdated, path, line, start_line, original_line, diff_side, updated_at, pending_op)
         VALUES (?1, NULL, ?2, ?3, 0, 0, ?4, ?5, ?6, ?5, 'RIGHT', ?7, ?8)",
        params![
            client_key,
            repo,
            pr_number,
            path,
            line,
            start_line,
            now,
            op_id
        ],
    )?;
    conn.execute(
        "INSERT INTO comments (client_key, github_id, database_id, thread_key, body, author, created_at, url, pending_op, soft_deleted)
         VALUES (?1, NULL, NULL, ?2, ?3, ?4, ?5, NULL, ?6, 0)",
        params![comment_key, client_key, body, author, now, op_id],
    )?;
    Ok((client_key.to_string(), comment_key))
}

/// On post_comment success: clear pending_op. The row stays local
/// (github_id NULL) until the next poll's replace_threads matches the key
/// echoed in the body marker and fills github_id in.
pub fn finalize_post_comment(pool: &DbPool, op_id: &str) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    let Some(pr) = thread_pr_by_pending_op(&conn, op_id)? else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE threads SET pending_op=NULL WHERE pending_op=?1",
        params![op_id],
    )?;
    conn.execute(
        "UPDATE comments SET pending_op=NULL WHERE pending_op=?1",
        params![op_id],
    )?;
    Ok(Some(pr))
}

/// On permanent post_comment failure: keep the local rows but re-tag them
/// `failed:<op_id>` so the UI can render a failed card with Retry/Discard.
/// Deleting them (the old behavior) silently destroyed the user's comment
/// text. The failed tag still counts as pending_op for every preservation
/// filter (replace_threads, clear_pr_cache), so failed comments survive
/// polls and refreshes until the user acts.
pub fn mark_optimistic_post_failed(
    pool: &DbPool,
    op_id: &str,
) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    let Some(pr) = thread_pr_by_pending_op(&conn, op_id)? else {
        return Ok(None);
    };
    let failed_tag = format!("failed:{op_id}");
    conn.execute(
        "UPDATE threads SET pending_op=?2 WHERE pending_op=?1",
        params![op_id, failed_tag],
    )?;
    conn.execute(
        "UPDATE comments SET pending_op=?2 WHERE pending_op=?1",
        params![op_id, failed_tag],
    )?;
    Ok(Some(pr))
}

/// Re-arm a failed op: reset the outbox row for a fresh round of attempts
/// and restore the plain pending_op tag on the rows we marked failed.
/// Returns (repo, pr_number) from the op payload, or None if the op doesn't
/// exist or isn't in the failed state.
pub fn retry_failed_op(
    pool: &DbPool,
    op_id: &str,
) -> Result<Option<(String, i64)>, DbError> {
    let mut conn = pool.get()?;
    let tx = conn.transaction()?;
    let payload_str: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM outbox WHERE id=?1 AND status='failed'",
            params![op_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(payload_str) = payload_str else {
        return Ok(None);
    };
    let now = Utc::now().to_rfc3339();
    tx.execute(
        "UPDATE outbox SET status='pending', attempts=0, next_attempt_at=?2, last_error=NULL
         WHERE id=?1",
        params![op_id, now],
    )?;
    let failed_tag = format!("failed:{op_id}");
    tx.execute(
        "UPDATE threads SET pending_op=?2 WHERE pending_op=?1",
        params![failed_tag, op_id],
    )?;
    tx.execute(
        "UPDATE comments SET pending_op=?2 WHERE pending_op=?1",
        params![failed_tag, op_id],
    )?;
    tx.commit()?;
    let payload: Value = serde_json::from_str(&payload_str).unwrap_or(Value::Null);
    let repo = payload
        .get("repo")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let number = payload.get("number").and_then(|v| v.as_i64());
    Ok(repo.zip(number))
}

/// Drop a failed op and its optimistic rows for good: the user saw the
/// failure and chose to discard the comment.
pub fn discard_failed_op(
    pool: &DbPool,
    op_id: &str,
) -> Result<Option<(String, i64)>, DbError> {
    let mut conn = pool.get()?;
    let tx = conn.transaction()?;
    let payload_str: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM outbox WHERE id=?1 AND status='failed'",
            params![op_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(payload_str) = payload_str else {
        return Ok(None);
    };
    tx.execute(
        "UPDATE outbox SET status='discarded' WHERE id=?1",
        params![op_id],
    )?;
    let failed_tag = format!("failed:{op_id}");
    // Order matters: comments first (a failed reply lives on a real thread
    // that must survive), then any local thread the op created.
    tx.execute(
        "DELETE FROM comments WHERE pending_op=?1",
        params![failed_tag],
    )?;
    tx.execute(
        "DELETE FROM threads WHERE pending_op=?1",
        params![failed_tag],
    )?;
    tx.commit()?;
    let payload: Value = serde_json::from_str(&payload_str).unwrap_or(Value::Null);
    let repo = payload
        .get("repo")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let number = payload.get("number").and_then(|v| v.as_i64());
    Ok(repo.zip(number))
}

/// Insert an optimistic reply on an existing thread (addressed by its
/// client_key). `comment_key` is the frontend-minted identity, also embedded
/// in the reply body's marker. Returns (comment_key, repo, pr_number).
pub fn apply_optimistic_reply(
    pool: &DbPool,
    thread_key: &str,
    body: &str,
    author: &str,
    op_id: &str,
    comment_key: &str,
) -> Result<Option<(String, String, i64)>, DbError> {
    let conn = pool.get()?;
    let Some((repo, pr_number)) = thread_pr_of(&conn, thread_key)? else {
        return Ok(None);
    };
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO comments (client_key, github_id, database_id, thread_key, body, author, created_at, url, pending_op, soft_deleted)
         VALUES (?1, NULL, NULL, ?2, ?3, ?4, ?5, NULL, ?6, 0)",
        params![comment_key, thread_key, body, author, now, op_id],
    )?;
    Ok(Some((comment_key.to_string(), repo, pr_number)))
}

/// On reply success: clear pending_op on the local reply. The next poll
/// promotes it in place via the key echoed in the body marker.
pub fn finalize_reply(pool: &DbPool, op_id: &str) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    let Some(pr) = comment_pr_by_pending_op(&conn, op_id)? else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE comments SET pending_op=NULL WHERE pending_op=?1",
        params![op_id],
    )?;
    Ok(Some(pr))
}

/// On permanent reply failure: keep the local reply but re-tag it
/// `failed:<op_id>` so the UI can offer Retry/Discard instead of silently
/// destroying the user's text. See mark_optimistic_post_failed.
pub fn mark_optimistic_reply_failed(
    pool: &DbPool,
    op_id: &str,
) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    let Some(pr) = comment_pr_by_pending_op(&conn, op_id)? else {
        return Ok(None);
    };
    let failed_tag = format!("failed:{op_id}");
    conn.execute(
        "UPDATE comments SET pending_op=?2 WHERE pending_op=?1",
        params![op_id, failed_tag],
    )?;
    Ok(Some(pr))
}

/// Soft-delete a comment by its GitHub database_id, tagging with the outbox
/// op. Returns (repo, pr_number) for event emission.
pub fn apply_optimistic_delete_comment(
    pool: &DbPool,
    database_id: i64,
    op_id: &str,
) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT client_key, thread_key FROM comments WHERE database_id=?1",
            params![database_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((ckey, thread_key)) = row else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE comments SET soft_deleted=1, pending_op=?2 WHERE client_key=?1",
        params![ckey, op_id],
    )?;
    Ok(thread_pr_of(&conn, &thread_key)?)
}

/// Hard-delete the comment that was optimistically marked by `op_id`.
pub fn finalize_delete_comment(
    pool: &DbPool,
    op_id: &str,
) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT client_key, thread_key FROM comments WHERE pending_op=?1",
            params![op_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((ckey, thread_key)) = row else {
        return Ok(None);
    };
    conn.execute("DELETE FROM comments WHERE client_key=?1", params![ckey])?;
    Ok(thread_pr_of(&conn, &thread_key)?)
}

/// Restore a soft-deleted comment when the outbox op fails permanently.
pub fn revert_optimistic_delete_comment(
    pool: &DbPool,
    op_id: &str,
) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT client_key, thread_key FROM comments WHERE pending_op=?1",
            params![op_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((ckey, thread_key)) = row else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE comments SET soft_deleted=0, pending_op=NULL WHERE client_key=?1",
        params![ckey],
    )?;
    Ok(thread_pr_of(&conn, &thread_key)?)
}

pub fn get_thread_resolved(pool: &DbPool, thread_key: &str) -> Result<Option<bool>, DbError> {
    let conn = pool.get()?;
    let row: Option<i64> = conn
        .query_row(
            "SELECT is_resolved FROM threads WHERE client_key=?1",
            params![thread_key],
            |r| r.get(0),
        )
        .optional()?;
    Ok(row.map(|v| v != 0))
}

pub fn get_thread_pr(pool: &DbPool, thread_key: &str) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    Ok(thread_pr_of(&conn, thread_key)?)
}

/// The server-side GraphQL id for a thread, addressed by client_key.
/// Outer None: no such row (a legacy outbox payload may hold a raw GitHub id
/// instead of a client key). Inner None: row exists but GitHub hasn't
/// confirmed it yet - the caller should retry after the post settles.
pub fn get_thread_github_id(
    pool: &DbPool,
    thread_key: &str,
) -> Result<Option<Option<String>>, DbError> {
    let conn = pool.get()?;
    let row: Option<Option<String>> = conn
        .query_row(
            "SELECT github_id FROM threads WHERE client_key=?1",
            params![thread_key],
            |r| r.get(0),
        )
        .optional()?;
    Ok(row)
}

// ---- File content cache (keyed by repo+ref+path; immutable per ref) -----

pub fn get_file_cached(
    pool: &DbPool,
    repo: &str,
    git_ref: &str,
    path: &str,
) -> Result<Option<String>, DbError> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT content FROM file_contents WHERE repo = ?1 AND git_ref = ?2 AND path = ?3",
    )?;
    let mut rows = stmt.query(params![repo, git_ref, path])?;
    if let Some(row) = rows.next()? {
        let content: String = row.get(0)?;
        Ok(Some(content))
    } else {
        Ok(None)
    }
}

pub fn put_file(
    pool: &DbPool,
    repo: &str,
    git_ref: &str,
    path: &str,
    content: &str,
) -> Result<(), DbError> {
    let conn = pool.get()?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR REPLACE INTO file_contents (repo, git_ref, path, content, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![repo, git_ref, path, content, now],
    )?;
    Ok(())
}

// ---- PR detail / list caches (single-row JSON blobs per key) -----

pub fn get_pr_cached(pool: &DbPool, repo: &str, number: i64) -> Result<Option<Value>, DbError> {
    let conn = pool.get()?;
    let mut stmt =
        conn.prepare("SELECT json FROM pr_detail WHERE repo = ?1 AND number = ?2")?;
    let mut rows = stmt.query(params![repo, number])?;
    if let Some(row) = rows.next()? {
        let s: String = row.get(0)?;
        Ok(Some(serde_json::from_str(&s).unwrap_or(Value::Null)))
    } else {
        Ok(None)
    }
}

pub fn get_pr_fetched_at(
    pool: &DbPool,
    repo: &str,
    number: i64,
) -> Result<Option<String>, DbError> {
    let conn = pool.get()?;
    let mut stmt =
        conn.prepare("SELECT fetched_at FROM pr_detail WHERE repo = ?1 AND number = ?2")?;
    let mut rows = stmt.query(params![repo, number])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn put_pr(pool: &DbPool, repo: &str, number: i64, value: &Value) -> Result<(), DbError> {
    let conn = pool.get()?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR REPLACE INTO pr_detail (repo, number, json, fetched_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![repo, number, value.to_string(), now],
    )?;
    Ok(())
}

pub fn get_pr_list_cached(pool: &DbPool, repo: &str) -> Result<Option<Value>, DbError> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT json FROM pr_summaries WHERE repo = ?1")?;
    let mut rows = stmt.query(params![repo])?;
    if let Some(row) = rows.next()? {
        let s: String = row.get(0)?;
        Ok(Some(serde_json::from_str(&s).unwrap_or(Value::Null)))
    } else {
        Ok(None)
    }
}

/// Wipe just one PR's cache (threads, comments, fetch marker, PR detail).
/// Used by the per-PR refresh button so refreshing one PR doesn't blow
/// away every other PR's local cache. `file_contents` is left alone
/// because it's keyed by immutable head SHA, not PR number.
///
/// Pending and local rows survive, mirroring replace_threads: the outbox op
/// for an in-flight optimistic mutation outlives this wipe, so deleting its
/// local thread/comment here would make the user's just-posted comment
/// vanish from the UI on Cmd+R while the post is still retrying (and, if the
/// post later fails permanently, lose the comment text with no trace).
pub fn clear_pr_cache(
    pool: &DbPool,
    repo: &str,
    pr_number: i64,
) -> Result<(), DbError> {
    let conn = pool.get()?;
    conn.execute(
        "DELETE FROM comments
         WHERE pending_op IS NULL AND github_id IS NOT NULL
           AND thread_key IN
            (SELECT client_key FROM threads WHERE repo = ?1 AND pr_number = ?2)",
        params![repo, pr_number],
    )?;
    // Keep threads that carry a pending op, are themselves local, or still
    // own surviving comments (a confirmed thread holding a local reply).
    conn.execute(
        "DELETE FROM threads WHERE repo = ?1 AND pr_number = ?2
           AND pending_op IS NULL AND github_id IS NOT NULL
           AND client_key NOT IN (SELECT DISTINCT thread_key FROM comments)",
        params![repo, pr_number],
    )?;
    conn.execute(
        "DELETE FROM thread_fetches WHERE repo = ?1 AND pr_number = ?2",
        params![repo, pr_number],
    )?;
    conn.execute(
        "DELETE FROM pr_detail WHERE repo = ?1 AND number = ?2",
        params![repo, pr_number],
    )?;
    conn.execute(
        "DELETE FROM meta WHERE k = ?1",
        params![threads_sig_key(repo, pr_number)],
    )?;
    Ok(())
}

pub fn put_pr_list(pool: &DbPool, repo: &str, value: &Value) -> Result<(), DbError> {
    let conn = pool.get()?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR REPLACE INTO pr_summaries (repo, json, fetched_at) VALUES (?1, ?2, ?3)",
        params![repo, value.to_string(), now],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_pool() -> DbPool {
        let manager = SqliteConnectionManager::memory();
        let pool = Pool::builder().max_size(1).build(manager).unwrap();
        migrate(&pool).unwrap();
        pool
    }

    #[test]
    fn replace_and_read_threads_round_trip() {
        let pool = memory_pool();
        let nodes = vec![json!({
            "id": "T_kw1",
            "isResolved": false,
            "isOutdated": false,
            "path": "chapter-10.md",
            "line": 132,
            "startLine": 130,
            "originalLine": 132,
            "diffSide": "RIGHT",
            "comments": { "nodes": [
                {
                    "id": "PRRC_1",
                    "databaseId": 12345,
                    "body": "fix this",
                    "author": { "login": "collaborator" },
                    "createdAt": "2026-04-28T12:00:00Z",
                    "url": "https://github.com/x/y/pull/25#discussion_r12345"
                }
            ]}
        })];
        replace_threads(&pool, "Owner/repo", 25, &nodes).unwrap();

        let cached = get_threads(&pool, "Owner/repo", 25).unwrap();
        let returned_nodes = cached
            .pointer("/data/repository/pullRequest/reviewThreads/nodes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap();
        assert_eq!(returned_nodes.len(), 1);
        assert_eq!(returned_nodes[0]["id"], "T_kw1");
        assert_eq!(returned_nodes[0]["line"], 132);
        let cs = returned_nodes[0]["comments"]["nodes"].as_array().unwrap();
        assert_eq!(cs.len(), 1);
        assert_eq!(cs[0]["body"], "fix this");
        assert_eq!(cs[0]["databaseId"], 12345);
    }

    /// A file-level comment posts with no line, so both the optimistic row and
    /// the server thread that replaces it carry line = NULL. This body has no
    /// embedded key (legacy/edited case), so the coordinate sweep is what has
    /// to clean up the settled tmp - otherwise it lingers next to the real
    /// thread and the user sees their comment twice.
    #[test]
    fn file_level_tmp_is_promoted_by_matching_server_thread() {
        let pool = memory_pool();
        let op_id = "op-file-level";
        apply_optimistic_post_comment(
            &pool,
            "Owner/repo",
            25,
            "chapter-12.md",
            None,
            None,
            "> \"anchored phrase\"\n\nlooks off",
            "me",
            op_id,
            "ck-file-level",
        )
        .unwrap();
        // Post succeeded: pending_op clears, tmp stays until the server thread lands.
        finalize_post_comment(&pool, op_id).unwrap();

        // What GraphQL actually returns for a file-level thread: subjectType
        // FILE but line/originalLine reported as 1, not null. Ingestion must
        // normalize those away or promotion misses and the walker goes stale.
        let server = vec![json!({
            "id": "PRRT_real",
            "isResolved": false,
            "isOutdated": false,
            "path": "chapter-12.md",
            "line": 1,
            "startLine": Value::Null,
            "originalLine": 1,
            "diffSide": "RIGHT",
            "subjectType": "FILE",
            "comments": { "nodes": [{
                "id": "PRRC_real",
                "databaseId": 99,
                "body": "> \"anchored phrase\"\n\nlooks off",
                "author": { "login": "me" },
                "createdAt": "2026-07-22T12:00:00Z",
                "url": "https://github.com/x/y/pull/25#discussion_r99"
            }]}
        })];
        replace_threads(&pool, "Owner/repo", 25, &server).unwrap();

        let nodes = get_threads(&pool, "Owner/repo", 25).unwrap();
        let nodes = nodes
            .pointer("/data/repository/pullRequest/reviewThreads/nodes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap();
        assert_eq!(nodes.len(), 1, "tmp should be replaced, not duplicated");
        assert_eq!(nodes[0]["id"], "PRRT_real");
        assert!(nodes[0]["line"].is_null());
    }

    /// The same arrival must NOT swallow a file-level comment that is still
    /// in flight or has failed: those rows keep their pending_op and are the
    /// user's only copy of the text.
    #[test]
    fn in_flight_file_level_tmp_survives_server_thread_on_same_path() {
        let pool = memory_pool();
        apply_optimistic_post_comment(
            &pool,
            "Owner/repo",
            25,
            "chapter-12.md",
            None,
            None,
            "still sending",
            "me",
            "op-inflight",
            "ck-inflight",
        )
        .unwrap();

        let server = vec![json!({
            "id": "PRRT_other",
            "isResolved": false,
            "isOutdated": false,
            "path": "chapter-12.md",
            "line": 1,
            "startLine": Value::Null,
            "originalLine": 1,
            "diffSide": "RIGHT",
            "subjectType": "FILE",
            "comments": { "nodes": [{
                "id": "PRRC_other",
                "databaseId": 7,
                "body": "somebody else's file-level note",
                "author": { "login": "collaborator" },
                "createdAt": "2026-07-22T12:00:00Z",
                "url": "u"
            }]}
        })];
        replace_threads(&pool, "Owner/repo", 25, &server).unwrap();

        let nodes = get_threads(&pool, "Owner/repo", 25).unwrap();
        let nodes = nodes
            .pointer("/data/repository/pullRequest/reviewThreads/nodes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap();
        assert_eq!(nodes.len(), 2, "in-flight tmp must survive");
        assert!(nodes.iter().any(|n| n["comments"]["nodes"][0]["body"] == "still sending"));
    }

    /// The clientKey identity is minted by the frontend, embedded in the
    /// body's nr:v1 marker, and must survive promotion (tmp deleted, real
    /// row takes the key from the echoed marker) and every subsequent poll's
    /// delete-and-reinsert churn. If it ever flips, the frontend remounts
    /// the card (visible as a layout bounce).
    #[test]
    fn client_key_survives_promotion_and_later_polls() {
        let pool = memory_pool();
        let op_id = "op-promote";
        let body = "my comment\n\n<!-- nr:v1 {\"key\":\"ck-1\"} -->";
        let (thread_key, _) = apply_optimistic_post_comment(
            &pool, "Owner/repo", 25, "x.md", Some(10), None, body, "me", op_id, "ck-1",
        )
        .unwrap();
        assert_eq!(thread_key, "ck-1");
        finalize_post_comment(&pool, op_id).unwrap();

        let thread_nodes = |resolved: bool| {
            vec![json!({
                "id": "PRRT_real", "isResolved": resolved, "isOutdated": false,
                "path": "x.md", "line": 10, "startLine": Value::Null,
                "originalLine": 10, "diffSide": "RIGHT",
                "comments": { "nodes": [{
                    "id": "PRRC_real", "databaseId": 99, "body": body,
                    "author": { "login": "me" }, "createdAt": "2026-07-22T12:00:00Z",
                    "url": "u"
                }]}
            })]
        };

        let client_keys = |pool: &DbPool| -> Vec<(String, String)> {
            let cached = get_threads(pool, "Owner/repo", 25).unwrap();
            cached
                .pointer("/data/repository/pullRequest/reviewThreads/nodes")
                .and_then(|v| v.as_array())
                .unwrap()
                .iter()
                .map(|n| {
                    (
                        n["id"].as_str().unwrap().to_string(),
                        n["clientKey"].as_str().unwrap().to_string(),
                    )
                })
                .collect()
        };

        // Before promotion the local row is keyed (and displayed) by the
        // minted key - github_id is still NULL.
        assert_eq!(
            client_keys(&pool),
            vec![("ck-1".to_string(), "ck-1".to_string())]
        );

        // Promotion poll: real id arrives with the key echoed in its body.
        replace_threads(&pool, "Owner/repo", 25, &thread_nodes(false)).unwrap();
        assert_eq!(
            client_keys(&pool),
            vec![("PRRT_real".to_string(), "ck-1".to_string())]
        );
        // The optimistic comment row must merge with the echoed server
        // comment (same embedded key), not sit next to it as a duplicate.
        let cached = get_threads(&pool, "Owner/repo", 25).unwrap();
        let comments = cached
            .pointer("/data/repository/pullRequest/reviewThreads/nodes/0/comments/nodes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap();
        assert_eq!(comments.len(), 1, "promoted comment must not duplicate");
        assert_eq!(comments[0]["id"], "PRRC_real");

        // Next poll (no tmp anywhere): identity still carries over.
        replace_threads(&pool, "Owner/repo", 25, &thread_nodes(true)).unwrap();
        assert_eq!(
            client_keys(&pool),
            vec![("PRRT_real".to_string(), "ck-1".to_string())]
        );

        // A thread that never had a tmp keys on its server id.
        replace_threads(
            &pool,
            "Owner/repo",
            25,
            &[json!({
                "id": "PRRT_other", "isResolved": false, "isOutdated": false,
                "path": "y.md", "line": 3,
                "comments": { "nodes": [{
                    "id": "PRRC_other", "databaseId": 7, "body": "hi",
                    "author": { "login": "them" }, "createdAt": "2026-07-22T12:00:00Z",
                    "url": "u"
                }]}
            })],
        )
        .unwrap();
        assert_eq!(
            client_keys(&pool),
            vec![("PRRT_other".to_string(), "PRRT_other".to_string())]
        );
    }

    /// Regression: all file-level threads on a path share the same (path,
    /// NULL line) coordinates. When another user's file-level thread on the
    /// same file appears EARLIER in the server response than the user's
    /// just-posted thread, it must not consume the tmp or take over its
    /// identity - promotion matches on the key embedded in the body marker,
    /// not on coordinates.
    #[test]
    fn promotion_matches_embedded_key_not_coordinates_for_file_level() {
        let pool = memory_pool();
        let op_id = "op-file";
        let body = "my file note\n\n<!-- nr:v1 {\"key\":\"ck-file\"} -->";
        apply_optimistic_post_comment(
            &pool, "Owner/repo", 25, "chapter-12.md", None, None, body, "me", op_id, "ck-file",
        )
        .unwrap();
        finalize_post_comment(&pool, op_id).unwrap();

        let mk = |id: &str, cid: &str, body: &str, login: &str| {
            json!({
                "id": id, "isResolved": false, "isOutdated": false,
                "path": "chapter-12.md", "line": 1, "startLine": Value::Null,
                "originalLine": 1, "diffSide": "RIGHT", "subjectType": "FILE",
                "comments": { "nodes": [{
                    "id": cid, "databaseId": 1, "body": body,
                    "author": { "login": login }, "createdAt": "2026-07-22T12:00:00Z",
                    "url": "u"
                }]}
            })
        };
        // The unrelated thread comes FIRST, like in the real GraphQL response.
        let server = vec![
            mk("PRRT_other", "PRRC_other", "someone else's note", "them"),
            mk("PRRT_mine", "PRRC_mine", body, "me"),
        ];
        replace_threads(&pool, "Owner/repo", 25, &server).unwrap();

        let nodes = get_threads(&pool, "Owner/repo", 25).unwrap();
        let nodes = nodes
            .pointer("/data/repository/pullRequest/reviewThreads/nodes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap();
        let mut keys: Vec<(String, String)> = nodes
            .iter()
            .map(|n| {
                (
                    n["id"].as_str().unwrap().to_string(),
                    n["clientKey"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                ("PRRT_mine".to_string(), "ck-file".to_string()),
                ("PRRT_other".to_string(), "PRRT_other".to_string()),
            ],
            "the user's thread keeps the minted identity; the unrelated one keeps its own"
        );
    }

    #[test]
    fn replace_threads_removes_old_threads() {
        let pool = memory_pool();
        replace_threads(
            &pool,
            "Owner/repo",
            25,
            &[json!({
                "id": "T_old",
                "isResolved": false,
                "isOutdated": false,
                "path": "x.md",
                "line": 1,
                "comments": { "nodes": [] }
            })],
        )
        .unwrap();
        replace_threads(
            &pool,
            "Owner/repo",
            25,
            &[json!({
                "id": "T_new",
                "isResolved": false,
                "isOutdated": false,
                "path": "x.md",
                "line": 2,
                "comments": { "nodes": [] }
            })],
        )
        .unwrap();
        assert_eq!(count_threads(&pool, "Owner/repo", 25).unwrap(), 1);
    }

    #[test]
    fn threads_sig_round_trip_and_clear() {
        let pool = memory_pool();
        assert_eq!(get_threads_sig(&pool, "Owner/repo", 25).unwrap(), None);
        put_threads_sig(&pool, "Owner/repo", 25, "abc123").unwrap();
        assert_eq!(
            get_threads_sig(&pool, "Owner/repo", 25).unwrap().as_deref(),
            Some("abc123")
        );
        // Per-PR clear drops the signature so the next poll refetches, but
        // leaves unrelated meta keys alone.
        clear_pr_cache(&pool, "Owner/repo", 25).unwrap();
        assert_eq!(get_threads_sig(&pool, "Owner/repo", 25).unwrap(), None);
        let conn = pool.get().unwrap();
        let v: String = conn
            .query_row("SELECT v FROM meta WHERE k = 'schema_version'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(v, "3");
    }

    /// Enqueue + optimistic-insert a post_comment, returning its op id.
    fn queue_post(pool: &DbPool) -> String {
        let payload = json!({
            "repo": "Owner/repo", "number": 25, "commitId": "sha",
            "path": "x.md", "line": 10, "startLine": null, "body": "my comment",
        });
        let op_id = enqueue_outbox(pool, "post_comment", &payload).unwrap();
        apply_optimistic_post_comment(
            pool, "Owner/repo", 25, "x.md", Some(10), None, "my comment", "me", &op_id, "ck-post",
        )
        .unwrap();
        op_id
    }

    fn thread_bodies(pool: &DbPool) -> Vec<String> {
        let cached = get_threads(pool, "Owner/repo", 25).unwrap();
        cached
            .pointer("/data/repository/pullRequest/reviewThreads/nodes")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .flat_map(|t| t["comments"]["nodes"].as_array().unwrap().clone())
            .map(|c| c["body"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    #[test]
    fn clear_pr_cache_preserves_inflight_and_failed_comments() {
        let pool = memory_pool();
        // A canonical server thread plus an in-flight optimistic post.
        replace_threads(
            &pool,
            "Owner/repo",
            25,
            &[json!({
                "id": "T_real", "isResolved": false, "isOutdated": false,
                "path": "x.md", "line": 1,
                "comments": { "nodes": [{
                    "id": "PRRC_1", "databaseId": 1, "body": "server comment",
                    "author": { "login": "them" }, "createdAt": "2026-04-28T12:00:00Z",
                    "url": null
                }]}
            })],
        )
        .unwrap();
        let op_id = queue_post(&pool);
        assert_eq!(count_threads(&pool, "Owner/repo", 25).unwrap(), 2);

        // Refresh wipes the server thread but must keep the in-flight one.
        clear_pr_cache(&pool, "Owner/repo", 25).unwrap();
        assert_eq!(thread_bodies(&pool), vec!["my comment".to_string()]);

        // Same holds once the op has permanently failed.
        mark_optimistic_post_failed(&pool, &op_id).unwrap();
        clear_pr_cache(&pool, "Owner/repo", 25).unwrap();
        assert_eq!(thread_bodies(&pool), vec!["my comment".to_string()]);
    }

    #[test]
    fn failed_post_keeps_text_and_survives_poll() {
        let pool = memory_pool();
        let op_id = queue_post(&pool);
        mark_outbox_failed(&pool, &op_id, "422 line not in diff").unwrap();
        let pr = mark_optimistic_post_failed(&pool, &op_id).unwrap();
        assert_eq!(pr, Some(("Owner/repo".to_string(), 25)));

        // The comment is still readable and tagged failed:<op>.
        let cached = get_threads(&pool, "Owner/repo", 25).unwrap();
        let nodes = cached
            .pointer("/data/repository/pullRequest/reviewThreads/nodes")
            .and_then(|v| v.as_array())
            .unwrap()
            .clone();
        assert_eq!(nodes.len(), 1);
        let c = &nodes[0]["comments"]["nodes"][0];
        assert_eq!(c["body"], "my comment");
        assert_eq!(c["pendingOp"], format!("failed:{op_id}"));

        // A later poll bringing an unrelated thread on the same line must not
        // consume or drop the failed one.
        replace_threads(
            &pool,
            "Owner/repo",
            25,
            &[json!({
                "id": "T_other", "isResolved": false, "isOutdated": false,
                "path": "x.md", "line": 10,
                "comments": { "nodes": [{
                    "id": "PRRC_9", "databaseId": 9, "body": "someone else",
                    "author": { "login": "them" }, "createdAt": "2026-04-28T12:00:00Z",
                    "url": null
                }]}
            })],
        )
        .unwrap();
        let mut bodies = thread_bodies(&pool);
        bodies.sort();
        assert_eq!(bodies, vec!["my comment", "someone else"]);
    }

    #[test]
    fn retry_failed_op_rearms_outbox_and_rows() {
        let pool = memory_pool();
        let op_id = queue_post(&pool);
        mark_outbox_failed(&pool, &op_id, "boom").unwrap();
        mark_optimistic_post_failed(&pool, &op_id).unwrap();

        let pr = retry_failed_op(&pool, &op_id).unwrap();
        assert_eq!(pr, Some(("Owner/repo".to_string(), 25)));

        // The op is claimable again, with attempts reset.
        let claimed = claim_next_outbox(&pool).unwrap().expect("op is ready");
        assert_eq!(claimed.id, op_id);
        assert_eq!(claimed.attempts, 0);

        // Rows are back to plain pending (not `failed:`), so the UI shows
        // "sending" rather than a failed card.
        let cached = get_threads(&pool, "Owner/repo", 25).unwrap();
        let c = &cached.pointer("/data/repository/pullRequest/reviewThreads/nodes").unwrap()[0]
            ["comments"]["nodes"][0];
        assert_eq!(c["pendingOp"], op_id);

        // Retrying something that isn't failed is a no-op.
        assert_eq!(retry_failed_op(&pool, &op_id).unwrap(), None);
    }

    #[test]
    fn discard_failed_op_removes_rows() {
        let pool = memory_pool();
        let op_id = queue_post(&pool);
        mark_outbox_failed(&pool, &op_id, "boom").unwrap();
        mark_optimistic_post_failed(&pool, &op_id).unwrap();

        let pr = discard_failed_op(&pool, &op_id).unwrap();
        assert_eq!(pr, Some(("Owner/repo".to_string(), 25)));
        assert_eq!(count_threads(&pool, "Owner/repo", 25).unwrap(), 0);
        // Discarded ops never come back through the worker.
        assert!(claim_next_outbox(&pool).unwrap().is_none());
        assert_eq!(discard_failed_op(&pool, &op_id).unwrap(), None);
    }

    #[test]
    fn failed_reply_keeps_text_on_real_thread() {
        let pool = memory_pool();
        replace_threads(
            &pool,
            "Owner/repo",
            25,
            &[json!({
                "id": "T_real", "isResolved": false, "isOutdated": false,
                "path": "x.md", "line": 1,
                "comments": { "nodes": [{
                    "id": "PRRC_1", "databaseId": 1, "body": "server comment",
                    "author": { "login": "them" }, "createdAt": "2026-04-28T12:00:00Z",
                    "url": null
                }]}
            })],
        )
        .unwrap();
        let payload = json!({
            "repo": "Owner/repo", "number": 25, "inReplyTo": 1, "body": "my reply",
        });
        let op_id = enqueue_outbox(&pool, "reply", &payload).unwrap();
        apply_optimistic_reply(&pool, "T_real", "my reply", "me", &op_id, "ck-reply").unwrap();
        mark_outbox_failed(&pool, &op_id, "boom").unwrap();
        mark_optimistic_reply_failed(&pool, &op_id).unwrap();

        // Refresh keeps the failed reply AND the real thread hosting it.
        clear_pr_cache(&pool, "Owner/repo", 25).unwrap();
        assert_eq!(thread_bodies(&pool), vec!["my reply".to_string()]);

        // Discarding drops the reply but leaves the thread for the next poll.
        discard_failed_op(&pool, &op_id).unwrap();
        assert!(thread_bodies(&pool).is_empty());
    }

    /// A reply goes through the same lifecycle as a post: optimistic local
    /// row, settle, then in-place promotion when the server echoes the key
    /// marker back. No duplicate comment, identity stable throughout.
    #[test]
    fn reply_promotes_in_place_by_embedded_key() {
        let pool = memory_pool();
        replace_threads(
            &pool,
            "Owner/repo",
            25,
            &[json!({
                "id": "PRRT_real", "isResolved": false, "isOutdated": false,
                "path": "x.md", "line": 1,
                "comments": { "nodes": [{
                    "id": "PRRC_1", "databaseId": 1, "body": "server comment",
                    "author": { "login": "them" }, "createdAt": "2026-07-22T10:00:00Z",
                    "url": null
                }]}
            })],
        )
        .unwrap();

        let reply_body = "my reply\n\n<!-- nr:v1 {\"key\":\"ck-r\"} -->";
        let op_id = enqueue_outbox(
            &pool,
            "reply",
            &json!({ "repo": "Owner/repo", "number": 25, "inReplyTo": 1, "body": reply_body }),
        )
        .unwrap();
        apply_optimistic_reply(&pool, "PRRT_real", reply_body, "me", &op_id, "ck-r").unwrap();
        finalize_reply(&pool, &op_id).unwrap();

        // Server now reports both comments; the reply carries the marker.
        replace_threads(
            &pool,
            "Owner/repo",
            25,
            &[json!({
                "id": "PRRT_real", "isResolved": false, "isOutdated": false,
                "path": "x.md", "line": 1,
                "comments": { "nodes": [
                    {
                        "id": "PRRC_1", "databaseId": 1, "body": "server comment",
                        "author": { "login": "them" }, "createdAt": "2026-07-22T10:00:00Z",
                        "url": null
                    },
                    {
                        "id": "PRRC_2", "databaseId": 2, "body": reply_body,
                        "author": { "login": "me" }, "createdAt": "2026-07-22T11:00:00Z",
                        "url": null
                    }
                ]}
            })],
        )
        .unwrap();

        let nodes = get_threads(&pool, "Owner/repo", 25).unwrap();
        let comments = nodes
            .pointer("/data/repository/pullRequest/reviewThreads/nodes/0/comments/nodes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap();
        let mut ids: Vec<&str> = comments.iter().map(|c| c["id"].as_str().unwrap()).collect();
        ids.sort();
        assert_eq!(ids, vec!["PRRC_1", "PRRC_2"], "reply promoted, not duplicated");
    }

    /// Upgrading a v2-shaped cache (id-keyed tables, tmp: placeholders) must
    /// carry every row over - above all a failed comment, which is the
    /// user's only copy of unsent text.
    #[test]
    fn migrate_rebuilds_v2_shaped_db() {
        let manager = SqliteConnectionManager::memory();
        let pool = Pool::builder().max_size(1).build(manager).unwrap();
        {
            let conn = pool.get().unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE threads (
                  id TEXT PRIMARY KEY, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
                  is_resolved INTEGER NOT NULL, is_outdated INTEGER NOT NULL,
                  path TEXT, line INTEGER, start_line INTEGER, original_line INTEGER,
                  diff_side TEXT, updated_at TEXT NOT NULL, pending_op TEXT, client_key TEXT
                );
                CREATE TABLE comments (
                  id TEXT PRIMARY KEY, database_id INTEGER,
                  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                  body TEXT NOT NULL, author TEXT, created_at TEXT NOT NULL, url TEXT,
                  pending_op TEXT, soft_deleted INTEGER NOT NULL DEFAULT 0
                );
                INSERT INTO threads VALUES
                  ('PRRT_x', 'O/r', 1, 0, 0, 'a.md', 3, NULL, 3, 'RIGHT', 't', NULL, NULL),
                  ('tmp:abc', 'O/r', 1, 0, 0, 'a.md', 9, NULL, 9, 'RIGHT', 't', 'failed:op9', 'abc');
                INSERT INTO comments VALUES
                  ('PRRC_x', 5, 'PRRT_x', 'server comment', 'them', 't1', NULL, NULL, 0),
                  ('tmp:c1', NULL, 'tmp:abc', 'unsent text', 'me', 't2', NULL, 'failed:op9', 0);
                "#,
            )
            .unwrap();
        }
        migrate(&pool).unwrap();

        let nodes = get_threads(&pool, "O/r", 1).unwrap();
        let nodes = nodes
            .pointer("/data/repository/pullRequest/reviewThreads/nodes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap();
        assert_eq!(nodes.len(), 2);
        let confirmed = nodes.iter().find(|n| n["id"] == "PRRT_x").unwrap();
        assert_eq!(confirmed["clientKey"], "PRRT_x");
        assert_eq!(confirmed["comments"]["nodes"][0]["body"], "server comment");
        let failed = nodes.iter().find(|n| n["id"] == "abc").unwrap();
        assert_eq!(failed["clientKey"], "abc");
        assert_eq!(failed["pendingOp"], "failed:op9");
        assert_eq!(failed["comments"]["nodes"][0]["body"], "unsent text");
    }

    #[test]
    fn migration_runs_on_in_memory_db() {
        let manager = SqliteConnectionManager::memory();
        let pool = Pool::builder().max_size(1).build(manager).unwrap();
        migrate(&pool).unwrap();
        let conn = pool.get().unwrap();
        let v: String = conn
            .query_row(
                "SELECT v FROM meta WHERE k = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v, "3");
        // sanity: tables exist
        for table in ["threads", "comments", "outbox", "meta"] {
            let cnt: i32 = conn
                .query_row(
                    &format!("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='{table}'"),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(cnt, 1, "table {table} missing");
        }
        // The dead prs table is dropped for good (created by early schemas,
        // never written).
        let cnt: i32 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='prs'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cnt, 0, "prs table should be dropped");
    }

    /// A crash between claim (status='inflight') and settle must not strand
    /// the op: startup recovery flips it back to pending so the worker can
    /// claim it again.
    #[test]
    fn recover_inflight_outbox_requeues_orphaned_ops() {
        let pool = memory_pool();
        let op_id = queue_post(&pool);
        let claimed = claim_next_outbox(&pool).unwrap().expect("op is ready");
        assert_eq!(claimed.id, op_id);
        // Simulated crash: op left inflight, nothing claimable.
        assert!(claim_next_outbox(&pool).unwrap().is_none());

        assert_eq!(recover_inflight_outbox(&pool).unwrap(), 1);
        let reclaimed = claim_next_outbox(&pool).unwrap().expect("op requeued");
        assert_eq!(reclaimed.id, op_id);
        // Settled ops are left alone by recovery.
        mark_outbox_done(&pool, &op_id).unwrap();
        assert_eq!(recover_inflight_outbox(&pool).unwrap(), 0);
    }
}

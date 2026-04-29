use chrono::Utc;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;
use uuid::Uuid;

pub type DbPool = Pool<SqliteConnectionManager>;

const MIGRATION_V1: &str = r#"
CREATE TABLE IF NOT EXISTS prs (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT,
  body TEXT,
  head_ref TEXT,
  base_ref TEXT,
  head_oid TEXT,
  base_oid TEXT,
  state TEXT,
  url TEXT,
  author TEXT,
  is_draft INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  files_json TEXT,
  PRIMARY KEY (repo, number)
);
CREATE INDEX IF NOT EXISTS idx_prs_updated ON prs(repo, updated_at DESC);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,
  database_id INTEGER,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author TEXT,
  created_at TEXT NOT NULL,
  url TEXT,
  pending_op TEXT,
  soft_deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(thread_id);

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

const SCHEMA_VERSION: i32 = 1;

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
    Ok(pool)
}

fn migrate(pool: &DbPool) -> Result<(), DbError> {
    let conn = pool.get()?;
    conn.execute_batch(MIGRATION_V1)?;
    conn.execute(
        "INSERT OR REPLACE INTO meta(k, v) VALUES ('schema_version', ?1)",
        rusqlite::params![SCHEMA_VERSION.to_string()],
    )?;
    Ok(())
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

    // Delete non-pending, non-tmp threads. Tmp threads (`id LIKE 'tmp:%'`)
    // represent optimistic posts whose real server thread may not yet be in
    // this GraphQL response (eventual consistency, or a >100-thread PR where
    // pagination drops it). Wiping them here would make the user's just-posted
    // comment vanish from Prose even though it exists on GitHub. We delete
    // tmps below only when a real thread arrives at the same coordinates.
    tx.execute(
        "DELETE FROM threads
         WHERE repo = ?1 AND pr_number = ?2
           AND pending_op IS NULL
           AND id NOT LIKE 'tmp:%'",
        params![repo, pr_number],
    )?;

    for t in thread_nodes {
        let id = t.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let is_resolved = t.get("isResolved").and_then(|v| v.as_bool()).unwrap_or(false);
        let is_outdated = t.get("isOutdated").and_then(|v| v.as_bool()).unwrap_or(false);
        let path = t.get("path").and_then(|v| v.as_str());
        let line = t.get("line").and_then(|v| v.as_i64());
        let start_line = t.get("startLine").and_then(|v| v.as_i64());
        let original_line = t.get("originalLine").and_then(|v| v.as_i64());
        let diff_side = t.get("diffSide").and_then(|v| v.as_str());

        // A real thread arrived at coordinates that match an outstanding tmp
        // thread (settled or still pending). Promote: delete the tmp so it
        // doesn't shadow the canonical row.
        tx.execute(
            "DELETE FROM threads
             WHERE repo = ?1 AND pr_number = ?2 AND id LIKE 'tmp:%'
               AND path IS ?3 AND line IS ?4
               AND COALESCE(start_line, line) IS COALESCE(?5, ?4)",
            params![repo, pr_number, path, line, start_line],
        )?;

        tx.execute(
            "INSERT INTO threads (id, repo, pr_number, is_resolved, is_outdated, path, line, start_line, original_line, diff_side, updated_at, pending_op)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL)
             ON CONFLICT(id) DO UPDATE SET
                is_resolved = excluded.is_resolved,
                is_outdated = excluded.is_outdated,
                path = excluded.path,
                line = excluded.line,
                start_line = excluded.start_line,
                original_line = excluded.original_line,
                diff_side = excluded.diff_side,
                updated_at = excluded.updated_at
             WHERE pending_op IS NULL",
            params![
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

        // Replace comments for this thread (preserve pending and tmps -
        // tmps are cleaned up below, after we've seen the real comments).
        tx.execute(
            "DELETE FROM comments
             WHERE thread_id = ?1
               AND pending_op IS NULL
               AND id NOT LIKE 'tmp:%'",
            params![id],
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
                tx.execute(
                    "INSERT INTO comments (id, database_id, thread_id, body, author, created_at, url, pending_op, soft_deleted)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, 0)
                     ON CONFLICT(id) DO UPDATE SET
                        database_id = excluded.database_id,
                        body = excluded.body,
                        author = excluded.author,
                        created_at = excluded.created_at,
                        url = excluded.url
                     WHERE pending_op IS NULL",
                    params![cid, database_id, id, body, author, created_at, url],
                )?;

                // Promote: a real comment with matching (thread_id, author,
                // body) supersedes any tmp reply we kept around for eventual
                // consistency. Delete the tmp(s).
                tx.execute(
                    "DELETE FROM comments
                     WHERE thread_id = ?1 AND id LIKE 'tmp:%'
                       AND author IS ?2 AND body = ?3",
                    params![id, author, body],
                )?;
            }
        }
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
        "SELECT id, is_resolved, is_outdated, path, line, start_line, original_line, diff_side, pending_op
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
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut cstmt = conn.prepare(
        "SELECT id, database_id, body, author, created_at, url FROM comments
         WHERE thread_id = ?1 AND soft_deleted = 0 ORDER BY created_at, rowid",
    )?;

    let mut nodes = Vec::with_capacity(thread_rows.len());
    for (id, is_resolved, is_outdated, path, line, start_line, original_line, diff_side, pending_op) in
        thread_rows
    {
        let comments = cstmt
            .query_map(params![&id], |c| {
                Ok(json!({
                    "id": c.get::<_, String>(0)?,
                    "databaseId": c.get::<_, Option<i64>>(1)?,
                    "body": c.get::<_, String>(2)?,
                    "author": { "login": c.get::<_, Option<String>>(3)?.unwrap_or_default() },
                    "createdAt": c.get::<_, String>(4)?,
                    "url": c.get::<_, Option<String>>(5)?,
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

/// Optimistically flip is_resolved on a thread + tag with pending_op id.
/// Returns (repo, pr_number) so the caller can emit an event.
pub fn apply_optimistic_resolve(
    pool: &DbPool,
    thread_id: &str,
    resolved: bool,
    op_id: &str,
) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    let updated = conn.execute(
        "UPDATE threads SET is_resolved=?2, pending_op=?3 WHERE id=?1",
        params![thread_id, resolved as i64, op_id],
    )?;
    if updated == 0 {
        return Ok(None);
    }
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT repo, pr_number FROM threads WHERE id=?1",
            params![thread_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(row)
}

/// Clear pending_op once an op settles successfully. Subsequent poll cycles
/// will reconcile to authoritative server state.
pub fn clear_pending_op(pool: &DbPool, thread_id: &str, op_id: &str) -> Result<(), DbError> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE threads SET pending_op=NULL WHERE id=?1 AND pending_op=?2",
        params![thread_id, op_id],
    )?;
    Ok(())
}

/// On op failure, restore the thread's pre-op resolve state and clear the op tag.
pub fn revert_optimistic_resolve(
    pool: &DbPool,
    thread_id: &str,
    prior_resolved: bool,
    op_id: &str,
) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    let updated = conn.execute(
        "UPDATE threads SET is_resolved=?2, pending_op=NULL WHERE id=?1 AND pending_op=?3",
        params![thread_id, prior_resolved as i64, op_id],
    )?;
    if updated == 0 {
        return Ok(None);
    }
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT repo, pr_number FROM threads WHERE id=?1",
            params![thread_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(row)
}

/// Insert a tmp thread + tmp comment optimistically. Returns (tmp_thread_id, tmp_comment_id).
pub fn apply_optimistic_post_comment(
    pool: &DbPool,
    repo: &str,
    pr_number: i64,
    path: &str,
    line: i64,
    start_line: Option<i64>,
    body: &str,
    author: &str,
    op_id: &str,
) -> Result<(String, String), DbError> {
    let tmp_thread_id = format!("tmp:{}", Uuid::new_v4());
    let tmp_comment_id = format!("tmp:{}", Uuid::new_v4());
    let now = Utc::now().to_rfc3339();
    let conn = pool.get()?;
    conn.execute(
        "INSERT INTO threads (id, repo, pr_number, is_resolved, is_outdated, path, line, start_line, original_line, diff_side, updated_at, pending_op)
         VALUES (?1, ?2, ?3, 0, 0, ?4, ?5, ?6, ?5, 'RIGHT', ?7, ?8)",
        params![
            tmp_thread_id,
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
        "INSERT INTO comments (id, database_id, thread_id, body, author, created_at, url, pending_op, soft_deleted)
         VALUES (?1, NULL, ?2, ?3, ?4, ?5, NULL, ?6, 0)",
        params![tmp_comment_id, tmp_thread_id, body, author, now, op_id],
    )?;
    Ok((tmp_thread_id, tmp_comment_id))
}

/// On post_comment success: clear pending_op on the tmp rows. The next poll
/// cycle's replace_threads will remove the tmp thread (now non-pending) and
/// the fresh server thread will be inserted in its place.
pub fn finalize_post_comment(pool: &DbPool, op_id: &str) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    // Find the tmp thread tagged with this op
    let row: Option<(String, String, i64)> = conn
        .query_row(
            "SELECT id, repo, pr_number FROM threads WHERE pending_op=?1",
            params![op_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((thread_id, repo, pr_number)) = row else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE threads SET pending_op=NULL WHERE id=?1",
        params![thread_id],
    )?;
    conn.execute(
        "UPDATE comments SET pending_op=NULL WHERE pending_op=?1",
        params![op_id],
    )?;
    Ok(Some((repo, pr_number)))
}

/// On post_comment failure: drop the tmp rows entirely.
pub fn revert_optimistic_post_comment(
    pool: &DbPool,
    op_id: &str,
) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    let row: Option<(String, String, i64)> = conn
        .query_row(
            "SELECT id, repo, pr_number FROM threads WHERE pending_op=?1",
            params![op_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((thread_id, repo, pr_number)) = row else {
        return Ok(None);
    };
    conn.execute("DELETE FROM threads WHERE id=?1", params![thread_id])?;
    Ok(Some((repo, pr_number)))
}

/// Insert a tmp comment as a reply on an existing real thread. Returns the
/// (tmp_comment_id, repo, pr_number).
pub fn apply_optimistic_reply(
    pool: &DbPool,
    thread_id: &str,
    body: &str,
    author: &str,
    op_id: &str,
) -> Result<Option<(String, String, i64)>, DbError> {
    let conn = pool.get()?;
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT repo, pr_number FROM threads WHERE id=?1",
            params![thread_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((repo, pr_number)) = row else {
        return Ok(None);
    };
    let tmp_comment_id = format!("tmp:{}", Uuid::new_v4());
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO comments (id, database_id, thread_id, body, author, created_at, url, pending_op, soft_deleted)
         VALUES (?1, NULL, ?2, ?3, ?4, ?5, NULL, ?6, 0)",
        params![tmp_comment_id, thread_id, body, author, now, op_id],
    )?;
    Ok(Some((tmp_comment_id, repo, pr_number)))
}

/// On reply success: clear pending_op on the tmp reply. Next poll will
/// replace it with the canonical row.
pub fn finalize_reply(pool: &DbPool, op_id: &str) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    let row: Option<(String, String, i64)> = conn
        .query_row(
            "SELECT c.thread_id, t.repo, t.pr_number
             FROM comments c JOIN threads t ON t.id = c.thread_id
             WHERE c.pending_op=?1",
            params![op_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((_thread_id, repo, pr_number)) = row else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE comments SET pending_op=NULL WHERE pending_op=?1",
        params![op_id],
    )?;
    Ok(Some((repo, pr_number)))
}

/// On reply failure: drop the tmp reply.
pub fn revert_optimistic_reply(
    pool: &DbPool,
    op_id: &str,
) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    let row: Option<(String, String, i64)> = conn
        .query_row(
            "SELECT c.thread_id, t.repo, t.pr_number
             FROM comments c JOIN threads t ON t.id = c.thread_id
             WHERE c.pending_op=?1",
            params![op_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((_thread_id, repo, pr_number)) = row else {
        return Ok(None);
    };
    conn.execute(
        "DELETE FROM comments WHERE pending_op=?1",
        params![op_id],
    )?;
    Ok(Some((repo, pr_number)))
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
            "SELECT id, thread_id FROM comments WHERE database_id=?1",
            params![database_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((cid, thread_id)) = row else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE comments SET soft_deleted=1, pending_op=?2 WHERE id=?1",
        params![cid, op_id],
    )?;
    let pr: Option<(String, i64)> = conn
        .query_row(
            "SELECT repo, pr_number FROM threads WHERE id=?1",
            params![thread_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(pr)
}

/// Hard-delete the comment that was optimistically marked by `op_id`.
pub fn finalize_delete_comment(
    pool: &DbPool,
    op_id: &str,
) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT id, thread_id FROM comments WHERE pending_op=?1",
            params![op_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((cid, thread_id)) = row else {
        return Ok(None);
    };
    conn.execute("DELETE FROM comments WHERE id=?1", params![cid])?;
    let pr: Option<(String, i64)> = conn
        .query_row(
            "SELECT repo, pr_number FROM threads WHERE id=?1",
            params![thread_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(pr)
}

/// Restore a soft-deleted comment when the outbox op fails permanently.
pub fn revert_optimistic_delete_comment(
    pool: &DbPool,
    op_id: &str,
) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT id, thread_id FROM comments WHERE pending_op=?1",
            params![op_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((cid, thread_id)) = row else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE comments SET soft_deleted=0, pending_op=NULL WHERE id=?1",
        params![cid],
    )?;
    let pr: Option<(String, i64)> = conn
        .query_row(
            "SELECT repo, pr_number FROM threads WHERE id=?1",
            params![thread_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(pr)
}

pub fn get_thread_resolved(pool: &DbPool, thread_id: &str) -> Result<Option<bool>, DbError> {
    let conn = pool.get()?;
    let row: Option<i64> = conn
        .query_row(
            "SELECT is_resolved FROM threads WHERE id=?1",
            params![thread_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(row.map(|v| v != 0))
}

pub fn get_thread_pr(pool: &DbPool, thread_id: &str) -> Result<Option<(String, i64)>, DbError> {
    let conn = pool.get()?;
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT repo, pr_number FROM threads WHERE id=?1",
            params![thread_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
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

/// Wipe every cache table EXCEPT outbox. Used by the manual reload shortcut
/// so the user can blow away potentially stale cached state without losing
/// in-flight optimistic mutations (which the outbox worker is still trying
/// to drain to GitHub).
pub fn clear_cache(pool: &DbPool) -> Result<(), DbError> {
    let conn = pool.get()?;
    // Threads cascades to comments via the FK, but be explicit anyway in
    // case the cascade is ever disabled.
    conn.execute_batch(
        "DELETE FROM comments;
         DELETE FROM threads;
         DELETE FROM thread_fetches;
         DELETE FROM pr_detail;
         DELETE FROM pr_summaries;
         DELETE FROM prs;
         DELETE FROM file_contents;",
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
        assert_eq!(v, "1");
        // sanity: tables exist
        for table in ["prs", "threads", "comments", "outbox", "meta"] {
            let cnt: i32 = conn
                .query_row(
                    &format!("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='{table}'"),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(cnt, 1, "table {table} missing");
        }
    }
}

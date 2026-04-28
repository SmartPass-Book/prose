use serde_json::Value;
use std::process::Command;

fn run_gh(args: &[&str]) -> Result<String, String> {
    let out = Command::new("gh")
        .args(args)
        .output()
        .map_err(|e| format!("failed to spawn gh: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "gh {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn run_gh_stdin(args: &[&str], stdin_body: &str) -> Result<String, String> {
    use std::io::Write;
    let mut child = Command::new("gh")
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn gh: {e}"))?;
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(stdin_body.as_bytes())
        .map_err(|e| format!("stdin write: {e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("wait: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "gh {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
fn get_current_user() -> Result<String, String> {
    let out = run_gh(&["api", "user", "--jq", ".login"])?;
    Ok(out.trim().to_string())
}

#[tauri::command]
fn list_prs(repo: String) -> Result<Value, String> {
    let out = run_gh(&[
        "pr", "list", "--repo", &repo, "--state", "open", "--limit", "100", "--json",
        "number,title,headRefName,baseRefName,updatedAt,author,isDraft",
    ])?;
    serde_json::from_str(&out).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_pr(repo: String, number: u64) -> Result<Value, String> {
    let out = run_gh(&[
        "pr", "view", &number.to_string(), "--repo", &repo, "--json",
        "number,title,body,headRefName,baseRefName,headRefOid,baseRefOid,state,url,author,updatedAt,files",
    ])?;
    serde_json::from_str(&out).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_file_content(repo: String, git_ref: String, path: String) -> Result<String, String> {
    let endpoint = format!("repos/{repo}/contents/{path}?ref={git_ref}");
    let out = run_gh(&["api", "-H", "Accept: application/vnd.github.raw", &endpoint])?;
    Ok(out)
}

#[tauri::command]
fn get_review_threads(repo: String, number: u64) -> Result<Value, String> {
    let (owner, name) = repo
        .split_once('/')
        .ok_or_else(|| "repo must be owner/name".to_string())?;
    let query = format!(
        r#"
        query {{
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
    let out = run_gh(&["api", "graphql", "-f", &format!("query={query}")])?;
    serde_json::from_str(&out).map_err(|e| e.to_string())
}

#[tauri::command]
fn post_review_comment(
    repo: String,
    number: u64,
    commit_id: String,
    path: String,
    line: u64,
    start_line: Option<u64>,
    body: String,
) -> Result<Value, String> {
    let endpoint = format!("repos/{repo}/pulls/{number}/comments");
    let mut payload = serde_json::json!({
        "body": body,
        "commit_id": commit_id,
        "path": path,
        "line": line,
        "side": "RIGHT",
    });
    if let Some(sl) = start_line {
        if sl != line {
            payload["start_line"] = serde_json::json!(sl);
            payload["start_side"] = serde_json::json!("RIGHT");
        }
    }
    let body_str = serde_json::to_string(&payload).unwrap();
    let out = run_gh_stdin(
        &["api", "--method", "POST", &endpoint, "--input", "-"],
        &body_str,
    )?;
    serde_json::from_str(&out).map_err(|e| e.to_string())
}

#[tauri::command]
fn reply_to_comment(
    repo: String,
    number: u64,
    in_reply_to: u64,
    body: String,
) -> Result<Value, String> {
    let endpoint = format!("repos/{repo}/pulls/{number}/comments");
    let payload = serde_json::json!({ "body": body, "in_reply_to": in_reply_to });
    let body_str = serde_json::to_string(&payload).unwrap();
    let out = run_gh_stdin(
        &["api", "--method", "POST", &endpoint, "--input", "-"],
        &body_str,
    )?;
    serde_json::from_str(&out).map_err(|e| e.to_string())
}

#[tauri::command]
fn resolve_thread(thread_id: String, resolved: bool) -> Result<Value, String> {
    let mutation = if resolved { "resolveReviewThread" } else { "unresolveReviewThread" };
    let query = format!(
        r#"mutation {{ {mutation}(input: {{ threadId: "{thread_id}" }}) {{ thread {{ id isResolved }} }} }}"#
    );
    let out = run_gh(&["api", "graphql", "-f", &format!("query={query}")])?;
    serde_json::from_str(&out).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_current_user,
            list_prs,
            get_pr,
            get_file_content,
            get_review_threads,
            post_review_comment,
            reply_to_comment,
            resolve_thread,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

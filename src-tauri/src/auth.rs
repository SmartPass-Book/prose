//! GitHub OAuth device flow.
//!
//! Prose is distributed from a public repo (the auto-updater has to fetch
//! releases anonymously), so no client secret can ship in the binary. GitHub's
//! device flow is its only authorization flow that needs none - the web flow
//! still requires a secret at the token-exchange step even when PKCE is used.
//!
//! It also needs no redirect handling, so one code path covers both desktop
//! and iOS, where the old `gh auth token` subprocess can't run at all.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use thiserror::Error;

/// Public identifier for the "Prose" OAuth app. Not a secret - the device
/// flow authenticates the *user*, not the client, which is exactly why it is
/// safe to commit here.
pub const CLIENT_ID: &str = "Ov23ctraMal13DpjuVyM";

/// Reading PRs and posting review comments on private repos both fall under
/// `repo`. Kept in sync with `github::REQUIRED_SCOPES`.
const SCOPE: &str = "repo";

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const USER_URL: &str = "https://api.github.com/user";

const KEYRING_SERVICE: &str = "com.dhruvsringari.prose";
const KEYRING_ACCOUNT: &str = "github-oauth";

/// GitHub rejects API requests without a User-Agent.
fn user_agent() -> String {
    format!("prose/{}", env!("CARGO_PKG_VERSION"))
}

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("network error talking to GitHub: {0}")]
    Http(String),
    #[error("keychain error: {0}")]
    Keyring(String),
    #[error("{0}")]
    Other(String),
}

impl From<reqwest::Error> for AuthError {
    fn from(e: reqwest::Error) -> Self {
        AuthError::Http(e.to_string())
    }
}

impl From<keyring::Error> for AuthError {
    fn from(e: keyring::Error) -> Self {
        AuthError::Keyring(e.to_string())
    }
}

impl serde::Serialize for AuthError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Pick the rustls crypto provider for the whole process.
///
/// Both `aws-lc-rs` and `ring` are pulled in by different dependents, so
/// rustls refuses to guess and panics the moment any TLS client is built.
/// Idempotent: a second call is a no-op, so it's safe to call from startup
/// and defensively from `http()`.
pub fn install_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // Err just means something already installed a default, which is fine.
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    });
}

fn http() -> Result<reqwest::Client, AuthError> {
    install_crypto_provider();
    reqwest::Client::builder()
        .user_agent(user_agent())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(Into::into)
}

// ---- Device flow --------------------------------------------------------

/// Step 1 response: the code the user types, and the code we poll with.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// What one poll of the token endpoint told us. GitHub returns HTTP 200 for
/// every one of these, with the outcome in the body, so the status code says
/// nothing useful and the body has to be parsed.
#[derive(Debug, Clone, PartialEq)]
pub enum PollOutcome {
    Authorized {
        access_token: String,
        scopes: Vec<String>,
    },
    /// User hasn't finished entering the code yet. Keep polling.
    Pending,
    /// We polled too fast. GitHub wants the interval raised by 5s.
    SlowDown,
    /// The device code passed its 15-minute lifetime; start over.
    Expired,
    /// User clicked cancel on the GitHub authorization page.
    Denied,
    /// Anything else, including the app not having device flow enabled.
    Failed(String),
}

/// Split GitHub's space-delimited scope string into individual scopes.
/// Also tolerates the comma-delimited form used by the `X-OAuth-Scopes`
/// response header, which is a different separator for the same concept.
pub fn parse_scopes(raw: &str) -> Vec<String> {
    raw.split([' ', ','])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Classify a token-endpoint response body. Pure so the error taxonomy is
/// testable without hitting the network.
pub fn parse_poll_response(body: &Value) -> PollOutcome {
    if let Some(token) = body.get("access_token").and_then(Value::as_str) {
        if !token.is_empty() {
            let scopes = body
                .get("scope")
                .and_then(Value::as_str)
                .map(parse_scopes)
                .unwrap_or_default();
            return PollOutcome::Authorized {
                access_token: token.to_string(),
                scopes,
            };
        }
    }
    let code = body.get("error").and_then(Value::as_str).unwrap_or("");
    match code {
        "authorization_pending" => PollOutcome::Pending,
        "slow_down" => PollOutcome::SlowDown,
        "expired_token" => PollOutcome::Expired,
        "access_denied" => PollOutcome::Denied,
        "" => PollOutcome::Failed("GitHub returned no access token".into()),
        other => {
            let detail = body
                .get("error_description")
                .and_then(Value::as_str)
                .unwrap_or(other);
            PollOutcome::Failed(detail.to_string())
        }
    }
}

/// Step 1: ask GitHub for a device code and the code the user types in.
pub async fn request_device_code() -> Result<DeviceCode, AuthError> {
    let body: Value = http()?
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&[("client_id", CLIENT_ID), ("scope", SCOPE)])
        .send()
        .await?
        .json()
        .await?;

    if let Some(err) = body.get("error").and_then(Value::as_str) {
        let detail = body
            .get("error_description")
            .and_then(Value::as_str)
            .unwrap_or(err);
        // The overwhelmingly likely cause on a fresh app registration.
        if err == "device_flow_disabled" {
            return Err(AuthError::Other(
                "This GitHub OAuth app doesn't have Device Flow enabled. Turn it on in the app's settings on github.com.".into(),
            ));
        }
        return Err(AuthError::Other(detail.to_string()));
    }

    serde_json::from_value(body)
        .map_err(|e| AuthError::Other(format!("unexpected device code response: {e}")))
}

/// Step 3, one iteration.
pub async fn poll_for_token(device_code: &str) -> Result<PollOutcome, AuthError> {
    let body: Value = http()?
        .post(ACCESS_TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", CLIENT_ID),
            ("device_code", device_code),
            ("grant_type", GRANT_TYPE),
        ])
        .send()
        .await?
        .json()
        .await?;
    Ok(parse_poll_response(&body))
}

/// Read the scopes actually granted to a token, straight off the API response
/// header. Replaces scraping `gh auth status`, which needed a subprocess.
pub async fn fetch_scopes(token: &str) -> Result<Vec<String>, AuthError> {
    let res = http()?
        .get(USER_URL)
        .header("Accept", "application/vnd.github+json")
        .bearer_auth(token)
        .send()
        .await?;
    let raw = res
        .headers()
        .get("x-oauth-scopes")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    Ok(parse_scopes(&raw))
}

// ---- Token storage ------------------------------------------------------

/// Durable token storage.
///
/// Two peer implementations, not a base case with an exception, which is why
/// this is a trait rather than a `cfg` inside each operation: the branch would
/// otherwise be repeated in every one of read/write/clear. It also gives the
/// store a seam to test against - `FileStore` is exercised directly below.
trait TokenStore: Send + Sync {
    fn read(&self) -> Option<String>;
    fn write(&self, token: &str) -> Result<(), AuthError>;
    fn clear(&self) -> Result<(), AuthError>;
}

/// The real store: the OS keychain. Used by every release build, and by iOS in
/// any configuration.
struct KeychainStore;

impl KeychainStore {
    fn entry(&self) -> Result<keyring::Entry, AuthError> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(Into::into)
    }
}

impl TokenStore for KeychainStore {
    fn read(&self) -> Option<String> {
        self.entry().ok()?.get_password().ok()
    }

    fn write(&self, token: &str) -> Result<(), AuthError> {
        self.entry()?.set_password(token).map_err(Into::into)
    }

    fn clear(&self) -> Result<(), AuthError> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// A 0600 file under the app data dir, used only by macOS debug builds.
///
/// The legacy macOS Keychain gates each item on an ACL of trusted binaries
/// matched by code signature. `tauri dev` runs an unsigned `target/debug/Prose`
/// whose ad-hoc signature changes on every rebuild, so macOS sees a new
/// application each time and prompts for the password - and "Always Allow"
/// only holds until the next `cargo build`.
///
/// Release builds are signed with a stable Developer ID, so their ACL entry
/// keeps matching and they use the Keychain. iOS is unaffected either way: its
/// keychain is scoped by the app's identity rather than a binary ACL, so it
/// prompts for nothing.
///
/// The tradeoff is deliberate and development-only: the token sits on disk
/// instead of in the Keychain while you work. Drop the `FileStore` arm in
/// `init_token_store` if you would rather answer the prompt.
// Constructed only by macOS debug builds and by the tests below, so release
// and iOS builds see it as dead. Gating the type on the same cfg as its one
// caller would also hide it from `cargo test` on other hosts.
#[allow(dead_code)]
struct FileStore {
    path: std::path::PathBuf,
}

impl TokenStore for FileStore {
    fn read(&self) -> Option<String> {
        std::fs::read_to_string(&self.path)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    fn write(&self, token: &str) -> Result<(), AuthError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AuthError::Other(format!("token store: {e}")))?;
        }
        std::fs::write(&self.path, token)
            .map_err(|e| AuthError::Other(format!("token store: {e}")))?;
        // Owner-only: this is a repo-scoped token sitting on disk.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(
                &self.path,
                std::fs::Permissions::from_mode(0o600),
            );
        }
        Ok(())
    }

    fn clear(&self) -> Result<(), AuthError> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AuthError::Other(format!("token store: {e}"))),
        }
    }
}

static STORE: std::sync::OnceLock<Box<dyn TokenStore>> = std::sync::OnceLock::new();

/// Choose the token store. The single decision point - every operation below
/// goes through whatever this picked.
#[cfg_attr(
    not(all(debug_assertions, target_os = "macos")),
    allow(unused_variables)
)]
pub fn init_token_store(app_data_dir: std::path::PathBuf) {
    #[cfg(all(debug_assertions, target_os = "macos"))]
    let chosen: Box<dyn TokenStore> = Box::new(FileStore {
        path: app_data_dir.join("dev-token"),
    });
    #[cfg(not(all(debug_assertions, target_os = "macos")))]
    let chosen: Box<dyn TokenStore> = Box::new(KeychainStore);

    let _ = STORE.set(chosen);
}

/// Falls back to the keychain when setup hasn't run yet, so a token operation
/// early in startup can never silently write nowhere.
fn store() -> &'static dyn TokenStore {
    STORE.get_or_init(|| Box::new(KeychainStore)).as_ref()
}

/// In-memory copy of the token for the life of the process.
///
/// The Keychain is the durable store, but it is not always available: an
/// unsigned simulator build has no application-identifier entitlement, so
/// Keychain calls there fail with errSecMissingEntitlement. Without this
/// cache, a sign-in that genuinely succeeded would appear to fail the instant
/// the token was read back. Holding it in memory keeps the session working
/// and degrades to "sign in again next launch" instead of "can't sign in".
static MEMORY_TOKEN: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

/// Persist a token. Keychain failures are logged and tolerated - the session
/// still works, it just won't survive a restart.
pub fn store_token(token: &str) -> Result<(), AuthError> {
    if let Ok(mut slot) = MEMORY_TOKEN.write() {
        *slot = Some(token.to_string());
    }
    match store().write(token) {
        Ok(()) => Ok(()),
        Err(e) => {
            eprintln!("[auth] token store write failed, kept in memory only: {e}");
            Ok(())
        }
    }
}

/// None when nothing is stored, or when the keychain is unreachable - callers
/// treat both as "not signed in" and fall through to their next token source.
pub fn load_token() -> Option<String> {
    if let Ok(slot) = MEMORY_TOKEN.read() {
        if let Some(token) = slot.as_deref() {
            return Some(token.to_string());
        }
    }
    store().read()
}

pub fn clear_token() -> Result<(), AuthError> {
    if let Ok(mut slot) = MEMORY_TOKEN.write() {
        *slot = None;
    }
    store().clear()
}

// ---- Tauri surface ------------------------------------------------------

/// Lets a sign-in in progress be cancelled from the UI. The polling loop
/// checks this between sleeps rather than being aborted mid-request.
#[derive(Default)]
pub struct AuthState {
    cancel: std::sync::Mutex<Option<Arc<AtomicBool>>>,
}

impl AuthState {
    fn begin(&self) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut slot = self.cancel.lock().unwrap();
        if let Some(previous) = slot.replace(flag.clone()) {
            // Only one sign-in at a time; retire whatever was running.
            previous.store(true, Ordering::SeqCst);
        }
        flag
    }

    fn cancel(&self) {
        if let Some(flag) = self.cancel.lock().unwrap().take() {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthStatus {
    pub signed_in: bool,
    pub user: Option<String>,
    pub missing_scopes: Vec<String>,
}

#[tauri::command]
pub async fn auth_status(state: tauri::State<'_, crate::github::AppState>) -> Result<AuthStatus, AuthError> {
    if crate::github::resolve_token().is_none() {
        return Ok(AuthStatus {
            signed_in: false,
            user: None,
            missing_scopes: vec![],
        });
    }
    match state.ensure().await {
        Ok(client) => Ok(AuthStatus {
            signed_in: true,
            user: Some(client.user.clone()),
            missing_scopes: vec![],
        }),
        // A stored-but-rejected token (revoked, expired) is not signed in.
        Err(_) => Ok(AuthStatus {
            signed_in: false,
            user: None,
            missing_scopes: vec![],
        }),
    }
}

/// Runs the whole device flow. Emits `auth://device-code` as soon as there is
/// a code to show, then resolves when the user finishes (or doesn't).
///
/// Polling lives here rather than in the frontend so the `interval` and
/// `slow_down` backoff rules are enforced in one place.
#[tauri::command]
pub async fn auth_sign_in(
    app: tauri::AppHandle,
    auth: tauri::State<'_, AuthState>,
    state: tauri::State<'_, crate::github::AppState>,
) -> Result<AuthStatus, AuthError> {
    let cancel = auth.begin();

    let device = request_device_code().await?;
    let _ = app.emit("auth://device-code", &device);

    let deadline = std::time::Instant::now() + Duration::from_secs(device.expires_in);
    let mut interval = Duration::from_secs(device.interval.max(1));

    let token = loop {
        tokio::time::sleep(interval).await;
        if cancel.load(Ordering::SeqCst) {
            return Err(AuthError::Other("Sign-in cancelled".into()));
        }
        if std::time::Instant::now() >= deadline {
            return Err(AuthError::Other(
                "The code expired before it was entered. Try signing in again.".into(),
            ));
        }
        match poll_for_token(&device.device_code).await? {
            PollOutcome::Authorized { access_token, .. } => break access_token,
            PollOutcome::Pending => {}
            PollOutcome::SlowDown => interval += Duration::from_secs(5),
            PollOutcome::Expired => {
                return Err(AuthError::Other(
                    "The code expired before it was entered. Try signing in again.".into(),
                ))
            }
            PollOutcome::Denied => {
                return Err(AuthError::Other("Sign-in was denied on GitHub.".into()))
            }
            PollOutcome::Failed(msg) => return Err(AuthError::Other(msg)),
        }
    };

    let granted = fetch_scopes(&token).await.unwrap_or_default();
    let missing: Vec<String> = crate::github::missing_scopes(&granted)
        .into_iter()
        .map(str::to_string)
        .collect();

    store_token(&token)?;
    // Drop the client built from whatever token was in play before, so the
    // next API call picks up the one we just stored.
    state.reset().await;

    // Surfaced rather than swallowed: a token GitHub just issued that then
    // fails to build a client is a real problem (revoked app, network, SSO
    // authorization required), and reporting it as a plain "signed out"
    // leaves the user with a dead button and no idea why.
    let user = state.ensure().await.map(|c| c.user.clone()).map_err(|e| {
        eprintln!("[auth] token stored but client init failed: {e}");
        AuthError::Other(format!("GitHub accepted the sign-in but rejected the token: {e}"))
    })?;

    if let Some(pool) = state.db.get() {
        let _ = crate::db::put_cached_user(pool, &user);
    }

    let status = AuthStatus {
        signed_in: true,
        user: Some(user),
        missing_scopes: missing,
    };
    let _ = app.emit("auth://status", &status);
    Ok(status)
}

#[tauri::command]
pub async fn auth_cancel_sign_in(auth: tauri::State<'_, AuthState>) -> Result<(), AuthError> {
    auth.cancel();
    Ok(())
}

#[tauri::command]
pub async fn auth_sign_out(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::github::AppState>,
) -> Result<AuthStatus, AuthError> {
    clear_token()?;
    state.reset().await;
    let status = AuthStatus {
        signed_in: false,
        user: None,
        missing_scopes: vec![],
    };
    let _ = app.emit("auth://status", &status);
    Ok(status)
}

/// Open the GitHub verification page in the system browser. On iOS this hands
/// off to Safari, which is where the user is already signed in to GitHub.
#[tauri::command]
pub async fn auth_open_verification(app: tauri::AppHandle, url: String) -> Result<(), AuthError> {
    // Only ever open GitHub's own verification page - the URL comes from the
    // device-code response, but pinning the host keeps a compromised or
    // spoofed response from turning this into an open redirect.
    let allowed = url.starts_with("https://github.com/");
    if !allowed {
        return Err(AuthError::Other(format!("refusing to open {url}")));
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AuthError::Other(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_a_successful_token_response() {
        let body = json!({
            "access_token": "gho_abc123",
            "token_type": "bearer",
            "scope": "repo gist"
        });
        assert_eq!(
            parse_poll_response(&body),
            PollOutcome::Authorized {
                access_token: "gho_abc123".into(),
                scopes: vec!["repo".into(), "gist".into()],
            }
        );
    }

    #[test]
    fn maps_each_documented_error_code() {
        let cases = [
            ("authorization_pending", PollOutcome::Pending),
            ("slow_down", PollOutcome::SlowDown),
            ("expired_token", PollOutcome::Expired),
            ("access_denied", PollOutcome::Denied),
        ];
        for (code, want) in cases {
            assert_eq!(parse_poll_response(&json!({ "error": code })), want, "{code}");
        }
    }

    #[test]
    fn unknown_error_prefers_the_human_description() {
        let body = json!({
            "error": "unsupported_grant_type",
            "error_description": "grant_type is not supported"
        });
        assert_eq!(
            parse_poll_response(&body),
            PollOutcome::Failed("grant_type is not supported".into())
        );
    }

    #[test]
    fn an_empty_body_is_a_failure_not_a_success() {
        assert!(matches!(
            parse_poll_response(&json!({})),
            PollOutcome::Failed(_)
        ));
        // An empty-string token must not read as authorized.
        assert!(matches!(
            parse_poll_response(&json!({ "access_token": "" })),
            PollOutcome::Failed(_)
        ));
    }

    fn temp_store(name: &str) -> FileStore {
        // Nested a directory deep on purpose: write() has to create the parent,
        // which is the real behaviour on a first run before the app data dir
        // exists.
        let dir = std::env::temp_dir().join(format!("prose-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        FileStore {
            path: dir.join("dev-token"),
        }
    }

    #[test]
    fn file_store_round_trips_a_token() {
        let store = temp_store("roundtrip");
        assert_eq!(store.read(), None, "nothing stored yet");
        store.write("gho_abc123").unwrap();
        assert_eq!(store.read().as_deref(), Some("gho_abc123"));
        store.clear().unwrap();
        assert_eq!(store.read(), None, "cleared");
    }

    #[test]
    fn file_store_clear_is_idempotent() {
        // Signing out twice, or signing out having never signed in, must not
        // surface an error to the user.
        let store = temp_store("idempotent");
        store.clear().unwrap();
        store.write("t").unwrap();
        store.clear().unwrap();
        store.clear().unwrap();
    }

    #[test]
    fn file_store_treats_a_blank_file_as_absent() {
        // A truncated or half-written file must read as "not signed in" rather
        // than handing an empty string to the API client.
        let store = temp_store("blank");
        store.write("   \n").unwrap();
        assert_eq!(store.read(), None);
    }

    #[cfg(unix)]
    #[test]
    fn file_store_writes_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let store = temp_store("perms");
        store.write("secret").unwrap();
        let mode = std::fs::metadata(&store.path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "token must not be group/world readable");
    }

    #[test]
    fn scope_parsing_handles_both_separators() {
        // Token response uses spaces; the X-OAuth-Scopes header uses commas.
        assert_eq!(parse_scopes("repo gist"), vec!["repo", "gist"]);
        assert_eq!(parse_scopes("repo, gist"), vec!["repo", "gist"]);
        assert!(parse_scopes("").is_empty());
        assert!(parse_scopes("   ").is_empty());
    }
}

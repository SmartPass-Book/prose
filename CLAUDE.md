# Prose

Native macOS + iOS Tauri app for narrative PR review. Frontend: React + TypeScript + Vite. Backend: Rust (Tauri 2). Distribution: GitHub Releases with signed + notarized DMG and Tauri auto-updater (desktop only).

## Layout

- `src/` - React frontend. Entry: `main.tsx`. Updater integration: `updater.ts`.
  - `App.tsx` - auth gate + platform switch. `DesktopApp` is the three-pane review UI; `MobileApp` is the iOS stack.
  - `mobile/` - iOS-only screens (PR list, file sheet, thread sheet, composer). Tailwind-styled.
  - `mobile.css` - Tailwind entry, imported **without preflight** so it can't restyle the desktop UI.
  - `lib/platform.ts` - `isMobilePlatform()` / `supportsUpdater()`.
- `src-tauri/src/` - Rust backend.
  - `lib.rs` - Tauri builder, plugins, command registration.
  - `desktop.rs` - **the only platform seam in the backend**: desktop-only plugins (updater) and the native menu. `#[cfg(desktop)] mod desktop;` means the whole file compiles out on mobile, so `run()` carries one platform branch rather than scattered gating.
  - `auth.rs` - GitHub OAuth device flow, Keychain token storage, auth commands.
  - `github.rs` - token resolution + `octocrab` API calls.
  - `db.rs` - SQLite cache (rusqlite + r2d2 pool).
  - `sync.rs` - background poll loop + outbox worker for mutations.
  - `events.rs` - frontend↔backend event types.
- `src-tauri/tauri.conf.json` - app config, bundle settings, updater endpoints/pubkey.
- `src-tauri/capabilities/` - `default.json` (all platforms) + `desktop.json` (updater, window dragging).
- `src-tauri/gen/apple/` - generated Xcode project (`tauri ios init`).
- `.github/workflows/release.yml` - cache-warm on push to main, sign + notarize + publish on tag.

## Auth

GitHub **OAuth device flow**. Client ID `Ov23ctraMal13DpjuVyM` is in `auth.rs` - it is a public identifier, not a secret. The device flow is the only GitHub flow that needs no client secret (the web flow requires one even with PKCE), which matters because this repo is **public** so the auto-updater can fetch releases anonymously.

`github::resolve_token()` has exactly one source on every platform: the OAuth token in the Keychain. The `gh auth token` subprocess fallback was removed - it only ever worked on desktop, and keeping it meant desktop and iOS could disagree about who was signed in. **The `gh` CLI is no longer a dependency of the app at runtime.**

Scopes are read from the `X-OAuth-Scopes` header on `GET /user` rather than by parsing `gh auth status`, so scope checking works on iOS too. Required scope: `repo`.

Distribution decision documented in [LICENSE](./LICENSE): source is publicly viewable for distribution/auto-update only, all rights reserved.

## iOS

### Prerequisites

- Xcode with a **matching iOS platform installed** (`xcodebuild -downloadPlatform iOS`). Having the SDK is not enough - if the platform is missing, `xcodebuild -showdestinations` lists no simulators and `tauri ios dev` silently falls back to "Opening Xcode" instead of building.
- Rust targets: `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`
- CocoaPods: `brew install cocoapods`

### Running

```bash
bun tauri ios dev "iPhone 17 Pro"
```

### Platform seams

Rather than `cfg` checks spread through the code, every desktop/mobile difference lives in one of these places. If you add a platform difference, put it in one of them instead of introducing a new branch:

| Seam | What diverges |
|---|---|
| `src-tauri/src/desktop.rs` | Desktop-only plugins (updater) + native menu. Whole file is `#[cfg(desktop)]`; `run()` has a single `desktop::extend(builder)` call. |
| `src-tauri/Cargo.toml` | `tauri-plugin-updater` is a target-gated dependency, so it isn't linked on iOS at all. |
| `src-tauri/capabilities/` | `default.json` (all platforms) vs `desktop.json` (`platforms: [macOS, windows, linux]`). |
| `src/lib/platform.ts` | Frontend capability checks: `isMobilePlatform()`, `supportsUpdater()`. |
| `src/App.tsx` | Chooses `DesktopApp` vs `MobileApp` after the auth gate. |
| `src/mobile/` | The iOS-only screens. |

That is the complete list - the backend has exactly two `#[cfg(desktop)]` sites (the `mod` declaration and the one call).

### Gotchas found the hard way

- **`octocrab` needs the `rustls-webpki-tokio` feature.** Without it octocrab builds its hyper-rustls connector with `with_native_roots()`, and iOS exposes no system trust store - every `api.github.com` call fails the TLS handshake there while working fine on macOS.
- **`reqwest`'s TLS features are named explicitly.** The only other reqwest dependent is `tauri-plugin-updater`, which is desktop-only, so relying on feature unification would leave iOS with no TLS backend.
- **A rustls crypto provider must be installed at startup** (`auth::install_crypto_provider`). Both `aws-lc-rs` and `ring` end up in the tree, so rustls can't infer a process default and panics the first time any TLS client is built.
- **`App.css` is imported from `mobile.css` inside a cascade layer**, not from `App.tsx`. Unlayered CSS beats every `@layer` regardless of specificity, so while App.css sat outside the layers its global `button {}` rule silently overrode every Tailwind utility on the mobile screens.
- **A mobile composer must carry the `composer` class.** `useCommentSelection` dismisses the composer on any pointer-down outside `.composer`, so without it the submit button dismissed the sheet before the click fired and comments were silently dropped.

## Release process

Releases are tag-driven. Pushing a `v*` tag to GitHub triggers `.github/workflows/release.yml` which builds, signs with Developer ID, notarizes with Apple, and publishes a GitHub Release containing the DMG, app tarball, signature, and `latest.json` (consumed by the in-app updater).

### Steps to ship a release

1. Bump version in **all three** files (must match):
   - `src-tauri/tauri.conf.json` → `version`
   - `package.json` → `version`
   - `src-tauri/Cargo.toml` → `[package].version`
2. Run `cargo check` in `src-tauri/` to update `Cargo.lock`.
3. Commit (the version bump alone is fine), push to `main`. Wait for the cache-warm job to finish so the tag run restores rust-cache from main.
4. `git tag vX.Y.Z && git push origin vX.Y.Z`.
5. Watch the run at https://github.com/SmartPass-Book/prose/actions.

### Auto-update flow

`src/updater.ts::checkForUpdates` runs silently on app boot. The native menu's "Check for Updates..." item (registered in `lib.rs`) emits `menu://check-for-updates`, picked up by `registerUpdateMenuListener()` for an interactive check that surfaces "you're up to date" / error dialogs. The updater polls `https://github.com/SmartPass-Book/prose/releases/latest/download/latest.json` (configured in `tauri.conf.json` under `plugins.updater.endpoints`).

### Required GitHub secrets

These must exist on the repo for the workflow to succeed:

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater signing key (`~/.tauri/prose.key` contents) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the above |
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` password (must be non-empty - macOS keychain rejects passwordless `.p12`) |
| `APPLE_SIGNING_IDENTITY` | Full identity string, e.g. `Developer ID Application: Ebuyworld.com, Inc. (TEAMID)` |
| `APPLE_ID` | Apple ID email |
| `APPLE_PASSWORD` | App-specific password from appleid.apple.com (not the Apple ID password) |
| `APPLE_TEAM_ID` | 10-char team ID from developer.apple.com |

## Local dev

- `bun run tauri dev` - run the app with HMR.
- `bun run build` - frontend production build.
- `cd src-tauri && cargo check` - fast Rust check.
- `cd src-tauri && cargo test` - Rust unit tests.

## Conventions

- No emoji in code, comments, or commit messages.
- Single hyphen `-` instead of em dash or `--` (per user's global rule).
- Use `bun`, not `npm` / `yarn`.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
Use 'bd' for task tracking

## Figures in chapters

Chapters reference images with repo-relative paths (`![alt](assets/chapter-02/x.svg)` from `story/abridged/chapter-02.md`). The webview cannot load those itself: relative URLs resolve against the dev server or the `tauri://` origin, and **the repo is private**, so the bytes need an `Authorization` header that an `<img src>` cannot carry.

So `github::get_asset_data_url` fetches them authenticated and returns a `data:` URL, cached per `(repo, ref, path)` like text files. `src/components/RepoImage.tsx` resolves the relative path (`lib/repoPaths.ts`) and swaps in the data URL, and is wired in as the `img` renderer in `useThreadPresentation`'s `markdownComponents`, so desktop and mobile both get it.

Assets over 1MB fall back to the git blobs API - the contents API refuses to inline anything larger and returns an empty `content` with a sha.

## Token storage

`auth.rs` defines a `TokenStore` trait with two implementations, chosen once in `init_token_store`:

- `KeychainStore` - every release build, and iOS in any configuration.
- `FileStore` - **macOS debug builds only**. The legacy macOS Keychain gates items on an ACL of trusted binaries matched by code signature, and `tauri dev` runs an unsigned `target/debug/Prose` whose ad-hoc signature changes on every rebuild, so macOS prompts for the password every launch and "Always Allow" only holds until the next `cargo build`. The dev token goes to a 0600 file under the app data dir instead.

Release builds are signed with a stable Developer ID, so their ACL entry keeps matching. iOS is scoped by app identity rather than a binary ACL and never prompts.

The trait exists because there are two *peer* implementations and three operations - without it the same `cfg` branch is repeated in read, write and clear. It also gives `FileStore` a seam to test against.

The modern **data protection keychain** (`kSecUseDataProtectionKeychain`) would avoid ACL prompts entirely, but `keyring` 3.6 cannot reach it on macOS (`macos.rs` hardcodes the legacy `SecKeychain`; only `ios.rs` uses the generic SecItem API), and it requires a `keychain-access-groups` entitlement that an unsigned dev binary does not have - so it would not fix the dev prompt anyway.

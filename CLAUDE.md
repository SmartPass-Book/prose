# Prose

Native macOS Tauri app for narrative PR review. Frontend: React + TypeScript + Vite. Backend: Rust (Tauri 2). Distribution: GitHub Releases with signed + notarized DMG and Tauri auto-updater.

## Layout

- `src/` - React frontend. Entry: `main.tsx`. Updater integration: `updater.ts`.
- `src-tauri/src/` - Rust backend.
  - `lib.rs` - Tauri builder, plugins, native menu, command registration.
  - `github.rs` - shells out to `gh` CLI for auth + scopes; uses `octocrab` for API calls.
  - `db.rs` - SQLite cache (rusqlite + r2d2 pool).
  - `sync.rs` - background poll loop + outbox worker for mutations.
  - `events.rs` - frontend↔backend event types.
- `src-tauri/tauri.conf.json` - app config, bundle settings, updater endpoints/pubkey.
- `src-tauri/capabilities/default.json` - plugin permissions.
- `.github/workflows/release.yml` - cache-warm on push to main, sign + notarize + publish on tag.

## Auth

App reads the user's GitHub token via `gh auth token` for API calls. The repo is **public** (so the auto-updater works anonymously without needing a token). Distribution decision documented in [LICENSE](./LICENSE): source is publicly viewable for distribution/auto-update only, all rights reserved.

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

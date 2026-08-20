//! Getting the Kokoro weights onto disk.
//!
//! The model is not bundled in the DMG. The updater ships whole app tarballs,
//! so a bundled 163MB model would be re-downloaded on every patch release, for
//! a file that never changes. It lives in the app data dir instead and is
//! fetched once, on the first play.

use {
    serde::Serialize,
    sha2::{Digest, Sha256},
    std::{
        io::Write,
        path::{Path, PathBuf},
    },
    tauri::{AppHandle, Emitter},
    tokio::sync::Mutex,
};

/// Where the bytes come from, in order.
///
/// The mirror is primary so a core feature does not depend on a third party's
/// uptime or rate limits. Hugging Face is the upstream the mirror was copied
/// from, kept as a fallback because a failed 163MB download is the difference
/// between the feature working and not. Both serve identical bytes: the SHA-256
/// check below is what makes trying a second source safe.
const SOURCES: &[&str] = &[
    "https://github.com/SmartPass-Book/prose/releases/download/tts-models-v1",
    "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main",
];

/// Where a given source keeps a given file.
///
/// Release assets are flat, one namespace per tag. The Hugging Face repo is a
/// tree - the model sits under `onnx/` and the voices under `voices/` - so the
/// upstream path is pinned per asset rather than guessed from the filename.
fn source_url(source: &str, asset: &Asset) -> String {
    if source.contains("huggingface.co") {
        format!("{source}/{}", asset.hf_path)
    } else {
        format!("{source}/{}", asset.name)
    }
}

const MAX_ATTEMPTS: usize = 3;

/// One downloadable file, pinned by hash.
///
/// The hash is not paranoia about the network. It is what lets the file at the
/// final path be trusted on every later launch without re-reading 163MB: a
/// download lands in `.part` and is only renamed after it verifies, so anything
/// at the real path already passed.
#[derive(Debug, Clone, Copy)]
pub struct Asset {
    /// Flat name, used both on disk and as the release asset name.
    pub name: &'static str,
    /// Path within the upstream Hugging Face repo.
    pub hf_path: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
}

/// fp32, not fp16, and this is a correctness decision rather than a quality
/// preference: the fp16 export's decoder overflows for scattered style-vector
/// rows and emits an all-NaN waveform - pure silence, no error, and only for
/// certain sentence lengths. Measured over rows 0-69 of af_heart, fp16 produced
/// NaN on 4-6 rows per sentence while fp32 produced none. A model that silently
/// skips sentences is useless for proofreading by ear, which is the whole
/// feature. See "fp16 emits NaN" in docs/adr/0001-chapter-audio-player.md.
pub const MODEL: Asset = Asset {
    name: "model_fp32.onnx",
    hf_path: "onnx/model.onnx",
    sha256: "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb",
    bytes: 325_532_232,
};

/// The fp16 model an earlier build downloaded. Deleted when found: it is 163MB
/// of dead weight next to the fp32 file that replaced it.
const STALE_MODELS: &[&str] = &["model_fp16.onnx"];

/// The 115-entry IPA vocabulary. `Synthesizer::load` reads it for the
/// character-to-token-id map.
pub const TOKENIZER: Asset = Asset {
    name: "tokenizer.json",
    hf_path: "tokenizer.json",
    sha256: "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
    bytes: 3_497,
};

pub struct VoiceInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub asset: Asset,
}

/// Kokoro ships 55 voices. Offering all of them is a worse picker, not a better
/// one, and most of them are graded D or below on the model card. These are six
/// of the highest-graded, spread across accent and register so the choice is
/// about the reading and not about hunting for one that is merely competent.
/// Each is 510x1x256 f32, about 510KB, fetched only when selected.
pub const VOICES: &[VoiceInfo] = &[
    VoiceInfo {
        id: "af_heart",
        label: "Heart (American, female)",
        asset: Asset {
            name: "af_heart.bin",
            hf_path: "voices/af_heart.bin",
            sha256: "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
            bytes: 522_240,
        },
    },
    VoiceInfo {
        id: "af_bella",
        label: "Bella (American, female)",
        asset: Asset {
            name: "af_bella.bin",
            hf_path: "voices/af_bella.bin",
            sha256: "f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b",
            bytes: 522_240,
        },
    },
    VoiceInfo {
        id: "am_michael",
        label: "Michael (American, male)",
        asset: Asset {
            name: "am_michael.bin",
            hf_path: "voices/am_michael.bin",
            sha256: "1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1",
            bytes: 522_240,
        },
    },
    VoiceInfo {
        id: "am_fenrir",
        label: "Fenrir (American, male)",
        asset: Asset {
            name: "am_fenrir.bin",
            hf_path: "voices/am_fenrir.bin",
            sha256: "c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43",
            bytes: 522_240,
        },
    },
    VoiceInfo {
        id: "bf_emma",
        label: "Emma (British, female)",
        asset: Asset {
            name: "bf_emma.bin",
            hf_path: "voices/bf_emma.bin",
            sha256: "669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73",
            bytes: 522_240,
        },
    },
    VoiceInfo {
        id: "bm_george",
        label: "George (British, male)",
        asset: Asset {
            name: "bm_george.bin",
            hf_path: "voices/bm_george.bin",
            sha256: "c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc",
            bytes: 522_240,
        },
    },
];

pub const DEFAULT_VOICE: &str = "af_heart";

pub fn voice(id: &str) -> Option<&'static VoiceInfo> {
    VOICES.iter().find(|v| v.id == id)
}

#[derive(Debug)]
pub enum FetchError {
    UnknownVoice(String),
    Io(String),
    Http { asset: &'static str, detail: String },
    Corrupt { asset: &'static str, got: String },
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownVoice(id) => write!(f, "unknown voice: {id}"),
            Self::Io(detail) => write!(f, "writing model files: {detail}"),
            Self::Http { asset, detail } => write!(f, "downloading {asset}: {detail}"),
            Self::Corrupt { asset, got } => {
                write!(f, "{asset} failed its checksum (got {got})")
            }
        }
    }
}

/// Every download is retryable, because every one of these is a transient
/// network problem rather than a broken install. A corrupt file is included:
/// the `.part` is discarded and the next attempt starts clean.
impl FetchError {
    pub fn retryable(&self) -> bool {
        !matches!(self, Self::UnknownVoice(_))
    }
}

pub const TTS_DOWNLOAD_PROGRESS: &str = "tts:download-progress";

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    /// File being fetched, so the UI can say "model" rather than a byte count.
    pub asset: String,
    pub received: u64,
    pub total: u64,
    /// Which asset of how many, for a first-play sequence that fetches both the
    /// model and a voice.
    pub step: usize,
    pub steps: usize,
}

/// Paths to everything `Synthesizer::load` and `VoicePack::load` need.
pub struct ModelPaths {
    pub model: PathBuf,
    pub tokenizer: PathBuf,
    pub voice: PathBuf,
}

/// Serializes first-play downloads. Two blocks clicked in quick succession
/// would otherwise both start a 163MB fetch into the same `.part` file.
static DOWNLOAD_LOCK: Mutex<()> = Mutex::const_new(());

pub fn models_dir(app: &AppHandle) -> Result<PathBuf, FetchError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| FetchError::Io(format!("app_data_dir: {e}")))?
        .join("tts");
    std::fs::create_dir_all(&dir).map_err(|e| FetchError::Io(e.to_string()))?;
    Ok(dir)
}

/// True when every file the given voice needs is already on disk, so the caller
/// can skip the "downloading" UI entirely rather than flashing it.
pub fn is_ready(app: &AppHandle, voice_id: &str) -> bool {
    let Some(v) = voice(voice_id) else { return false };
    let Ok(dir) = models_dir(app) else {
        return false;
    };
    [MODEL, TOKENIZER, v.asset]
        .iter()
        .all(|a| present(&dir.join(a.name), a))
}

/// Make sure the model, the tokenizer and one voice are on disk, downloading
/// whatever is missing.
pub async fn ensure(app: &AppHandle, voice_id: &str) -> Result<ModelPaths, FetchError> {
    let v = voice(voice_id).ok_or_else(|| FetchError::UnknownVoice(voice_id.to_string()))?;
    let dir = models_dir(app)?;
    let _guard = DOWNLOAD_LOCK.lock().await;

    for stale in STALE_MODELS {
        let path = dir.join(stale);
        if path.exists() {
            tts_log!("removing stale {stale}");
            let _ = std::fs::remove_file(&path);
        }
    }

    let wanted = [MODEL, TOKENIZER, v.asset];
    let missing: Vec<&Asset> = wanted
        .iter()
        .filter(|a| !present(&dir.join(a.name), a))
        .collect();

    for (i, asset) in missing.iter().enumerate() {
        fetch_one(app, &dir, asset, i + 1, missing.len()).await?;
    }

    Ok(ModelPaths {
        model: dir.join(MODEL.name),
        tokenizer: dir.join(TOKENIZER.name),
        voice: dir.join(v.asset.name),
    })
}

/// A file at the final path has already been verified, so the size is a cheap
/// guard against a half-written file from an older build rather than a real
/// integrity check.
fn present(path: &Path, asset: &Asset) -> bool {
    std::fs::metadata(path).map(|m| m.len()).ok() == Some(asset.bytes)
}

async fn fetch_one(
    app: &AppHandle,
    dir: &Path,
    asset: &Asset,
    step: usize,
    steps: usize,
) -> Result<(), FetchError> {
    let mut last: Option<FetchError> = None;
    for attempt in 1..=MAX_ATTEMPTS {
        // Rotate sources across attempts, so a mirror that is missing the file
        // costs one attempt rather than all of them.
        let source = SOURCES[(attempt - 1) % SOURCES.len()];
        match try_fetch(app, dir, asset, source, step, steps).await {
            Ok(()) => return Ok(()),
            Err(e) if e.retryable() && attempt < MAX_ATTEMPTS => {
                tts_log!("{} attempt {attempt} failed: {e}", asset.name);
                last = Some(e);
                tokio::time::sleep(std::time::Duration::from_millis(500 * attempt as u64)).await;
            }
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or(FetchError::Http {
        asset: asset.name,
        detail: "no attempts made".into(),
    }))
}

async fn try_fetch(
    app: &AppHandle,
    dir: &Path,
    asset: &Asset,
    source: &str,
    step: usize,
    steps: usize,
) -> Result<(), FetchError> {
    let part = dir.join(format!("{}.part", asset.name));
    let url = source_url(source, asset);

    // Resume a partial download rather than restarting it. On a 163MB file over
    // a connection bad enough to have dropped once, starting over is how a
    // download never finishes.
    let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let have = if have >= asset.bytes { 0 } else { have };

    let mut request = reqwest::Client::new().get(&url);
    if have > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let response = request.send().await.map_err(|e| FetchError::Http {
        asset: asset.name,
        detail: e.to_string(),
    })?;

    let status = response.status();
    if !status.is_success() {
        return Err(FetchError::Http {
            asset: asset.name,
            detail: format!("{url} returned {status}"),
        });
    }
    // A server that ignores the Range header answers 200 with the whole file,
    // and appending that to what we already have would silently corrupt it.
    let resuming = have > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
    let mut received = if resuming { have } else { 0 };

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resuming)
        .truncate(!resuming)
        .open(&part)
        .map_err(|e| FetchError::Io(e.to_string()))?;

    tts_log!(
        "fetching {} from {source} ({}resuming at {received})",
        asset.name,
        if resuming { "" } else { "not " }
    );

    let mut response = response;
    let mut last_emit = std::time::Instant::now();
    emit(app, asset, received, step, steps);
    loop {
        let chunk = response.chunk().await.map_err(|e| FetchError::Http {
            asset: asset.name,
            detail: e.to_string(),
        })?;
        let Some(chunk) = chunk else { break };
        file.write_all(&chunk)
            .map_err(|e| FetchError::Io(e.to_string()))?;
        received += chunk.len() as u64;
        // Throttled: a 163MB download is tens of thousands of chunks, and one
        // IPC message each would cost more than the download.
        if last_emit.elapsed() >= std::time::Duration::from_millis(200) {
            emit(app, asset, received, step, steps);
            last_emit = std::time::Instant::now();
        }
    }
    file.flush().map_err(|e| FetchError::Io(e.to_string()))?;
    drop(file);

    let digest = hash_file(&part)?;
    if digest != asset.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(FetchError::Corrupt {
            asset: asset.name,
            got: digest,
        });
    }

    std::fs::rename(&part, dir.join(asset.name)).map_err(|e| FetchError::Io(e.to_string()))?;
    emit(app, asset, asset.bytes, step, steps);
    tts_log!("{} verified and installed", asset.name);
    Ok(())
}

fn emit(app: &AppHandle, asset: &Asset, received: u64, step: usize, steps: usize) {
    let _ = app.emit(
        TTS_DOWNLOAD_PROGRESS,
        DownloadProgress {
            asset: asset.name.to_string(),
            received,
            total: asset.bytes,
            step,
            steps,
        },
    );
}

fn hash_file(path: &Path) -> Result<String, FetchError> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| FetchError::Io(e.to_string()))?;
    let mut hasher = Sha256::new();
    // Streamed in 64KB bites rather than read to a Vec: this runs over a 163MB
    // file, and sha2 0.11 does not implement io::Write for us to copy into.
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| FetchError::Io(e.to_string()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_voice_has_a_distinct_id_and_file() {
        let mut ids: Vec<&str> = VOICES.iter().map(|v| v.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate voice id");

        for v in VOICES {
            assert_eq!(
                v.asset.name,
                format!("{}.bin", v.id),
                "voice file must be named after its id, or `ensure` fetches the wrong one"
            );
        }
    }

    #[test]
    fn the_default_voice_is_one_we_offer() {
        assert!(voice(DEFAULT_VOICE).is_some());
    }

    #[test]
    fn every_pinned_hash_is_a_sha256() {
        for asset in [MODEL, TOKENIZER].iter().chain(VOICES.iter().map(|v| &v.asset)) {
            assert_eq!(asset.sha256.len(), 64, "{}", asset.name);
            assert!(
                asset.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()),
                "{} must be lowercase hex to compare against hash_file",
                asset.name
            );
        }
    }

    #[test]
    fn every_voice_pack_is_the_shape_the_synthesizer_expects() {
        // 510 token lengths x 1 x 256 f32. A voice of any other size would fail
        // deep inside VoicePack::load instead of here.
        for v in VOICES {
            assert_eq!(v.asset.bytes, 510 * 256 * 4, "{}", v.id);
        }
    }

    #[test]
    fn each_source_gets_its_own_layout() {
        let hf = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main";
        let release = "https://github.com/SmartPass-Book/prose/releases/download/tts-models-v1";
        let bella = VOICES[1].asset;
        assert_eq!(source_url(hf, &bella), format!("{hf}/voices/af_bella.bin"));
        assert_eq!(source_url(release, &bella), format!("{release}/af_bella.bin"));
        // The trap this catches: the model is under onnx/ upstream (and named
        // model.onnx there) but flat in a release, and getting it wrong is a
        // 404 rather than a build error.
        assert_eq!(source_url(hf, &MODEL), format!("{hf}/onnx/model.onnx"));
        assert_eq!(source_url(release, &MODEL), format!("{release}/model_fp32.onnx"));
    }

    /// The check a unit test structurally cannot make: that the pinned paths
    /// exist. The first version of this file had the model at the root of the
    /// Hugging Face repo, where it is actually under `onnx/`, and every test
    /// passed. Run with `cargo test -- --ignored reachable`.
    #[test]
    #[ignore = "network"]
    fn every_pinned_url_is_reachable() {
        let all: Vec<Asset> = [MODEL, TOKENIZER]
            .into_iter()
            .chain(VOICES.iter().map(|v| v.asset))
            .collect();
        let mut missing = Vec::new();
        for source in SOURCES {
            for asset in &all {
                let url = source_url(source, asset);
                let status = std::process::Command::new("curl")
                    .args(["-sIL", "-o", "/dev/null", "-w", "%{http_code}", &url])
                    .output()
                    .expect("curl");
                let code = String::from_utf8_lossy(&status.stdout).to_string();
                println!("{code} {url}");
                if code != "200" {
                    missing.push(format!("{code} {url}"));
                }
            }
        }
        // The mirror is allowed to be absent - the fallback exists for exactly
        // that - but every asset must be reachable from at least one source.
        for asset in &all {
            let reachable = SOURCES
                .iter()
                .any(|s| !missing.iter().any(|m| m.ends_with(&source_url(s, asset))));
            assert!(reachable, "{} is not reachable from any source", asset.name);
        }
    }

    #[test]
    fn an_unknown_voice_is_not_retried() {
        assert!(!FetchError::UnknownVoice("nope".into()).retryable());
        assert!(FetchError::Corrupt {
            asset: "x",
            got: "y".into()
        }
        .retryable());
    }
}

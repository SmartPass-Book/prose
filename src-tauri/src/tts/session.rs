//! The commands the player calls, and the loaded model they share.
//!
//! Chunking, ordering and lookahead all live in the frontend. This side is a
//! pure function from a sentence to audio, deliberately: the reader skipping
//! backwards mid-paragraph is most of what proofreading by ear consists of, and
//! a backend that owned a play queue would have to be told to throw it away on
//! every skip. The frontend owns the queue and asks for what it needs next.

use {
    super::{
        fetch::{self, DEFAULT_VOICE},
        Synthesizer, TtsError, VoicePack,
    },
    base64::{engine::general_purpose::STANDARD, Engine},
    sha2::{Digest, Sha256},
    serde::Serialize,
    std::sync::Arc,
    tauri::AppHandle,
    tokio::sync::Mutex,
};

/// The model, held across chunks.
///
/// Loading is seconds of work for a 163MB file, so it cannot happen per
/// sentence. `Synthesizer::synth` needs `&mut self` because misaki's lexicon
/// learns out-of-vocabulary pronunciations as it goes, which means one
/// synthesis at a time anyway - and that is the right shape regardless, since
/// two ORT sessions on the same CPU only slow each other down.
struct Loaded {
    voice_id: String,
    synth: Synthesizer,
    pack: VoicePack,
}

#[derive(Default)]
pub struct TtsState {
    loaded: Mutex<Option<Loaded>>,
}

impl TtsState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VoiceOption {
    pub id: String,
    pub label: String,
}

/// The voices the picker offers. Static, but it lives here so the frontend has
/// one source of truth instead of a hardcoded list that can drift from the
/// files the fetcher knows how to download.
#[tauri::command]
pub fn tts_voices() -> Vec<VoiceOption> {
    fetch::VOICES
        .iter()
        .map(|v| VoiceOption {
            id: v.id.to_string(),
            label: v.label.to_string(),
        })
        .collect()
}

#[tauri::command]
pub fn tts_default_voice() -> String {
    DEFAULT_VOICE.to_string()
}

/// Whether pressing play would start immediately or start a 163MB download.
///
/// The player asks before showing anything, so a reader whose model is already
/// on disk never sees a progress bar flash past.
#[tauri::command]
pub fn tts_is_ready(app: AppHandle, voice: String) -> bool {
    fetch::is_ready(&app, &voice)
}

/// Download whatever is missing and load the model.
///
/// Idempotent, and safe to call on a voice that is already loaded: switching
/// voices reloads only the voice pack, not the model.
#[tauri::command]
pub async fn tts_prepare(
    app: AppHandle,
    state: tauri::State<'_, Arc<TtsState>>,
    voice: String,
) -> Result<(), String> {
    prepare(&app, &state, &voice).await.map_err(|e| e.to_string())
}

/// Synthesize one chunk and hand it back as a `data:` URL.
///
/// A `data:` URL rather than a file because that is already how this app moves
/// bytes into the webview (`github::get_asset_data_url` does the same for
/// chapter figures), and because a sentence of 24kHz mono is a few hundred KB -
/// small enough that the base64 round trip costs less than managing temp files
/// nobody remembers to delete.
#[tauri::command]
pub async fn tts_speak(
    app: AppHandle,
    state: tauri::State<'_, Arc<TtsState>>,
    text: String,
    voice: String,
) -> Result<String, String> {
    speak(&app, &state, &text, &voice)
        .await
        .map_err(|e| e.to_string())
}

/// Drop the model.
///
/// The reader who listened to one chapter this morning should not still be
/// paying 163MB of resident memory this afternoon. The player calls this when
/// it closes; the next play reloads from disk, which is fast because the
/// download already happened.
#[tauri::command]
pub async fn tts_release(state: tauri::State<'_, Arc<TtsState>>) -> Result<(), String> {
    let mut slot = state.loaded.lock().await;
    if slot.take().is_some() {
        tts_log!("model released");
    }
    Ok(())
}

/// Ceiling on the rendered-audio cache. WAV is uncompressed, so this is roughly
/// six chapters in one voice - enough that a reading session never re-renders,
/// small enough not to be noticed in the app data dir.
const AUDIO_CACHE_BYTES: i64 = 300 * 1024 * 1024;

/// Cache key. Voice and text are the only things the audio depends on.
fn audio_key(voice: &str, text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(voice.as_bytes());
    // A separator, so ("af", "xy") and ("afx", "y") cannot collide.
    hasher.update([0u8]);
    hasher.update(text.as_bytes());
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug)]
enum SpeakError {
    Fetch(fetch::FetchError),
    Tts(TtsError),
    /// Unreachable in practice - `prepare` runs first and either fills the slot
    /// or returns. It exists so that invariant is stated rather than unwrapped.
    NotLoaded,
}

impl std::fmt::Display for SpeakError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Fetch(e) => write!(f, "{e}"),
            Self::Tts(e) => write!(f, "{e}"),
            Self::NotLoaded => write!(f, "model was released mid-render"),
        }
    }
}

async fn prepare(
    app: &AppHandle,
    state: &Arc<TtsState>,
    voice_id: &str,
) -> Result<(), SpeakError> {
    // Downloads happen outside the lock. They can take minutes on a first play,
    // and holding the model lock across one would block a `tts_release` from a
    // reader who gave up waiting.
    let paths = fetch::ensure(app, voice_id).await.map_err(SpeakError::Fetch)?;

    let mut slot = state.loaded.lock().await;
    if let Some(loaded) = slot.as_mut() {
        if loaded.voice_id == voice_id {
            return Ok(());
        }
        // Same model, different style vectors. Reloading 163MB to change voice
        // would make the picker feel broken.
        loaded.pack = VoicePack::load(&paths.voice).map_err(SpeakError::Tts)?;
        loaded.voice_id = voice_id.to_string();
        tts_log!("voice switched to {voice_id}");
        return Ok(());
    }

    let started = std::time::Instant::now();
    let synth = Synthesizer::load(&paths.model, &paths.tokenizer).map_err(SpeakError::Tts)?;
    let pack = VoicePack::load(&paths.voice).map_err(SpeakError::Tts)?;
    tts_log!("model loaded in {:?} (voice {voice_id})", started.elapsed());
    *slot = Some(Loaded {
        voice_id: voice_id.to_string(),
        synth,
        pack,
    });
    Ok(())
}

async fn speak(
    app: &AppHandle,
    state: &Arc<TtsState>,
    text: &str,
    voice_id: &str,
) -> Result<String, SpeakError> {
    use tauri::Manager;
    let key = audio_key(voice_id, text);
    let pool = app
        .state::<crate::github::AppState>()
        .inner()
        .db
        .get()
        .cloned();

    // A cache hit skips loading the model entirely, which is what makes
    // replaying a chapter you already listened to instant rather than a
    // several-second wait for a 163MB file to come off disk.
    if let Some(pool) = pool.as_ref() {
        match crate::db::tts_audio_get(pool, &key) {
            Ok(Some(wav)) => return Ok(data_url(&wav)),
            Ok(None) => {}
            Err(e) => tts_log!("audio cache read failed, rendering instead: {e}"),
        }
    }

    prepare(app, state, voice_id).await?;

    let mut slot = state.loaded.lock().await;
    let loaded = slot.as_mut().ok_or(SpeakError::NotLoaded)?;

    // Speed stays 1.0 here. The frontend's <audio> element does speed with
    // playbackRate, which is pitch-corrected and changeable mid-sentence;
    // baking it into the render would mean re-synthesizing on every speed
    // change and would invalidate the audio cache per speed.
    let started = std::time::Instant::now();
    let samples = loaded
        .synth
        .synth(text, &loaded.pack, 1.0)
        .map_err(SpeakError::Tts)?;

    let seconds = samples.len() as f32 / super::SAMPLE_RATE as f32;
    tts_log!(
        "rendered {:.1}s in {:?} ({:.1}x real time)",
        seconds,
        started.elapsed(),
        seconds / started.elapsed().as_secs_f32()
    );

    let wav = super::wav_bytes(&samples);
    // Cache failures are logged and ignored: the audio is already rendered, and
    // refusing to play it because it could not be saved would be the wrong
    // trade.
    if let Some(pool) = pool.as_ref() {
        if let Err(e) = crate::db::tts_audio_put(pool, &key, &wav) {
            tts_log!("audio cache write failed: {e}");
        } else if let Err(e) = crate::db::tts_audio_evict(pool, AUDIO_CACHE_BYTES) {
            tts_log!("audio cache eviction failed: {e}");
        }
    }
    Ok(data_url(&wav))
}

fn data_url(wav: &[u8]) -> String {
    format!("data:audio/wav;base64,{}", STANDARD.encode(wav))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_voice_list_matches_what_the_fetcher_can_download() {
        // A picker offering a voice the fetcher has no URL for would fail at
        // play time, after the reader had already chosen it.
        let offered = tts_voices();
        assert_eq!(offered.len(), fetch::VOICES.len());
        for v in &offered {
            assert!(fetch::voice(&v.id).is_some(), "{} has no asset", v.id);
            assert!(!v.label.is_empty());
        }
        assert!(offered.iter().any(|v| v.id == tts_default_voice()));
    }

    #[test]
    fn the_cache_key_separates_voice_from_text() {
        // Without a separator byte these two would hash identically, and a
        // voice change would silently replay the old audio.
        assert_ne!(audio_key("af", "xy"), audio_key("afx", "y"));
        assert_eq!(audio_key("af_heart", "Hello."), audio_key("af_heart", "Hello."));
        assert_ne!(audio_key("af_heart", "Hello."), audio_key("bm_george", "Hello."));
    }

    #[test]
    fn wav_output_is_a_playable_container() {
        // The <audio> element gets a data: URL and either plays it or fails
        // silently, so the header is worth checking here rather than by ear.
        let samples = vec![0.0f32; 240];
        let wav = super::super::wav_bytes(&samples);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(wav.len(), 44 + samples.len() * 2);
        // Declared sizes must match the real ones or the element plays silence.
        let riff_size = u32::from_le_bytes(wav[4..8].try_into().unwrap());
        let data_size = u32::from_le_bytes(wav[40..44].try_into().unwrap());
        assert_eq!(riff_size as usize, wav.len() - 8);
        assert_eq!(data_size as usize, samples.len() * 2);
    }

    #[test]
    fn samples_clamp_instead_of_wrapping() {
        // A sample past 1.0 cast straight to i16 wraps to a loud click.
        let wav = super::super::wav_bytes(&[2.0, -2.0]);
        let a = i16::from_le_bytes(wav[44..46].try_into().unwrap());
        let b = i16::from_le_bytes(wav[46..48].try_into().unwrap());
        assert_eq!(a, 32767);
        assert_eq!(b, -32767);
    }
}

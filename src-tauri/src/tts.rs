//! Kokoro-82M text to speech. Desktop only.
//!
//! There is no Kokoro wrapper crate in the dependency tree on purpose: the two
//! that exist are unmaintained hobby projects, and the more popular one spells
//! every capitalized word out letter by letter because it never lowercases
//! before the dictionary lookup. See docs/adr/0001-chapter-audio-player.md.
//!
//! So this drives `ort` directly and takes phonemes from `misaki-rs`, whose POS
//! tagger is deterministic and gets "thuh rain" versus "thee apple" right.
//!
//! Runs on CPU. CoreML cannot execute this model at all: the export is fully
//! dynamic, the duration predictor is an LSTM, and the ISTFT decoder uses
//! `NonZero`. CPU measures 8.1x real time, against the roughly 1x that a
//! three-sentence lookahead needs.

// The Tauri commands that drive this land with the streaming work (prose-bny);
// until then the public surface has no in-crate callers.
#![allow(dead_code)]

macro_rules! tts_log {
    ($($arg:tt)*) => {{
        let __line = format!("[tts] {}", format!($($arg)*));
        eprintln!("{}", __line);
        $crate::logging::forward(&__line);
    }};
}

use {
    misaki_rs::{G2P, Language},
    ort::{session::Session, value::Tensor},
    std::{collections::HashMap, fs, path::Path},
};

/// Kokoro emits 24kHz mono.
pub const SAMPLE_RATE: u32 = 24_000;

/// Style vectors are 256-wide.
const STYLE_DIM: usize = 256;

#[derive(Debug, thiserror::Error)]
pub enum TtsError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("onnx: {0}")]
    Ort(#[from] ort::Error),
    #[error("bad tokenizer.json: {0}")]
    Tokenizer(String),
    #[error("bad voice pack {path}: {detail}")]
    Voice { path: String, detail: String },
    #[error("phonemization failed: {0}")]
    G2p(String),
    /// The caller must split the text and retry. Never a panic: the voice pack
    /// is indexed by token count, so an over-long chunk would run off the end.
    #[error("chunk is {tokens} tokens, limit is {limit}; split it")]
    ChunkTooLong { tokens: usize, limit: usize },
}

/// One voice: a style vector per sequence length. The row count is also the
/// hard ceiling on how many tokens a single synthesis call can carry.
pub struct VoicePack {
    rows: Vec<Vec<f32>>,
}

impl VoicePack {
    pub fn load(path: impl AsRef<Path>) -> Result<Self, TtsError> {
        let path = path.as_ref();
        let bytes = fs::read(path)?;
        let bad = |detail: String| TtsError::Voice {
            path: path.display().to_string(),
            detail,
        };
        if bytes.len() % (STYLE_DIM * 4) != 0 {
            return Err(bad(format!(
                "{} bytes is not a whole number of {STYLE_DIM}-wide f32 rows",
                bytes.len()
            )));
        }
        let rows: Vec<Vec<f32>> = bytes
            .chunks_exact(STYLE_DIM * 4)
            .map(|row| {
                row.chunks_exact(4)
                    .map(|f| f32::from_le_bytes([f[0], f[1], f[2], f[3]]))
                    .collect()
            })
            .collect();
        if rows.is_empty() {
            return Err(bad("no style rows".into()));
        }
        Ok(Self { rows })
    }

    pub fn max_tokens(&self) -> usize {
        self.rows.len()
    }
}

/// Maps a single IPA character to its Kokoro token id.
type Vocab = HashMap<char, i64>;

fn load_vocab(tokenizer_json: impl AsRef<Path>) -> Result<Vocab, TtsError> {
    let raw = fs::read_to_string(tokenizer_json)?;
    let doc: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| TtsError::Tokenizer(e.to_string()))?;
    let entries = doc["model"]["vocab"]
        .as_object()
        .ok_or_else(|| TtsError::Tokenizer("missing model.vocab object".into()))?;
    let mut vocab = Vocab::new();
    for (symbol, id) in entries {
        // Every Kokoro token is a single character; anything else is a special
        // token we do not emit.
        let mut chars = symbol.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            if let Some(id) = id.as_i64() {
                vocab.insert(c, id);
            }
        }
    }
    if vocab.is_empty() {
        return Err(TtsError::Tokenizer("vocab had no single-char tokens".into()));
    }
    Ok(vocab)
}

/// IPA string to token ids, wrapped in the boundary token Kokoro expects.
///
/// Returns any characters the vocab did not cover. misaki emits zero-width
/// joiners inside diphthongs (`e\u{200d}ɪ`) which Kokoro has no token for;
/// dropping them is correct, but the caller should log anything else.
fn tokenize(ipa: &str, vocab: &Vocab) -> (Vec<i64>, Vec<char>) {
    let mut tokens = Vec::with_capacity(ipa.len() + 2);
    let mut unmapped = Vec::new();
    tokens.push(0);
    for c in ipa.chars() {
        match vocab.get(&c) {
            Some(id) => tokens.push(*id),
            None => unmapped.push(c),
        }
    }
    tokens.push(0);
    (tokens, unmapped)
}

pub struct Synthesizer {
    session: Session,
    vocab: Vocab,
    g2p: G2P,
}

impl Synthesizer {
    pub fn load(
        model: impl AsRef<Path>,
        tokenizer_json: impl AsRef<Path>,
    ) -> Result<Self, TtsError> {
        let vocab = load_vocab(tokenizer_json)?;
        // BuilderResult's error hands the builder back, so it is not Send and
        // cannot cross into TtsError; flatten it to a message here.
        let builder = Session::builder().map_err(|e| ort::Error::new(e.to_string()))?;
        let mut builder = builder;
        let session = builder.commit_from_file(model)?;
        Ok(Self {
            session,
            vocab,
            g2p: G2P::new(Language::EnglishUS),
        })
    }

    /// Phonemes for one chunk of text, as IPA.
    pub fn phonemize(&self, text: &str) -> Result<String, TtsError> {
        self.g2p
            .g2p(text)
            .map(|(ipa, _)| ipa)
            .map_err(|e| TtsError::G2p(format!("{e:?}")))
    }

    /// Synthesize one chunk. `speed` is Kokoro's own rate, not playback rate:
    /// leave it at 1.0 and let the player's `playbackRate` handle speed, which
    /// is pitch-corrected and adjustable mid-sentence.
    pub fn synth(
        &mut self,
        text: &str,
        voice: &VoicePack,
        speed: f32,
    ) -> Result<Vec<f32>, TtsError> {
        let ipa = self.phonemize(text)?;
        let (tokens, unmapped) = tokenize(&ipa, &self.vocab);

        let unexpected: Vec<char> = unmapped
            .into_iter()
            .filter(|c| *c != '\u{200d}')
            .collect();
        if !unexpected.is_empty() {
            tts_log!("{unexpected:?} not in Kokoro vocab, dropped");
        }

        if tokens.len() > voice.max_tokens() {
            return Err(TtsError::ChunkTooLong {
                tokens: tokens.len(),
                limit: voice.max_tokens(),
            });
        }

        // The model picks its style vector by sequence length.
        let style = voice.rows[tokens.len() - 1].clone();
        let n = tokens.len();
        let input_ids = Tensor::from_array(([1usize, n], tokens))?;
        let style = Tensor::from_array(([1usize, STYLE_DIM], style))?;
        let speed = Tensor::from_array(([1usize], vec![speed]))?;

        let outputs = self.session.run(ort::inputs![
            "input_ids" => input_ids,
            "style" => style,
            "speed" => speed,
        ])?;
        let (_, samples) = outputs["waveform"].try_extract_tensor::<f32>()?;
        Ok(samples.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_wav(path: &str, samples: &[f32]) {
        let pcm: Vec<u8> = samples
            .iter()
            .flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())
            .collect();
        let mut out = Vec::new();
        out.extend(b"RIFF");
        out.extend(((36 + pcm.len()) as u32).to_le_bytes());
        out.extend(b"WAVEfmt ");
        out.extend(16u32.to_le_bytes()); // fmt chunk size
        out.extend(1u16.to_le_bytes()); // PCM
        out.extend(1u16.to_le_bytes()); // mono
        out.extend(SAMPLE_RATE.to_le_bytes());
        out.extend((SAMPLE_RATE * 2).to_le_bytes()); // byte rate
        out.extend(2u16.to_le_bytes()); // block align
        out.extend(16u16.to_le_bytes()); // bits per sample
        out.extend(b"data");
        out.extend((pcm.len() as u32).to_le_bytes());
        out.extend(pcm);
        std::fs::write(path, out).unwrap();
    }

    fn vocab() -> Vocab {
        // A stand-in for the real 115-entry table.
        [('a', 40), ('b', 41), ('ð', 81), ('ə', 83)]
            .into_iter()
            .collect()
    }

    #[test]
    fn wraps_tokens_in_boundary_markers() {
        let (tokens, unmapped) = tokenize("ab", &vocab());
        assert_eq!(tokens, vec![0, 40, 41, 0]);
        assert!(unmapped.is_empty());
    }

    #[test]
    fn reports_characters_outside_the_vocab_instead_of_guessing() {
        let (tokens, unmapped) = tokenize("aQb", &vocab());
        assert_eq!(tokens, vec![0, 40, 41, 0], "unknown chars are skipped");
        assert_eq!(unmapped, vec!['Q'], "and reported");
    }

    #[test]
    fn empty_text_still_produces_a_well_formed_sequence() {
        let (tokens, _) = tokenize("", &vocab());
        assert_eq!(tokens, vec![0, 0]);
    }

    /// Exercises the real model. Ignored by default because it needs ~163MB of
    /// assets; point PROSE_TTS_MODELS at a directory holding model_fp16.onnx,
    /// tokenizer.json and af_heart.bin, then:
    ///   cargo test tts::tests::synthesizes -- --ignored --nocapture
    #[test]
    #[ignore]
    fn synthesizes_real_audio_without_spelling_words_out() {
        let dir = std::path::PathBuf::from(
            std::env::var("PROSE_TTS_MODELS").expect("set PROSE_TTS_MODELS"),
        );
        let mut synth =
            Synthesizer::load(dir.join("model_fp16.onnx"), dir.join("tokenizer.json")).unwrap();
        let voice = VoicePack::load(dir.join("af_heart.bin")).unwrap();
        assert_eq!(voice.max_tokens(), 510);

        // The bug that killed the wrapper crate: a capitalized word must not be
        // spelled out. "The" has to phonemize as a word, and to "thuh" rather
        // than "thee" because a consonant follows.
        let ipa = synth.phonemize("The rain had stopped.").unwrap();
        assert!(
            ipa.starts_with("ðə"),
            "expected 'thuh', got {ipa:?} (letter-spelling regression?)"
        );

        // And it must be deterministic, or the audio cache key is a lie.
        let again = synth.phonemize("The rain had stopped.").unwrap();
        assert_eq!(ipa, again, "g2p must be deterministic");

        let samples = synth
            .synth("The rain had stopped some time before she noticed it.", &voice, 1.0)
            .unwrap();
        let seconds = samples.len() as f32 / SAMPLE_RATE as f32;
        assert!(
            (1.5..8.0).contains(&seconds),
            "expected a few seconds of audio, got {seconds:.2}s"
        );
        assert!(
            samples.iter().any(|s| s.abs() > 0.01),
            "audio is silent"
        );
        println!("synthesized {seconds:.2}s, ipa: {ipa}");

        if let Ok(out) = std::env::var("PROSE_TTS_WAV") {
            let sentences = [
                "The rain had stopped some time before she noticed it, and the quiet that followed felt larger than the noise had been.",
                "She stood at the window with her hands flat against the sill, watching water move along the gutter in slow, deliberate pushes.",
                "Somewhere below, a door opened and did not close again.",
                "Kaelith crossed the Ardenmoor road before dawn, past the Vaelthorne gate.",
            ];
            let mut all = Vec::new();
            for line in sentences {
                all.extend(synth.synth(line, &voice, 1.0).unwrap());
                all.extend(std::iter::repeat(0.0).take(SAMPLE_RATE as usize / 4));
            }
            write_wav(&out, &all);
            println!("wrote {out}");
        }
    }

    #[test]
    fn voice_pack_rejects_a_truncated_file() {
        let dir = std::env::temp_dir().join("prose-tts-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("truncated.bin");
        // One byte short of a whole row.
        std::fs::write(&path, vec![0u8; STYLE_DIM * 4 - 1]).unwrap();
        // Matched rather than unwrap_err'd: that would need Debug on VoicePack,
        // which carries 130k floats.
        match VoicePack::load(&path) {
            Err(TtsError::Voice { .. }) => {}
            Err(other) => panic!("expected a Voice error, got {other:?}"),
            Ok(_) => panic!("expected a truncated voice pack to be rejected"),
        }
    }
}

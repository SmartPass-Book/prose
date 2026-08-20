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

mod fetch;
mod oov;
// Public so `generate_handler!` can name the commands. `#[tauri::command]`
// emits a hidden `__cmd__NAME` macro beside each function, and a `pub use` of
// the function alone does not carry it, so the module has to be reachable.
pub mod session;

pub use session::TtsState;

use {
    misaki_rs::{lexicon::PhonemeEntry, G2P, Language},
    oov::OovPredictor,
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
    /// The model emitted NaN samples. The fp16 export did this for scattered
    /// style rows; fp32 has never been observed to. Kept as a hard error so a
    /// recurrence surfaces in the player instead of caching as silence.
    #[error("model produced a NaN waveform ({tokens} tokens); this render is unusable")]
    NanAudio { tokens: usize },
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
/// Which style-vector row a padded token sequence uses.
///
/// `tokenize` returns the phonemes wrapped in two boundary zeros; the style
/// table is indexed by the phoneme count alone.
fn style_row(padded_tokens: usize) -> usize {
    padded_tokens.saturating_sub(2)
}

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
    oov: OovPredictor,
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
            oov: OovPredictor::load().map_err(TtsError::G2p)?,
        })
    }

    /// Phonemes for one chunk of text, as IPA.
    ///
    /// Words the lexicon does not have are predicted and taught to it first,
    /// because misaki's own fallback spells them out letter by letter. They go
    /// into `silvers`, misaki's lower-confidence tier, which is what a guess is.
    /// Entries persist for the life of the synthesizer, so a name recurring
    /// through a chapter is predicted once and then pronounced consistently.
    pub fn phonemize(&mut self, text: &str) -> Result<String, TtsError> {
        let predicted = {
            let lexicon = &self.g2p.lexicon;
            self.oov
                .predict_unknown(text, |word| lexicon.is_known(word, ""))
        };
        for (word, ipa) in predicted {
            tts_log!("predicted {word:?} -> {ipa}");
            let lower = word.to_lowercase();
            let entry = PhonemeEntry::Simple(ipa);
            self.g2p.lexicon.silvers.insert(lower, entry.clone());
            self.g2p.lexicon.silvers.insert(word, entry);
        }
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

        // Style row is indexed by the *phoneme* count, not the padded token
        // count. `tokenize` wraps the sequence in two boundary zeros, and the
        // reference implementation takes `voices[len(tokens)]` before adding
        // them (see the model card). Indexing one row too high makes the model
        // emit pure digital silence for some lengths - not quieter audio, not
        // wrong prosody, but a waveform of exact zeros - so it fails
        // inaudibly and only for some sentences.
        let phonemes = style_row(tokens.len());
        if phonemes >= voice.max_tokens() {
            return Err(TtsError::ChunkTooLong {
                tokens: phonemes,
                limit: voice.max_tokens() - 1,
            });
        }

        let style = voice.rows[phonemes].clone();
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
        if samples.iter().any(|v| v.is_nan()) {
            return Err(TtsError::NanAudio { tokens: n });
        }
        Ok(trim_silence(samples))
    }
}

/// Anything quieter than this counts as silence. -60 dBFS is the noise-floor
/// bar audiobook mastering uses (ACX), which is a convenient definition of
/// "the listener cannot hear it".
const SILENCE_FLOOR: f32 = 0.001;

/// A little padding either side of the trim, so a soft consonant onset is not
/// clipped and the speech does not start on the very first sample.
const TRIM_PAD: usize = SAMPLE_RATE as usize / 50; // 20ms

/// Strip the silence Kokoro pads every render with.
///
/// Measured on this model: roughly 300ms of leading and 380ms of trailing
/// silence on every chunk, regardless of length. Since a chunk is one sentence,
/// that is ~680ms of dead air at every sentence boundary - which is what made
/// playback feel slow, and it was invisible because the configured gap between
/// sentences was already zero.
///
/// Trimming here rather than in the player means the gap between sentences is
/// exactly what the pause table says it is, and that the cached audio is the
/// trimmed audio.
fn trim_silence(samples: &[f32]) -> Vec<f32> {
    let first = samples.iter().position(|v| v.abs() > SILENCE_FLOOR);
    let Some(first) = first else {
        // Entirely silent. Returning it as-is keeps this function honest about
        // what the model produced; a silent render is a bug to find, not
        // something to paper over by returning an empty buffer.
        return samples.to_vec();
    };
    let last = samples
        .iter()
        .rposition(|v| v.abs() > SILENCE_FLOOR)
        .unwrap_or(samples.len() - 1);
    let start = first.saturating_sub(TRIM_PAD);
    let end = (last + TRIM_PAD).min(samples.len() - 1);
    samples[start..=end].to_vec()
}

/// Wrap samples in a 44-byte WAV header, 16-bit PCM mono.
///
/// The frontend plays chunks through an `<audio>` element, which is what makes
/// `playbackRate` a pitch-corrected speed control rather than something we
/// would have to resample for. That element needs a container, and WAV is the
/// only one we can write without an encoder dependency. Chunks are a sentence
/// long and are thrown away after playing, so the size costs nothing.
///
/// Samples are clamped rather than normalized: Kokoro's output already sits
/// inside -1.0..1.0, and normalizing per chunk would make the volume drift
/// sentence to sentence.
pub fn wav_bytes(samples: &[f32]) -> Vec<u8> {
    let pcm: Vec<u8> = samples
        .iter()
        .flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())
        .collect();
    let mut out = Vec::with_capacity(44 + pcm.len());
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
    out
}

#[cfg(test)]
mod tests {
    use super::*;

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
    /// assets; point PROSE_TTS_MODELS at a directory holding the fetch::MODEL file,
    /// tokenizer.json and af_heart.bin, then:
    ///   cargo test tts::tests::synthesizes -- --ignored --nocapture
    /// Validates `MAX_CHUNK_CHARS` in `src/lib/speech.ts`.
    ///
    /// The frontend caps a chunk at 350 characters of input, but Kokoro's limit
    /// is 510 *tokens*, and its tokens are IPA characters. The two units do not
    /// convert exactly, so the margin is measured rather than assumed - a
    /// chunk that overshoots is a `ChunkTooLong` mid-chapter.
    #[test]
    #[ignore = "needs PROSE_TTS_MODELS"]
    fn the_frontend_chunk_cap_leaves_room_under_the_token_ceiling() {
        let dir = std::path::PathBuf::from(
            std::env::var("PROSE_TTS_MODELS").expect("set PROSE_TTS_MODELS"),
        );
        let mut synth =
            Synthesizer::load(dir.join(crate::tts::fetch::MODEL.name), dir.join("tokenizer.json")).unwrap();

        // Ordinary prose, and then a deliberately phoneme-dense worst case:
        // short words phonemize to nearly as many IPA characters as letters,
        // while long ones compress. "strengths" is nine letters, six phonemes;
        // "eye" is three letters and one.
        let ordinary = "She walked out into the rain and did not look back at the \
             house, which had never once felt like hers, and the road ahead of her \
             ran straight for a mile before it bent north toward the water and the \
             low grey line of the far shore beyond, where the lamps were already \
             lit against an afternoon that had given up on itself hours ago.";
        let dense = "It is a bit of a job to fix a big bug in the old ship, but the \
             lad had a go at it, and the six men in the crew did not ask him why he \
             had to do it, or how, or when, or what it was that made him think he \
             was the one to do the job at all, or if he had a plan, or if the plan \
             was any good, or if he knew what a plan was, or why the ship was here.";

        for text in [ordinary, dense] {
            let words: Vec<&str> = text.split_whitespace().collect();
            // Fill to the cap on a word boundary. Cutting mid-word would invent
            // an out-of-vocabulary token and measure the predictor instead of
            // the density of real prose.
            let mut clipped = String::new();
            for word in words.iter().cycle() {
                if clipped.chars().count() + 1 + word.chars().count() > 350 {
                    break;
                }
                if !clipped.is_empty() {
                    clipped.push(' ');
                }
                clipped.push_str(word);
            }
            assert!(clipped.chars().count() >= 340, "sample too short to be a test");

            let ipa = synth.phonemize(&clipped).unwrap();
            let (tokens, _) = tokenize(&ipa, &synth.vocab);
            println!("{} chars -> {} tokens", clipped.chars().count(), tokens.len());
            assert!(
                tokens.len() <= 510,
                "350 chars phonemized to {} tokens, over Kokoro's 510 ceiling; \
                 lower MAX_CHUNK_CHARS in src/lib/speech.ts",
                tokens.len()
            );
        }
    }

    #[test]
    #[ignore = "needs PROSE_TTS_MODELS"]
    fn synthesizes_real_audio_without_spelling_words_out() {
        let dir = std::path::PathBuf::from(
            std::env::var("PROSE_TTS_MODELS").expect("set PROSE_TTS_MODELS"),
        );
        let mut synth =
            Synthesizer::load(dir.join(crate::tts::fetch::MODEL.name), dir.join("tokenizer.json")).unwrap();
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

        // Invented names must be pronounced, not spelled. Letter-spelling
        // "Kaelith" yields seven stressed syllables and is unmistakable.
        let name = synth.phonemize("Kaelith").unwrap();
        assert!(
            name.matches('\u{02C8}').count() <= 2,
            "Kaelith looks spelled out: {name:?}"
        );
        assert!(
            !name.contains("\u{02C8}e\u{026A}\u{02C8}i"),
            "Kaelith starts with letter names: {name:?}"
        );
        println!("Kaelith -> {name}");

        // And every symbol the predictor emits must exist in Kokoro's vocab,
        // or tokens silently vanish.
        let (_, unmapped) = tokenize(&name, &synth.vocab);
        let unexpected: Vec<char> =
            unmapped.into_iter().filter(|c| *c != '\u{200d}').collect();
        assert!(unexpected.is_empty(), "OOV IPA outside vocab: {unexpected:?}");

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
            std::fs::write(&out, wav_bytes(&all)).unwrap();
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
    #[test]
    fn style_row_is_the_phoneme_count_not_the_padded_length() {
        // The reference implementation takes voices[len(tokens)] *before*
        // wrapping the sequence in boundary zeros. Getting this one too high
        // makes the model emit exact-zero samples for some lengths.
        let vocab = vocab();
        let (tokens, _) = tokenize("ab", &vocab);
        assert_eq!(tokens.len(), 4, "two phonemes plus two boundary zeros");
        assert_eq!(style_row(tokens.len()), 2);
    }

    #[test]
    fn style_row_never_underflows_on_an_empty_sequence() {
        let (tokens, _) = tokenize("", &vocab());
        assert_eq!(tokens.len(), 2);
        assert_eq!(style_row(tokens.len()), 0);
    }

    #[test]
    fn trim_silence_strips_both_ends_but_keeps_the_speech() {
        let mut samples = vec![0.0f32; 5000];
        samples.extend([0.5f32; 1000]);
        samples.extend(vec![0.0f32; 5000]);
        let trimmed = trim_silence(&samples);
        assert!(trimmed.len() < samples.len());
        // The loud part survives whole, plus the 20ms guard band either side.
        assert!(trimmed.len() >= 1000);
        assert!(trimmed.len() <= 1000 + 2 * TRIM_PAD + 2);
        assert!(trimmed.iter().any(|v| *v == 0.5));
    }

    #[test]
    fn trim_silence_leaves_an_entirely_silent_render_alone() {
        // A silent buffer is a bug to surface, not something to hide by
        // returning an empty one.
        let samples = vec![0.0f32; 2400];
        assert_eq!(trim_silence(&samples).len(), 2400);
    }

    /// Guards the failure that made playback intermittently silent: the fp16
    /// model emitted all-NaN waveforms for scattered style rows, inaudibly and
    /// only at certain sentence lengths. Sweeps lengths because a single
    /// sentence would not have caught it, and sweeps 70 style rows directly
    /// because the length sweep only samples a few. Also checks that the
    /// ~300ms of silence Kokoro pads each render with is trimmed, which was
    /// what made sentence gaps feel slow.
    #[test]
    #[ignore = "needs PROSE_TTS_MODELS"]
    fn pacing_no_nan_renders_and_no_padded_silence() {
        let dir = std::path::PathBuf::from(
            std::env::var("PROSE_TTS_MODELS").expect("set PROSE_TTS_MODELS"),
        );
        let mut synth = Synthesizer::load(
            dir.join(crate::tts::fetch::MODEL.name),
            dir.join("tokenizer.json"),
        )
        .unwrap();
        let voice = VoicePack::load(dir.join("af_heart.bin")).unwrap();

        let words = [
            "the", "road", "to", "the", "north", "was", "flooded", "and", "she", "knew",
            "it", "would", "be", "before", "she", "ever", "set", "out", "that", "morning",
            "with", "the", "lamp", "and", "the", "letter", "she", "had", "not", "opened",
        ];
        let mut worst_lead = 0usize;
        let mut worst_trail = 0usize;
        for n in 1..=words.len() {
            let text = format!("{}.", words[..n].join(" "));
            let s = synth.synth(&text, &voice, 1.0).unwrap();
            let peak = s.iter().fold(0f32, |m, v| m.max(v.abs()));
            assert!(peak > 0.01, "silent render at {n} words: {text:?}");

            let lead = s.iter().position(|v| v.abs() > SILENCE_FLOOR).unwrap();
            let trail = s.len() - 1 - s.iter().rposition(|v| v.abs() > SILENCE_FLOOR).unwrap();
            worst_lead = worst_lead.max(lead);
            worst_trail = worst_trail.max(trail);
        }
        let ms = |c: usize| c * 1000 / SAMPLE_RATE as usize;
        println!("worst lead {}ms, worst trail {}ms", ms(worst_lead), ms(worst_trail));
        assert!(ms(worst_lead) <= 30, "leading silence not trimmed: {}ms", ms(worst_lead));
        assert!(ms(worst_trail) <= 30, "trailing silence not trimmed: {}ms", ms(worst_trail));

        // Row sweep: every style row must render finite, audible samples.
        let (tokens, _) = tokenize(&synth.phonemize("Morning came.").unwrap(), &synth.vocab);
        let n = tokens.len();
        for row in 0..70usize {
            let ids = Tensor::from_array(([1usize, n], tokens.clone())).unwrap();
            let st = Tensor::from_array(([1usize, STYLE_DIM], voice.rows[row].clone())).unwrap();
            let sp = Tensor::from_array(([1usize], vec![1.0f32])).unwrap();
            let out = synth
                .session
                .run(ort::inputs!["input_ids" => ids, "style" => st, "speed" => sp])
                .unwrap();
            let (_, w) = out["waveform"].try_extract_tensor::<f32>().unwrap();
            assert!(!w.iter().any(|v| v.is_nan()), "NaN waveform at style row {row}");
            let peak = w.iter().fold(0f32, |m, v| m.max(v.abs()));
            assert!(peak > 0.01, "silent waveform at style row {row}");
        }
    }

}

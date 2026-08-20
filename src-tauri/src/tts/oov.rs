//! Pronunciation for words the dictionary does not have.
//!
//! misaki spells an unknown word out letter by letter, so "Kaelith" is read
//! "kay-ay-ee-ell-eye-tee-aitch". In a novel the unknown words are exactly the
//! invented names, so they appear constantly and the result is unlistenable.
//!
//! The usual fix is espeak-ng, which is GPLv3 and cannot ship inside the DMG.
//! This uses a small neural predictor instead: it learned English spelling-to-
//! sound patterns from CMUdict, so it produces a plausible reading for words it
//! has never seen. Output is ARPAbet, which this module converts to the IPA
//! subset Kokoro's tokenizer accepts.

use {
    grapheme_to_phoneme::Model,
    std::collections::{HashMap, HashSet},
};

/// ARPAbet consonants to Kokoro's IPA.
///
/// Two traps live here. Kokoro's vocab has no ASCII `g`: it uses U+0261 `ɡ`.
/// And its affricates are single characters `ʧ`/`ʤ`, not the two-character
/// sequences `tʃ`/`dʒ`. Either mistake produces tokens that silently drop.
const CONSONANTS: &[(&str, &str)] = &[
    ("B", "b"),
    ("CH", "ʧ"),
    ("D", "d"),
    ("DH", "ð"),
    ("F", "f"),
    ("G", "ɡ"),
    ("HH", "h"),
    ("JH", "ʤ"),
    ("K", "k"),
    ("L", "l"),
    ("M", "m"),
    ("N", "n"),
    ("NG", "ŋ"),
    ("P", "p"),
    ("R", "ɹ"),
    ("S", "s"),
    ("SH", "ʃ"),
    ("T", "t"),
    ("TH", "θ"),
    ("V", "v"),
    ("W", "w"),
    ("Y", "j"),
    ("Z", "z"),
    ("ZH", "ʒ"),
];

/// ARPAbet vowels to IPA, as (stressed, unstressed).
///
/// Most are the same either way. AH is the exception English actually cares
/// about: stressed it is "cup", unstressed it is schwa. ER splits too, and
/// note Kokoro has no `ɝ`, so the stressed form borrows `ɜ`.
const VOWELS: &[(&str, &str, &str)] = &[
    ("AA", "ɑ", "ɑ"),
    ("AE", "æ", "æ"),
    ("AH", "ʌ", "ə"),
    ("AO", "ɔ", "ɔ"),
    ("AW", "aʊ", "aʊ"),
    ("AY", "aɪ", "aɪ"),
    ("EH", "ɛ", "ɛ"),
    ("ER", "ɜ", "ɚ"),
    ("EY", "eɪ", "eɪ"),
    ("IH", "ɪ", "ɪ"),
    ("IY", "i", "i"),
    ("OW", "oʊ", "oʊ"),
    ("OY", "ɔɪ", "ɔɪ"),
    ("UH", "ʊ", "ʊ"),
    ("UW", "u", "u"),
];

/// Turn one ARPAbet phoneme into IPA, carrying its stress marker.
///
/// ARPAbet marks stress with a trailing digit on the vowel (`AE1`); Kokoro
/// wants the marker *before* the vowel (`ˈæ`).
fn phoneme_to_ipa(token: &str) -> Option<String> {
    let (base, stress) = match token.chars().last() {
        Some(d @ '0'..='2') => (&token[..token.len() - 1], Some(d)),
        _ => (token, None),
    };

    if let Some((_, ipa)) = CONSONANTS.iter().find(|(a, _)| *a == base) {
        return Some((*ipa).to_string());
    }

    let (_, stressed, unstressed) = VOWELS.iter().find(|(a, _, _)| *a == base)?;
    Some(match stress {
        Some('1') => format!("ˈ{stressed}"),
        Some('2') => format!("ˌ{stressed}"),
        // Stress 0, or a vowel with no marker at all.
        _ => (*unstressed).to_string(),
    })
}

pub struct OovPredictor {
    model: Model,
}

impl OovPredictor {
    pub fn load() -> Result<Self, String> {
        Model::load_in_memory()
            .map(|model| Self { model })
            .map_err(|e| format!("{e:?}"))
    }

    /// A plausible IPA pronunciation, or None if the predictor produced nothing
    /// usable. Callers should leave the word alone rather than guess further.
    ///
    /// The word is lowercased first, and that is load-bearing rather than
    /// tidiness: the model's input vocabulary is lowercase only, so a capital
    /// initial is an unknown character and is silently skipped. "Kaelith" comes
    /// back as "ELL-ith" with the K missing. Proper nouns are exactly the words
    /// this module exists for, and they are always capitalized.
    pub fn predict(&self, word: &str) -> Option<String> {
        let arpabet = self.model.predict_phonemes_strs(&word.to_lowercase()).ok()?;
        let ipa: String = arpabet.iter().filter_map(|p| phoneme_to_ipa(p)).collect();
        (!ipa.is_empty()).then_some(ipa)
    }

    /// Predict for every distinct word in `text` that `is_known` rejects.
    ///
    /// Returns word to IPA. Words are matched case-insensitively but returned
    /// under the spelling that appeared, since that is what the lexicon is
    /// looked up by.
    pub fn predict_unknown<F>(&self, text: &str, is_known: F) -> HashMap<String, String>
    where
        F: Fn(&str) -> bool,
    {
        let mut out = HashMap::new();
        let mut seen = HashSet::new();
        for word in text.split(|c: char| !c.is_alphabetic()) {
            if word.len() < 2 || !seen.insert(word.to_lowercase()) || is_known(word) {
                continue;
            }
            if let Some(ipa) = self.predict(word) {
                out.insert(word.to_string(), ipa);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_stress_markers_in_front_of_the_vowel() {
        assert_eq!(phoneme_to_ipa("AE1").unwrap(), "ˈæ");
        assert_eq!(phoneme_to_ipa("AE2").unwrap(), "ˌæ");
        assert_eq!(phoneme_to_ipa("AE0").unwrap(), "æ");
    }

    #[test]
    fn ah_reduces_to_schwa_only_when_unstressed() {
        assert_eq!(phoneme_to_ipa("AH1").unwrap(), "ˈʌ");
        assert_eq!(phoneme_to_ipa("AH0").unwrap(), "ə");
    }

    #[test]
    fn uses_the_symbols_kokoro_actually_has() {
        // Not ASCII 'g' (U+0067), which is absent from the vocab.
        assert_eq!(phoneme_to_ipa("G").unwrap(), "\u{0261}");
        // Single-character affricates, not two-character sequences.
        assert_eq!(phoneme_to_ipa("CH").unwrap(), "\u{02A7}");
        assert_eq!(phoneme_to_ipa("JH").unwrap(), "\u{02A4}");
        // Kokoro has no ɝ, so stressed ER borrows ɜ.
        assert_eq!(phoneme_to_ipa("ER1").unwrap(), "ˈɜ");
        assert_eq!(phoneme_to_ipa("ER0").unwrap(), "ɚ");
    }

    #[test]
    fn unrecognized_phonemes_are_dropped_rather_than_guessed() {
        assert!(phoneme_to_ipa("XX").is_none());
    }

    #[test]
    fn predicts_a_pronunciation_for_an_invented_name() {
        let p = OovPredictor::load().expect("embedded model should load");
        let ipa = p.predict("Kaelith").expect("should produce something");
        assert!(
            !ipa.is_empty() && ipa.chars().count() < 20,
            "expected a word-length pronunciation, got {ipa:?}"
        );
        // The failure this whole module exists to prevent: letter-spelling
        // would render the seven letters as seven stressed syllables.
        assert!(
            ipa.matches('ˈ').count() <= 2,
            "looks like letters were spelled out: {ipa:?}"
        );
    }

    #[test]
    fn a_capital_initial_does_not_lose_its_consonant() {
        let p = OovPredictor::load().unwrap();
        // The model's vocabulary is lowercase; feeding it "Kaelith" directly
        // drops the K. Proper nouns are the whole point, so this must hold.
        let upper = p.predict("Kaelith").unwrap();
        let lower = p.predict("kaelith").unwrap();
        assert_eq!(upper, lower, "capitalization changed the pronunciation");
        assert!(
            upper.starts_with('k'),
            "leading consonant was dropped: {upper:?}"
        );
    }

    #[test]
    fn only_predicts_for_words_the_lexicon_rejects() {
        let p = OovPredictor::load().unwrap();
        let known = |w: &str| w.eq_ignore_ascii_case("the") || w.eq_ignore_ascii_case("road");
        let out = p.predict_unknown("The Ardenmoor road", known);
        assert!(out.contains_key("Ardenmoor"), "got {out:?}");
        assert!(!out.contains_key("The"));
        assert!(!out.contains_key("road"));
    }
}


#[cfg(test)]
mod cost {
    use super::*;
    use std::time::Instant;

    /// What the current predictor actually costs, so the question of swapping it
    /// for an ONNX model is answered with numbers.
    #[test]
    #[ignore]
    fn measure() {
        let t = Instant::now();
        let p = OovPredictor::load().unwrap();
        println!("load: {:?}", t.elapsed());

        let names = [
            "Kaelith", "Ardenmoor", "Vaelthorne", "Sythrin", "Eldrimoor",
            "Thessaly", "Corvane", "Mirelle", "Ashgrove", "Duskwater",
        ];
        // Warm.
        let _ = p.predict("warmup");

        let t = Instant::now();
        for _ in 0..10 {
            for n in names {
                let _ = p.predict(n);
            }
        }
        let per = t.elapsed() / 100;
        println!("predict: {per:?} per word");

        // A chapter's worth: how many distinct unknown words might appear, and
        // what does predicting all of them cost once?
        let t = Instant::now();
        for i in 0..80 {
            let _ = p.predict(&format!("nameword{i}"));
        }
        println!("80 distinct unknown words: {:?}", t.elapsed());
    }
}

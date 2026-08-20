# ADR 0001: Chapter audio player

Status: accepted
Date: 2026-08-19

## Context

Reading a chapter silently hides problems that hearing it exposes. The goal is to
listen to a chapter inside Prose, catch continuity and content errors during long
uninterrupted playback, and mark a spot without losing your place.

Constraints established up front:

- Cost must be zero. Local open-source models are acceptable; hosted APIs are not.
- macOS only. iOS is explicitly out of scope.
- Network is available, so a model may be fetched on first use rather than bundled.
- Prose is distributed as a signed, notarized DMG under an all-rights-reserved
  LICENSE, so any dependency's license flows into what we ship.

## Decision

### Engine: Kokoro-82M

Kokoro-82M (Apache-2.0, weights included), `model_fp16.onnx` (163MB), downloaded on
first play from Prose's own GitHub release assets into the app data dir. Not bundled:
the updater ships full app tarballs, so bundling would re-download the model on every
patch release.

The deciding property is not voice quality. Kokoro is non-autoregressive (StyleTTS2
with an ISTFTNet decoder), so it is structurally incapable of skipping, repeating, or
inventing a word. Every larger 2026 model is autoregressive, and skipping and
repetition are the documented failure mode of autoregressive TTS on long inputs. When
audio is being used as a defect detector on the text itself, a model that silently
drops a word sends you hunting a bug that is not in the manuscript.

Rejected:

- **Apple `AVSpeechSynthesizer`**. Free and offline, and its word-range delegate would
  give exact follow-highlighting, but `AVSpeechUtterance.rate` is per-utterance and
  nonlinear, and cannot change mid-utterance. Rendering audio and using `playbackRate`
  gives exact pitch-corrected speed instead.
- **Web Speech API**. Exposes only pre-installed compact voices on macOS, and is not
  enabled in WKWebView on iOS at all.
- **Supertonic 3**. Faster (RTF 0.165 vs Kokoro's ~0.47) but head-to-head benchmarks
  call its fast configuration robotic and its 5-step output lacking natural prosody.
  OpenRAIL-M carries use restrictions. Speed was never the bottleneck.
- **Hume TADA** (March 2026). Purpose-built against long-form hallucination, with
  token-level alignment that would give word-level highlighting for free. Rejected on
  weight: 1B parameters, Llama 3.2 Community License with attribution obligations and
  a gated download, and no ONNX path. Worth revisiting if sentence-granular
  highlighting proves annoying.
- **dots.tts (2B), Chatterbox (0.5B), Step Audio EditX**. Too large to embed.

### Runtime: `kokoro-tts` on `ort`

`kokoro-tts` (Apache-2.0) driving `ort` (Rust bindings to ONNX Runtime) with CoreML.

Rejected: **`sherpa-onnx`**, despite being far more used (217k recent downloads vs
30k) and org-maintained. Its value is that one API covers iOS, Android, Raspberry Pi,
RISC-V and NPUs, which is exactly the reach this feature does not need. What it would
still cost: a C++ library through FFI with a cmake build, two dylibs to sign under
hardened runtime inside the notarized DMG, and a vendored GPLv3 espeak-ng that must be
configured out of a build system we do not control. Upstream issue #3731 plans to
remove espeak-ng in a 2.0.0 major release precisely because it is incompatible with
their Apache-2.0 license; that issue is open with no timeline.

`kokoro-tts` also exposes `SynthStream`/`SynthSink` for streaming synthesis, which the
lookahead design needs, and `arpa_to_ipa`, which the OOV predictor plugs into.

Note: `ort` is at `2.0.0-rc.13`, formally pre-release, though universally shipped.

### Grapheme-to-phoneme: CMUdict plus a neural OOV predictor, no espeak-ng

Kokoro consumes phonemes, not letters, so a g2p stage sits in front of it. CMUdict
(~134k words, via `kokoro-tts`) covers ordinary prose. Words outside it - which in a
novel means invented character and place names - go to the `grapheme_to_phoneme` crate
(BSD-4-Clause, 3.5MB with weights embedded, pure Rust, no runtime files), whose ARPAbet
output feeds the existing `arpa_to_ipa` conversion and is indistinguishable downstream
from a dictionary hit.

**espeak-ng is excluded.** It is the conventional OOV fallback and is GPLv3, which
cannot ship inside Prose. Without any fallback, an unknown word is spelled out letter
by letter ("kay-ay-ee-ell-eye-tee-aitch"), which is unusable in fiction, so the
predictor is load-bearing rather than optional.

Rejected: **OpenPhonemizer** (BSD-3-Clause-Clear, purpose-built as a permissive espeak
replacement) because the repo was archived in March 2026 and the author has moved on.
**DeepPhonemizer** exported to ONNX is more accurate and remains a contained swap if
name pronunciation proves bad, but needs a second `ort` session and its own IPA path.

**No pronunciation lexicon or override UI.** Whatever the predictor guesses is what
you get.

BSD-4-Clause carries the advertising clause, so `grapheme_to_phoneme` needs an
acknowledgment line wherever third-party licenses are listed.

### Text selection

Read: headings as plain text, paragraphs, blockquotes.

Skip: images and figures, front matter, footnote markers, all HTML comments (including
the `<!-- nr:v1 ... -->` anchor markers, which would otherwise be read aloud as JSON),
and review thread comments. Only document prose is spoken. Scene-break markers become
a pause rather than being read.

Playback starts from the block you click and stops at the end of the file. It does not
roll into the next file in the PR: a PR's file list is not necessarily reading order.

### Playback and caching

Rendered audio plays through an HTML `<audio>` element, so `playbackRate` gives exact
pitch-corrected speed and instant mid-playback speed changes.

Synthesis streams with a rolling lookahead of about three sentences. Playback begins as
soon as the first chunk is ready, with a spinner in the player until then.

Rendered audio is cached on disk in the existing SQLite cache, keyed by
`(repo, ref, path, voice, hash of chunk text)`, mirroring `get_asset_data_url`. The text
hash means a revised paragraph re-renders itself while the rest of the chapter stays
cached, which matches listening to the same chapter across successive pushes. LRU cap of
a few hundred MB.

### Interface

Every rendered markdown block already carries `data-line-start`, and `App.css` already
paints the source line number into a left gutter. A **play button appears on hover of a
block's left gutter strip, replacing that line number**, and clicking it plays from that
block. Granularity is per block, not per source line: a paragraph spanning five source
lines renders as one `<p>`.

While playing, a **narrow vertical pill is fixed to the viewport**, vertically centered
in the left margin, holding play/pause and a tap-to-cycle speed label (1x, 1.25x, 1.5x,
1.75x, 2x; shift-click reverses). It is fixed rather than anchored to the playing block
because the document does not follow playback.

The current sentence highlights. **The document does not auto-scroll**, but it jumps to
the playhead when play or pause is clicked.

Keyboard, while the player is open: space toggles play/pause, left and right arrow skip
back and forward one sentence. Skip-back matters most: rewinding is most of what
proofreading by ear consists of.

The voice picker lives in `Settings.tsx`, not the pill, which has no room for it.

### Comments during playback

Pressing `c` while playing pauses, selects the currently spoken sentence, and opens the
composer anchored to it, so the anchor text is exactly the sentence that sounded wrong.
Playback resumes whether the comment is posted or cancelled.

### Lifecycle

Switching file or PR while playing stops playback and closes the player. Voice and speed
persist across restarts via the existing review settings. Files do not remember where you
stopped.

## Consequences

- An unknown word must never crash or be dropped. Words that fall through to the
  predictor are logged, so a lexicon feature has a ready list if one is ever wanted.
- Sentence-granular highlighting is the ceiling. Kokoro provides no word-level
  alignment. If that becomes the main irritation, TADA is the reason to revisit.
- The engine seam is not built. Kokoro (86-163MB ONNX, in-process) and any 1B-class
  alternative (MLX, out-of-process) have incompatible shapes, so an abstraction between
  them now would be fictional.
- Verified by spike before implementation: CoreML acceleration under `kokoro-tts` on
  Apple Silicon, real-time factor sufficient for a three-sentence lookahead, fp16
  against q8f16 by ear, and ONNX Runtime static linking against notarization and the
  hardened runtime.

## Spike findings (2026-08-20, prose-07r)

Measured on this machine against `kokoro-tts` 0.3.3 with the real model. Three
decisions above are amended.

### Model: fp32, not fp16

There is no fp16 build. The distribution `kokoro-tts` expects (its own release assets,
`mzdk100/kokoro` V1.0, because `voices.bin` is a crate-specific bincode format rather
than the Hugging Face layout) offers only `kokoro-v1.0.int8.onnx` (88MB) and
`kokoro-v1.0.onnx` (310MB).

fp32 is both higher quality **and roughly twice as fast** as int8 on Apple Silicon,
which is counterintuitive but consistent: the CPU has strong float throughput and int8
pays dequantization overhead.

| Model | Size | RTF | Speed | First-chunk latency |
|---|---|---|---|---|
| int8 | 88MB | 0.363 | 2.8x real time | 1.68s |
| fp32 | 310MB | 0.184 | 5.4x real time | ~0.85s |

**Decision: fp32 (310MB).** The only cost is download size, and it is a one-time fetch.

### CoreML is neither reachable nor needed

`KokoroTts::new` hardcodes `CUDAExecutionProvider` and exposes no way to pass execution
providers, so CoreML cannot be selected through the public API. It also does not matter:
CPU alone sustains 5.4x real time, far more than a three-sentence lookahead needs.

### `kokoro-tts` must be vendored, not consumed as published

Three defects, all confirmed against the real model:

1. **The g2p is nondeterministic.** `g2p.rs:120` calls `rand::random_range(0..rules.len())`
   to choose among CMUdict variants on every call. Over 8 calls, `the` produced 3 distinct
   pronunciations and `record` randomly alternated between `ɹˈɛkɝd` (the noun) and
   `ɹəkˈɔɹd` (the verb).

   This is disqualifying as-is. The whole reason for choosing Kokoro was that a
   non-autoregressive model cannot garble text; this moves the garbling upstream into the
   g2p. Listening to catch defects is worthless if the reader invents defects of its own.
   It also invalidates the cache key, which assumes audio is a pure function of the text.

2. **Unchecked index panics on long inputs.** `synthesizer.rs:30` indexes
   `pack[phonemes.len() - 1]` into a 510-entry voice pack with no bounds check. Combined
   with defect 1, token counts for one fixed passage drifted across
   `[506, 507, 513, 505, 512, 511, 508, 511]`, so **4 of 8 runs panicked on identical
   input**. Sentence chunking keeps normal text well clear of the limit, but a long
   sentence would still crash the backend.

3. **Does not build against current `ort`.** The crate declares `ort = "2.0.0-rc.12"`;
   Cargo resolves rc.13, where `CUDAExecutionProvider` sits behind ort's `cuda` feature,
   so the build fails unless CUDA is enabled. Requires pinning `ort = "=2.0.0-rc.12"`.

The crate is Apache-2.0 and 1,746 lines total, so vendoring is cheap. The fork needs:
deterministic variant selection (take the first pronunciation), a bounds check returning
an error instead of panicking, configurable execution providers, and our own `ort` pin.
It also gives a clean insertion point for the OOV predictor at the `letters_to_ipa`
fallback.

### Confirmed as designed

- CMUdict is bundled in the crate via `include_str!`, so no separate dictionary download.
- OOV words fall to `letters_to_ipa` exactly as predicted: `Kaelith` becomes
  `kˈAɐˈiˈɛlˈItˈiˈAʧ`, the letters spelled out. The predictor is load-bearing.
- Dictionary hits route through `arpa_to_ipa`, so an ARPAbet-producing OOV predictor
  plugs into a converter that already exists.
- Sentence chunking holds RTF (0.176 chunked vs 0.184 whole-passage) and avoids the
  510-token limit.

## Runtime revised (2026-08-20, prose-drm)

The vendoring plan above is superseded. We build the synthesis layer ourselves on
`ort` + `misaki-rs`, and depend on no Kokoro wrapper crate.

### What forced it

`kokoro-tts` never lowercases before the CMUdict lookup, so **every capitalized word
misses the dictionary and falls through to the letter-speller**:

```
the   -> ðə              The   -> tˈiˈAʧˈi        ("T-H-E")
she   -> ʃˈi             She   -> ˈɛsˈAʧˈi        ("S-H-E")
close -> klˈoʊs          Close -> sˈiˈɛlˈOˈɛsˈi   ("C-L-O-S-E")
```

That means the first word of every sentence, every proper noun, and every "I" is
spelled out aloud. It also explains the 510-token panic: spelling words out inflates
the token count, which is why one ordinary paragraph sat exactly at the limit.

The crate is Chinese-first (README in Chinese, `jieba`/`pinyin`/`chinese-number`
dependencies, flagship model `kokoro-v1.1-zh.onnx`, mostly-Chinese example text).
Chinese has no capitalization and does not touch CMUdict, so this path never fires for
its author or its main users.

### Why not swap to `kokoro-en`

Because the adoption numbers do not support it, and popularity was the wrong basis for
the original choice anyway. Latest-version downloads are the honest figure: `kokoro-en`
0.1.5 has **216**, `kokoro-tts` 0.3.3 has **613**. `kokoro-en` has 2 GitHub stars, no
forks, no real reverse dependencies, and publishes no model assets. Both totals are
inflated by single-version spikes that read as mirror and CI traffic.

There is no well-used Rust Kokoro wrapper. The foundations are well used; the ~300-line
shims on top are not.

### The decision

Depend directly on the layers that are actually exercised:

| Crate | Total | Recent (90d) | Role |
|---|---|---|---|
| `ort` | 16.1M | 6.0M | ONNX Runtime bindings |
| `misaki-rs` | 47k | 43k | POS-aware English g2p |

`kokoro-tts`'s entire inference core is `synthesizer.rs`, 123 lines: phonemes in,
tokenize, build three tensors (`tokens`, `style`, `speed`), run the session, samples
out. Our own layer is on the order of 200-300 lines, and owning it resolves every
defect at once: determinism comes from misaki, the voice-pack bounds check is ours, the
execution providers are configured directly, the `ort` pin is ours, and the OOV
predictor hook exists by construction.

`misaki-rs` runs a trained averaged-perceptron POS tagger. Measured against
`kokoro-tts` on hard cases, it is fully deterministic (1 distinct output over 8 calls,
against 6) and correct on the cases that matter most in prose:

| Phrase | Should say | misaki-rs | kokoro-tts |
|---|---|---|---|
| **The** rain had stopped | thuh | correct | "T-H-E" |
| **The** apple fell | thee | correct | "T-H-E" |
| She kept a **record** | REC-ord | correct | "re-CORD" |
| The **wind** picked up | wind | correct | correct |
| She **read** it yesterday | red | wrong | wrong |
| **Close** the door | cloze | wrong | "C-L-O-S-E" |

It scores 7/10 on deliberately hard heteronyms. The residual misses are genuine
hard cases that need more than a POS tag, and are acceptable. `misaki-rs` defaults to
an `espeak` feature pulling GPL `espeak-rs`, so it must be taken with
`default-features = false`.

### Model source changes too

Assets now come from `onnx-community/Kokoro-82M-v1.0-ONNX` on Hugging Face
(Apache-2.0), mirrored to Prose's own release assets, rather than a solo maintainer's
releases. Two things improve:

- **fp16 exists again.** That repo carries `model.onnx` (326MB), `model_fp16.onnx`
  (163MB), `model_q8f16.onnx` (86MB) and others. The earlier "no fp16 build" finding
  was specific to `kokoro-tts`'s own release assets.
- **Voices are per-file.** 55 individual `voices/*.bin` files at roughly 510KB each
  (510 x 1 x 256 float32), so we ship only the voices we offer rather than a 27MB
  packed bundle in a crate-specific bincode format.

The earlier fp32-beats-int8 measurement was taken through the broken g2p, which was
synthesising spelled-out letters, so it is indicative rather than authoritative, and
fp16 was never in that comparison. **Re-measure fp16 against fp32 in the new layer
before fixing the model choice.**

## Hardware acceleration (2026-08-20)

Requirement added: use the Neural Engine, or failing that Apple Silicon GPU.

This only became possible with the decision above. `kokoro-tts` hardcoded
`CUDAExecutionProvider` and exposed no way to configure execution providers; owning
session construction means `ort`'s CoreML EP is reachable. `ort` gives us:

- `ComputeUnits::{All, CPUAndNeuralEngine, CPUAndGPU, CPUOnly}` to target the ANE or
  the GPU explicitly.
- `ModelFormat::MLProgram` (CoreML 5+, macOS 12+), which "supports more operators" than
  the default `NeuralNetwork` format. This matters directly: the more operators CoreML
  accepts, the less of the graph falls back to CPU.
- `with_model_cache_dir`, which caches the compiled CoreML model. CoreML compiles the
  graph on first load, so without this we would pay that cost on every app launch,
  landing squarely on the first-play latency.
- `with_specialization_strategy(FastPrediction)` and
  `with_low_precision_accumulation_on_gpu`.

Requires the `coreml` feature on `ort`.

### Measured: CoreML cannot run this model (2026-08-20)

Answered, and the answer is no. CoreML does not partially offload Kokoro; it refuses
the graph outright.

```
CPU only (no CoreML EP)   RTF 0.123 (8.1x real time)   9,168 nodes, all CPU
CoreML All/MLProgram      RUN FAILED
  Input: input_ids has unbounded dimension which is not supported.
```

Three structural blockers: the export is fully dynamic (`input_ids [1, -1]`,
`waveform [1, -1]`) and the ANE is a fixed-shape accelerator; the duration predictor
and text encoder are LSTMs, which the ANE cannot run at all; and the ISTFT decoder uses
`NonZero`, whose output shape is data-dependent and can never be made static.

**Decision: ship on CPU.** 8.1x real time on an M4 Pro against the roughly 1x a
three-sentence lookahead needs. Note this improved from an earlier 0.184 only because
the g2p was fixed; the old figure was partly timing the synthesis of spelled-out
letters.

An ANE port is possible (it needs the model split into stages with the LSTM and
data-dependent parts on CPU, and a matrix of fixed-size bucket exports instead of one
dynamic model) but is out of scope. It is a contained swap if ever wanted, since only
the "phonemes in, samples out" box changes.

> **Do not retry the CoreML path on this model.** Driving `ANECompilerService` with
> this unbounded-dimension graph triggered a kernel panic (`element modified after
> free`, XNU 25.5.0, ANE stack live in the panic log) and forced a reboot. The kernel
> bug is Apple's, but the trigger is reproducible and there is nothing to gain: CPU
> already exceeds what the feature needs by 8x.

## Implementation notes (2026-08-20)

Amendments made while building v1. Each of these supersedes what the Decision
section above says.

### The audio cache key drops the path

The Decision says rendered audio is keyed by `(repo, ref, path, voice, hash of
chunk text)`. It is keyed by `(voice, hash of chunk text)` alone.

The path and the ref carry no information the text hash does not. Audio is a
pure function of the words and the voice, so including where the words happened
to live only splits the cache: a sentence that survives an edit elsewhere in the
chapter, a chapter that is moved or renamed, or the same passage appearing in
both an abridged and a full version, would each re-render for no reason.

The path would have been worth keeping if eviction were per-file, but it is
least-recently-used across the whole table, so nothing needed it.

Cap is 300MB, roughly six chapters in one voice. WAV is uncompressed because
there is no encoder in the dependency tree and adding one to save disk that
SQLite reuses anyway is not worth a new dependency.

### The mirror release does not exist yet

The Decision says the weights are mirrored to Prose's own release assets rather
than fetched from Hugging Face at runtime. The fetcher tries the mirror first
and falls back to Hugging Face, and today **every download is served by the
fallback**, because no `tts-models-v1` release has been created.

Creating it is a one-time upload of nine files (`model_fp16.onnx`,
`tokenizer.json`, and six voices). The pinned SHA-256 hashes are already correct
for it: the mirror would serve identical bytes.

The fallback stays either way. A failed 163MB download is the difference between
the feature working and not, and the checksum is what makes trying a second
source safe rather than a way to install the wrong file.

### Six voices, not fifty-five

Kokoro ships 55. Most are graded D or below on the model card. The picker offers
`af_heart`, `af_bella`, `am_michael`, `am_fenrir`, `bf_emma` and `bm_george` -
high-graded, and spread across accent and register so choosing is about the
reading rather than about hunting for one that is merely competent.

### Chunk length is capped in characters, not tokens

`speech.ts` splits anything over 350 characters. The real ceiling is Kokoro's
510 tokens, and its tokens are IPA characters, so the two units do not convert
exactly. 350 leaves a wide margin and keeps the first chunk quick to render.
`Synthesizer::synth` still returns `ChunkTooLong` rather than trusting it.

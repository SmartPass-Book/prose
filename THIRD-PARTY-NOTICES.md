# Third-party notices

Prose itself is all rights reserved (see [LICENSE](./LICENSE)). This file covers
the third-party components it links or downloads.

## Required acknowledgement

`grapheme_to_phoneme` is BSD-4-Clause, whose clause 3 is the old advertising
clause. It requires this acknowledgement in advertising materials mentioning
features of, or use of, this software:

> This product includes software developed by Brandon Thomas
> (bt@brand.io, echelon@gmail.com).

This is the only dependency in the tree that imposes such a requirement.

## Text to speech

| Component | License | Used for |
|---|---|---|
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) weights, via [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) | Apache-2.0 | The voice model and voice packs, downloaded on first play |
| [`ort`](https://github.com/pykeio/ort) | MIT OR Apache-2.0 | Rust bindings to ONNX Runtime |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) | MIT | Inference, bundled by `ort` |
| [`misaki-rs`](https://crates.io/crates/misaki-rs) | MIT | English grapheme-to-phoneme, CMUdict plus a part-of-speech tagger |
| [CMUdict](http://www.speech.cs.cmu.edu/cgi-bin/cmudict) | BSD-2-Clause | The pronunciation dictionary inside `misaki-rs` |
| [`grapheme_to_phoneme`](https://crates.io/crates/grapheme_to_phoneme) | BSD-4-Clause | Predicting pronunciations for words CMUdict does not have |

The model weights are **not** bundled in the DMG. They are fetched on first play
into the app data directory. See `src-tauri/src/tts/fetch.rs`.

## espeak-ng is deliberately absent

`misaki-rs` is declared with `default-features = false`. Its default features
pull in `espeak-rs`, which links **espeak-ng (GPLv3)**. Prose ships as a signed,
all-rights-reserved application, so GPLv3 code cannot be inside the bundle.

The out-of-vocabulary predictor exists to fill the gap espeak would otherwise
have filled.

Verified with `cargo metadata`: neither `espeak-rs` nor `espeak-rs-sys` appears
anywhere in the dependency tree. The only crate in the tree whose license string
mentions the GPL at all is `r-efi`, which is `MIT OR Apache-2.0 OR
LGPL-2.1-or-later` - MIT is selected, and it is a UEFI target crate that is not
compiled into a macOS build in any case.

To re-check after a dependency change:

```bash
cd src-tauri && cargo metadata --format-version 1 | python3 -c "import json,sys; print([ (p['name'], p.get('license')) for p in json.load(sys.stdin)['packages'] if 'GPL' in (p.get('license') or '').upper() ])"
```

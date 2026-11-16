# tincan-denoise

DeepFilterNet3 noise suppression for the web client's voice pipeline (docs/09-audio-pipeline.md §3, tier A).

A thin wrapper around upstream [libDF](https://github.com/Rikorose/DeepFilterNet) (Hendrik Schröter; code and
model weights MIT OR Apache-2.0), pinned to one commit in `Cargo.toml`. It builds to a WebAssembly module that
exports plain functions and imports nothing, so the AudioWorklet
(`apps/web/src/core/voice/deepfilter/worklet.ts`) needs no generated JavaScript glue. `src/lib.rs` describes the
memory protocol.

## Build

From the repository root, with Rust and the `wasm32-unknown-unknown` target:

```sh
sh scripts/build-deepfilternet.sh
```

This writes `apps/web/public/denoise/deepfilternet3/` (git-ignored): the module, the upstream model archive from
the same pinned checkout (its SHA-256 is checked), both licence texts, `SHA256SUMS`, and `manifest.json` with
the two files' sizes. The client reads the manifest for the download progress and to learn that the server has
the tier at all. `pnpm build` then copies them into the PWA. The web Docker image runs the same script.

Without these files the client still works: choosing DeepFilterNet falls back to RNNoise and says so.

## Updating upstream

Change `rev` in `Cargo.toml`, run `cargo update -p deep_filter --manifest-path apps/denoise-wasm/Cargo.toml`,
update `model_sha256` in the build script if the model changed, and re-check the upstream licence for the code
and the weights.

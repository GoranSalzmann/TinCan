#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Builds the DeepFilterNet3 noise suppression tier (docs/09-audio-pipeline.md §3) for the web client.
# Run from the repository root. Needs Rust with the wasm32-unknown-unknown target; nothing else.
#
# Writes OUTPUT_DIRECTORY (default apps/web/public/denoise/deepfilternet3):
#   deepfilternet3.wasm        apps/denoise-wasm built for wasm32 with SIMD
#   deepfilternet3-model.bin   upstream models/DeepFilterNet3_onnx.tar.gz from the pinned commit, byte for byte
#                              (renamed so no server or dev proxy decides to gunzip it on the way)
#   LICENSE-MIT, LICENSE-APACHE, SHA256SUMS
#   manifest.json              the two files' sizes, for the client's download progress
# Without these files the web client still works: choosing DeepFilterNet falls back to RNNoise and says so.
set -eu
out=${1:-apps/web/public/denoise/deepfilternet3}
manifest=apps/denoise-wasm/Cargo.toml
# sha256 of DeepFilterNet3_onnx.tar.gz at the pinned commit.
model_sha256=c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616

if command -v rustup >/dev/null 2>&1; then
    rustup target add wasm32-unknown-unknown >/dev/null
fi
RUSTFLAGS="-C target-feature=+simd128" \
    cargo build --locked --release --target wasm32-unknown-unknown --manifest-path "$manifest"

# The model and the licence texts come from the same upstream checkout cargo just built from.
libdf=$(cargo metadata --locked --format-version 1 --manifest-path "$manifest" |
    grep -o '"manifest_path":"[^"]*/libDF/Cargo.toml"' | head -n 1 | sed 's/^"manifest_path":"//; s/"$//')
upstream=$(dirname "$(dirname "$libdf")")
[ -f "$upstream/models/DeepFilterNet3_onnx.tar.gz" ] || {
    echo "DeepFilterNet checkout not found (cargo metadata gave '$libdf')" >&2
    exit 1
}
echo "$model_sha256  $upstream/models/DeepFilterNet3_onnx.tar.gz" | sha256sum -c - >/dev/null

mkdir -p "$out"
target_dir=${CARGO_TARGET_DIR:-apps/denoise-wasm/target}
cp "$target_dir/wasm32-unknown-unknown/release/tincan_denoise.wasm" "$out/deepfilternet3.wasm"
cp "$upstream/models/DeepFilterNet3_onnx.tar.gz" "$out/deepfilternet3-model.bin"
cp "$upstream/LICENSE-MIT" "$out/LICENSE-MIT"
cp "$upstream/LICENSE-APACHE" "$out/LICENSE-APACHE"
(
    cd "$out"
    sha256sum deepfilternet3.wasm deepfilternet3-model.bin >SHA256SUMS
    # Byte sizes for the download progress; the client also reads this file to learn that the server has the tier.
    printf '{"wasm":%s,"model":%s}\n' "$(wc -c <deepfilternet3.wasm | tr -d ' ')" \
        "$(wc -c <deepfilternet3-model.bin | tr -d ' ')" >manifest.json
)
echo "DeepFilterNet3 written to $out"

#!/bin/sh
# Rebuilds src/tactical-map/oodle.wasm from oozextract (Cargo.lock pins it) in a
# Rust container: no local Rust or wasm target is needed.
set -eu
cd "$(dirname "$0")"
docker run --rm -v "$PWD":/work -w /work -e CARGO_HOME=/work/.cargo rust:1.90-slim \
  sh -c 'rustup target add wasm32-unknown-unknown >/dev/null && cargo build --locked --release --target wasm32-unknown-unknown'
cp target/wasm32-unknown-unknown/release/oodle_wasm.wasm ../../src/tactical-map/oodle.wasm
chmod 644 ../../src/tactical-map/oodle.wasm
# The container wrote these as root.
docker run --rm -v "$PWD":/work -w /work rust:1.90-slim rm -rf target .cargo
sha256sum ../../src/tactical-map/oodle.wasm

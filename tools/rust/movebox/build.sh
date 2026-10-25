#!/bin/sh
# r15-50: builds the moveBox slice as WebAssembly (movebox.wasm, browser and Node) and as a Node N-API addon (movebox.node).
# Needs rustup with the wasm32-unknown-unknown target: rustup target add wasm32-unknown-unknown
set -e
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
cargo build --release
cp target/release/libmovebox.so target/release/movebox.node
ls -l target/wasm32-unknown-unknown/release/movebox.wasm target/release/movebox.node

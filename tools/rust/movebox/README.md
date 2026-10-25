# r15-50: world.moveBox in Rust (experiment, not merged)

One hot slice of the simulation, mob and drop collision (`world.moveBox` in js/world.js, 27 to 34% of a 1.5 headless tick), ported
to Rust to measure what the language buys. Report: /mnt/project-files/reports/r15-50.md.

- `src/core.rs`: the slice. It follows the JavaScript line by line (the same f64 operations in the same order), so its results are
  bit-identical. It reads its own mirror of the chunks' block sections. Margin cells (face edges) and panes (dynamic boxes) return
  FALLBACK, and the JavaScript does that call.
- `src/lib.rs`: two bindings with no dependencies. One is WebAssembly (`wasm32-unknown-unknown`, plain exports, no wasm-bindgen).
  The other is a Node N-API addon with the napi functions declared by hand.
- `jsfast.js`: the control. It is the same algorithm written back in JavaScript and reads the game's own chunks.
- `glue.js`: switches `world.moveBox` between `js`, the slice (`rust` mode) and `compare`. In compare mode both run on every call,
  and any difference is counted. It keeps the mirror current through the `world.mirror` hooks in js/world.js.
- `bench.js`: the headless runs (`run`) and the per-call replay (`calls`).

```
rustup target add wasm32-unknown-unknown
tools/rust/movebox/build.sh
node tools/rust/movebox/bench.js run 3 1200 wasm 150     # one game day on seed 3, hash every 1/8 day
node tools/rust/movebox/bench.js calls 3 200 3           # per-call: js, jsfast, wasm, napi on the same recorded calls
```

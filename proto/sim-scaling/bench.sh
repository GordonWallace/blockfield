#!/bin/bash
# Runs the scaling measurements; one JSON line per run in $OUT (default results.jsonl). Run nothing else at the same time.
OUT=${OUT:-results.jsonl}
R=./rust/target/release/simscale
T=${TICKS:-1500}
for w in 1 2 3 4; do echo "{\"run\":\"js-dyn\",\"r\":$(node sim.js $w 2048 64 16 $T 0 1 0 1 64 | tail -1)}" >> $OUT; done
for w in 1 2 3 4; do echo "{\"run\":\"rust\",\"r\":$($R $w 2048 64 16 $T 0 1 64 2>/dev/null)}" >> $OUT; done
for w in 1 4; do echo "{\"run\":\"js-static-strips\",\"r\":$(node sim.js $w 2048 64 16 $T 0 1 0 0 64 | tail -1)}" >> $OUT; done
# small regions (more crossings): RS 32, static interleaved vs dynamic
for s in 0 1; do echo "{\"run\":\"js-rs32-interleaved-sched$s\",\"r\":$(node sim.js 4 2048 64 16 $T 0 1 1 $s 32 | tail -1)}" >> $OUT; done
echo "{\"run\":\"js-rs32-1w\",\"r\":$(node sim.js 1 2048 64 16 $T 0 1 1 1 32 | tail -1)}" >> $OUT
echo "{\"run\":\"rust-rs32\",\"r\":$($R 4 2048 64 16 $T 0 1 32 2>/dev/null)}" >> $OUT
# coarse level of detail beyond 256 blocks of the centre (every 4th tick)
echo "{\"run\":\"js-far256\",\"r\":$(node sim.js 4 2048 64 16 $T 256 1 0 1 64 | tail -1)}" >> $OUT
echo "{\"run\":\"rust-far256\",\"r\":$($R 4 2048 64 16 $T 256 1 64 2>/dev/null)}" >> $OUT
# 4x the villagers per village (65,536)
for w in 1 4; do echo "{\"run\":\"rust-64per\",\"r\":$($R $w 2048 64 64 $((T/2)) 0 1 64 2>/dev/null)}" >> $OUT; done
for w in 1 4; do echo "{\"run\":\"js-64per\",\"r\":$(node sim.js $w 2048 64 64 $((T/2)) 0 1 0 1 64 | tail -1)}" >> $OUT; done

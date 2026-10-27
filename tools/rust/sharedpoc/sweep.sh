#!/bin/sh
# Runs the whole comparison: node and the release build, one at a time (timings need a quiet machine). Output: one JSON line per run.
# Usage: sh sweep.sh <K> > results.jsonl     (K=6000: ~18 us an object in both languages; K=600: ~2 us, a light object)
K=${1:-6000}
B=./target/release/sharedpoc
for spec in 200:400 2000:100 20000:40; do
  N=${spec%:*}; T=${spec#*:}
  node poc.js single $N 1 $K $T
  $B single $N 1 $K $T
  for th in 1 2 4; do
    node poc.js msgobj $N $th $K $T
    node poc.js msgbuf $N $th $K $T
    node poc.js sab $N $th $K $T
    $B threads $N $th $K $T
  done
done

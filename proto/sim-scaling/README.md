# Sim-scaling prototype (not game code)

A literal villager economy on a voxel world (miners, woodcutters, farmers, builders, village chests, crops and trees that grow),
written to measure how a Blockfield-style simulation scales over cores and languages. Write-up and results:
`/mnt/project-files/notes/sim-scaling-feasibility.md` and `/mnt/project-files/sim-scaling/results/` in the project.

- `kernel.js`: the rules. Every tick has two phases. Phase A ("think"): each villager reads the frozen world and writes only its own
  state, plus *intents* (mine, place, harvest, sell, buy, wage) into the inbox of the region they touch. Phase B ("apply"): the owner
  of each region resolves that region's intents in villager-id order, grows plants, and files villagers into the next tick's grid.
  Nothing comes from nothing: items only move through resolved intents, and the run checks stone+cobble, dirt and coins totals.
- `sim.js`: Node runner with worker threads and SharedArrayBuffer. Regions (64x64 blocks) are the unit of work; threads take them
  from a shared counter (or a fixed share). The end-of-run hash is the same for any worker count.
- `rust/`: the same rules in Rust with native threads. Its end-of-run hash matches the JS one bit for bit.
- `bench.sh`: the measurement runs.

```
node sim.js [workers] [size] [spacing] [perVillage] [ticks] [far] [seed] [own] [sched] [regionSize]
cd rust && cargo build --release && ./target/release/simscale [threads] [size] [spacing] [perVillage] [ticks] [far] [seed] [regionSize]
```

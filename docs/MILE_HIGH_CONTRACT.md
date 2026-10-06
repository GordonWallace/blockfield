# Mile-high engine: shared contract (engine <-> worldgen)

Limits are per world and live on `BF`: `BF.MIN_Y` (lowest y, bedrock), `BF.H` (exclusive top), `BF.SEA` (sea level), plus `BF.SY0 = MIN_Y >> 4` and `BF.SY1 = H >> 4` (section index range, SY1 exclusive). Never cache them at module load; read them at call time.

| generator | MIN_Y | H | SEA | notes |
|---|---|---|---|---|
| gen 1, gen 2 (every old world) | 0 | 192 | 48 | byte-identical terrain to PR #10 |
| gen 3 (new worlds) | -64 | 3072 | 0 | mile-high terrain |

`BF.setLimits(gen)` (defined in worldgen.js, called by `worldgen.init`) assigns all five values.

## Section layout
A chunk column is split into 16-high sections. Section index `sy = y >> 4` (floor, so negative y works). A block at local `(lx, y, lz)` inside a window that starts at section `sy0` has index `((y - sy0 * 16) * 16 + lz) * 16 + lx` (for sy0 = 0 this is the old `vIdx`).

## Worldgen API
- `worldgen.init(noise, { gen, biomeScale })`: also calls `BF.setLimits(gen)`.
- `worldgen.generateBand(cx, cz)` -> `{ lo, hi, vox }`. `lo`/`hi` are section indices (hi exclusive) of the band that holds everything non-trivial in this column: terrain surface, water, trees, plants, villages and some stone below the lowest surface point (about 3 sections). `vox` is a `Uint16Array((hi - lo) * 4096)` window starting at section `lo`. Everything above `hi * 16` must be air, everything below `lo * 16` must be what `generateRange` would produce. For gen 1/2 return the whole column (`lo = 0, hi = 12`).
- `worldgen.generateRange(cx, cz, sy0, sy1)` -> `Uint16Array((sy1 - sy0) * 4096)`: terrain only for an arbitrary section range (used lazily when the player digs below the band): stone, deepslate, caves, ores, magma, bedrock, water. It must agree exactly with `generateBand` where they overlap (same blocks), because the band is generated first and deeper ranges are generated later. Pure function of (seed, coordinates).
- `worldgen.generate(cx, cz, vox)` stays for gen 1/2 (full 192-high column) so tools and old tests keep working.
- `worldgen.heightAt(x, z)`, `waterLevelAt(x, z)`, `biomeAt`, `tintAt`, `villagesNear`, `nearestVillage`: unchanged, signed absolute y for gen 3.

## Engine API (world.js, for consumers)
- `world.getBlock(x, y, z)`: any y. Below `MIN_Y` bedrock, above `H` air, inside the column but outside the loaded band: below -> `BF.B.stone` (solid), above -> air.
- `world.isSolid`, `world.setBlock` (extends the band if needed), `world.heightAt(x, z)` (highest solid y in the loaded band, `MIN_Y - 1` if the column is not loaded).
- `world.chunkBlock(c, lx, y, lz)`: block in a chunk object (same out-of-band rules, no bounds on y inside MIN_Y..H).
- `c.lo`, `c.hi`: loaded section range of chunk `c` (hi exclusive); `c.y0 = lo * 16`, `c.y1 = hi * 16` (exclusive). Consumers that scan a chunk loop `y` over `c.y0 .. c.y1 - 1` and use `world.chunkBlock`.
- `c.top[lz * 16 + lx]`: highest light-blocking y in the column (signed), `MIN_Y - 1` if none.
- `world.ensureRange(x, z, y0, y1)`: makes sure the sections covering y0..y1 at that column are loaded (generated lazily). Returns false if the chunk itself is not loaded.
- Edits are stored per chunk by local index `((y - MIN_Y) * 16 + lz) * 16 + lx`, which for the legacy limits is the old index.

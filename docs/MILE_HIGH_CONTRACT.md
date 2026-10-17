# Mile-high engine: shared contract (engine <-> worldgen)

Limits live on `BF`: `BF.MIN_Y` (lowest y, bedrock), `BF.H` (exclusive top), `BF.SEA` (sea level), plus `BF.SY0 = MIN_Y >> 4` and `BF.SY1 = H >> 4` (section index range, SY1 exclusive). Read them at call time rather than caching them at module load.

| generator | MIN_Y | H | SEA | notes |
|---|---|---|---|---|
| gen 4 (the planet, the only world since 1.4) | -64 | 3072 | 0 | the round planet: atlas x/z (js/planet.js); generator 3's mile-high terrain sampled on the sphere (js/worldgen.js, js/planetgen.js) |

The flat generators were retired in 1.4 (spec r14-24): gen 1 and gen 2 (0 / 192 / 48) and gen 3 (the flat mile-high world, -64 / 3072 / 0). 1.4 opens no world made with them.

`BF.setLimits()` (defined in worldgen.js, called by `worldgen.init`; world.js has the same fallback) assigns all five values.

## Section layout
A chunk column is split into 16-high sections. Section index `sy = y >> 4` (floor, so negative y works). A block at local `(lx, y, lz)` inside a window that starts at section `sy0` has index `((y - sy0 * 16) * 16 + lz) * 16 + lx` (for sy0 = 0 this is `BF.vIdx`).

## Worldgen API
- `worldgen.init(noise, { biomeScale, villages })`: also calls `BF.setLimits()`. (A `gen` option is ignored: every world is the planet.)
- `worldgen.generateBand(cx, cz)` -> `{ lo, hi, vox }`. `lo`/`hi` are section indices (hi exclusive) of the band that holds everything non-trivial in this column: terrain surface, water, trees, plants, villages and some stone below the lowest surface point (about 3 sections). `vox` is a `Uint16Array((hi - lo) * 4096)` window starting at section `lo`. Everything above `hi * 16` must be air, everything below `lo * 16` must be what `generateRange` would produce.
- `worldgen.generateRange(cx, cz, sy0, sy1)` -> `Uint16Array((sy1 - sy0) * 4096)`: terrain only for an arbitrary section range (used lazily when the player digs below the band): stone, deepslate, caves, ores, magma, bedrock, water. It must agree exactly with `generateBand` where they overlap (same blocks), because the band is generated first and deeper ranges are generated later. Pure function of (seed, coordinates).
- `worldgen.heightAt(x, z)`, `waterLevelAt(x, z)`, `biomeAt`, `tintAt`, `villagesNear`, `nearestVillage`: signed absolute y; x / z are atlas coordinates (a margin address reads the canonical column it shows).

## Engine API (world.js, for consumers)
- `world.getBlock(x, y, z)`: any y. Below `MIN_Y` bedrock, above `H` air, inside the column but outside the loaded band: below -> `BF.B.stone` (solid), above -> air.
- `world.isSolid`, `world.setBlock` (extends the band if needed), `world.heightAt(x, z)` (highest solid y in the loaded band, `MIN_Y - 1` if the column is not loaded).
- `world.chunkBlock(c, lx, y, lz)`: block in a chunk object (same out-of-band rules, no bounds on y inside MIN_Y..H).
- `c.lo`, `c.hi`: loaded section range of chunk `c` (hi exclusive); `c.y0 = lo * 16`, `c.y1 = hi * 16` (exclusive). Consumers that scan a chunk loop `y` over `c.y0 .. c.y1 - 1` and use `world.chunkBlock`.
- `c.top[lz * 16 + lx]`: highest light-blocking y in the column (signed), `MIN_Y - 1` if none.
- `world.ensureRange(x, z, y0, y1)`: makes sure the sections covering y0..y1 at that column are loaded (generated lazily). Returns false if the chunk itself is not loaded.
- Edits are stored per chunk by local index `((y - MIN_Y) * 16 + lz) * 16 + lx`.

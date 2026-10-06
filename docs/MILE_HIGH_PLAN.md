# Mile-high terrain: plan (stacked on PR #10)

Goal (Gordon): sea level at y=0 with negative y below it, flat plains a mile up (y 1000+), mountains above that. Old worlds keep loading.

## Approach
- **Chunk columns hold vertical sections.** A chunk is still a 16x16 column, but its blocks live in 16x16x16 sections (`Uint16Array(4096)`), allocated only when a section is not uniform (all air, all stone, all water are stored as one id). World limits become per world: `BF.MIN_Y` (bottom, bedrock) and `BF.H` (exclusive top); `BF.SEA` is per world too.
  - generator v1/v2 worlds (every existing save): `MIN_Y=0, H=192, SEA=48`, same generator, same edit indices, byte-identical terrain.
  - generator v3 (new worlds): `MIN_Y=-64, H=3072, SEA=0`.
- **Vertical streaming.** The generator reports, per column, the band of sections that holds the surface (`columnRange`). The engine loads and meshes that band for every column in view (so view distance still means horizontal distance), treats everything below the loaded range as solid and above it as air, and loads more sections downward when the player digs or flies into the ground (within 3 sections of the player) and upward when anything is built above the band. One mesh pair per column, as today, built from the loaded non-uniform sections.
- **Generation by section.** `generateSection(cx, cz, sy, vox)` is deterministic from the seed. Sections in the surface band come from one column pass (terrain, surface, trees, plants, villages, caves, ores). Sections below the band are generated lazily: stone/deepslate, caves, ores, magma, all as pure functions of absolute coordinates so the band edge has no seam.
- **Terrain model v3.** Same continents, biomes, rivers machinery, rescaled: ocean floor about -10 to -55, coastal lowlands 0 to 100, a long escarpment of foothills up to broad flat high plains (about y900-1300, very low relief), ranges on top reaching about y2500, soft ceiling below 3072. Temperature falls much more gently with height (1000 blocks is cool, not arctic). Rivers keep running downhill to sea level, so on the way off the plains they cascade in whole-block steps.

## What changes per system
- `world.js`: sections, signed y, vertical streaming, mesh from sections, fluids/growth with signed y, collision and raycast unchanged in API (`getBlock/isSolid/setBlock` take any y; unloaded below = solid, above = air).
- `light.js`: block light arrays per section (allocated when a torch/light exists nearby), column sky tops stored signed.
- `worldgen.js`: v3 height model, `columnRange` / `generateSection`, v1/v2 served through an adapter (generates the old 192-high array, slices it).
- Consumers that read `chunk.vox`/`maxY` directly (`jobs`, `breeding`, `signs`, `villagesim`, `weather`, `maps`, `mobs`): moved to a section iterator and `world.getBlock`; `y < 0` and `y >= BF.H` guards use `BF.MIN_Y`.
- `sky.js`/`weather.js`/`audio.js`: cloud deck follows the local ground height (so you walk under clouds on the plains and above them on peaks), snow lines and wind altitude are relative to sea level.
- Commands (`/tp`, `/fill`, `/setblock`, `/summon`), F3 and the map UI accept negative and large y. Maps ignore height except for shading.
- Villages and their data-only chunks: unchanged (they live in the surface band, `villagesim` keeps those sections loaded).

## Memory and performance at render distance 24
Today a chunk is a fixed 96 KB array (2,400 chunks is about 230 MB at the previous PR's 192 height). Sections cost 8 KB each and only non-uniform ones exist: a plains column is about 4 sections, so roughly 80 MB for the same view; mountains cost more. Chunk generation is more work per column (caves in the band) but deep sections are never generated unless visited. Mesh counts and draw calls stay at two per column.

## Old saves
Saves carry `gen`; gen 1 and 2 worlds load into the legacy limits (`MIN_Y=0, H=192, SEA=48`) and generate exactly as now. Edits are stored by chunk and local index `((y - MIN_Y)*16 + z)*16 + x`, which is the old formula for legacy worlds, so no migration is needed. New worlds are gen 3 with their own limits. The creation screen just creates gen 3; there is no in-place upgrade of an old world (the terrain would change under existing builds).

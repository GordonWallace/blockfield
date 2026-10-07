# Blockfield module contract

Plain browser scripts (no bundler, no ES modules). Every file is an IIFE that attaches to the
global `window.BF`. Three.js r128 is the global `THREE`. Load order is in `index.html`:
blocks, noise, textures, worldgen, world, sky, trading, mobs, inventory, drops, player, save, main.
Modules must only *call* other modules from inside `init()`/`update()`/event handlers,
never at load time (except blocks/noise which are pure).

Each module injects its own CSS (a `<style>` element created from JS) and mounts its own DOM
into `#ui` (a full-screen, pointer-events:none layer whose direct children get pointer-events:auto).
Do not edit `index.html`, `main.js`, `world.js`, `blocks.js` or `noise.js`; if you need a core
change, describe it in your final report instead, and work around it meanwhile.

UI look: dark translucent panels (`--panel`, `--panel-edge`), text `--ink`/`--muted`,
accent `--accent` (grass green), `--danger` red, display font `--display` (Silkscreen, pixel),
body font `--mono`. These CSS variables are defined on :root in index.html.

## Core (owned by integrator)

- `BF.CS = 16`. World limits are per world and set by `BF.setLimits(gen)` (called from `worldgen.init`): `BF.MIN_Y` (lowest y, bedrock), `BF.H` (exclusive top), `BF.SEA`
  (water fills y <= SEA where terrain is lower), `BF.SY0/SY1` (section range). Generators 1 and 2 (every old world): 0 / 192 / 48. Generator 3 (new worlds, mile-high): -64 / 3072 / 0.
  Never cache them at load time. Full engine/worldgen contract: docs/MILE_HIGH_CONTRACT.md.
- Chunks are 16x16 columns of 16-high sections: `c.secs[sy - c.lo]` is a `Uint16Array(4096)` (index `(ly<<8)|(lz<<4)|lx`) or a number (the whole section is that block). `[c.lo, c.hi)` is the
  loaded band (`c.y0 = lo*16`, `c.y1 = hi*16`); below it is stone, above it air, and the band grows lazily (`world.ensureRange`, `setBlock`, the player digging or falling). Read blocks with
  `world.getBlock` / `world.chunkBlock(c, lx, y, lz)`, scan with `world.scanFlagged(c, flagTable, cb)`. Edits are stored per chunk by `((y - MIN_Y)*16 + lz)*16 + lx` (the old `vIdx` for legacy worlds).
- `BF.vIdx(x, y, z)` -> index `(y*CS + z)*CS + x` into a legacy full-height window (generator 1/2 `generate`, tools).
- `BF.blocks[id]`, `BF.items[id]`, `BF.B.name -> blockId`, `BF.I.name -> itemId` (blocks.js). Block ids are 0..`BF.MAX_BLOCK` (4095;
  voxels are `Uint16Array`; ids 0..255 are the original blocks and are never renumbered, saves store block ids in edit lists),
  non-block item ids start at `BF.ITEM_BASE` (4096) and are saved by name. `BF.items` is sparse (blocks, then a gap, then
  items from ITEM_BASE): skip holes when iterating; test blocks with `BF.items[id].isBlock`. `SOLID/OPAQUE/RENDER/FLUID/
  REPLACEABLE` and `world._faceTint` are sized `MAX_BLOCK + 1`. Block fields: name, solid, opaque, render ("cube"|"cutout"|"liquid"), tiles{top,side,bottom},
  hardness (seconds by hand), tool ("pickaxe"|"axe"|"shovel"|"shears"|null), needsTool, drop (item id or null),
  color, stack. Item fields: name, tool{type,tier,speed,damage}, food, color, stack.
  `BF.SOLID/OPAQUE/RENDER` lookup tables. `BF.itemName(id)` -> display name.
- Doors and beds are two blocks, one block id per state (blocks.js): `BF.DIRS[f]` = [dx, dz] for facing f
  (0 north -z, 1 east +x, 2 south +z, 3 west -x), `BF.dirIndex(dx, dz)`, `BF.doorId(f, upper, open)`, `BF.bedId(f, head)`.
  Door blocks have `door: {f, upper, open}` (f = edge the closed slab sits on; open doors are not solid), bed blocks
  `bed: {f, head}` (f = foot -> head). Both have `boxes` (model boxes in 1/16, optional 7th entry = tile name),
  `box` (collision box in 1/16), `item` (the item they drop/pick as: `oak_door`, `red_bed`) and `hidden` (not in the
  creative menu). Items with `places: "door"|"bed"` place them. `BF.CBOX[id]` = collision box in blocks for
  non-full solid blocks (used by `boxCollides`/`moveBox`), `BF.rotBox(box16, f)` rotates a south-facing box.
- `BF.world.partnerOf(x,y,z,id?)` -> other half [x,y,z] | null, `removePartner(x,y,z,id)` (removes the other half
  without drops; player.js calls it on `blockBroken`, creeper explosions too), `setDoor(x,y,z,open?)` (both halves;
  toggles when open is omitted; returns the new state).
  `setBlock` also pops doors/beds when the block under the lower half stops being solid (one item via
  `BF.drops.spawnAt(BF.rollDrops(id))`, none in creative; both halves go) and silently removes an upper door half left
  without its lower half.
- `BF.spawnPoint` may also carry `{y, bed: [x,y,z], world: {x,z}}` after sleeping in a bed: respawn is on the bed
  while it stands, else back at `world`. Event `playerSlept()` after a successful night skip.
- `BF.makeNoise(seed)` -> `{n2, n3, fbm(x,y,oct), fbm3(x,y,z,oct), hash(x,z,salt) -> [0,1), hash3(x,y,z,salt)}`.
- `BF.world`: `getBlock(x,y,z)`, `setBlock(x,y,z,id)` (records edits, remeshes), `isSolid`, `heightAt(x,z)`
  (top solid y in loaded data or -1), `isLoaded(x,z)`, `raycast(origin, dir, maxDist, pred?)` ->
  `{x,y,z,id,normal:[nx,ny,nz],dist}|null`, `boxCollides(px,py,pz,halfW,h)`,
  `moveBox(pos, vel, halfW, h, dt, {stepUp})` -> `{onGround, hitX, hitZ, hitCeil, inWater, headInWater}`
  (pos = feet centre, mutated; vel mutated; unloaded chunks are solid),
  `onChunkLoad(fn(cx,cz,chunk))`, `onChunkUnload(fn)`, `setDaylight(l)`, `viewDist`, `setViewDist(n)`,
  `solidMat`, `liquidMat`.
- `BF.scene`, `BF.camera` (PerspectiveCamera, already added to scene so children render), `BF.renderer`.
- `BF.state = {paused, seed, time}`. When `paused` is true, main skips sky/player/mobs update
  (it still calls `BF.player.updatePaused(dt)` if present and `BF.inventory.update(dt)` always).
- Event bus: `BF.on(name, fn)`, `BF.emit(name, ...args)`. Known events:
  `newWorld(seed)`, `blockBroken(x,y,z,blockId)`, `blockPlaced(x,y,z,blockId)`,
  `playerDamaged(amount)`, `playerDied()`, `playerRespawned()`, `mobKilled(mob)`.
- `BF.newWorld(seed)` resets world + mobs, calls `worldgen.init(noise)`, then `player.spawn(x,y,z)`.
- `BF.spawnPoint = {x, z}`. F3 toggles a debug overlay (main.js).

## textures.js (owner: sky/textures worker)

`BF.textures = { build() -> {texture: THREE.Texture, canvas}, uv(tileName) -> [u0,v0,u1,v1], icon(itemId) -> dataURL }`
- Must provide every tile name referenced in `BF.blocks[*].tiles`. 16x16 pixel-art tiles, procedurally drawn on a
  canvas atlas, NearestFilter, no mipmaps, half-texel inset UVs. Cutout tiles (leaves, glass, ice) use alpha (< 0.5 = hole).
- `icon(itemId)`: 32x32+ icon for inventory UI: blocks as a small isometric cube from their tiles, items as pixel sprites.
  Called lazily; cache results.

## worldgen.js (owner: worldgen worker)

`BF.worldgen = { init(noise), generate(cx, cz, vox), heightAt(x, z), biomeAt(x, z) -> {name, ...} }`
- `generate` fills a zeroed `Uint16Array(CS*CS*H)` for chunk (cx, cz) deterministically from the seed. It must not
  depend on other chunks being loaded: structures (trees) that cross chunk borders are placed by iterating candidate
  origins in a margin around the chunk and writing only voxels inside it.
- `heightAt` is the deterministic surface height (used for spawning before chunks load). y=0 is bedrock.
- `init(noise, { gen, biomeScale })`. `gen` is the generator version of the world (`BF.state.gen`): 1 = the original generator (kept bit-for-bit, so
  worlds saved before v2 have no seams), 2 = generator v2. `biomeScale` (>= 1, v2 only) is the relative biome size from the world creation slider.
  `waterLevelAt(x, z)` is the water surface of a column (sea level, or a river's surface above it); `heightAt` is the floor under that water.
- **Generator v2** (js/worldgen.js `climate2`, js/rivers.js; saves store `gen` and `biomeScale`, old saves have neither = gen 1):
  - Continents: continentalness (5 octaves, ~14000-block wavelength, grows 12% per biome-scale step) is contrasted and biased so land and open ocean
    come in blobs thousands of blocks across; a landmass is forced around the origin so spawn is on land. Climate zones (temperature, humidity) and the
    weirdness/erosion fields scale with `biomeScale` (1 = the old size); the border dither widens with it, so big biomes blend softly.
  - Elevation: ocean basins ~y18-45, shelf and coast ~48, lowlands ~52-70, plus broad "uplands" (up to +82 on continental interiors, gentler within ~1500 blocks of
    spawn) and ridged-noise mountains (up to +110 on top), soft-clamped to H-8 = 184. Temperature falls with height (biome bands shift cold above ~y70-175),
    mountain biome thresholds are +35 vs v1 (slopes y115, peaks y135).
  - Rivers (js/rivers.js `BF.rivers`): a jittered 96-block node lattice with a smooth macro potential (terrain without local hills + a bias toward the
    ocean); each node flows to its steepest lower neighbour (within 2 nodes), basins spill over their lowest rim. Sources (inland, likelier when high) whose
    chain reaches the sea within 80 links become rivers; the water surface never rises downstream (it falls in 1-block steps), width
    grows toward the sea. Everything is a pure function of the seed (sources in reach of a query are traced on demand and cached). `climate2` carves the
    channel and a flat floodplain around it into the terrain; river columns report `C.wl` > sea level and `C.rv`.
  - Caves: the coarse cave grid now covers y up to 200 (`GY_MAX`).

## Stone / ore / mineral pack (Tier 1, js/textures-stone.js, js/recipes-stone.js)

80 blocks appended in `blocks.js` between the `// ---- stone/ore pack ----` markers (granite .. amethyst_block, ids 119..198; never reorder) and 8 items
(`lapis_lazuli, redstone, raw_iron, raw_gold, raw_copper, copper_ingot, amethyst_shard, quartz`) in the matching items block. Vanilla texture names are used
for every tile (`stone_bricks`, `deepslate_top`, `lapis_ore`, `tnt_side`, `magma`, `quartz_pillar_top`, ...).
- Stone family: granite/diorite/andesite (+ polished), stone_bricks (+ mossy/cracked/chiseled), smooth_stone, deepslate (top/side, drops cobbled_deepslate),
  cobbled/polished deepslate, deepslate_bricks/tiles, tuff, dripstone_block, obsidian, cut/chiseled/smooth sandstone and red sandstone family, mud_bricks, packed_mud,
  prismarine, prismarine_bricks, dark_prismarine, sea_lantern, blackstone (+ polished), basalt, smooth_basalt, netherrack, nether_bricks, soul_sand, glowstone, magma_block,
  quartz family (block, chiseled, pillar, bricks, smooth), end_stone, purpur_block/pillar, bone_block, blue_ice, sponge, wet_sponge, melon, tnt (decor only, no explosion), bookshelf.
  Pillars/log-like blocks have top/side tiles but no rotation. `snow_block` was not added: the existing `snow` block is the full snow block.
- Ores: lapis/redstone/emerald/copper plus `deepslate_<ore>` for coal, iron, gold, diamond, lapis, redstone, emerald, copper. Mineral blocks: iron, gold, diamond, emerald,
  lapis, redstone, coal, copper, raw_iron/raw_gold/raw_copper blocks, amethyst_block.
- Block field `minTier` (1 wood, 2 stone, 3 iron, 4 diamond pickaxe): `player.js` `canHarvest`/`breakTime` now compare the held tool's `tool.tier` with it (blocks without
  `minTier` behave as before). Existing iron_ore (2), gold_ore (3), diamond_ore (3) got `minTier`. Obsidian needs a diamond pickaxe (hardness 50).
- Block field `creativeTab` ("building" | "natural" | "functional") overrides the regex classification in `creativeItems()`; new items land in "Miscellaneous".
- Drops: lapis_ore 4-8 `lapis_lazuli`, redstone_ore 4-5 `redstone`, emerald_ore `emerald`, copper_ore 2-5 `raw_copper`, deepslate variants likewise. **iron/gold ores still
  drop themselves** (`deepslate_iron_ore` drops `iron_ore`, `deepslate_gold_ore` drops `gold_ore`), so the trade audit is unchanged; `raw_iron/raw_gold` exist for the raw
  blocks and smelt like the ores.
- Recipes live in `js/recipes-stone.js` through `BF.recipeHooks` (functions `({addShaped, addShapeless, smelt, fuel, nameOf})` run at the end of `buildRecipes()`); the
  existing `sandstone_bricks` recipe now takes 4 cut_sandstone (4 sandstone make cut_sandstone, as in vanilla).
- Textures: `textures.js` exports its painter helpers as `BF.texKit` (T, ICON_T, SPRITES, Px, palettes and painters); `textures-stone.js` adds `T[...]` painters and item
  `SPRITES[...]` at load time (index.html loads it right after textures.js).
- Worldgen (`worldgen.js`, after caves, before ore veins): deepslate replaces stone below y12 and with a hash-noisy probability up to y20 (`vein()` takes an optional
  deepslate replacement id so coal/iron/gold/diamond/lapis/redstone/copper/emerald veins turn into `deepslate_*_ore` inside deepslate); rare magma_block on deep (y5-16) cave floors
  (3% of stone/deepslate floor cells); veins: lapis 1.5/chunk y2-40, redstone 4/chunk y2-24, copper 8/chunk y20-60, emerald single blocks (3/chunk in mountain biomes
  y8..surface, 0.12/chunk elsewhere y20-60), granite/diorite/andesite blobs (4 per chunk each, y5-85), tuff blobs y2-26 (also replace deepslate), dripstone_block 0.7/chunk y25-55.

## Wood and colour families (Tier 1, js/textures-colour.js, js/recipes-colour.js)
127 blocks appended in `blocks.js` between `// ---- wood/colour pack ----` markers (generated by `woodColourDefs()`; append-only) and 17 items (`bone_meal`, `<colour>_dye` x16).
`BF.WOOD_SPECIES` (oak, spruce, birch, jungle, acacia, dark_oak, mangrove, cherry), `BF.WOOD_COLOR`, `BF.DYE_COLOURS` = `[[name, hex] x16]` in vanilla dye order
(white, orange, magenta, light_blue, yellow, lime, pink, gray, light_gray, cyan, purple, blue, brown, green, red, black).
- Wood: oak uses the legacy names (`planks`, `oak_fence`, `oak_log`); new `birch_/jungle_/dark_oak_/mangrove_/cherry_planks`. For every species: `stripped_<sp>_log`
  (tiles `stripped_<sp>_log` / `stripped_<sp>_log_top`), `<sp>_wood` (bark on all six faces, tile `<sp>_log`), `stripped_<sp>_wood` (tile `stripped_<sp>_log`), and
  `<sp>_fence` for all but oak (model `fence`, tile `<sp>_planks`, icon tile `<sp>_fence`; fences of any wood connect to each other: `connects` in world.js tests `model === "fence"`).
  Any log/wood/stripped variant crafts 4 planks of its own species (inventory.js maps `stripped_`/`_wood` to the species), is furnace fuel and smelts to charcoal.
  Right-clicking a log or wood with an axe strips it (player.js `secondaryDown`). Not done: other-wood doors, fence gates, slabs/stairs (Tier 2), per-species village houses.
- Colour (names `<colour>_<family>`): `wool` (`white_wool` plus 15 new; the old plain `wool` block is a hidden legacy id that drops and resolves to `white_wool`), `terracotta` (existing plain + orange/yellow/white/brown/red kept; 11 new),
  `_concrete`, `_concrete_powder`, `_stained_glass`, `_glazed_terracotta` (16 each), `tinted_glass`. Block fields: `translucent: true` (stained/tinted glass) sends the
  faces into the blended pass (liquidMat, alpha from the tile) instead of the alpha-tested one; `hardensTo: "<colour>_concrete"` on powder.
- `BF.hardenPowder(x, y, z, id)` (blocks.js): turns powder into concrete when water is on a side or above; world.js `fluidTick` calls it for every queued cell
  (placing powder or water queues its neighbours), so no extra tick exists. Powder does not fall (no falling-block entity in the game).
- Dyes: `red_dye` (poppy, beetroot), `yellow_dye` (dandelion), `blue_dye` (cornflower), `white_dye` (`bone_meal` = 3 per bone), `green_dye` (smelt cactus), `brown_dye`
  (brown mushroom), `black_dye` (charcoal or coal); vanilla mixes (2 dyes -> 2) for orange, pink, light_blue, purple, lime, cyan, gray, light_gray, magenta.
  Dyeing: dye + 8 wool / terracotta / concrete powder / glass-or-stained-glass in a ring -> 8 coloured (any colour of the family, `BF.inventory.recipes`),
  dye + 1 wool (any) -> that wool, dye + 4 sand + 4 gravel -> 8 concrete powder, coloured terracotta smelts to glazed terracotta, 4 black dye around glass -> tinted glass.
  The bed recipe accepts any wool. Sheep and shepherds produce `white_wool`; plain `wool` was merged into it (`BF.resolveItem("wool")` returns `white_wool`, so old saves convert on load).
- Creative menu: tab "Colored Blocks" (`colour`): everything matching `/(^|_)(wool|terracotta|concrete|concrete_powder|stained_glass|dye)$|^tinted_glass$/`, sorted by family then dye order.
  Stripped logs carry `creativeTab: "building"`. `bone_meal` is under Miscellaneous.
- Textures: `js/textures-colour.js` registers painters in `BF.texKit` (shared with textures-stone.js; the kit now also exposes `woolBase, barkSide, logTop, SPRITE_TILES, WOOD_SPRUCE, WOOD_ACACIA`).
  Tile names are the vanilla ones (`birch_planks`, `stripped_oak_log`, `stripped_oak_log_top`, `red_wool`, `lime_concrete`, `cyan_stained_glass`, `magenta_glazed_terracotta`, `tinted_glass`).
  Wood blocks reuse the log tiles. Dye/bone_meal icons are `SPRITES["<colour>_dye"]`. Recipes go through `BF.recipeHooks` (inventory.js passes `{addShaped, addShapeless, smelt, fuel, nameOf}`).

## Slabs and stairs (Tier 2, js/recipes-shapes.js)
410 blocks appended in `blocks.js` between `// ---- slabs/stairs pack ----` markers (generated by `shapeDefs()`; append-only) for 41 materials (`SHAPE_MATERIALS`: 8 planks, cobblestone/mossy, stone, smooth_stone, stone/mossy bricks,
granite/diorite/andesite + polished, sandstone and red sandstone families, bricks, mud_bricks, quartz_block, smooth_quartz, deepslate family, blackstone/polished, prismarine/_bricks, purpur, nether_bricks, terracotta). No new items or textures: tiles, hardness, tool, colour are copied from the base block.
- Ids: all slabs first (per material `<p>_slab` bottom = the item, `<p>_slab_top` hidden), then all stairs (8 per material: `<p>_stairs` = bottom facing south = the item, others `<p>_stairs_bottom_<nesw>` / `<p>_stairs_top_<nesw>`, hidden, `drop`/`item` = the item).
  Prefix is vanilla (`oak`, `brick`, `stone_brick`, `quartz`, `purpur`, `nether_brick`, ...). A double slab is the base block itself.
- Block fields: `render:"model", model:"shape"` (world.js `MODELS.shape` returns `boxes`), `shape: {kind:"slab"|"stairs", baseName, base (id), top (0|1), f}`, `boxes` (render), `cboxes` (collision list, 1/16). Stairs `f` = direction they ascend (the high step is on that side); top-half stairs are mirrored vertically.
- `BF.SHAPES[baseId] = {slab:[bottomId, topId], stairs:[[f0..f3] bottom, [f0..f3] top], name}`, `BF.CBOXES[id]` = list of collision boxes in blocks (world.js `boxHit` tests each box on its own, so stairs step up with the normal `stepUp`),
  `BF.LIGHTBLOCK[id]` = counts as sky-light blocking for the column top (updateColumn) although not opaque for face culling. Mesh faces flush with the cell edge cull against opaque neighbours (emitBox).
- Placement (player.js `placeShaped`, items whose block has `shape`): bottom slab on a block's top face or the lower half of a side face, top slab on the bottom face or upper half; clicking the open half of a slab of the same family (top face of a bottom slab, bottom face of a top slab, or the empty half of its side face) or placing into a cell whose slab has the other half open gives the full base block. Other materials never replace a slab. Stairs: facing = look direction (ascend away from the player), half as for slabs. Placement is refused if the new boxes overlap the player or a mob. The target ray is voxel based (the outline shows the real box).
- Drops/pick: each slab/stair state drops/picks its item; a full block drops the base block. Not implemented: inner/outer corner stair shapes, waterlogging, double-slab drops of 2, support-less popping (none needed).
- Recipes (`recipes-shapes.js`): 3 base blocks in a row -> 6 slabs; stairs pattern (`M  `,`MM `,`MMM`, mirror allowed) -> 4 stairs; wood species use only their own planks; wooden slabs fuel 7.5 s, stairs 15 s.
- Icons: `blockIcon` in textures.js draws slab/stairs shapes (`shapeIcon`). Creative: tab "building", after the other building blocks (slabs, then stairs).

## Panes, bars, ladders (Tier 2, js/textures-shapes.js, js/recipes-panes.js)
22 blocks appended in `blocks.js` between the `// ---- panes/ladders pack ----` markers (`panesLadderDefs()`: `glass_pane`, 16 `<colour>_stained_glass_pane`, `iron_bars`, `ladder_n/e/s/w`) and one item `ladder` (`places: "ladder"`, tab "functional").
- Panes and bars: `model: "pane"`, one id each, `solid` (collision) and not opaque. world.js `paneBoxes()` computes a 2/16 post plus an arm towards each of the 4 neighbours that is another pane/bars, a glass block (cutout block named `glass` / `*_glass`) or a full opaque solid cube; a pane with no neighbour is a cross. The
  mesher emits the boxes with an 8th box entry = bitmask of faces to skip (bit = face index 0 top, 1 bottom, 2 +x, 3 -x, 4 +z, 5 -z: arm caps at the cell edge, post/arm joints, faces shared with a pane above/below). Block field `translucent` (stained panes) now also applies to model boxes
  (blended pass). Collision: `BF.DYNBOXES[id](get, x, y, z, id)` returns the box list (in blocks) and is consulted by `boxHit` before `CBOXES`/`CBOX`, so the collision is post + arms. Raycast targets the whole cell.
- Tiles: faces reuse `glass` / `<colour>_stained_glass`; new tiles `glass_pane_top`, `<colour>_stained_glass_pane_top` (cross-shaped edge strips for top/bottom faces), `iron_bars`, `iron_bars_top`, `ladder` (all painted in textures-shapes.js; cutout, in `SPRITE_TILES`). Icons are flat (`icon` field). Item sprite `SPRITES.ladder`.
- Ladders: block `ladder: {f}` (f = direction the ladder faces, i.e. the clicked face normal; the wall is at pos - `BF.DIRS[f]`), `BF.ladderId(f)`, box 2/16 against the wall, `solid: false` (no collision, still raycast-targetable), hidden, `item`/`drop` = item `ladder`.
  player.js `placeLadder()`: only on the side face of a full solid opaque block (`BF.ladderSupport(id)`), or clicking a ladder's top/bottom face extends the column with the same facing. world.js `setBlock` pops (one drop, none in creative) any ladder whose wall block stops being a support.
- Climbing (player.js `physics`): when the feet or waist cell is a ladder (and not flying/swimming) gravity is replaced: jump, or forward while pushed against a wall, goes up at 2.35 b/s; sneak holds position; otherwise slides down at 3 b/s; horizontal speed clamped to 3 b/s; fall distance is reset (no fall damage). Mobs do not climb.
- Recipes: 6 glass (3x2) -> 16 glass panes; 6 stained glass of a colour (3x2) -> 16 stained panes of it; dye ringed by 8 panes of any kind -> 8 stained panes; 6 iron ingots (3x2) -> 16 iron bars; 7 sticks (H) -> 3 ladders. Ladder burns 7.5 s.

## sky.js (owner: sky/textures worker)

`BF.sky = { init(scene), update(dt), time, light, day, isNight() }`
- time in [0,1): 0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight. `light` is the block brightness multiplier
  (main passes it to `world.setDaylight`). Owns scene.background, scene.fog (keep fog distances tied to
  `BF.world.viewDist * BF.CS`).
- Clouds are volumetric slabs ("fancy" clouds): slab bottom = `BF.sky.cloudHeight` = `BF.sky.cloudBase` (default `BF.H + 4`, settable per world, e.g. for mile-high terrain) + a rise of 0..70 that varies smoothly with game time (never below the base). Mile-high worlds (generator 3) set `cloudBase` each second from the smoothed regional ground height (+80, never below SEA+110, eased; teleports snap) so you walk under clouds on the plains and climb above them on peaks. Cover (`BF.sky.cloudCover`, 0 clear..1 overcast) also varies by game time (clear spells to broken skies; value noise on day+time seeded by world seed) and rain forces overcast and lowers the deck, `CLOUD_H = 5`, cell 12x12, periodic 64x64 deterministic cell mask,
  drifting in -x at 1.2 blocks/s. One BufferGeometry (~6.5k triangles, exposed faces only; shade top 1 / z-sides 0.9 / x-sides 0.8 /
  bottom 0.7) over a 56x56 cell window, rebuilt (preallocated buffers) only when the camera or drift crosses a cell boundary,
  otherwise just translated. Single-sided, depthWrite off, renderOrder 5, alpha 0.9 with distance fade to the horizon colour at CLOUD_R=320.

## mobs.js (owner: mobs worker)

`BF.mobs = { list, init(scene), update(dt), raycast(origin, dir, maxDist) -> {mob, dist}|null, hit(mob, damage, knockDir: THREE.Vector3), clear() }`
- Villagers: one per bed of their home (`m.home`, `m.bed` from `worldgen` house records). From sky time 0.52 to 0.985
  they walk home along an A* grid path, opening doors on the way and closing them behind, and sleep (`m.sleeping`,
  lying on the bed); villagers without a usable bed stand indoors or by the bell. They wake at sunrise (or when hurt)
  and walk out through the door. `interact(mob)` returns "Villager is sleeping" for a sleeper.
- Villagers carry trading state on the mob object (created by `BF.trades.init` in `createMob`): `inv` (18-slot array, see trading.js),
  `level` (1..5), `xp`, `trades` (the offers of levels <= level), `restockDay`. `restockVillagers` tops stock up once per
  `BF.sky.day` (never while `tradingWith`). That state is kept per stable key `"<village key x,z>#<roster slot idx>"` (slot idx = house index * 2
  + bed index, deterministic from the seed): saved into an in-memory map when the mob is unloaded and re-applied when the roster slot respawns.
  Villagers made by the debug `BF.mobs.spawn` have no key and are not saved.
- `BF.mobs.exportVillagers() -> {key: {inv:[{n,c}|null x18], level, xp, day}}` (live villagers override stored ones) and
  `importVillagers(obj)` (replaces the stored map; call after `newWorld`). Cows also drop 0-2 leather.
- Zombies (only) with a target (player, not in creative, or a villager) that stay pressed against a closed door for 3 s
  break it: both halves removed, one `oak_door` drops. Other hostiles cannot pass closed doors.
- `worldgen.villagesNear()` house records: `{x, y, z, w, d, doorX, doorZ, outX, outZ (cell in front of the door), type,
  beds: [{x, y, z, f}]}` (bed = foot block, f = foot -> head).

## trading.js (villager economy)

`BF.trades` (loaded before mobs.js; calls into BF only at runtime). Balance and reasoning: `TRADE_AUDIT.md`.
- Tables: `TRADES[profession] = [5 pools of "<n> <item> [+ <n> <item>] > <n> <item>"]` (pool = offers unlocked at that level; every offer
  of every pool up to the villager's level is offered). `VALUE[itemName]` = effort in emeralds (documentation/balance only), `PRODUCE[profession]`
  = wares that the daily restock may regenerate, `LEVELS`, `LEVEL_XP`, `TRADE_XP`, `SLOTS = 18`, `EM_CAP = 12`, `EM_DAY = 2`.
- `offers(prof, level) -> [{buy:[{id,n}], sell:{id,n}, level, xp}]`, `parseTrade(str)` (null if an item is missing).
- `init(v)` gives a villager mob level/xp/trades/inv (starting stock via `stockFor(prof)`; nitwits get junk + 1-6 emeralds, no trades).
- `blockReason(v, offer) -> null | "Out of stock" | "Out of emeralds" | "Villager has no room"`. An offer is clickable only when the villager holds
  `sell.n` of `sell.id` and, with those removed, can store all `buy` items. `exchange(v, offer)` moves the goods in the villager inventory
  (sold items out, the player's payment in; returns false if blocked), `addXp(v, offer) -> levelsGained`.
- `restock(v, day?)` applies the daily production (wares in `PRODUCE` +25% of cap up to the cap, emeralds +2 up to 12; never diamonds etc.).
- `inv` helpers on plain `{id,count}|null` arrays: `create()`, `count(a,id)`, `add(a,id,n) -> leftover`, `remove(a,id,n) -> removed`,
  `canFit(a, adds, removes)`, `clone(a)`. `pack(v) / unpack(v, saved)` convert the persisted form (item names, not ids).
- Trade screen (inventory.js): shows the villager inventory greyed and read-only under the offer list; unavailable offers are dimmed with an "X"
  and a tooltip reason. Player-side payment slots, shift-click bulk trades and level-ups are unchanged; bulk stops when stock or room runs out.

## player.js (owner: player worker)

`BF.player = { position (THREE.Vector3, feet centre), halfWidth, height, eye, health, maxHealth, hunger, dead,
  init(), spawn(x,y,z), update(dt), updatePaused?(dt), eyePos() -> Vector3, lookDir() -> Vector3,
  damage(amount, fromPos?), heal(n) }`
Owns camera transform, input, pointer lock, block break/place, attacking mobs, HUD hearts/hunger, menus.

## inventory.js (owner: inventory worker)

`BF.inventory = { init(), update(dt), add(itemId, count) -> leftover, remove(itemId, count) -> removed,
  count(itemId), selected() -> {id, count}|null, selectedIndex, select(i), consumeSelected(n),
  isOpen(), open(mode?), close(), clear() }`
Owns hotbar UI, inventory screen, crafting.

## save.js

The snapshot now also has `villagers` (`BF.mobs.exportVillagers()`; see mobs.js). `restore()` applies it after `newWorld` and ignores saves that lack it.

## Testing

`node test/run.js <outPrefix> [actions.js]` (run from this folder with `NODE_PATH=$(npm root -g)`) loads the game
headlessly, prints console errors, runs `module.exports = async (page, outPrefix) => {...}` from actions.js, toggles
F3 and screenshots `<outPrefix>.png`. Use `page.evaluate(() => BF...)` to drive state. Headless FPS is low (software GL).

## BF.drops (js/drops.js)
Dropped item entities (sprites with gravity) from broken blocks, popped plants and killed mobs; picked up within ~1.6 blocks after 0.5s, merge nearby, despawn after 300s, not saved.
- `init(scene)`, `update(dt)`, `clear()` (called by newWorld), `list`
- `spawn(itemId, count, x, y, z)`; `spawnAt([{id,count}], bx, by, bz)` drops at the centre of a block.

## Plant clustering (worldgen.js, ground plants)
Non-tree plants are clumped with deterministic world-coordinate noise (no Math.random; chunk-independent):
- Short grass / fern: density = per-biome mean (`PLANTS`) x `patchMult(field)`, a patch field (wavelength 18-36 blocks per biome, `GRASS_PATCH`/`FERN_PATCH` = [wavelength, area fraction in patches, density between patches]); mean density is preserved, patches are dense, gaps sparse.
- Flowers: one presence field (wavelength 16, threshold from the biome's flower rate, ~42% density inside a patch) decides where flower patches are; the colour (poppy / dandelion / cornflower) comes from a slow selector field (wavelength 64) split into three equal bands, with a flower-free gap at band edges, so each patch is one colour (same-type neighbour fraction within r6 >= 0.94). Strays (3% of the rate) take the local colour.
- Mushrooms: one field (`MUSH_S`), stray + patch like flowers. Dead bush and sugar cane: loose patch field multiplier (`patchMult`).
- Pumpkin patches (40-block cells, 20% of cells, radius 3.5-6, any grass) and melon patches (36-block cells, 34%, jungle + sparse jungle only, grass only) are hashed centres; the plant itself replaces the air above grass. `melon` drops itself.
- Fields are sampled on a 2-block grid per chunk (`patchField`, cached in `fieldCache`, cleared per chunk) with bilinear interpolation and a per-column hash jitter. Villages/structures are untouched (village columns are skipped as before).

## Block light (js/light.js, js/textures-light.js, js/recipes-light.js)
Block light is an integer 0..15 per voxel, separate from the simple per-column sky shade. It is derived data (never saved): `light.onChunkCreated(c)` rebuilds it
whenever a chunk is created, so loading a save recomputes it.
- Data: every chunk gets `chunk.light`, an array parallel to `chunk.secs` of `Uint8Array(4096)` (or undefined = all dark; allocated when light reaches the section), same in-section index as the blocks. Emitters: block def field `emit` (0..15), table `BF.EMIT[id]`
  (blocks.js). Current emitters: torch / wall torches 14, lantern 15, glowstone 15, sea_lantern 15, magma_block 3. Add `emit: n` to any new block def.
- Propagation: BFS flood fill, -1 per step through blocks with `OPAQUE == 0` (opaque blocks stop it; an opaque emitter still lights its neighbours), across chunk borders
  through loaded chunks. A chunk that loads later seeds from its 4 loaded neighbours' border cells and from its own emitters (only emitters and border light are touched, not a
  full flood). Unloading leaves neighbours' light as is (identical when the chunk returns).
- Incremental: `world.setBlock` calls `BF.light.onSet(x,y,z,oldId,newId)`: no-op unless the emit level or opacity changed (so water/plant swaps are free); otherwise a
  Minecraft-style removal queue (clear what was lit through the cell, re-fill from the surviving sources) plus an add pass, work bounded by the 15-block light radius. Every chunk whose
  light changed (and neighbours when the change touches a border cell) is added to `world._dirty` and remeshes.
- API: `BF.world.getBlockLight(x,y,z)` (0 when unloaded), `BF.light.get`, `BF.light.recomputeAll()` (tests: full rebuild, returns ms), `BF.light.canSupport(id)`.
- Rendering: the mesher writes a per-vertex attribute `bl` (level/15) next to `skyl`: cube/cutout/translucent faces average the face cell and the non-opaque cells around each
  corner (smooth lighting, on top of AO); fluids use the cell in front; cross plants and model boxes use their own cell (best neighbour if that cell is opaque). `bl = 2` marks an emissive
  part (the torch flame): full brightness, no tint. Shader: `lit = max(skyTerm, blockTerm)` with `blockTerm = min(1, 1.1 * bl^1.25)`; block-lit surfaces are tinted warm (#ffd9a0-ish).
  The sky term is `vSky * (0.6 + 0.4*smoothstep(0.3, 0.7, vSky)) * uDay`, so open sky is unchanged and deep cover is darker (floor 0.1).
- Torches: blocks `torch` and hidden `wall_torch_north|east|south|west` (`wallTorch: {f}`, f = outward facing; leans on the block at -DIRS[f]), appended in blocks.js
  between the `// ---- torch pack ----` markers. Model `torch` (world.js MODELS; box entries 8 = glow, 9 = lean {dy, base, k, dx, dz}), tile `torch` (32px, cutout), icon tile `torch_icon`.
  Not solid, hardness 0, drop `torch`. Placement: `BF.light.torchPlace(x,y,z,normal)` (top face -> standing, side face -> wall variant, bottom face refused; support must be a solid
  cube/cutout block, `canSupport`). `setBlock` calls `BF.light.popUnsupported` so torches pop (one drop, none in creative) when their support goes. Recipe: coal or charcoal over stick -> 4 torches.
- Mobs: hostile spawns (surface and cave) require block light <= 7 at the spawn cell; mob tint also uses block light.
- F3 shows `BL n` (block light at the player).

## Builder villagers (js/blueprints.js, js/builder.js)
The 15th profession `builder` (orange hi-vis vest with reflective band and straps, brown overalls, yellow hard hat, hammer in the folded hands that swings while it places a block;
`VILLAGER_OUTFITS.builder` in mobs.js). Loaded after mobs.js (index.html: `blueprints.js`, `builder.js`); mobs.js, trading.js and inventory.js only call `BF.builder` / `BF.blueprints` at runtime and work without them.
- **Roster.** `villageRoster` appends builder slots at the END with their own key range: `<village key>#1000`, `#1001` (never `idx = house * 2 + bed`, so every other slot keeps its persistence key).
  `rec.nb` (= worldgen `v.buildings.length`) >= 6 gives 1 builder, >= 19 gives 2; builders count toward the roster cap (`rec.pop` for sized villages, else `VILLAGERS_PER_VILLAGE` = 24: the roster is cut to `24 - builders` BEFORE the appended slots, which can only
  drop the last, 24th, ordinary slot of an existing village). `builder` is excluded from the shuffled profession pool (otherwise old villages' professions would shift). A builder slot has no house/bed at first
  (stands by the bell at night); the first finished house with a bed is claimed by the builder that built it (`entry.claim = slot idx`, `m.home`, `m.bed`, restored by `BF.builder.onSpawn`). Other villagers do not use built beds
  (the roster is deterministic from the seed; extending it would shift keys), noted as not done.
- **Village record** (`BF.mobs.villages` value): new `rec.wg` (the worldgen village object: buildings, pads, roads, lamps, decor, minX..maxZ), `rec.nb`, `rec.built` = list of structures
  `{id, type, label, rot, style, h, opts?, ox, oy, oz (min corner, oy = floor level), w, d (footprint box incl. eaves/doorstep), prog (next cell index), n (total cells), skipped, placed, state: "building"|"done"|"abandoned",
  owner (slot idx), claim?, fill: [[x,y,z]] (foundation cells filled under the floor), start, end}`. Sites of later structures avoid `built` (+3 margin); one active build (`state "building"`) per village.
- **Blueprint API** `BF.blueprints`: `get(type, rot 0..3, style 0..4, h in [0,1), opts?) -> {type, label, rot, style, w, d, hgt, cells: [{x, y, z, id, item, cost, pair, ph}], n, req, exact, free, door, beds, house}`
  (cached, treat as read-only). x/z are relative to the min corner of the rotated footprint box, y relative to the floor level (floor blocks at y 0, standing on the ground block below). `rot` turns the building clockwise
  (door faces north, east, south, west). `cells` are in build order (phase `ph`: 1 floor/foundation, 2 walls bottom-to-top going round, 3 roof, 4 windows, 5 door, 6 bed, 7 torches/furniture); `cost` is 1 inventory item per block
  (0 for the upper door half, the bed head, water); `req` = needed items by bucket (`{itemId: n}`, any planks count as `planks`, any log as `oak_log`), `exact` = the items by exact id. Types (`BF.blueprints.TYPES`):
  `small_house` (worldgen `house` 5x5, 1 bed), `medium_house` (`house` 7x5 shell with the `house2` bed plan: 2 beds), `cottage` (`lhouse` 7x7, 1 bed), `workshop` (`smith` 7x6), `well` (3x3), `lamp_posts` (3 posts 4 apart, lanterns if
  `opts.lantern` else torches), `garden` (7x5 fence ring with a gate gap, hay bales with `opts.hay`), `market_stall` (5x3). All use the village palette of the style (`BF.worldgen.palette(style)`).
  Houses: door, windows, bed(s), a torch inside and a wall torch beside the door, doorstep. Houses are built from the worldgen generators through `BF.worldgen.recordBuilding(kind, w, d, style, h)` (runs `drawShell` against a
  recording buffer; the chunk generation path is untouched, verified by hashing village chunks of 5 seeds before/after) and `BF.worldgen.bedPlan(kind, w, d, h)`, `BF.worldgen.palette(style)`.
- **Builder AI** (`BF.builder.ai(m, dt, out)`, called from `villagerAI` after the trading freeze, flee, bedtime and morning logic, so sleeping, door opening and trading still work): modes `idle -> think -> build | shop`.
  Day only (`sky.time < BUILD_END 0.47`); at dusk it stops and the normal night AI sends it home; progress (`entry.prog`) resumes in the morning. `think` picks a type weighted by village needs (homeless villagers -> houses, no built well, lamp posts,
  stall, garden, workshop) times affordability (x3 from inventory, x1.2 buyable from villagers, x0.25 otherwise); the first plan is always the small house. Site: 150 random origins in the village box + 40 blocks, rotated so the door faces the village
  centre; rejects overlap with building footprints (+3), pads, roads, plaza/well/bell, lamps, decor, built structures, unloaded chunks, entities nearby, water/ice/farmland/paths/trees, slope > 2 (gaps <= 2 under the floor are filled from inventory with the
  foundation block), solid blocks in the volume (plants are cleared). BUILD places one cell every `BLOCK_T` 0.5-0.8 s (random per block) when the eye is within `REACH` 4 blocks of the cell and the ray is free; otherwise it picks a standing spot (preferring
  outside, with a free line), walks there with A* (hops of 20 blocks for long trips), never places into its own or another entity's body box (waits, skips after 8 s), skips cells that already hold the block, never overwrites solid blocks
  (skipped, logged). A cell stuck for 15 s (no standing spot / no free line) is put on a retry list (`e.retry`) and revisited in a second pass at the end with a reach stretched by 1.6 blocks (gable tops); only cells still failing then stay `skipped`. Each placed block takes exactly one item from `m.inv` (door/bed: one item, two blocks; the water of a well comes from a full water bucket, which is empty again afterwards: a builder without one walks to water within ~30 blocks of the village and fills its empty bucket, `bs.mode "fill"`; with no bucket at all, or no water in 4 tries / 240 s, the water cell is skipped and logged); a stand-in wood of the same family is used when the exact one is missing; doors/fences/tables/chests/furnaces are crafted from
  planks/cobblestone and planks from logs on the spot when short. SHOP (short of materials): buys the shortfall from the nearest other villager whose current offers sell it and who could do the deal (`BF.trades.blockReason`, `exchange`, `addXp`;
  payment from the builder's inventory, 2 s standing pause), else waits (wandering) and re-checks every 30-60 s while the player can sell it materials through the normal trade screen. Exchanges are logged in `BF.builder.log` and `console.info`.
  Status text `BF.builder.statusText(m)`: "Building: small house (63%)", "Looking for: 24 Oak Planks", "Fetching: ...", "Planning", "Resting"; shown in the trade screen header (inventory.js `renderOffers`).
- **Trading** (trading.js): `TRADES.builder` (5 levels) BUYS cobblestone, stone, all 8 planks, all 8 logs, glass, doors, bricks, beds, sandstone, sandstone_bricks, orange_terracotta, torches from the player; sells doors/torches (rarely in stock). Starting stock
  `BF.trades.stockFor("builder", v)` -> `BF.builder.startStock(v)`: the small house requirement + 10 % + 8 foundation blocks + 40-80 emeralds. Emerald budget: +4 per day up to 80 (`BUILDER_EM_DAY/CAP`). See TRADE_AUDIT.md.
  In a village whose roster has a furniture maker the kit holds no beds (`bedsFromFurniture`; `onSpawn(m, rec, saved)` also strips them from a new builder, whose kit was packed before it knew its village): it buys them from the furniture maker.
- **Save format.** `exportVillagers()` additionally contains `"built:<village key>": [entries]` (the `rec.built` lists, JSON); `importVillagers` hands them to `BF.builder.importAll`. Old saves have none; builder inventories use the normal `<village key>#1000` entries.
  The placed blocks are ordinary world edits. `mobs.nav` exposes `findPath, followRoute, feetCell, walkCell, blockAt, takePlan` for builder.js.
- **Not done / notes.** Other villagers do not adopt built beds; the builder does not climb, so structures are limited to what it reaches from the floor or the ground (2-storey houses were left out); garden crops, farmland and lanterns depend on items it holds; if the builder is killed
  its partial structure stays (state "building", resumed by a replacement builder of the same village).

## Weather (js/weather.js, loaded after sky.js)
`BF.weather = { type: "clear"|"rain"|"thunder", remaining (s left in the spell), intensity 0..1, thunder 0..1, flash 0..1,
  set(type, seconds?) -> seconds, update(dt), tick(dt) (schedule + ramps only), serialize(), deserialize(o), reset(seed),
  precipAt(x, z, y?) -> 0 dry | 1 rain | 2 snow, rainingAt(x, y, z), raining (getter), strikeAt(x, y, z), debugText(), ms }`
- Driven from `sky.update(dt)` (sky.js calls `BF.weather.update(dt)` first, so it pauses with the sky). `/weather` (commands.js) calls `set`.
- Schedule (seeded mulberry32, state saved): clear spells 1-3 days (600-1800 s), rain 0.3-1 day; a rain spell is a thunderstorm 1 time in 4.
  `reset(seed)` on `newWorld` (first clear spell 0.5-1.5 days). `intensity` ramps at 1/15 per s toward 1 (rain/thunder) or 0, `thunder` toward 1 in storms.
  Sleeping through the night (`playerSlept`) clears the weather. Events: `weatherChanged(type)`, `lightning({x, y, z, dist})`.
- Save: snapshot field `weather = {type, remaining, rng, intensity, thunder}`; restore applies it after `newWorld` (old saves keep the seeded default).
- Per column precipitation (biome cached per 4x4 cell): desert/badlands/savanna dry (sky still overcast); snowy biomes (snowy beach/plains/taiga/slopes,
  ice spikes, jagged peaks) or temperature < -0.3 snow; temperature < -0.1 snow at y >= 90; < 0.12 snow at y >= 100; else rain.
- Sky (sky.js hook): `sky.light *= 1 - 0.3*intensity - 0.3*thunder` (noon: rain 0.70, thunder 0.40, so `isNight()` is true in a thunderstorm:
  surface hostile spawns, no undead burning, sleeping allowed, like vanilla); dome/fog/clouds blend to grey, glow/sun/moon/stars fade by intensity,
  cloud coverage grows (mask quantile 0.7 -> 0.3, `clouds.userData.setCoverage`), fog near/far shorten (~-25%/-35%). Lightning `flash` adds up to +0.85 light
  and whitens the sky for ~0.3 s (double flash).
- Particles: one indexed mesh, 4000 quads (4 verts each) in a 20-block-radius cylinder, 44-block band around the camera, world-anchored and animated
  entirely in the vertex shader (time uniform). Each particle reads a 64x64 RGBA DataTexture around the camera (R = column surface y = top light-blocking
  block (`chunk.top`) + liquid surface, G = 0/1/2 precip kind; unloaded = 255 none) and is hidden below its column's surface, so nothing falls indoors,
  in caves or under trees. Rain = camera-facing vertical streaks, snow = drifting round flakes; count scales with intensity; hidden underwater.
  The texture is rebuilt when the camera crosses a block, on block place/break, chunk load and every 1.5 s (~0.1-0.4 ms); steady update ~0.01 ms.
- Lightning: in thunderstorms every 10-40 s at a random wet column 6-64 blocks from the player (dry biomes never struck): additive camera-facing ribbon bolt
  (cloud height H+4 -> surface, jagged, up to 3 branches, 0.32 s flicker), flash, `lightning` event (audio.js plays thunder). 5 damage to the player/mobs within 2.5 blocks; no fire.
- Gameplay: undead do not burn where `rainingAt` (rain or snow falling on an open column) (mobs.js); crops grow 1.5x faster while raining (world.js growTick).
- F3: line `Weather <type> <intensity> [th <thunder>] (<s> left, <rain|snow|dry> here) <ms>`.

## Commands (js/commands.js, loaded after player.js)
`/` (or numpad `/`) while playing opens a Minecraft-style command line at the bottom prefilled with "/", `T` opens it empty (plain text = chat line `<Player> ...`).
- While open (`BF.commands.isOpen()`), a window capture-phase keydown listener registered at load time (before inventory.js's) swallows every key, so typing never moves the
  player or triggers E/Q/digits/F3. player.js treats it like an open screen (`invOpen()` includes it: no clicks, wheel, movement; an unlock does not pause or re-lock).
  Lock handling: `BF.player.uiOpen()` (sets expectUnlock, clears keys, exitLock) and `uiClose()` (re-requests the lock like closing the inventory); `canOpenUI()`.
- Enter runs, Esc cancels, Up/Down history (last 30, `localStorage["blockfield.cmdHistory"]`, try/catch), Tab / Shift+Tab cycle completions (command names, item/block names,
  mob types, `~ ~ ~` and the targeted block's coordinates, sub-commands); a suggestion box and the usage line sit above the input. Output goes to a fading chat log
  (10 s; all lines visible while open; errors red, results grey). Commands never throw: bad input prints a usage/error line.
- Coordinates: absolute, `~` or `~n` (block commands floor; `/tp` centres integer x/z). Item names with or without `minecraft:` plus a few vanilla aliases
  (`grass_block`, `oak_planks`, `wheat`, `cooked_beef` ...); hidden block states give their `item`.
- Commands: `/help [cmd]`, `/tp <x y z> [yaw pitch]` / `/tp <x z>` (surface; alias `/teleport`), `/time set <day|noon|sunset|night|midnight|sunrise|ticks>`, `/time add <ticks>`,
  `/time query <daytime|day|gametime>` (24000 ticks/day, `BF.sky.time = ticks/24000`, 0 = sunrise 06:00 like the F3 clock; units t/s/d; `add` rolls `BF.sky.day`),
  `/gamemode <survival|creative|s|c|0|1>` (`/gm`), `/give <item> [count<=2304]` (overflow is dropped), `/clear [item] [max]`, `/summon <mob> [x y z] [profession]`,
  `/kill` (you), `/kill <@e|mobs|hostile|passive|items|type|@e[type=t]>` (mobs, never you), `/weather <clear|rain|thunder> [seconds]` (`BF.weather.set(type, sec)`, else
  "Weather not available"), `/seed`, `/spawnpoint [x y z]` (`/setworldspawn`), `/setblock <x y z> <block> [replace|keep|destroy]`,
  `/fill <x1 y1 z1> <x2 y2 z2> <block> [replace [filter]|keep|hollow|outline]` (max 32768 blocks, all columns must be loaded; `world.setBlock` per cell, so edits save,
  light updates, and each dirty chunk remeshes once on the next `world.update`), `/locate village` (`worldgen.nearestVillage`), `/heal [n]`, `/feed`, `/say <msg>`.
- Running any command other than /help, /seed, /say sets `BF.save.current.cheats = true` (saved in the world meta, no UI). Event `commandExecuted(name, args)`.
- API: `BF.commands = { isOpen(), open(prefill?), close(), execute("/cmd ...") -> {ok, msg}, print(text, kind), complete(text) -> [candidates], history, list }`.
- player.js additions used here: `P.teleport(x,y,z)` (zeroes velocity and fall distance, waits for the chunk), `P.kill()`, `P.feed()`, `P.spawnParticles(x,y,z,id,n)`.
  mobs.js: `BF.mobs.kill(mob)` (outright kill with drops, no knockback/golem anger).

## Break animation (js/cracks.js, loaded after player.js)
- 10 destroy stages from one deterministic 32px crack network (random walks from the centre plus later outer seeds; each pixel has a birth time, stage s shows
  pixels born before T(s), so every stage adds cracks to the previous one), dark lines with a lighter bevel pixel. Drawn as one preallocated BufferGeometry decal
  (rebuilt only when the target changes) from the block's real shape: `boxes` (slabs, stairs, doors, beds, ladders), `BF.DYNBOXES` (panes/bars), model
  replicas (fence, lantern, torches, bell, chest, cactus), crossed planes for plants, 15/16 for paths/farmland, else a full cube; every box inflated by 0.002.
  Optional core hook: if `BF.world.modelBoxes(x,y,z,id)` ever exists it is used first.
- Material: blend `src*dst + dst*src` (vanilla destroy-stage blending; grey 0.5 = neutral), alpha-tested, depthWrite off, polygonOffset, no fog, so it only
  darkens the already-lit face and never glows at night.
- player.js `updateBreaking` (survival) calls `BF.cracks.show(x, y, z, id, progress, hitNormal, dt)`; `resetBreak()` calls `BF.cracks.hide()` (target change,
  release, creative switch). Every 0.25 s of mining (first one immediately) a hit tick: `BF.emit("blockHit", x, y, z, id, progress)`, 4 debris cubes from the hit face
  coloured from the face tile's atlas pixels (tinted tiles use the block colour; lit by daylight / block light), a small overlay pulse and a restarted hand swing.
  The final break keeps the player.js burst; `blockBroken`/`blockPlaced` unchanged. Creative instant break shows no cracks. Debris uses a pooled set of 64 meshes.

## Audio (js/audio.js, loaded last, after main.js)
Everything is synthesized with the Web Audio API (no audio files). Effect samples are generated in JS (seeded, a few variants per sound) into shared
`AudioBuffer`s, lazily and in idle time from 2.5 s after load; nothing touches an `AudioContext` until the first user activation (pointerdown/keydown/touchstart),
which creates and resumes it. The tab being hidden suspends the context. audio.js runs its own `requestAnimationFrame` loop (main.js is unchanged).
- `BF.audio = { play(name, {x,y,z, volume, pitch, delay, variant, group, dist}) -> voice|null, blockSound(kind "break"|"place"|"hit"|"step", blockId, x,y,z, vol?),
  mobSound(mob, "amb"|"hurt"|"death"), setVolume(group, 0..1), getVolume(group), setMuted(bool), muted, settings, material(blockId) -> name, names(),
  music: {start(mood?, seed?), stop(fade?), playing, mood, wait (s until the next piece), compose(seed, mood), moods}, update(dt), ctx, graph, voices, maxVoices (24),
  stats {plays, dropped, stolen, count{name}, frames, updMs, updMax, genMs}, env, renderOffline(name | [[name, opts, t]...], opts, sec, rate) -> Promise<AudioBuffer>,
  renderMusic(sec, mood, seed, rate) -> Promise<{buffer, info}>, encodeWav(AudioBuffer) -> Uint8Array, samples(name) }`.
- Groups (settings sliders in the pause menu "Sound…" panel, persisted as JSON in localStorage `blockfield.audio`): `master` 0.8, `music` 0.5, `blocks`, `mobs`, `ambient`,
  `player` (1.0), `muted`. Graph: voice -> gain -> StereoPanner -> group gain -> underwater low-pass (480 Hz while `BF.player.headInWater`) -> master -> limiter;
  music and the shared ConvolverNode (generated impulse) bypass the muffle. Spatialisation: listener = camera position + `BF.player.yaw`; gain `(1 - d/R)^1.4`, R 24 blocks
  (explosions 64, birds 40, cave 48), pan from the horizontal direction. Max 24 effect voices: the lowest priority / oldest voice is stolen (music and loops are separate).
- Materials (`material(id)`, from block name/tool/render): stone (default), wood, gravel, dirt, grass, sand, snow, glass (glass, panes, ice), wool (wool, beds, cactus),
  plant (leaves, crops, flowers, torches), metal (iron/gold/... blocks, lanterns, bells, bars), water. Sounds `dig.<mat>` (break; place = dig at 0.8 pitch, glass places `place.glass`),
  `step.<mat>` (footsteps; mining hit = step at 0.55 pitch).
- Other sounds: player `hurt eat burp land fall_big splash swim bubble ui_click levelup xp`; blocks `door_open door_close`; mobs `cow pig sheep chicken zombie skeleton spider villager`
  (ambient) + `<type>_hurt`, `<type>_death` (cow/sheep/chicken reuse hurt lower), `creeper_fuse creeper_hurt creeper_death explode villager_yes villager_no villager_trade golem_step
  golem_hurt golem_death golem_attack door_bash bow`; ambience `bird cricket cave thunder_near thunder_far`; loops `wind rain water underwater` (levels driven by update).
- Events consumed: `blockBroken`, `blockPlaced` (second one within 60 ms ignored: door/bed halves; liquids splash), `blockHit` (cracks.js, every 0.25 s of mining), `playerDamaged`,
  `playerAte`, `mobKilled`, `mobExploded`, `villagerTrade`, `villagerLevelUp`, `lightning` ({x,y,z,dist}; thunder delayed by distance), `gameModeChanged`, `newWorld`, `worldLoaded`.
  Events added for audio (one-line emits): player.js `playerEating(itemId)` (every frame while eating; audio throttles to ~0.21 s); mobs.js `mobHurt(mob, amount)` (damageMob),
  `arrowShot(mob, fromVec3)`, `doorBroken(mob, x, y, z)` (zombie). mobs.js `noiseSound` returns early when `BF.audio` exists.
- Polled (no events needed): footsteps (distance walked on the ground: stride 1.65 blocks, 1.9 sprinting, 1.1 sneaking and quieter; none flying/swimming), jump, landing
  (fall speed from `BF.player.velocity.y`), ladder climbing, water entry/swim strokes/bubbles, mob ambient calls (random 6-22 s per mob within 26 blocks, villagers with a per-villager
  pitch, not while sleeping), creeper fuse start (`ai.fuse`), iron golem steps/attack swing, zombie door pounding (`ai.doorT`), villager trade screen opening (`tradingWith`).
  `BF.world.setDoor` is wrapped once to play open/close for players and villagers.
- Ambience: wind (altitude above sea + openness from 8 `heightAt` probes, muted underground), rain loop from `BF.weather` (`precipAt` 1 = rain, intensity; low-passed when the
  column above is covered; snow = wind only), gentle water lapping within ~7 blocks of a water surface, birds by day in wooded biomes (plains rarely), crickets at night in grassy
  biomes, rare cave tones (50-160 s) when underground (>5 blocks of cover) and block light < 7. Paused: music x0.45, loops x0.4.
- Music: seeded generative pieces (felt-piano notes rendered once per pitch + soft detuned pads + reverb), moods day (major pentatonic), night (minor), under (phrygian, sparse, low),
  creative (lydian, brighter); 1.5-3 min each, the first 30-60 s of play after load / new world, then 3-8 min of silence. Mood = creative mode > underground > night > day.

## Jobsites (js/jobs.js)
Villager workstations, loaded after builder.js (`index.html`: `textures-jobs.js` after textures-shapes.js, `recipes-jobs.js` after recipes-panes.js, `jobs.js` after builder.js).
- **Blocks** (blocks.js `// ---- jobsite pack ----`, `jobsiteDefs()`, append-only; field `jobsite` = profession; creative tab "functional"): composter (farmer), lectern (librarian), brewing_stand (cleric),
  blast_furnace (armorer), grindstone (weaponsmith), smithing_table (toolsmith), smoker (butcher), barrel (fisherman), loom (shepherd), fletching_table (fletcher), stonecutter (mason),
  cauldron (leatherworker), cartography_table (cartographer), drafting_table (builder, not vanilla: blueprint table). Cubes use tiles {top, side, front (+z), bottom}; lectern, brewing stand,
  grindstone, stonecutter and cauldron are box models (`render: "model", model: "shape"` without a `shape` field: world.js draws `boxes`, collision `box`); a 7th box entry names a tile that is one of
  the block's own tiles (so it is in the atlas). No facing, no block function (no composting/brewing/smelting). Tiles in `textures-jobs.js` (vanilla names, 32px, `ICON_T` icons for brewing stand and
  grindstone); recipes in `recipes-jobs.js` (vanilla; brewing stand uses a gold ingot for the blaze rod, drafting table = paper + blue dye over 4 planks); wooden ones burn 15 s.
- **API** `BF.jobs`: `JOBSITE` (profession -> block name), `PROFESSION_OF` (block name -> profession), `profOfBlock(id)`, `blockFor(prof)`,
  `claim(mob, {radius = 48, prefer: [professions]}) -> profession | null` (random unclaimed standing jobsite within radius of the villager's village centre, else its position; each `prefer` match x3 weight;
  experienced villagers (xp > 0, or remembering a profession) only take blocks of that profession; nitwits never; instant: used by commands / tests, villagers themselves walk to the block, see "Walking to a jobsite";
  `claim(mob, {site})` takes that exact block if it is still free; sets `mob.profession`, `mob.jobsite = {x,y,z}`, rebuilds the outfit and the offers; first job ever adds the profession's
  starting wares without emeralds; emits `villagerHired(mob, prof)`), `release(mob, {keepProfession}?)` (frees the block; the villager becomes `unemployed` and remembers its profession, see "Jobsite memory"; `villagerFired(mob)` is emitted
  when a jobsite is lost), `hire(mob, site)` (the claim itself: profession, stock, `BF.villageLife.ensureKit`, `villagerHired`), `unclaimed(villageRec | {x,z} | mob, radius?, forMob?) -> [{x,y,z,id,prof}]`, `isEmployed(mob)`, `setProfession(mob, prof)`, `sites` / `claims` maps (debug).
  Hooks: `planVillage(v)`, `planFor(rec)`, `onSpawn(m, rec, sv)`, `tick(dt)`, `ai(m, dt, out)`, `importAll(o)`, `reset()`, `drawCount(need, rand)`.
- **Professions**: new key `unemployed` (`VILLAGER_OUTFITS.unemployed = {}`: plain biome robe; never in the roster pool, so old rosters do not shift; `TRADES.unemployed` empty, nitwit-like stock;
  right-click says "This villager has no job yet"). `BF.mobs.roster(rec)` = `villageRoster`, `BF.mobs.setProfession(m, prof)` rebuilds the body parts in place (keeps model scale, badge, everything else).
- **Worldgen** (worldgen.js `drawVillage`, after the buildings): `v.jobsites = BF.jobs.planVillage(v)` once per village = `[{x,y,z,id,prof,slot}]`. Count = `round(need + N(0,1) * max(0.7, 0.18 * need))`, min 0,
  need = roster villagers that are not nitwits (builders included), seeded from the world seed + village key. Special-building villagers (library, church, smith) get blocks first, then a seeded shuffle; spare blocks
  (count > need) take professions from the roster mix (`slot -1`). Placement: farmers' composters on the plot ring beside a farm, builders' drafting tables on the plaza, everyone else inside their own house on a free
  floor cell next to a wall (from `recordBuilding`; never on beds or the door entry, and only where the door still reaches every other floor cell and a bed side), else beside the building, else the plaza. Chunk generation
  stays deterministic; blueprints/recordBuilding are unchanged.
- **Runtime**: the registry scans every loaded chunk for jobsite ids (`world.onChunkLoad`, registered on the first tick) and follows `blockPlaced` / `blockBroken`; `tick` (from `mobs.update`, 1 Hz) re-checks each
  employed villager's block when loaded (broken / replaced by anything -> loses it). A generated block of a roster slot that has not spawned yet is
  reserved for it. `ai` (from `villagerAI`, after the builder) walks an employed villager (not builders) to its block with A* now and then between sky time 0.04 and 0.45 and has it stand there 8-20 s.
- **Walking to a jobsite** (`seekAI`, from `ai`, which `villagerAI` now calls for every villager after the food and builder logic): a villager without a job (not a nitwit, not a child, awake, not trading) looks
  every 3-8 s for the nearest free jobsite block within 48 blocks of its village centre (experienced ones only blocks of their own profession; a grown child's parents' professions count 0.6x distance),
  walks there with A* and takes the block only once it stands beside it (`claim(m, {site})`). Whoever arrives first gets it: a walker whose block is claimed or removed on the way picks again after 0.5-2 s, an unreachable
  block is left alone for 60 s, a walk is given up after 120 s. Newly grown villagers (`breeding.js finishGrow`) no longer claim instantly: they start unemployed with `m.jobPrefer` and walk like the others.
  Generated roster slots still take their planned block at spawn (`onSpawn`).
- **Roster reconciliation** (`onSpawn`, called by `updateVillages` after `trades.unpack`): saved state with `prof` wins (profession + jobsite from the save). Otherwise the slot takes its planned block; no block -> unemployed
  (fresh villagers get unemployed stock); old saves without `prof` keep their profession when they had traded (xp > 0 or level > 1) and look for a block of it.
- **Jobsite memory**: a villager whose block is broken or replaced always loses its profession (becomes `unemployed`, outfit changes) but keeps `level`, `xp` and inventory and sets `m.jobMem = {prof, t}` (`t` = absolute game day,
  `sky.day + sky.time`). Within `BF.jobs.MEMORY_DAYS` (30) game days: placing a block of that profession makes the nearest remembering villager within 48 blocks of it (village-centre distance, then nearest by position) take it at once
  (`reclaimAt`, from `blockPlaced`; level and xp restored, no second starter stock); standing blocks of that profession are reserved for remembering villagers against other unemployed ones (`claimedByOther`), and remembering villagers
  walk to them first (0.3x distance). A remembering villager with xp > 0 only takes its own profession; taking a job clears the memory. After 30 days the memory ends in `tick`: level 1, xp 0, offers rebuilt, a regular unemployed villager.
- **Save**: `trades.pack` adds `prof`, `job: [x,y,z] | null`, `st` (first-job stock given), `mem: [prof, t]` (only while remembering) to each villager entry; `mobs.importVillagers` -> `jobs.importAll` rebuilds the claim table. Newborns (`#2000+k`) use the same fields.

## Villager food and farming (js/villagelife.js)
Loaded after mobs.js / builder.js (index.html). mobs.js, trading.js, inventory.js and player.js only call `BF.food` / `BF.villageLife` at runtime and work without them.
- **Bread equivalents** (`BF.food`): item `food` points / 5 (bread). `breadEq(itemId | inv array | mob)`, `isFood(id)`, `edible(m) -> [{id, n, eq}]` (cheapest per bread-eq first by
  `BF.trades.VALUE`; farmers keep `SEED_KEEP` 8 of each plantable crop/seed item out of it), `available(m)` (edible + fractional carry), `surplus(m) = max(0, available - KEEP 7)`,
  `rate(m)` = 1 bread-eq/day, 2 for `m.child`. `eat(m, eq) -> eaten` takes whole items (cheapest first, rotten flesh and raw food before bread) and carries the excess as
  `m.life.sat`; `take(m, eq) -> [{id, count}]` removes whole items worth at least eq (for gifts, e.g. breeding). `onEat(cb(m, eq, itemIds))` listeners; `m.eatenTotal` = lifetime bread-eq eaten.
  Every food the player can eat counts (rotten flesh too).
- **Meals** (`BF.food.digest(m, now)`, run for every loaded villager every 0.5 s by `BF.villageLife.tick` from `mobs.update`): three meals a day at sky time `MEALS` 0.04 / 0.22 / 0.42,
  each `rate/3`. Due meals are counted from `life.mealT` to `day + time` (absolute game days), so sleeping, `/time add`, reloads and villagers coming back into range catch up
  (max 30 days; `/time set` backwards eats nothing). A visible meal (player within 24 blocks): crumbs at the mouth, arm movement, `eat` sound at the villager.
- **Hunger**: `m.life = {v, mealT, lastAte, sat, eaten, starving, cookDay?}`; `m.starving` = more than 1 game day since a meal found food. A starving villager that gets food eats at once.
  `BF.trades.blockReason` returns "Too hungry to trade" for every offer whose `sell` item is not food while `m.starving` (food offers keep working); the trade screen title shows
  `BF.villageLife.statusText(v)` ("Too hungry to trade", "Hungry", "Buying food", farmer task) before the builder status.
- **Buying food** (any villager, daytime until sky time 0.5): when `available < rate` and it holds an emerald, it picks the nearest villager of its village with a surplus (farmers at
  half distance), walks there (A* via `BF.mobs.nav`, like the builder), waits 1.6 s and buys up to `SHOP_DAYS` 3 days of food: with the seller's own "emerald > food" offers through
  `BF.trades.exchange`/`addXp` (seller xp), else 1 emerald for ~0.9 emerald of the seller's most plentiful food at `VALUE` prices. The seller never drops below 7 bread-eq.
  No emeralds or no seller: retry after 0.08 day. Log `BF.villageLife.log` (`kind: "buyFood"`), event `villagerFoodTrade(buyer, seller, itemId, n)`.
- **Starting food** (`BF.food.startFood(v)`, from `trades.init` when the inventory is new, and from `trades.unpack` for saved villagers without `life`): non-farmers are topped up to
  3-6 bread-eq (bread, apple, carrot, baked potato); farmers get 10-20 wheat seeds, 8-14 carrots and potatoes, 4-10 beetroot seeds, bread up to 12 bread-eq, 45 % 3-8 oak logs. Buckets and hoes come from the kit
  (`BF.villageLife.ensureKit(m)`, on hiring and once when a farmer / builder first runs its AI): a farmer or builder with no bucket and no water bucket gets one **empty** bucket, a farmer with no hoe a stone hoe.
- **Restock**: food is never created (see TRADE_AUDIT.md): `PRODUCE.farmer/butcher/fisherman` are empty; butchers and fishermen cook up to 8 raw meat / cod they hold per day.
- **Farmer AI** (`BF.villageLife.ai(m, dt, out)`, called from `villagerAI` after the trading freeze, flee, bedtime, morning and breeding logic and before the builder / jobsite AI;
  only `profession === "farmer"` with a `jobsite` (its composter), not children). Day only (sky time < `WORK_END` 0.5; night/bed handled by mobs.js). Village farm data `rec._life` (`vdata(rec)`): area = worldgen
  village box + 6 (`D.base`, widened to the composter's reach box by `ensureCover` when a composter stands outside it, which triggers a rescan), y range from the pads; an incremental column scan (500 columns
  per 0.5 s tick, rescan every 10 s) lists farmland cells and surface water sources inside the area, and the water sources of the ring `WATER_REACH` 30 blocks around it (lakes, ponds, rivers via `heightAt`),
  plus the well cells (generated well and built wells, which sit under a roof). **A farmer only tends farmland within `FARM_R` 12 blocks of its composter in every direction** (`inRange`, a Chebyshev box
  incl. y); harvest, plant, tilling, edging and new irrigation holes all stay inside it. Task priority:
  1. bake (3 wheat -> 1 bread, 9 wheat -> 1 hay bale once it holds 96 bread), 2. harvest the nearest mature crop (wheat, carrots, potatoes, beetroots on farmland) whose drops fit
  (`BF.rollDrops` straight into `m.inv`) and replant it at once with the matching seed, or plant empty farmland (crop chosen from the neighbours' crops), 3. when there is
  nothing to harvest/plant: till grass/dirt **with a hoe** (any hoe in the inventory, not consumed) within 4 blocks of a water source at the same level (next to existing beds first), and with logs/planks in the
  inventory edge the beds with wood (a ring of logs replacing the ground just outside the irrigated area); up to `FARM_MAX` 64 farmland cells in reach; with no wood and edging to do it fetches 8 logs (see
  gathering), 4. **no farmland in reach at all: make a farm** (`planTask`): `pickPlot` samples 60 spots near the composter for a 9x9 plot (`PLOT_R` 4) that lies in reach, in free ground (no building / plaza / lamp / decor /
  built-structure box), loaded, natural soil only in every column (grass, dirt, coarse dirt, podzol, snow, mycelium, sand, red sand, gravel, clay, path, farmland), no water, at most 2 blocks of slope, cheapest
  (blocks to dig + fill) first; then per cell (nearest first) `dig` the top soil block where the ground is higher (or is sand / gravel / clay and must become dirt) and `raise` a dirt block where it is lower, then
  pour a **full** water bucket into the middle (`water`; with only an empty bucket it first walks to a water source and fills it, see Buckets). Tilling and edging then continue from step 3. If no dirt is in the
  pocket it fetches up to 24 (digging puts dirt in the pocket too). Nothing but soil is ever dug and nothing inside the village's own area is taken for materials, 4b. beds already exist: pour its water bucket into a
  walled-in hole next to the beds in reach (needs 14+ tillable cells around and no water within 4), filling an empty bucket first, 5. tend young crops (stand and look 2-4 s). Each block action: walk until the cell
  centre is within 1.75 blocks, face it, swing, 0.45-0.9 s, then `world.setBlock` (only loaded chunks, never outside the area or inside building / plaza / lamp / decor /
  built-structure boxes; worldgen farm plots are harvested and replanted but never re-shaped). Cells are claimed so two farmers never share one; a failed cell is avoided for 30 s (`log` kind `giveup` says why).
  After 5 % of tasks a 4-9 s break (normal wandering). Measured share of the awake daytime spent on farm tasks (incl. trading with the player): 93-97 %.
  `BF.villageLife.stats(m) -> {today, yesterday, farm, total, counts, harvested, tilled, bordered, watered, task}`; `counts` also has `dig`, `raise`, `gather`, `fill`.
- **Gathering** (`findGather`, task `gather`): dirt = the top block of open grass / dirt / podzol ground, logs = the base log of a tree, from a random spot of the ring `GATHER_R` 24 blocks around the village
  area (`D.base`), **never inside it** (the village's own landscape and buildings are left alone); nearest of 120 samples, the drops go into the farmer's inventory. A trip goes on until the farmer holds enough (`fs.haul`).
- **Buckets**: items `bucket` (stack 16, recipe 3 iron ingots in a V) and `water_bucket` (stack 1) in blocks.js, sprites + recipe registered from villagelife.js (`texKit.SPRITES`,
  `recipeHooks`). The player uses them through `BF.villageLife.useBucket(item, target)` (player.js right-click hook before eating): an empty bucket scoops the water source looked at,
  a water bucket pours a source against the targeted face (creative keeps the bucket).
  **Villagers' buckets**: a new farmer or builder starts with one empty bucket (see Starting food). Water is only ever placed from a full bucket and leaves the bucket empty (farmer `water` task, builder well
  cell); a villager without a full bucket walks to a source and fills it first. Sources: any water source within ~30 blocks (`WATER_REACH`) of the village area, wells included
  (`findFill` picks the nearest 12 with a standing cell within 2 blocks, so the walled-in well is dipped over its wall). A source is only removed when it refills by itself (two source neighbours over
  ground / source, like vanilla and the 2x2 wells); a lone source stays put. API: `BF.villageLife.findWater(m, rec) -> {x,y,z,sx,sy,sz} | null` (also asks to keep the village's water ring scanned for 2 minutes;
  null until scanned), `fillBucket(m, x, y, z)`, `ensureKit(m)`.
- **Save format**: `trades.pack(v)` adds `life: {v: 1, mealT, lastAte, sat, eaten, starving}` to each villager entry (`exportVillagers`), `unpack` restores it; entries without
  `life` (older saves) get the starting food once. Farm progress is ordinary world edits; per-farmer task state and daily stats are not saved.

## Breeding (js/breeding.js)
`BF.breeding`, loaded after mobs.js, jobs.js and villagelife.js (index.html). Uses `BF.food.breadEq/take/rate` and `BF.jobs.claim/onSpawn/release` when present
(small fallbacks for food otherwise). mobs.js hooks: `BF.breeding.tick(dt)` in `mobs.update`; in `villagerAI` `if (m.love ...) BF.breeding.ai(m, dt, out)` (before the builder/jobs
hooks) and `if (m.child) BF.breeding.childMove(m, dt, out)` after `wanderAI`; `restockVillagers` skips `m.child`; `interact` returns "The child is too young to trade" for a child;
`updateVillages` counts only non-`m.bred` members against the roster; `exportVillagers/importVillagers` call `BF.breeding.exportAll(out)/importAll(o)`. commands.js: `/summon villager <x y z> child` (or `baby`).
- **Bed rule.** Beds = every bed foot block (any colour/facing) inside the worldgen village box + 8 or the footprint of a builder structure (`rec.built`), found by scanning the
  loaded chunks' voxels (~every 5 s, and at once after a bed `blockPlaced`/`blockBroken` in the area); chunks not loaded use their last scan, else the worldgen house beds in them. So
  worldgen, builder-built and player-placed beds all count and broken ones stop counting. Villagers = roster slots still alive (`roster.length - killed.villager`, includes builders) +
  living newborns (children and grown) + pairs already in love. Breeding needs `beds >= villagers + 1` (checked when the encounter rolls and again at the birth) and fewer than
  `MAX_TOTAL` 40 villagers, or 1.5 x `rec.pop` for sized villages (a safety cap; the roster cap of 24 does NOT apply to newborns, the bed rule is the limiter).
- **Eligible adult**: villager, not a child, not dead/asleep/fleeing/trading/already in love, not `m.starving`, daytime (not bedtime 0.52-0.985), `BF.food.breadEq(m.inv) >= 7`,
  and at least `COOLDOWN` 1 game day since it last bred. Any profession may breed, nitwits, unemployed and builders included (vanilla lets nitwits/unemployed breed).
- **Encounter.** Every 1 s, per village, each pair of its adults (`rec.members`) within `RADIUS` 5 blocks (3D) whose condition (both eligible + bed rule) has just become true
  rolls `CHANCE` 50% once; the pair is not rolled again until it separates (or stops being eligible) and meets again. Villagers are never steered toward each other.
  Success: both stop and face each other (`m.love` = partner) for `LOVE_T` 2.6 s with pixel heart sprites rising above their heads (8x8 canvas texture, NearestFilter), then
  each pays 5 bread-eq via `BF.food.take(mob, 5)` (whole items, cheapest first: a parent may overpay a fraction) and a child appears between them (a free standing cell
  nearby) with a burst of hearts. Event `villagerBorn(child, a, b)`; `BF.breeding.log` keeps the last 50 births (who paid what).
- **Child.** A normal villager mob with `m.child = true`, `m.bred = true`, `m.profession = "child"` (not "unemployed", so jobs.js does not hire it), the plain `unemployed` robe,
  `model` scaled 0.55 with the head x1.35 (height 1.3, half-width 0.2), no trades, no restock, inventory exactly 10 bread. It wanders 1.6x faster with a wobbling heading and short
  idles. At dusk (sky time > 0.45) it takes the nearest free bed (`m.bed`; not a roster slot's bed, a live villager's or another newborn's), else stands by the bell like the
  bedless. It eats 2 bread-eq a day through villagelife.js (`BF.food.rate` returns 2 for `m.child`; breeding.js eats 2 bread per new day itself only when `BF.food.rate` is
  missing). When its food is gone (~5 days) it grows up (scale animates to 1 over 1.6 s), becomes `unemployed`, and `BF.jobs.claim(m, {prefer: [parent professions]})` picks a
  job (preferred professions weigh 3x); with no free jobsite it stays unemployed and jobs.js keeps retrying. Event `villagerGrewUp(m)`. From then on it is an ordinary adult
  (starving rules, trading, can breed).
- **Persistence.** Newborns live in `rec.bred` (village record) as `{k, child, born, eaten, parents: [profA, profB], prof, cd, pos, bed, ...}` and use the existing villager map with
  keys `"<village key>#2000+k"` (roster slots < 1000, builders #1000+): the entry is `trades.pack(m)` plus `bred: {...}` (meta above). Unloaded newborns are respawned by
  breeding.js (not the roster) near their saved position when the player is within ~72 blocks; grown ones get `BF.jobs.onSpawn(m, rec, {prof, ...saved})`. Dead newborns
  are removed from `rec.bred` and their keys from the next save (and their death is not counted in `rec.killed`, so no roster slot is lost). Parents' cooldowns:
  `"breeding:cd": {villagerKey: day}`. Old saves have none of this and load unchanged.
- **Debug.** `BF.breeding.forceBreed(a, b)` (love sequence now, ignores eligibility and the bed rule), `forceBirth(a, b)` (instant), `growUp(child)` (animated), `growNow(child)`,
  `makeChild(mob, parents?)` (any villager becomes a child of the nearest village), `info(rec?)` -> `{beds, villagers, ok, newborns}`, `eligible(m)`, `bedsOK(rec)`, `stats`, `log`.
- **Not done / notes.** The bed scan is a box test, so a bed inside the village box that belongs to nobody (e.g. a player's base next to the village) counts. Children have no
  home house (`m.home` null): in the morning they just wander off from the bed. Grown newborns keep their jobsite through a save only via trading.js pack's `prof`/`job`
  fields (jobs.js); their profession itself is also kept in the `bred` meta.

## Signs (js/signs.js, js/village-names.js)
Loaded after commands.js (index.html: `village-names.js`, `signs.js`). Blocks/items in `blocks.js` between the `// ---- sign pack ----` markers (append-only; `signDefs()`): per wood species
(`BF.WOOD_SPECIES` order) 4 standing signs `<sp>_sign_<nesw>` then 4 wall signs `<sp>_wall_sign_<nesw>` (64 ids, hidden), field `sign: {wood, wall: 0|1, f}` (f = the direction the text faces;
a wall sign hangs on the block at pos - `DIRS[f]`), `render:"model", model:"sign"`, not solid, axe, hardness 1, `drop`/`item` = `<sp>_sign`; tiles = the species planks (+ `post: <sp>_log` for the post box).
Items `<sp>_sign` x8 (`places: "sign"`, stack 16, tab functional, fuel 10 s), recipe 6 planks of one wood + 1 stick (`PPP`,`PPP`,` S `) -> 3 signs (`BF.recipeHooks` in signs.js), icon `SPRITES["<sp>_sign"]`.
- **Placing** (player.js -> `BF.signs.place(target, item)`): top face (or a replaceable plant) = standing sign facing the player (snaps to the facing of an adjacent standing sign of the same wood
  in the same plane so it merges), side face = wall sign on that block, bottom face refused. Sneak + right click on a sign with a sign extends it: its left/right side adds a column, the top of a standing
  sign stacks another standing sign, top/bottom of a wall sign another wall sign. Support: wall sign needs a solid block behind it; standing sign a solid block below or the same standing sign
  (stacking). Signs pop (one item each, none in creative) when the support goes (`world.setBlock` -> `BF.signs.onSet`, chains up stacks). The editor opens right after placing (vanilla).
- **Groups.** Signs with the same block id (same wood, kind and facing) that touch left/right or above/below in their plane form a connected run, split deterministically into rectangles of at most
  `MAXW` 4 x `MAXH` 4: repeatedly the largest free rectangle, ties to the lowest row, then the leftmost column (as read from the front), then the wider one (5 in a row = 4 + 1; an L of 2 + 1 on top =
  2x1 + 1x1). Different woods / kinds / facings never merge. The anchor of a group is its bottom-left sign (`BF.signs.groupAt(x,y,z)` -> `{anchor, W, H, key, f, wall, wood, id}`).
  Rendering (`world.MODELS.sign`, models now get world coords): one seamless board; wall boards span 4/16 of the bottom row to 12/16 of the top row (2/16 thick against the wall), standing boards
  from 8/16 (on posts) or from the floor when stacked on another standing sign, up to the top row; posts (the species log tile) under the bottom row only: one for a 1-wide group, else under the two end columns.
- **Text.** Per group, keyed by the anchor `"x,y,z"` in a per-world map (saved; independent of chunk loading). Capacity: one sign = 4 lines x 15 characters (vanilla); a W x H group = `4H` lines x `15W`
  characters (3x2 = 8 x 45 = 6x a single sign). `BF.signs.layout(text, cols) -> {lines, pos}` = greedy word wrap (explicit newlines kept, the breaking space is consumed, words longer than a line are split),
  used by both the editor and the world; text that would need more than `rows` lines is refused (`clampText`). When a group changes shape: each old group's text moves to the new group containing its
  old anchor (else the one with most of its old signs); a new group receiving several texts joins them top-to-bottom, left-to-right with newlines and cuts what does not fit; an unchanged group keeps its entry.
- **Editor** (`openEditor(x,y,z)`, right click on a sign when not sneaking with an item; player.js `invOpen()` counts it as a screen): a modal board drawn with the same wood tile, the same aspect as the board
  and the same text renderer as the world (centred lines, fixed character cells, caret), over an invisible textarea; typing past capacity is blocked; shows lines used / characters left. A window
  capture-phase keydown listener (registered at load) swallows every key while open; Esc (or Done, or Ctrl+Enter) saves and closes; `P.uiOpen()/uiClose()` release/re-take the pointer lock.
- **In-world text**: one `CanvasTexture` plane per group with text (192 px per block, `IBM Plex Mono`, dark ink), just in front of the board, polygon offset, rebuilt only when text/shape changes,
  removed and disposed when the group goes or its chunk unloads; colour = sky term (column top, `world.daylight`) / block light like the mesher, refreshed every 0.4 s.
- **Auto signs.** `BF.signs.registerAuto(kind, fn(entry, anchorKey, group) -> text|null)`; entries `{t, auto: kind, ak: key}`. Every half in-game hour (`floor((sky.day + sky.time) * 48)` changes)
  each auto sign whose anchor chunk is loaded is recomputed and its text rewritten if it changed. Auto signs cannot be edited (the editor opens read-only). Breaking any sign of an auto board breaks
  the whole board: one sign item per sign block (none in creative), the auto key is remembered in `seen` (saved) so it never comes back; nothing can craft an auto sign. Kinds: `village`.
- **Village names**: `BF.VILLAGE_NAMES` (200 real New Zealand towns, js/village-names.js). `BF.signs.nameFor([rx, rz], spawn)`: a per-seed shuffle indexed by `rx + 9 rz` (no repeats in any 9x9 block of
  village regions; the spawn village offset by 100). Stored as `v.name` on the worldgen village (so `rec.wg.name`), copied to the mobs.js record as `rec.name`; `BF.signs.villageName(v | "x,z")`.
  `/locate village` prints it.
- **Entry arch** (`planArch(v, ctx)` called by worldgen `layoutVillage` before the village box is computed; `drawArch(v, set, palette)` at the end of `drawVillage`; deterministic): a random edge
  (hash of the village position and the seed), over the main road leaving through it at its end (or a cell beyond / up to 14 cells before it), else another edge, else the middle of an edge of the
  village extent with a path under it. Footprint 5 wide: two pillars (palette `corner`, foundation block under) at +-2 from the road centre, lintel `top` = highest ground + 5 (logs at the ends,
  `log` in between), a 3-block crown (`wall`/`roof`), a hanging lantern; the passage is cleared. Sign: 3x1 standing signs (wood by style: oak, birch (desert), spruce (snowy/taiga), acacia) one cell
  outside the arch on a random side (offsets 2..4), facing out, ground filled with the foundation block. Checks: pillars off plots (second pass: on a plot ring but not in a building or its door front),
  signs and passage off plots, roads, lamps and decor; dry land; slopes <= 2. `v.arch = {key, x, z, d, L, top, f, wood, signId, anchor, pillars, under, lintel, crown, signs, box}`; `box` is added to the
  village box (so trees/caves/builders keep clear; builder.js `obstacles` adds `wg.arch.box` + 2). The generated sign becomes an auto entry (`autoPlan`) once all three blocks are loaded; text:
  `Village of <name>` / `Villagers: N` / `Beds: M`, N = `BF.breeding.villagerCount(rec)` (roster - killed + newborns) or the deterministic roster when the record does not exist yet, M =
  `BF.breeding.bedCount(rec)` (falls back to the worldgen house beds still standing).
- **Save**: snapshot field `signs = {v:1, data: [[anchor, text, auto|null, autoKey|null]], seen: [autoKeys]}` (`serialize/deserialize`; old saves have none). Sign blocks are ordinary edits.
- **API** `BF.signs = {get(x,y,z) -> {anchor, W, H, wall, f, wood, cells, text, auto, autoKey, cols, rows, lines} | null, setText(x,y,z,text, force?), groupAt, layout, clampText, capacity(W,H),
  place, interact, openEditor, closeEditor, isOpen, registerAuto, runAuto, planArch, drawArch, villageName, nameFor, serialize, deserialize, reset, isSign(id), signId(wood, wall, f), onSet}`.
- **Not done / notes.** 4 facings only (vanilla 16 for standing signs); no back-side text, glow ink or dyes; signs have no collision (vanilla); the auto sign updates when its own chunk is loaded
  (the village record needs the player within ~96 blocks, before that the counts come from worldgen); adding a sign next to an auto board can merge into it, which turns it into an ordinary sign.

## Maps and compasses (js/maps.js, js/cartography.js, js/recipes-maps.js, js/textures-maps.js)
- **Items** (appended to `ITEM_DEFS`): `compass`, `blank_map_1..5` (`mapSize`, label "Blank Map (8x8 chunks)" ...). Sizes: side = 128 * 2^(size-1) blocks (8, 16, 32, 64, 128 chunks), always 128x128 pixels, so scale = 2^(size-1) blocks per pixel.
  **Filled maps are dynamic items** named `filled_map_<size>_<zoneX>_<zoneZ>`, created on demand by `BF.resolveItem(name)` (blocks.js; ids from `ITEM_BASE + 0x10000`, stack 1, `it.map = {size, zx, zz}`, sprite `filled_map`). Saves store items by name, so inventory.js `fromSave` and trading.js `unpack` go through `resolveItem`. `BF.itemName` honours an item's `label`.
- **Zones.** The world is divided into 8x8-chunk zones: `zone = floor(block / 128)` per axis; a size-s map of zone (zx, zz) is centred on `(zx*128+64, zz*128+64)` and covers `side(s)` blocks around it (`BF.maps.bounds`). Any chunk of a zone gives the same map; larger sizes keep the zone centre.
- **Non-player use.** `BF.maps.explore(data, x, z, budget)` samples around any world position (it does not need the player); `filledIdAt(size, x, z)` gives the filled-map item a blank map becomes at a position, `progress(item)` / `filled(item)` the explored fraction. Walk an entity along the map and call `explore` from its position.
- **Using** (player.js `secondaryDown`): right click with a blank map turns it into the filled map of the zone the player stands in (a stack of one is replaced in its slot, else one is consumed and the filled map added). Filled maps do nothing on right click.
- **Data.** `BF.maps` keeps one `{size, zx, zz, px: Uint16Array(128*128) RGB565, 0 = unexplored, ver}` per (size, zone), shared by every copy of that map; saved in the world file as `maps = {"size_zx_zz": base64}` (explored maps only; old saves none), cleared on `newWorld`. A map fills in only while it is the held item: each frame `heldTexture(item)` samples up to 900 pixels inside a radius of the player from loaded chunks; the radius in blocks is `max(16, 40 / sqrt(scale))` (40, 28, 20, 16, 16 for sizes 1-5, never under 1.5 pixels: `revealBlocks/revealPx(size)`) so big maps fill in more slowly per block walked, and `explore()` applies it for any caller (top solid block colour = the block's `color`, water blended by depth, relief shading against the column one pixel north as in vanilla; unloaded chunks stay blank).
- **Held view.** player.js builds a plane (0.75 blocks, `MAP_VM`) held low and close in front of the body, not the camera: it sits 0.38 ahead and 0.7 below the eye, tilted back ~61 degrees, and the camera pitch is undone, so only its top edge shows when looking ahead and it is face-on and centred when looking down. It is textured by a canvas textured by a canvas (`textureFor/heldTexture`): parchment backing and frame, the map pixels, a white arrow for the player (rotated by the heading, moves as they walk) or, when the player is outside the map, a smaller grey arrow clamped to the frame edge that still shows the heading. The compass shows a dial whose needle points at the world spawn (`BF.spawnPoint`, or its `world` field when a bed is set) relative to the view direction.
- **Recipes.** Compass: 4 iron ingots (N, E, S, W) around a gold ingot (vanilla uses redstone, which is not implemented). Map: 8 paper around a compass -> `blank_map_1`. Bigger: 8 paper around any map of size < 5 (blank or used) -> the next size; `BF.craftHooks` (inventory.js `recompute` runs them before the shaped recipes) gives the computed result, `BF.maps.upgradeData` copies a used map's pixels into the next size (resampled around the same centre). Crafting table only (3x3).
- **Cartographer** (`BF.cartography`): `seed(inv)` (called by `trading.stockFor`, so also the first-job stock) adds 4 iron + 1 gold ingot, and with probability 1/2 tops paper up to 8, else leaves it below 8; compass and maps are never in the starting stock (`noStart`). `plan(m)` / `craft(m, plan)`: with fewer than `MAP_STOCK` (2) blank maps it makes a compass (4 iron + gold) then a map (8 paper + compass); with >= 24 paper and two maps it surrounds its smallest blank map with paper. jobs.js calls `work(m, J, dt)` while the villager stands at its cartography table (one craft per 1.6 s) and `wantsJob(m)` to bring the next table visit forward. `ai(m, dt, out)` (mobs.js villagerAI, before the jobs hook, daytime): short of ingredients and holding emeralds, it walks to the nearest village member whose offers sell what is missing and trades with the same stock/room rules as the player (`T.exchange`, `T.addXp`); log in `BF.cartography.LOG`. Trade table and prices: TRADE_AUDIT.md.
- **Tests.** `test/maps-actions.js` (zones, exploring, upgrades, save round trip, held-view screenshots) and `test/cartography-actions.js` (starting stock distribution, crafting order, shopping), `test/cartography-live.js` (a cartographer in a village walks to its table and crafts, buys iron from the armorer): `NODE_PATH=$(npm root -g) node test/run.js /tmp/out test/<name>.js`.

## Auto maps and the full-screen map view (js/mapview.js, creative only)
- **Item** `auto_map` (appended to `ITEM_DEFS`, stack 1, `autoBlank`, label "Auto-Fill Map", `search` keywords "auto map autofill auto-fill ..."; no recipe, villagers never sell it, so it exists only in the creative menu: Miscellaneous tab, or Search Items with any of "auto", "map", "autofill", "auto-fill"; the search matches every word of the query against the item name plus its `search` keywords). It is the last entry of `ITEM_DEFS` so no existing item id moves. Filled ones are dynamic items `auto_map_<zones>_<zoneX>_<zoneZ>` made by `BF.resolveItem` (`it.auto = {k, zx, zz}`, sprite `auto_map`, stack 1), saved by name in the inventory.
- **Using** (player.js `secondaryDown` calls `BF.mapview.use(sel, it)`): right click with the blank auto map opens a width prompt (default 2048); the width is rounded to the nearest whole number of 8x8-chunk zones (`zonesFor(w)`, 1 to 32768, i.e. 128 to 4194304 blocks, so 2000 gives 2048; the cap is where worldgen's lattice cache keys (`lx * 1048576 + lz`, 4-block cells) start to collide, about 2M blocks from the origin) and the item becomes the filled map `side = zones * 128` blocks wide, centred on the zone the player stands in (same zone rule as normal maps: `x0 = zx*128 + 64 - side/2`). Right click with any filled map, normal or auto, opens the full-screen view instead. Both overlays use `BF.player.uiOpen/uiClose` and the capture-phase key handler pattern of signs.js (`BF.mapview.isOpen()` is part of player.js `invOpen`).
- **Data.** `getAuto(k, zx, zz)` keeps `{N, scale, x0, z0, hgt: Int16, bio: Uint8 (255 = unknown), wl: Int16, ver, done}` per map; `N = min(1024, side)` pixels a side, so `scale = side / N` blocks per pixel (2000 -> 2048 -> 2). Pixels are taken from **the world generator** (`BF.worldgen.biomeAt` for the biome id and height, `waterLevelAt`), never from loaded chunks, so it uses whichever generator version (`BF.state.gen`) the world was created with and works anywhere on the map at once. `tick()` (main.js frame loop, 8 ms a frame, 20 ms while an overlay is open, paused with the game) runs `step(d, deadline)`: five passes with block sizes 16, 8, 4, 2, 1 px (a coarse preview in about a second, then refined), each cell sampling the biome at its centre block. **Rivers** (`BF.rivers.at`, which traces the whole river network per 768-block cell: about 70 us a sample at 64 blocks per pixel, 250 us at 256, and hundreds of MB of cache over a big area) are only sampled when `scale <= RIVER_MAX_SCALE` (16 blocks per pixel, i.e. maps up to 16384 wide); wider maps switch them off around the sampling loop with `BF.rivers.setEnabled(false)` (a river is under a pixel there anyway), which does not touch any cache chunk generation uses. Without rivers a sample costs about 15 to 20 us in either generator, so a 1024x1024 map is about 15 to 20 s of CPU spread over frames. One shared 4 MB ImageData paints all maps; each map keeps its own canvas (4 MB at 1024 px) and about 5 MB of height/biome/water arrays. Maps are generated newest-used first. Nothing is saved: the pixels regenerate from the seed when the map is next held or viewed (`reset()` on `newWorld`). Colours (`paint`) have two modes, switched by the **Colours** button in the full-screen view (`BF.mapview.setColourMode(0|1)`, remembered in localStorage `bf_mapcolours`, repaints every map from the stored samples without regenerating): **ground** (default) is the colour of the block seen from above (`GROUND`/`groundOf`: sand, red sand, gravel, snow, stone above the snow lines, mud, mycelium; grass is the block colour times `BF.worldgen.tintAt(x, z).grass`, sampled once per cell during `step` only for grass-topped biomes and stored as `d.tn`, 3 bytes a pixel), so flower forest is green like in game; **biome** is the old biome colour table (as tools/terrain-map.js). Both are brightened with height and shaded against the south-east pixel; ocean, rivers and any column under its water level are blue, darker with depth.
- **Held view.** `BF.maps.heldTexture` hands auto maps to `mapview.held`, which draws the (up to) 1024 px canvas smoothed into the same framed 128 px held texture as normal maps (`BF.maps.heldCanvas`), arrow included.
- **Full screen.** Canvas up to the window size, parchment background for unexplored pixels, world-aligned grid lines every `128 * 2^n` blocks (at least ~56 px apart), the player arrow (grey and clamped to the edge when off the map), coordinates under the mouse (plus biome and height on auto maps), generation percentage while filling. Normal maps use `BF.maps.snapshot(item)` (128 px, shown in whole multiples). Esc, the Close button or a click outside closes it. **Teleport:** clicking the map selects a point (red crosshair, `selected x z` in the readout; works on any map); in creative mode only (`BF.player.gameMode`, checked when the view opens and again on click; survival keeps `/tp`, which is ungated here) a Teleport button appears, enabled once a point is selected. It closes the view and calls `BF.player.teleport` to `surfaceAt(x, z)`: the loaded height or else the generator's `heightAt`, but never below the water level, plus 1.01. For ground that is not loaded yet the player waits for the chunk (player.js `waitingForChunk`) and `settle()` (mapview `tick`) re-lands on `BF.world.heightAt` once it exists, so trees and buildings are stood on, not inside. Hover and selection readouts on maps over 16 blocks per pixel call `biomeAt` with rivers switched off (`biomeFor`).
- **Icons.** The blank Auto-Fill Map has its own sprite (`SPRITES.auto_map`, textures-maps.js: teal-bordered sheet, green target ring, gold sparkle). **Every filled map, normal and auto, is drawn as a thumbnail of the map itself**: `BF.mapIcon(item) -> {ver, url}` (mapview.js) shrinks the map canvas into a 64 px framed sheet (brown frame for normal maps, teal for auto maps; unexplored pixels show parchment). `textures.js icon()` returns it instead of the cached sprite, inventory.js bypasses its icon cache for filled maps and `setSlot` re-sets the image when `ver` changes (`BF.inventory.refreshIcons()` re-renders), and `mapview.tick` checks the maps in the inventory once a second so a thumbnail follows a map as it generates or is explored (rebuilt at most every 0.7 s). Fallback sprites before data exists: `filled_map`, `auto_map_filled`. Dropped items and the held plane read the icon once, when created. Filled maps are no longer listed in the creative menu (only the blank auto map is).
- **Test.** `test/map-icons.js` (hotbar, creative search and drop icons), `test/automap-tp.js` (select a point, Teleport, survival hides it), `test/automap-actions.js` (prompt, width rounding, generation time and worst frame, held and full-screen screenshots, normal map full screen): `NODE_PATH=$(npm root -g) node test/run.js /tmp/am test/automap-actions.js`.

## Explorers (js/explorer.js; roster in mobs.js, block in blocks.js, outfit in mobs.js)
- **Profession** `explorer` (16th, not vanilla; khaki robe, brim hat). Jobsite: `survey_table` (blocks.js `// ---- explorer pack ----`, appended after the sign pack; cube, spruce top with a compass rose, creative tab "functional"; recipe paper + compass over 4 planks, burns 15 s). `BF.jobs.JOBSITE.explorer`, so it follows the normal jobsite and unemployment rules (planVillage places its table, a jobless one with xp 0 becomes unemployed, a table can recruit an unemployed villager).
- **Roster** (`villageRoster`): never in the shuffled pool. After builders, one seeded draw per cartographer in the roster (stream `explorers:<village key>`, so no other slot moves): 70% (`EXPLORER_CHANCE`) adds an explorer slot, keys `<village key>#1100+n`, never beyond the cap (24 in classic villages; in sized villages an explorer replaces the last shuffled resident that is not a cartographer, builder or special-building villager, so the 70% always holds), never without a cartographer. Needs `BF.explorer` loaded (js/explorer.js after cartography.js).
- **Maps.** Starting stock: emeralds only (`TRADES.explorer` is five empty pools so `stockFor` does not fall back to the farmer table). With >= 4 emeralds and fewer than `MAX_FOR_SALE` (2) filled maps it walks to a cartographer of its village that holds a `blank_map_1` and buys it for `PRICE_BLANK[size-1]` (4, 8, 16, 32, 64 emeralds: the cartographer's own prices for the five sizes, trading.js) taking a size it holds and can pay for (random, weights 16:8:4:2:1 for sizes 1 to 5, so mostly small maps) (`T.blockReason` / `T.exchange` / `T.addXp`, so stock, room and xp rules apply). Explorers have a bigger purse (`EXPLORER_EM_CAP` 100, +6 a day). It uses the blank map at once: the zone is its own 8x8-chunk zone if that map is not complete yet, else the nearest of the 5x5 zones around it that is not complete and that it does not already carry (`useBlank`).
- **Exploring** (`ai`, called from mobs.js villagerAI before the jobs hook, working hours only): the map's 128x128 pixels are split into patches (16 px on sizes 1-2, about 32 blocks on bigger ones, `cellPx`); it walks (A* legs of 20 blocks, as js/cartography.js) to the nearest patch that is under 90% explored, is with loaded terrain 24 blocks around it (and, without js/villagesim.js, within 85 blocks of the player), stands there 1.5 s, and meanwhile calls `BF.maps.explore(d, x, z, 700)` five times a second, so the shared zone data fills as if a player carried the map. A patch it could not reach or fill is given up after two tries. The map is **filled** at 97% coverage, or when only given-up patches are left, or after 1500 s of exploring one map (`MAP_WORK_CAP`; the fill radius of js/maps.js shrinks with size, so a size 5 map is ~130 km of walking), or after 180 s of waiting for patches nobody has loaded (`ex.fin`, saved: big maps cover far more than the 85-block play range, so they end up partly explored and priced by coverage). Maps are sampled from loaded chunks only (`BF.maps.column` reads `world.chunkAt`, never worldgen); data-only chunks kept by js/villagesim.js count, so a far village's explorer can map the terrain around its village, but nothing beyond until the player comes near.
- **Selling.** `syncOffers(m)` keeps one offer per filled map in its inventory (`{buy: [price emeralds], sell: {filled map id, 1}, dyn: 1}`, price `SELL_PRICE[size-1]` = 7, 16, 36, 80, 176, scaled down by coverage, at least 15%, for a map it gave up on early), refreshed every 2 s and by `trading.init` when the trade screen opens, so a finished map is on sale to the player; unfinished ones are not offered. Status line in the trade screen: `statusText`.
- **Persistence.** Maps are ordinary inventory items (saved by name); `trading.pack` adds `ex: {fin: [map names given up on]}` for explorers. Debug log: `BF.explorer.LOG`.
- **Test.** `test/explorer-far.js` (explorer of a village 130+ blocks beyond view distance keeps exploring on js/villagesim.js chunks), `test/explorer-actions.js` (roster statistics, starting stock, a live explorer buys a blank map from a cartographer, uses it, explores, and offers the filled map): `NODE_PATH=$(npm root -g) node test/run.js /tmp/exp test/explorer-actions.js`.
- **Tents** (js/tents.js, blocks.js `tentDefs()` in the explorer pack, item `tent`). A bed that is 3 wide, 2 long and 2 high at the ridge: 48 hidden block states `tent_[up_]<row 0|1>_<lateral 0..2>_<n|e|s|w>` (the first 24 are the ground cells, the `up_` ones the six cells stacked above them, appended later; `tent: {f, r, l, up}`, deliberately not `bed`, so villagers' bed checks ignore them), drawn as a floor mat and a stepped canvas A-frame (model "shape"; collision box = the shell height of that cell; the ridge is 32/16 blocks, so a tent needs two free blocks of headroom). The cell a player targets is the foot centre (row 0, lateral 1); the tent covers one cell to each side and one row ahead along the look direction (`BF.tents.cells/place/canPlace/remove/originOf/findSite`). Breaking any part removes the other eleven without extra drops (one tent item drops; `BF.tents.cells` lists all 12, `originOf` steps down from an `up` part). Recipe: 6 wool of any colour over 2 sticks (`WWW/WWW/S S`). Right click at night sleeps like a bed (sets the respawn point; `respawnPoint` accepts tents) but nearby monsters do not stop you, and `BF.player.hiddenInTent` is set for the 2 s of the sleep so `hostileAI` has no player target.
- **Explorer camping** (explorer.js `campAI`): an explorer carries one tent (added by `stockFor("explorer")`). From `DUSK` (sky.time 0.45) until bedtime (0.52), if the straight-line distance to its bed is more than it can walk in the time left (speed x 1.3 x 0.8 slack), it pitches the tent on the nearest flat 3x2 site within 7 blocks, sets `m.bed = {x, y, z, f, tent: true}` (the tent's foot centre; the home bed is kept in `m.homeBed`; `bedOK` in mobs.js accepts it) and waits; at bedtime the normal `nightAI` walks it in and lies it down. Sleeping villagers in tents are skipped by `zombieHuntVillagers` (`BF.tents.hidden(m)`). Next morning it takes the tent down (the item returns), gets its own bed back and carries on. `ex.camp` is saved so a despawned camper still strikes camp. An explorer that has no tent (a world saved before tents existed, a broken camp, a full pack) collects a spare from home: `spareTent` tops it up by day within 30 blocks of its bed.
- **Test.** `test/tent-actions.js` (placement in 4 facings, breaking, an explorer pitching at dusk, sleeping hidden, striking camp): `NODE_PATH=$(npm root -g) node test/run.js /tmp/tent test/tent-actions.js`.

## Foresters (js/forester.js; roster in mobs.js, blocks in blocks.js, tiles in js/textures-forester.js)
Recreation of the villager-planter mod (GordonWallace/villager-planter). Differences from the mod are listed in the PR that added this.
- **Profession** `forester` (17th, not vanilla; forest-green robe, brown belt, brim hat). Jobsite: `band_saw` (blocks.js `// ---- forester pack ----`, appended after the explorer pack; tiles are the mod's 16x16 art doubled to 32px). Recipe `IFI / IFI / SSS` (iron ingot, flint, stone), as the mod. `jobs.js JOBSITE.forester`.
- **Roster** (`villageRoster`): never in the shuffled pool. Own seeded stream `foresters:<village key>`: first forester 95%, a second one 40% in villages with 19+ buildings; their slots are reserved within the cap of 24. Key range `<village key>#1200+n`. Generated villages get their band saw from jobs.js `planVillage` like every other jobsite.
- **Saplings** (`oak_sapling` ... `cherry_sapling`, seven blocks with `sapling: "<species>"`, `render: "cross"`): placed on soil only (grass, dirt, coarse dirt, podzol, mud, moss, farmland, mycelium; player.js checks `BF.forester.canSurvive`). They grow into a tree after ~8 minutes of simulation time on average (`growTick` chained onto `world.tickSim`, so fast-forward speeds it up; rain x1.3), only when the trunk and crown cells are free. Tree shapes per species are in `shape()`. Registry `BF.forester.saplings` is filled from chunk scans and `blockPlaced`.
- **Leaf drops** (blocks.js `extraDrops` on every `*_leaves`): own sapling 5% (jungle 2.5%), 1-2 sticks 2%, apple 0.5% (oak, dark oak). Mangrove leaves drop sticks only (no mangrove sapling).
- **AI** (`ai`, called from mobs.js villagerAI before the jobs hook; working hours only, needs a jobsite): picks plant / fell / pick up. Planting and felling are drawn 10 : 8 when both are possible; cooldowns 10 s (plant) and 20 s (fell); tasks time out after 30 / 40 s. Pick up has priority and no cooldown.
  - *Sized villages* (village generator 2, `boxOf`): the leash runs from the village's box, not its centre. It fells any tree within 40 blocks of the box (`SIZED_CUT`, ground 10 below to 14 above it), plants within 16 of it, and with no planting spot near itself it plants around a random point just outside the box (`edgePoint`).
  - *Plant*: needs a sapling in its pack. Spot within 16 blocks (+-4 high) of the forester and 36 of the village centre: air on soil (not farmland), 5 free blocks above, no sapling within 4 (+-2 high), no door within 10, and no building or other structure within 8 blocks horizontally (`builtBlock`: anything that is not raw landscape, so stone bricks, sandstone, terracotta and farmland count; dirt paths and saplings do not).
  - *Fell*: needs 2 free pack slots. Tree = the connected logs (18-neighbourhood) whose lowest log stands on soil, at most 64 logs, no log touching a block that is not landscape (planks, bricks, glass ... mean a building), at least one leaf block joined to it. Search within 40 blocks (+12 / -6 high) and 64 of the village centre, nearer trees favoured (distance x random 0.5-2); the time limit grows with the walk (40 s + 2.5 s per block). At 3 blocks distance it chops 1.2 s, then removes all logs (top to bottom) and every joined leaf (up to 256) with their drops.
  - *Pick up*: saplings, emeralds, logs, sticks and apples lying within 16 blocks (js/drops.js entities). It reaches 4 blocks up for items caught in leaves, and takes every wanted item within 1.6 blocks with each pickup.
  - *Sweep*: after felling it stays (`F.sweep`) and picks up, nearest first, until no wanted item lies within 12 blocks of the stump. It waits while items are still falling (age < 0.8 s), starts no other task meanwhile, gives up an item after two failed paths, and stops after 2 minutes or with a full pack.
  - Tree and spot claims keep two foresters off the same target. State is `m.fo` (not saved). `BF.forester.LOG` is a debug log.
- **Felling for players** (`fallAbove`, on `blockBroken`): chopping a log of a natural tree brings down the logs above it (and their leaves, with drops; none in creative), as the mod does for its villagers. Not when the rest still stands on something (a second trunk) or is part of a building.
- **Which leaves fall** (`collectTree`, villagers and players alike): leaves reached through leaves within 6 steps of the felled logs (vanilla's leaf distance), minus any leaf that another tree's log reaches in as few or fewer steps, so touching crowns keep their own leaves.
- **Sawing** (`saw`, from the growth tick, whatever the villager is doing): every 5 s, while it holds more than 2 logs of a species and fewer than 125 planks of it, 1 log becomes 4 planks (8 logs a day at most). Never gives anything away: the planks come from logs it felled or picked up.
- **Wares**: level 1 sells `1 emerald > 30 <species> planks` for the seven species, level 2 `1 emerald > 8 <species>_log`. Not restocked, not in the starting pack (`noStart` in `stockFor`), so it can only sell what it harvested ("Out of stock" otherwise). The furniture maker and the builder buy these.
- **Trade**: `TRADES.forester` level 1: `1 oak_sapling > 1 emerald` (the player sells). It only pays while the villager holds emeralds ("Out of emeralds"), the mod's trade stock rule. Starting pack: 6-24 emeralds and sometimes an oak sapling (the generic "wanted goods" rule). Daily emerald top-up is the usual +2 up to 12.
- **Test.** `test/forester-actions.js`: `NODE_PATH=$(npm root -g) node test/run.js /tmp/fo test/forester-actions.js` (roster, every sapling grows, a forester plants / fells / picks up, door distances, the trade).
## Furniture makers (js/furniture.js; roster in mobs.js, block in blocks.js, tiles in js/textures-furniture.js)
- **Profession** `furniture_maker` (not vanilla; wine robe, sawdust-tan apron, red headband). Jobsite: `carpentry_bench` (blocks.js `// ---- furniture pack ----`, appended at the end; cube, oak top with a roll of red wool, front with a bench vice and a hand saw; creative tab "functional"; recipe wool + iron ingot over 4 planks `WI / PP / PP`, burns 15 s). `BF.jobs.JOBSITE.furniture_maker`, so the normal jobsite and unemployment rules apply. `planVillage` always gives it a bench (it is ranked with the special-building villagers) on the plaza, or beside a random house when the plaza spots are taken.
- **Roster** (`villageRoster`): never in the shuffled pool. A village whose roster has both a `shepherd` and a `forester` gets one furniture maker with 80% probability (`FURNITURE_CHANCE`, own stream `furniture:<village key>`, so nothing else moves), key `<village key>#1300`. It may take the village one past the cap of 24 (big villages are usually full, and the cap would rule it out there). **Newly generated villages only** (`freshVillage`): a village for which the save already holds villager states but not `#1300` was generated before this existed and never gets one, so no villager appears in a village the player knows; jobs.js `planVillage` calls the same roster, so the bench follows the same rule. Needs `BF.furniture` and the forester profession.
- **Beds** (`plan` / `craft` / `work`, called by jobs.js while it stands at the bench): one bed from 3 wool (any colour) + 3 planks (any wood), the vanilla recipe, every 1.8 s, while it holds fewer than `BED_STOCK` (6) beds; a log is sawn into 4 planks first when it is short of planks. `wantsJob` brings the next bench visit forward when it has the ingredients. Never restocked (`PRODUCE.furniture_maker` is empty): every bed comes from wool and planks it holds. It is the only villager that sells beds (the shepherd's `1 emerald > 2 red_bed` offer and bed restock are removed in the shepherd PR, #30).
- **Buying** (`ai`, mobs.js villagerAI before the jobs hook, working hours only): short of wool or boards for the next `BUY_BEDS` (2) beds and holding emeralds, it walks to the nearest villager of its village whose trade table sells wool (`wool`, `*_wool`), planks or logs (the shepherd's wool, the forester's planks and logs) and buys there with the player's stock, room and xp rules, as the cartographer does (A* legs of 20 blocks, 60 s walk limit, a seller that fails is avoided for 0.05 day).
- **Selling** (same trip logic, checked first): holding at least the 2 beds of its own offer, it walks to a builder of its village that wants beds and sells it `1 emerald > 2 red_bed` up to 4 times, the builder paying from its own purse (`builderWants`: beds still needed by the structure it is building or shopping for, and at least `BUILDER_BEDS` (2) in hand for the next house). xp goes to the furniture maker. Builders short of beds also come to it on their own (builder.js `findSeller` sees the same offer). Trades are logged in the village log (`BF.vlog.trade`).
- **Starting stock** (`seed`, from `trading.stockFor`): 2 beds and at least one bed's worth of wool and planks, without the generic wanted-goods draw (it buys its wool and boards from the shepherd and the forester) and 6-24 emeralds. Status line in the trade screen: `statusText` ("Making beds", "Buying wool", "Buying boards", "Taking beds to a builder"). State: `m.furn`, `m.furnWork` (not saved). Debug log: `BF.furniture.LOG`.
- **Test.** `test/furniture-actions.js` (roster odds and the new-village gate, trade table, crafting, buying from a shepherd and a wood seller, selling to a builder, then a live furniture maker in a village doing all three): `NODE_PATH=$(npm root -g) node test/run.js /tmp/furn test/furniture-actions.js`. The roster part needs the forester (PR #27).

## Far-village simulation (js/villagesim.js, loaded after world.js)
Villagers only exist while their chunks are loaded. `BF.villageSim` keeps the terrain **data** (never meshed) of the nearest `MAX` (4) villages within `RADIUS` (200) blocks of the player
(released at 216) loaded, so their villagers keep running the normal AI while the player is beyond view distance. Footprint = village bounds + 16 blocks, at most 12x12 chunks.
- `world.plan` adds `villageSim.keepKeys` to its keep set (they are never unloaded while active) and `world.update` generates the missing ones, nearest first, only when everything in view is ready.
  `world.update` calls `villageSim.update(px, pz)` (throttled to ~1.5 s); a changed set forces a re-plan.
- mobs.js: `updateVillages` spawns the roster of an active village regardless of the 80-block limit; `despawn` keeps villagers/golems of an active village past `DESPAWN_DIST`, and hides mob meshes
  beyond `(viewDist + 1)` chunks. breeding.js lifts its 72-block spawn limit for active villages. When a village leaves the set its chunks unload and `onChunkUnload` removes the mobs (state saved as before).
- **Catch-up**: the last game day each village was simulated is kept (`seen`, saved as `"seen:<village key>"` in the villagers save). When a village becomes active again after more than 0.1 game day,
  young crops on farmland in its chunks mature with the chance they would have had (`1 - exp(-days * 1200 / 240)`). Meals, trade restocks and breeding already count game days.
  Not caught up: builder progress, farmer harvests, explorer trips.
- API: `update(px, pz) -> changed`, `isActive(villageKey)`, `status()`, `exportSeen(out)` / `importSeen(o)`, `reset()`, `init()`. Debug HUD (F3) shows the simulated village and kept chunk counts.

## Village sizes (village generator 2; worldgen.js, mobs.js)
- `BF.state.villages` (saved as `villages`; saves without it load as 1): 1 = classic villages (8-25 buildings, roster capped at 24, layouts byte-identical to before), 2 = sized villages (default for new worlds).
- **Population.** Each village draws `v.pop` = 2 + Gamma(k 2.5, theta 32/3), rounded, redrawn above 100 (`villagePop`, deterministic from the region, salt 530; spawn village from the spawn point, salt 540): mode 18, median 25, mean ~28.5, ~5% at 60+, 2 and 100 both possible (~1 in 5000).
- **Layout.** `villageExtent(pop)` (56..150 blocks from the centre) bounds roads and plots; the candidate centre is pulled in so the village stays inside its 384 region, and region villages keep clear of the spawn village's box. Mains scale with `sqrt(pop / 18)`, side streets every ~16 blocks (both sides once pop > ~28), cross streets (pop > ~28) and a third level (pop > ~58). Plots fill from the plaza outward until the beds (houses without beds count 1) reach `pop`; streets are then trimmed to their last building and empty ones dropped. Special-building caps scale with `round(pop / 24)`. A site that cannot hold `pop` beds returns null and the next candidate is tried (almost never happens). `v.reach` = jobsite search radius.
- **Roster.** `rec.pop` (from `v.pop`) replaces the cap of 24; every caller of `BF.mobs.roster` passes `pop`. Iron golems: `round(pop / 15)` (min 1), each patrolling around a house. Villagers whose home is over 28 blocks from the plaza wander around their home. Villagers of a sized village spawn when the player is within 24 blocks of its box. `villagesim` keeps up to 20 chunks per axis for sized villages, 640 chunks in total.
- Test: `node test/run.js /tmp/vs test/village-sizes.js` (env VS_SEEDS, VS_R, VS_GEN, VS_VG, VS_WALK).

## Village logs and villager names (js/villagelog.js, loaded after signs.js)
`BF.vlog`: every village keeps a timestamped action log (births, beds and tents placed and by whom, trades between villagers and with the player, professions gained, deaths with cause), capped at `CAP` (300) entries, oldest dropped. Entries are `[t, kind, text]` with `t` = `sky.day + sky.time`, kind `birth|bed|trade|job|death`. `mobs.js damageMob(m, amount, knockDir, byPlayer, cause)` records `m.lastHurt` for the death line. Saved in the world snapshot as `vlog` (old saves have none).
- `nameOf(m)`: a deterministic "First Last" from the world seed and the villager's persistence key (`village.key#slot.idx`), so names need no saving.
- Writers: `log(rec, kind, text)`, `trade(buyer|"player", seller, offer|text, times)`, `bed(m|null, x, y, z, what)`, `profession(m, from, to)`. Hooked in: `villagerBorn`, `villagerTrade`, `blockPlaced` (beds, tents), builder placements, builder/cartography/food/explorer villager trades, `jobs.take` (professions gained at a jobsite). Set `BF.vlog.actor = m` around a villager's own `blockPlaced` emits (explorer tents).
- F3 shows the in-game day and time (same format as the log stamps) everywhere, and the log panel (bottom left) while the player is inside a village box (+8 blocks), with the villager and bed tally from `BF.breeding`, the occupation tally (live villagers) and unclaimed job blocks (`BF.jobs.unclaimed`), and a name + profession tag over every villager within 40 blocks.
- `panelData(rec)` -> `{key, name, villagers, beds, unclaimed, occupations: [[prof, n]], free: [[prof, n]], loaded}`: the panel's numbers for the debug feed (alphabetical, children last). The F3 panel itself is unchanged.

## Second-screen debug (debug/server.js, debug/index.html, js/debugfeed.js loaded after villagelog.js)
`node debug/server.js` serves the game on 8000 and the debug screen on 8001 (`--game`, `--debug`, `--lan`, `--no-game`). `js/debugfeed.js` is always on (independent of F3, and it changes nothing in the game): it streams to port 8001 on the page's host, or to `window.BF_DEBUG_FEED` (injected by the server) or `?debugfeed=<port|url>`; `?debugfeed=off` disables it. With no server it retries every 4 s, then every 15 s. `main.js` exposes the F3 numbers as `BF.debugInfo()` (data) and `BF.debugText(info)` (the overlay text) and calls `BF.debugFeed.update()` each frame.
- Feed: every 250 ms the game POSTs (text/plain JSON) to `/push` a snapshot `{t, n, info, text, mobs: {type: n}, paused, here: panelData + {villagerList, golems, jobsites} | null, nearest}`; `layout` (roads, plaza, buildings, lamps, bounds) is added when the village changes and `log` (`{key, cap, entries}`) when the log changes. The server answers `resync` when it lacks the layout or log for the current village (it restarted), and the game sends both again.
- Server: caches the latest snapshot, layout and log, and streams them to every debug screen as Server-Sent Events (`/events`, event `snap`); `/state` returns the cache as JSON. Zero dependencies.
- Villager status lines come from `BF.villagerStatus.text(m)` when that module exists, else the villageLife / builder / explorer status texts.

## Fast-forward (js/timewarp.js, loaded right after blocks.js)
**Right arrow** steps the speed up and **Left arrow** steps it down through 1x, 3x, 5x, 10x, 100x, 1000x (they stop at the ends; F no longer does anything, and the arrows no longer strafe, A / D do) (ignored while paused, in menus, the inventory or a text box). `BF.warp` holds the speed (`BF.warp.speed`, `set(i)`, `cycle()`, `reset()`); main.js runs the sim step (`sky`, `mobs`, `drops`, `world.tickSim`) `BF.warp.speed` times per frame; `player.update` runs once per frame so the player (movement, mining, hunger, air) stays in real time at the normal dt, up to `BF.warp.BUDGET_MS` (40 ms) of sim time, so behaviour is identical at any speed. If the budget is hit the indicator also shows the achieved speed.
**`BF.simNow()`** is the simulation clock in seconds. Sim modules must use it, not `performance.now()`, for cooldowns, rescans and timers that belong to game behaviour. UI-only timers (tooltips, blink, panel refresh) and `villagesim`'s chunk-streaming throttle stay on the wall clock. Fluid spread and crop growth run from `world.tickSim()` (once per sim step) on `BF.simNow()`.
Game day = 1200 s (`BF.sky.dayLength`, was 600). Things defined per game day (emerald top-ups, restock, eating, breeding, job memory, weather spells, crop growth 1/5 day, explorer day budget `DAY_S`) are scaled with it; per-second behaviour (walking speed, hunger, fluids) is not. Up to 10x a frame runs `speed` steps of the normal dt. From 100x the step grows to at most 0.05 s of game time (the step a slow frame already gets): `BF.warp.plan(dt)` gives `{n, h}`, n is capped at 1000 steps per frame, and the sim runs up to the 40 ms budget per frame and terrain meshing drops to 3 ms; the indicator shows the achieved speed when it can't keep up.
Boost flight (player.js): while flying, press E with W held (E down after W) to fly at 10x the normal flying speed (`TURBO_MULT`, base = non-sprint fly speed); releasing W or E ends it. That E press is consumed by the boost and does not open the inventory; E in any other situation (not flying, W not held, or E pressed before W) still opens/closes it. If the chunk 3 chunks ahead isn't generated yet the speed drops to a fast sprint (`BF.player.turbo` still drives the wider terrain streaming budget). Replaces the triple-tap-W turbo.

## Iron golems: rescue, damage and cracks (mobs.js)
- Rescue: a villager is under attack when a mob hit it in the last 6 s (`v.attacker`, `v.attackedAt`) or a zombie hunting it is within 6 blocks. Golems within `RESCUE_RANGE` (64) go for the attacker at `RESCUE_SPEED` (6 blocks/s; normal walk 1.4), only for their own village's villagers when they have one. Priority: rescue, then whatever hurt the golem (`ai.revenge`, 32 blocks), then the nearest hostile within 16.
- Hostiles fight back (`golemFight`): a hostile a golem hit targets it for 12 s (`ai.golemFoe`, `ai.golemFoeT`), even over the player; zombies, spiders (not when calm in daylight) and skeletons not chasing the player pick a golem within 10 blocks. Creepers ignore golems. Damage to golems: `GOLEM_HITS` = zombie 4, spider 3, skeleton arrow 3-5 (arrows carry a `victim` mob they can hit). Golem health 100.
- Cracks: below 75% / 50% / 25% health the golem's part geometries swap to crack stage 1 / 2 / 3 (`m.crackLevel`; cached per stage via `typeParts("iron_golem", "1".."3")`). Each stage only adds cracks.
- A golem drops its iron ingots whatever kills it. Test: `node test/run.js /tmp/golem test/golem-actions.js`.
## Sheep and shepherds (js/shepherd.js, loaded after breeding.js)
`BF.shepherd`. Every sheep mob carries `m.sheep = {fed, shorn, woolAt, growAt, cd, x, z, mob}` (game days are absolute: `BF.sky.day + BF.sky.time`).
- **Feeding / breeding.** 1 wheat (`wheat_item`) from the player (right click, player.js `secondaryDown`) or a shepherd sets `fed`; a sheep is *willing* while `now - fed < 1` day
  (`BF.shepherd.willing/hungry`). A hungry sheep refuses more wheat ("The sheep isn't hungry"). Two willing adults of the same pen (or both wild) within 10 blocks walk to each other (`sheepAI`, called from `updateMob`) and a lamb appears when they
  are 1.8 blocks apart; both rest 1 day (`cd`). Lambs (`m.lamb`, `growAt`) are scaled 0.55, drop nothing, cannot be fed to breed or sheared and are adult after 1 day; wheat ages one by 10%.
  No breeding while 30 sheep are within 16 blocks. Events: `sheepFed(m, by)`, `sheepBorn(lamb, a, b)`, `sheepShorn(m, by)`.
- **Shears** (item `shears`, `tool.type "shears"`, appended to the item list; recipe: 3 iron ingots, shapeless). Right click a woolly adult: 1-3 `white_wool` drop, `shorn = true`, the model swaps to the shorn one
  (`BF.mobs.setSheepLook`; mobs.js `typeParts("sheep", "shorn")`). The wool regrows after 7 days +-30% (sum of two uniforms), per sheep. Shears also break leaves 4x faster (`block.tool == "shears"`).
  Killed shorn sheep drop no wool (mobs.js `giveDrops`).
- **Pens.** worldgen (`layoutVillage`, gen 3+) makes sure a village has a fenced `pen` building for every shepherd job its jobs plan holds (`BF.jobs.shepherdCount`), adding pens after the normal layout so no other plot moves;
  `v.nb0` is the building count of the original layout and is what the villager roster uses, so the extra pens never change who lives there. `jobs.planVillage` puts a shepherd's loom beside a pen (outside the fence, gen 3+).
  `BF.shepherd.pensOf(rec)` returns `{key, idx, rec, b, x0..z1 (sheep room, block edges), fx0..fz1 (fence footprint), cells, threshold, sheep: [state]}`. The sheep room is the interior without the back row (hay and trough).
  Pens are stocked while their village is loaded or simulated: a new pen starts with 2-4 sheep; the state list outlives the mobs (despawned sheep come back with their state); penned sheep (`m.pen`, `m.penVillage`) are
  kept inside the room by `pickPenTarget` / `contain` (mobs.js `pickWander`, `updateMob`) and count as village stock (not wildlife) in `countMobs`. A sheep that wanders into a pen joins it; one that gets 2.5 blocks out leaves it.
  Saved under `"pens:<village key>"` in `exportVillagers` (`[{i: building index, s: [[fed, woolAt|null, growAt|null, cd, x, z], ...]}]`); old saves have none (pens just start with new sheep).
- **Shepherd AI** (`BF.shepherd.ai`, called from `villagerAI` after the farmer/builder hooks; daytime only, before sky time 0.5). It tends its pen (the one whose fence is within 4.5 blocks of its loom), plus loose sheep within 12 blocks;
  with no pen it tends the sheep within 10 blocks of its loom. Order of work: feed every hungry adult (needs wheat), shear every woolly adult (needs shears), cull. Tasks walk with `BF.villageLife.travel`. It keeps wool and meat in its inventory.
  New shepherds get shears and 8 wheat (`ensureKit`, once, only when the inventory has no shears).
- **Overcrowding.** Pen threshold = `ceil(room cells / 6)` (6 for the standard 7x5 room): the pen is full once it holds that many sheep (lambs count). While full the shepherd kills adults (the nearest shorn one first, else the nearest, never below 2 adults) until the count is below the threshold, keeping 1-2 raw mutton (+1 wool if the sheep still wore it). It never kills while the pen has room. Without a pen the threshold is 8 sheep within 10 blocks.
- **Wheat.** `wheatWanted(m)`: under max(4, 2 per adult) wheat the shepherd wants to top up to ~5 days. villagelife.js `shopAI` buys it at the fair price (`VALUE.wheat_item`: 12 wheat per emerald) from the nearest villager
  with spare wheat, farmers first (`findWheatSeller`, `doWheatDeal`; status "Buying wheat"). Farmers bake only wheat above `WHEAT_SPARE` (24) and sell down to `WHEAT_SELF` (4).
- **Mutton.** Shepherds cook their raw mutton daily like butchers (`cookDaily`, 8 a day) and sell it to hungry villagers through the normal food market (`findFoodSeller`), and to the player (shepherd L3: 1 emerald > 9 cooked_mutton).
  Wool: the shepherd keeps what it shears and offers it as `1 emerald > 8 white_wool` from level 1, so any villager's trade logic (e.g. the furniture maker) can buy it.
- **Pen gates** (gen 3+): the pen's front gap holds an `oak_fence_gate_<x|z>` (blocks.js `gateDefs`, appended after the tents; 4 states, axis x/z, open/closed;
  item `oak_fence_gate`, 2 rows of stick-plank-stick). `BF.gateId(axis, open)`, `BF.world.setGate(x, y, z, open?)`; the player toggles it with right click.
  Villager paths treat a gate like a door (mobs.js `walkCell`, `villagerDoors` opens it ahead and shuts it behind). A shepherd with no task inside a pen
  walks out through the gate to the path outside (`leave`). Fences connect to gates in line with them.
- **Looms and sheep**: only a pen with a shepherd's loom on its outside ring (`hasLoom(pen)`, from `BF.jobs.planFor`) is stocked with sheep; spare pens stay empty.
- Tests: `test/shepherd-check.js`, `test/shepherd-day.js`, `test/shepherd-misc.js` (`NODE_PATH=$(npm root -g) node test/run.js /tmp/x test/shepherd-day.js`).

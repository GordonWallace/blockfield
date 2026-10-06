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

- `BF.CS = 16`, `BF.H = 128`, `BF.SEA = 48` (water fills y <= SEA where terrain is lower).
- `BF.vIdx(x, y, z)` -> index into a chunk's `Uint16Array` voxel array, local coords, `(y*CS + z)*CS + x`.
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
- Colour (names `<colour>_<family>`): `wool` (existing `wool` and `white_wool` kept; 15 new), `terracotta` (existing plain + orange/yellow/white/brown/red kept; 11 new),
  `_concrete`, `_concrete_powder`, `_stained_glass`, `_glazed_terracotta` (16 each), `tinted_glass`. Block fields: `translucent: true` (stained/tinted glass) sends the
  faces into the blended pass (liquidMat, alpha from the tile) instead of the alpha-tested one; `hardensTo: "<colour>_concrete"` on powder.
- `BF.hardenPowder(x, y, z, id)` (blocks.js): turns powder into concrete when water is on a side or above; world.js `fluidTick` calls it for every queued cell
  (placing powder or water queues its neighbours), so no extra tick exists. Powder does not fall (no falling-block entity in the game).
- Dyes: `red_dye` (poppy, beetroot), `yellow_dye` (dandelion), `blue_dye` (cornflower), `white_dye` (`bone_meal` = 3 per bone), `green_dye` (smelt cactus), `brown_dye`
  (brown mushroom), `black_dye` (charcoal or coal); vanilla mixes (2 dyes -> 2) for orange, pink, light_blue, purple, lime, cyan, gray, light_gray, magenta.
  Dyeing: dye + 8 wool / terracotta / concrete powder / glass-or-stained-glass in a ring -> 8 coloured (any colour of the family, `BF.inventory.recipes`),
  dye + 1 wool (any) -> that wool, dye + 4 sand + 4 gravel -> 8 concrete powder, coloured terracotta smelts to glazed terracotta, 4 black dye around glass -> tinted glass.
  The bed recipe accepts any wool. Villagers/sheep still only deal in `wool` / `white_wool`.
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
- Clouds are volumetric slabs ("fancy" clouds): `CLOUD_Y = 116` (slab bottom; terrain is hard-capped at H-10 = 118, so only the rare
  tallest peaks, about 0.4% of columns >= 116, poke in), `CLOUD_H = 5`, cell 12x12, periodic 64x64 deterministic cell mask,
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
- Data: every chunk gets `chunk.light = Uint8Array(CS*CS*H)`, same index as `chunk.vox` (`BF.vIdx`). Emitters: block def field `emit` (0..15), table `BF.EMIT[id]`
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
  `rec.nb` (= worldgen `v.buildings.length`) >= 6 gives 1 builder, >= 19 gives 2; builders count toward `VILLAGERS_PER_VILLAGE` (24: the roster is cut to `24 - builders` BEFORE the appended slots, which can only
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
  (cloud height 118 -> surface, jagged, up to 3 branches, 0.32 s flicker), flash, `lightning` event (audio.js plays thunder). 5 damage to the player/mobs within 2.5 blocks; no fire.
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
  experienced villagers (xp > 0) only take blocks of their own profession; nitwits never; instant: used by commands / tests, villagers themselves walk to the block, see "Walking to a jobsite";
  `claim(mob, {site})` takes that exact block if it is still free; sets `mob.profession`, `mob.jobsite = {x,y,z}`, rebuilds the outfit and the offers; first job ever adds the profession's
  starting wares without emeralds; emits `villagerHired(mob, prof)`), `release(mob, {keepProfession}?)` (frees the block; a villager with xp 0 becomes `unemployed`, emits nothing; `villagerFired(mob)` is emitted
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
- **Save**: `trades.pack` adds `prof`, `job: [x,y,z] | null`, `st` (first-job stock given) to each villager entry; `mobs.importVillagers` -> `jobs.importAll` rebuilds the claim table. Newborns (`#2000+k`) use the same fields.

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
  `MAX_TOTAL` 40 villagers (a safety cap; the roster cap of 24 does NOT apply to newborns, the bed rule is the limiter).
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

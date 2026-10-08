# Vanilla block gap analysis

Snapshot: Blockfield has about 90 distinct blocks (119 ids; 24 of those are per-state ids for doors and beds, 7 are flowing-water levels, 5 are young crops). Vanilla Java Edition has roughly 1,000 block types. Everything below is "vanilla but missing". Names follow vanilla texture/block names so a texture pack can map onto them later.

## What we have
Terrain: grass, dirt, coarse_dirt, podzol, mycelium, mud, dirt_path, farmland, stone, cobblestone, mossy_cobblestone, gravel, sand, red_sand, sandstone, sandstone_bricks (not vanilla), clay, snow, ice, packed_ice, calcite, moss_block, bedrock, water.
Ores: coal, iron, gold, diamond.
Wood (logs and leaves only): oak, birch, spruce, jungle, dark_oak, cherry, acacia, mangrove; planks only for oak, spruce, acacia.
Colour: wool, white_wool, terracotta plus 5 colours (orange, yellow, white, brown, red).
Plants: short_grass, fern, dead_bush, poppy, dandelion, cornflower, mushrooms (+ giant mushroom blocks), sugar_cane, cactus, pumpkin, wheat, carrots, potatoes, beetroots, hay_bale.
Functional: crafting_table, furnace, chest, door, bed, fence, lantern, bell, glass, bricks.

## Gap, by tier

### Tier 1: full-cube and simple blocks (no new rendering needed, start here)
- Stone family: granite, diorite, andesite, polished_granite/diorite/andesite, stone_bricks, mossy_stone_bricks, cracked_stone_bricks, chiseled_stone_bricks, smooth_stone, deepslate, cobbled_deepslate, polished_deepslate, deepslate_bricks, deepslate_tiles, tuff, dripstone_block, obsidian, cut_sandstone, chiseled_sandstone, smooth_sandstone, red_sandstone family, mud_bricks, packed_mud, prismarine family, blackstone/basalt (Nether).
- Ores and mineral blocks: lapis_ore, redstone_ore, emerald_ore, copper_ore, and deepslate variants of each ore; iron_block, gold_block, diamond_block, emerald_block, lapis_block, redstone_block, coal_block, copper_block (and oxidised stages), raw_iron/gold/copper_block, amethyst_block.
- Wood families: planks for birch, jungle, dark_oak, cherry, mangrove (and bamboo); stripped logs for every species; "wood" (bark on all sides) and stripped_wood.
- Colour families: wool (16), terracotta (the other 10 colours), glazed terracotta (16), concrete (16), concrete_powder (16, falls), stained_glass (16), tinted_glass.
- Misc cubes: bookshelf, tnt (decor), sponge, wet_sponge, melon, glowstone, sea_lantern, magma_block, blue_ice, snow_block, bone_block, slime_block, honey_block, honeycomb_block, shroomlight, soul_sand, netherrack, nether_bricks, quartz_block family, end_stone, purpur, note_block, jukebox.

### Tier 2: shaped or stateful blocks (needs per-state ids and new models)
- Slabs and stairs for every material (stone, cobble, bricks, planks of each wood, sandstone, quartz, and so on). This is the biggest visual gap for builders and the reason the id space had to grow.
- Walls, trapdoors, iron_door, iron_bars, glass_pane (and 16 stained panes), ladder, carpets (16 colours), snow layers, torches (needs block light), soul_torch, chains, buttons, pressure_plates, levers, signs, flower_pot, rails, scaffolding, cobweb.

### Tier 3: job-site and utility blocks (tie into villager professions)
- lectern (librarian), barrel (fisherman), smoker (butcher), blast_furnace (armorer), cartography_table, fletching_table, grindstone (weaponsmith), smithing_table, stonecutter (mason), loom (shepherd), composter (farmer), brewing_stand (cleric), cauldron (leatherworker), anvil, enchanting_table, ender_chest, hopper, dispenser, dropper.

### Tier 4: nature and plants
- Saplings for each tree, azalea and flowering_azalea, bamboo, vines, lily_pad, kelp, seagrass, coral (many types), cocoa, sweet_berry_bush, melon_stem and pumpkin_stem, carved_pumpkin, jack_o_lantern, tall plants (tall_grass, large_fern, sunflower, lilac, rose_bush, peony), more flowers (azure_bluet, allium, orchid, tulips, oxeye_daisy, lily_of_the_valley), glow_lichen, moss_carpet, spore_blossom, hanging_roots, big_dripleaf, pointed_dripstone, amethyst_cluster, sculk family, powder_snow, lava.

### Tier 5: Nether, End and redstone
- Nether and End terrain and the whole redstone system (wire, repeater, comparator, piston, observer, rails, TNT as live explosive). These need whole new subsystems (dimensions, logic ticks), so they are out of scope until the overworld set is complete.

## Constraint that shaped the plan
Voxels were Uint8, so only 255 block ids existed and 119 were used. The id space is being raised to 4095 first (see CONTRACT.md "id space"), then Tier 1 is added in parallel batches, then Tier 2 (slabs, stairs, panes, ladders, torches).

## Tier 1 progress (stone / ore / mineral pack)
Implemented (80 blocks, 8 items; see CONTRACT.md "Stone / ore / mineral pack"):
- Stone family: granite, diorite, andesite and their polished forms; stone_bricks, mossy/cracked/chiseled stone bricks; smooth_stone; deepslate, cobbled_deepslate, polished_deepslate, deepslate_bricks, deepslate_tiles; tuff; dripstone_block; obsidian; cut/chiseled/smooth sandstone and the red_sandstone family; mud_bricks, packed_mud; prismarine, prismarine_bricks, dark_prismarine, sea_lantern; blackstone, polished_blackstone, basalt, smooth_basalt; netherrack, nether_bricks, soul_sand, glowstone, magma_block; quartz_block, chiseled_quartz_block, quartz_pillar, quartz_bricks, smooth_quartz; end_stone, purpur_block, purpur_pillar; bone_block; blue_ice; sponge, wet_sponge; melon; tnt (decor); bookshelf.
- Ores: lapis, redstone, emerald, copper and the deepslate variants of every ore (8). Mineral blocks: iron, gold, diamond, emerald, lapis, redstone, coal, copper, raw_iron, raw_gold, raw_copper, amethyst. Items: lapis_lazuli, redstone, raw_iron, raw_gold, raw_copper, copper_ingot, amethyst_shard, quartz.
- Worldgen: deepslate layer, ore veins and stone blobs; pickaxe tiers (`minTier`) enforced when harvesting.
- Recipes: storage blocks both ways, polished/brick/cut variants, chiseled and pillar blocks, mossy bricks, tnt, bookshelf, blue ice, packed mud; smelting for smooth stone/sandstone/quartz/basalt, deepslate, cracked bricks, wet sponge and the copper/lapis/redstone/emerald ores.
Still missing from Tier 1: oxidised copper stages, cut_copper, snow_block (the existing `snow` is the full block), prismarine/purpur/nether-brick crafting (no shards, chorus or nether brick items), red_nether_bricks, gilded_blackstone, cracked/chipped variants beyond stone bricks, terracotta/concrete/wool/planks families (separate pack), and live TNT (Tier 5).

## Tier 1 progress (wood / colour pack)
Implemented (127 blocks, 17 items; see CONTRACT.md "Wood and colour families"):
- Wood families for all 8 species: planks (birch, jungle, dark_oak, mangrove, cherry added), stripped logs, wood and stripped wood (32 blocks, 8 each), plus fences for the 7 species without one. Every log/wood/stripped variant makes 4 planks of its own species, burns, makes charcoal; axes strip logs and woods on right click.
- Colour families, all 16 vanilla colours: wool (15 new), terracotta (11 new), concrete, concrete powder (turns to concrete next to water, does not fall), stained glass (translucent), glazed terracotta (symmetric pattern per colour), tinted_glass.
- Dyes: 16 `<colour>_dye` plus `bone_meal`; sources (poppy, beetroot, dandelion, cornflower, bone, cactus smelting, brown mushroom, charcoal/coal), vanilla mixing, ring dyeing of wool/terracotta/concrete powder/glass, dye + wool, concrete powder recipe, glazed terracotta smelting.
- Creative tab "Colored Blocks"; one shared painter hook (`BF.texKit`) and recipe hook (`BF.recipeHooks`).
Still missing from Tier 1: bamboo planks/mosaic, falling concrete powder, carpets/panes/slabs/stairs/doors/gates for the new materials (Tier 2), coloured sheep and dyeing sheep, coloured beds, per-biome village planks, villager trades for coloured wool, leaf drops (saplings, apples, sticks) are unchanged.

## Tier 2 progress (slabs and stairs)
Implemented (410 blocks, see CONTRACT.md "Slabs and stairs"): slabs (bottom/top, merge to the full block) and straight stairs (4 facings x 2 halves) for 41 materials (all planks, cobble, stone, bricks, granite/diorite/andesite, sandstones, quartz, deepslate, blackstone, prismarine, purpur, nether bricks, mud bricks, terracotta), vanilla crafting and wood fuel.
Still missing: inner/outer corner stairs, walls, trapdoors, panes, ladders, carpets, etc.; slabs/stairs for copper, moss, concrete, wool and other blocks.

## Tier 2 progress (panes / bars / ladders)
Implemented (22 blocks, 1 item; see CONTRACT.md "Panes, bars, ladders"): glass_pane, 16 stained glass panes (translucent), iron_bars, ladder (4 facings, climbable, pops off). Recipes for all of them.
Still missing: pane/bars/ladder use in worldgen and villager trades, waterlogging, precise (thin) selection outlines, other bars materials (copper), chains, mobs climbing ladders.

## Tier 2 progress (torches / block light)
Implemented (see CONTRACT.md "Block light"): block light 0..15 with BFS flood fill, incremental removal/add on edits, cross-chunk propagation, per-vertex smooth block light with warm tint and ambient floor; `emit` on blocks (torch 14, lantern 15, glowstone 15, sea_lantern 15, magma_block 3);
`torch` + 4 wall torch states (pop off without support, coal/charcoal + stick recipe); hostile spawns need block light <= 7.
Still missing: soul_torch, redstone_torch, campfire, jack_o_lantern, shroomlight, end_rod, candles (no emitters yet besides the list above), flame particles, light level shown for item frames etc., sky light as a real flood fill (still the column model), village torches at doors.

## Tier 3 progress (jobsite blocks)
Implemented (14 blocks; see CONTRACT.md "Jobsites"): composter, lectern, brewing_stand, blast_furnace, grindstone, smithing_table, smoker, barrel, loom, fletching_table, stonecutter, cauldron, cartography_table, plus drafting_table (builder; not vanilla). Box models for lectern, brewing stand, grindstone, stonecutter, cauldron; vanilla recipes (brewing stand: gold ingot for the blaze rod); generated in villages and claimed by villagers (js/jobs.js).
Still missing: facing (fronts always look south), the blocks' own functions (composting, lectern books, brewing, smelting in smoker/blast furnace, grinding, smithing upgrades, stonecutting, cauldron water, maps, banners), anvil, enchanting_table, ender_chest, hopper, dispenser, dropper.

## Tier 2 progress (signs)
Implemented (64 blocks, 8 items; see CONTRACT.md "Signs"): standing and wall signs for all 8 woods (4 facings), merging into boards up to 4x4 with seamless rendering, editable text (4 lines x 15 chars per sign, scaled by board size), crafting, village entry arches with an auto-updating "Village of <name>" sign.
Still missing: 16 standing rotations, hanging signs, back-side text, dyed / glowing text, bamboo signs.

---
title: Sandbox worlds
category: World generation
---
A sandbox world is the usual round [[page:the-planet]] with its ground replaced by an empty grass plain. Nothing spawns by itself, there are no villages, trees, water or caves, and nothing gets in the way of building, summoning and trying things out. It is meant for testing: a quick place to look at a new tree, a building or a block, and the home of the scene files, the structure designer and the texture studio.

## Starting one

- **New World screen:** under *World type* pick **Sandbox**. There is no seed or biome size to choose; the game mode starts at creative. The **Scene** list offers the scenes in `sandbox/scenes/` to place at spawn (or none for the bare plain).
- **From the address:** `localhost:8000/#sandbox` starts a fresh sandbox world, saves it and drops you in, and `localhost:8000/#sandbox=<name>` does the same with the scene `<name>` placed at spawn. Every load of such an address makes a new world.

A sandbox world saves and loads like any other, and the world list shows **Sandbox** in place of its biome size.

## The plain

- The planet is the same size and shape (round at altitude, the same faces, latitude and longitude); only the ground changes.
- Every column is bedrock at the bottom (y -64), stone up to y 0, three blocks of dirt and grass on top at **y 4**, and air above. One biome, Plains, with one grass colour, everywhere.
- No villages, trees, plants, caves, ores, water or rivers. The rivers and lakes are never worked out, so a sandbox world starts at once.
- You start at the centre of face 4, about 80 km from every edge.
- Day and night and the weather run as usual.
- **Nothing spawns:** no wild animals, no monsters, no iron golems. `/summon` and scenes still make mobs. Caravans and explorers have no villages to look for and stay idle; `/locate village` says there are none.

## Sandbox blocks

Sixteen blocks, **Sandbox Block 1** to **Sandbox Block 16**, are kept for testing textures: plain full cubes with a numbered, coloured placeholder face. They are in the creative inventory (Building blocks; search "sandbox") in every world, but no recipe makes them and breaking one drops nothing, so survival never gets one.

## Scenes

A scene is a file `sandbox/scenes/<name>.json` in the game's folder that says what to put round the spawn: trees, buildings, mobs, blocks, commands and where the player stands. A thread or a player who wants a ready-made test world writes one and opens `#sandbox=<name>`.

- `/scene <name>`: places the scene round you (sandbox worlds only).
- `/scene list`: lists the scenes.
- `/scene clear [radius]`: puts the plain back within the radius (48 by default, up to 128) and removes the mobs there.

Placing a scene twice stacks it on what is there; nothing is cleared first. Scenes refuse to run in a normal world.

Three scenes come with the game: `empty` (the plain, day, creative), `trees` (one of each tree the world generator grows, in a row north of spawn) and `animals` (a fenced field of cows, pigs, sheep and chickens with a farmer).

### Writing a scene

The file is `{ "description": "...", "entries": [ ... ] }`. Each entry names its kind by one key and has an offset `"at": [dx, dy, dz]` from the spawn (or from you, for `/scene`): x is east, z is south, and dy 0 is the first block above the grass. Some take a `"facing"` (`north`, `east`, `south` or `west`).

- `{ "tree": "oak", "at": [0, 0, -10], "size": 5 }`: a tree drawn by the world generator's own code, so a changed tree shows as it now grows. Kinds: oak, oak_nest, birch, birch_nest, swamp_oak, jungle_oak, spruce, mega_spruce, jungle, jungle_big, acacia, dark_oak, cherry, mangrove, giant_mushroom, ice_spike, cactus, boulder. `size` is the height; `"red": false` gives a brown giant mushroom.
- `{ "structure": "house", "at": [12, 0, 0], "facing": "west", "style": 0 }`: a builder's blueprint by type (house, lhouse, smith, well and the rest), or a design saved by the structure designer, centred on the spot with its door to the facing.
- `{ "mob": "cow", "at": [5, 0, 5], "count": 3 }`: mobs as `/summon` makes them; `"profession": "farmer"` for a villager, `"child": true` for a child.
- `{ "fill": "stone", "at": [-3, 0, -3], "to": [3, 2, 3] }`: a box of one block.
- `{ "block": "planks", "at": [0, 0, 3] }`: one block.
- `{ "commands": ["/time set day", "/weather clear"] }`: commands, run in order after everything is placed.
- `{ "player": { "at": [0, 0, 4], "gameMode": "creative", "inventory": [["oak_log", 64]] } }`: where you stand, your game mode and items.

A bad entry (an unknown kind, block, tree or mob, or one out of the world) is skipped and named in the [[page:game-log]] as an ERROR; the rest of the scene still places. A scene that doesn't exist shows a message and an ERROR line.

The whole scene goes to the simulation as one batch, so it places the same way whether the simulation runs in the page, a worker or the [[page:world-server]].

## Game log

INFO lines (`sandbox`) when a scene is placed (where, how many blocks, mobs and commands) or the plain is cleared, and when a sandbox world is started from the address. ERROR lines for each skipped scene entry, a scene that isn't there, and a scene tried outside a sandbox world.

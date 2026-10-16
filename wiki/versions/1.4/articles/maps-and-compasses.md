---
title: Maps and compasses
category: Game rules
---
Maps record the land you have walked across, and a compass points you home. Both are crafted, and cartographers in villages make and sell them (see [[villager:cartographer]]).

## Compass

A [[item:compass]] shows a small dial when held, with a red needle that points at the **world spawn**, relative to the way you are looking. Setting a bed does not move it: the needle still points to where the world began. It is crafted from four iron ingots around a gold ingot.

## Maps

A map covers a square of the world and fills in as you move across it.

1. Craft a blank map from eight paper around a compass.
2. Right click with it to bind it. It becomes a filled map of the **zone** you are standing in. The world is divided into zones of 8 by 8 chunks (128 by 128 blocks), and a map is centred on its zone, so using a blank map anywhere in a zone gives the same map.
3. Hold the filled map while you walk. Only the land near you is drawn, as it is loaded: the map fills in around you, not from afar. Unexplored land stays blank parchment.

A white arrow shows where you are and which way you face. If you are outside the map, a smaller grey arrow clamps to the edge and still shows your heading.

### Sizes

Surround any map, blank or used, with eight paper in the crafting table to make the next size. A used map keeps what it showed. The sizes double in width each time:

| Size | Width covered | Blocks per pixel |
|---|---|---|
| 1 | 128 blocks | 1 |
| 2 | 256 blocks | 2 |
| 3 | 512 blocks | 4 |
| 4 | 1024 blocks | 8 |
| 5 | 2048 blocks | 16 |

Every map is 128 by 128 pixels, so larger maps are coarser. They also reveal their land around you more slowly per block walked: roughly 40 blocks around you on size 1 down to 16 blocks on sizes 4 and 5.

All copies of a map of one size and zone share the same explored picture, and the pictures are saved with the world, so if you lose a map you can craft another and the explored land is still there.

### Full-screen view

Right click a filled map to open it full screen. It shows a grid of zones, your arrow, and the coordinates of the spot under the mouse (on the planet its face, u and v). Click a point to select it. In **creative mode** only, a Teleport button then takes you to the selected point. Esc or Close shuts the view. On the planet a Planet button switches to the planet view.

### Planet view

On the planet, press M (or the Planet button in a map's full-screen view) to see the whole globe, coloured like the auto-fill maps, with lines every 30 degrees of latitude and a red dot where you are. Drag to turn it and scroll to zoom; when you hold still it sharpens. The spot under the mouse shows its latitude and longitude, face, u and v, and biome. In **creative mode** a click travels there, onto the surface; in survival a click only marks the spot. Find me turns the globe back to you.

Scroll in as far as it goes, then once more, and the view becomes a local auto-fill map 8,192 blocks wide around the middle of the globe; scroll out of that map to return to the globe. M or Esc closes the view.

## Auto-fill maps (creative only)

The creative menu has an **auto-fill map**. Right click it to choose a width in blocks (2048 is suggested; it is rounded to whole zones). It becomes a map of that width centred on your zone, drawn from the world itself rather than by walking: it fills in by itself over a short while, coarse first and then finer. It also shows biomes and heights under the cursor. Nothing is saved: the picture is rebuilt from the world's seed whenever you hold it. Rivers are drawn only on maps up to about 16 blocks per pixel. On the planet a map is drawn on the face it is centred on, with the neighbouring faces laid out flat around it, and is at most one face (163,840 blocks) wide; the gaps past the corners, where no face lies flat, stay blank. A toggle in the full-screen view switches the colours between ground colours and biome colours.

## Cartographers and explorers

A [[villager:cartographer]] crafts compasses and maps from iron, gold and paper, buying what it lacks from other villagers. [[villager:explorer]] villagers walk out across the land carrying maps and fill them in as they go.

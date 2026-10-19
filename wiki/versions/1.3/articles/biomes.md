---
title: Biomes
category: World generation
---
Blockfield has 29 biomes. Most are decided by two climate maps, temperature and humidity; the rest depend on the shape of the land (coasts, swamps, mountains and rivers). Which wild animals live in each is shown on the mob pages.

## How land biomes are chosen

Temperature and humidity are each cut into five bands. Each band covers a share of the world (about 16, 22, 27, 19 and 16 percent from the coldest to the hottest). The table shows the biome for each pair. On the high plains the air is a little drier, so results shift slightly toward the dry side.

| Temperature | Driest | Dry | Middle | Humid | Wettest |
|---|---|---|---|---|---|
| Frozen | Snowy Plains | Snowy Plains | Snowy Taiga | Snowy Taiga | Snowy Taiga |
| Cold | Taiga | Taiga | Taiga | Taiga | Old Growth Taiga |
| Temperate | Plains | Plains | Forest | Birch Forest | Dark Forest |
| Warm | Savanna | Plains | Forest | Sparse Jungle | Jungle |
| Hot | Desert | Desert | Savanna | Sparse Jungle | Jungle |

Exceptions: frozen dry country becomes Ice Spikes where the terrain is "weird", temperate Forest becomes Flower Forest in the same weird areas, and hot, dry weird country becomes Badlands. Low, wet, mild lowlands become Swamp, or Mangrove Swamp if they are warm.

## Land biomes

Plant words: *plentiful* is more than about a quarter of the ground, *common* about a tenth to a quarter, *scattered* a few percent. "Cells" are 4x4-block squares, each of which may hold one tree.

| Biome | Surface | Trees | Ground plants | Village |
|---|---|---|---|---|
| Plains | [[item:grass]] | Sparse [[item:oak_log|oak]] (3% of cells), a few with bee nests | Short grass plentiful, scattered flowers | Yes, plains style |
| Forest | grass | Dense, 70% oak and 30% birch (60%) | Grass common, rare ferns, flowers, mushrooms | No |
| Flower Forest | grass | Moderate oak and birch (35%) | Flowers very common, grass common | No |
| Birch Forest | grass | Dense, 85% [[item:birch_log|birch]] and 15% oak (65%) | Grass common | No |
| Dark Forest | grass with [[item:podzol]] patches | Very dense (92%): dark oak, some oak, 7% giant mushrooms | Mushrooms common, grass scattered | No |
| Swamp | grass, with [[item:clay]] or dirt under the water | Moderate wide-crowned oaks (30%) | Grass common, mushrooms and ferns scattered | No |
| Mangrove Swamp | [[item:mud]] | Dense mangrove trees with prop roots (60%) | Little | No |
| Desert | [[item:sand]] over [[item:sandstone]] | None; [[item:cactus]] in 14% of cells | Dead bushes scattered | Yes, desert style |
| Badlands | [[item:red_sand]] over bands of coloured [[item:terracotta]] | Cactus in 3% of cells | Dead bushes scattered | No |
| Savanna | grass with [[item:coarse_dirt]] patches | Sparse acacia (8%) | Grass plentiful | Yes, savanna style |
| Sparse Jungle | grass | Moderate jungle and oak trees (28%) | Grass and ferns common, melon patches | No |
| Jungle | grass | Dense (92%): huge 2x2 jungle trees, medium and small ones, leafy bushes | Ferns and grass common, melon patches | No |
| Taiga | grass with podzol patches | Moderate spruce (50%) | Ferns and grass scattered | Yes, taiga style |
| Old Growth Taiga | podzol, coarse dirt and grass | Giant 2x2 spruce (45% of trees) and spruce, plus mossy boulders | Ferns common, mushrooms scattered | No |
| Snowy Plains | [[item:snow_grass]] | Very sparse spruce (2.5%) | None | Yes, snowy style |
| Ice Spikes | [[item:snow]] (snow block) | None; spikes of [[item:packed_ice]] | None | No |
| Snowy Taiga | snowy grass block | Moderate spruce (50%) | Few ferns | No |
| Meadow | grass | Almost none (birch) | Grass plentiful, flowers very common | Yes, plains style |
| Cherry Grove | grass | Moderate cherry trees (22%) | Grass plentiful, few flowers | No |

Meadows and cherry groves occur on the foothills of mountain massifs rather than on open plains. Trees are not placed on cave entrances, shores or inside villages. See [[page:trees-and-plants]] for how trees, flowers and patches work.

## Coasts, water and fungi

| Biome | What it is |
|---|---|
| Ocean | Water over a sand floor with clay patches. Floors deeper than about 5 blocks below the surface are sand in warm seas and gravel in cold ones. Ocean is called Frozen, Cold, Lukewarm or Warm by climate (none for temperate), and Deep when the floor is below y -30. Frozen oceans have ice near shore and broken floes further out. |
| Beach | Sand over sandstone along ordinary coasts. |
| Snowy Beach | The frozen-climate beach: sand, with snowy grass above the waterline. |
| Stony Shore | Stone and gravel patches, on rugged coasts. |
| River | A channel cut into the land with a bed of sand, clay and gravel; Frozen River in the frozen band (rivers also ice over in the cold band). See [[page:rivers]]. |
| Mushroom Fields | Low islands far out at sea. Surface [[item:mycelium]], giant red and brown mushrooms, mushrooms on the ground. |

## Mountain biomes

These replace the plains on massifs by altitude; see [[page:terrain]].

| Biome | Surface and plants |
|---|---|
| Windswept Hills | Grass on gentle ground, stone on steep ground; scattered spruce and some ground plants. Temperate climates, between about y 1350 and 1750. |
| Snowy Slopes | Snowy grass block, snow blocks above about y 1450 and bare stone on cliffs. Frozen and cold climates, y 1350 to 1750. |
| Jagged Peaks | Snow blocks above about y 1800, patches of packed ice, stone on steep ground. Above y 1750 in frozen, cold or temperate climates. |
| Stony Peaks | Stone, with [[item:calcite]] streaks; never snow-covered. Warm and hot climates above y 1350. |

## Weather by biome

Weather is explained on [[page:time-and-weather]]; each biome has one kind of precipitation:

- **Dry (no rain or snow):** Desert, Badlands and Savanna.
- **Snow:** Snowy Beach, Snowy Plains, Ice Spikes, Snowy Taiga, Snowy Slopes and Jagged Peaks, and anywhere in the frozen temperature band.
- **Rain:** everything else. In the cold band it turns to snow above y 1400, and in the temperate band above y 1700.

## Villages

Villages generate only in Plains, Savanna, Desert, Snowy Plains, Taiga and Meadow. Each biome gives a different building style; see [[page:villages]].

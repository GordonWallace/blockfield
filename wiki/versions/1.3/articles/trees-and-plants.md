---
title: Trees and plants
category: World generation
---
Trees and ground plants are placed by biome. Trees go on a loose grid of 4x4-block cells; each cell may hold one tree, with the chance set by the biome. Plants are placed block by block, but clustered into patches so a meadow looks like a meadow rather than a sprinkle. For the biome-by-biome summary see [[page:biomes]].

## Trees by biome

| Tree | Biomes | Notes |
|---|---|---|
| [[item:oak_log|Oak]] | Plains, Forest, Flower Forest, Swamp; a few in Birch Forest, Dark Forest and Sparse Jungle | Trunk 4 to 6 blocks with a round crown; swamp crowns are wider |
| [[item:birch_log|Birch]] | Birch Forest (85% of trees), Forest and Flower Forest (30%), Meadow | Trunk 5 to 7 |
| [[item:spruce_log|Spruce]] | Taiga, Snowy Taiga, Snowy Plains, Windswept Hills, Old Growth Taiga | Cone shape, trunk 6 to 10; Old Growth Taiga also has giant spruces with a 2x2 trunk, 18 to 27 tall |
| [[item:jungle_log|Jungle]] | Jungle, Sparse Jungle | Jungle: huge 2x2-trunk trees 18 to 26 tall (18% of trees), medium trees 9 to 14 (42%), the rest small. Sparse Jungle: 7 to 10 tall (45%), small ones, and some plain oaks |
| [[item:acacia_log|Acacia]] | Savanna | Trunk 5 to 6, leaning, with a flat crown and sometimes a second branch |
| [[item:dark_oak_log|Dark oak]] | Dark Forest (78% of trees) | Thick 2x2 trunk, 6 to 8 tall, wide canopy |
| [[item:cherry_log|Cherry]] | Cherry Grove | Leaning trunk 4 to 6 with a rounded crown |
| [[item:mangrove_log|Mangrove]] | Mangrove Swamp | Standing in mud and shallow water, with roots arching to the ground |

Density (share of cells that hold a tree): Dark Forest and Jungle 92%, Birch Forest 65%, Forest and Mangrove Swamp 60%, Old Growth Taiga 60%, Taiga and Snowy Taiga 50%, Flower Forest 35%, Swamp 30%, Sparse Jungle 28%, Cherry Grove 22%, Savanna and Windswept Hills 8%, Plains 3%, Snowy Plains 2.5%, Meadow 1.5%. Deserts, Badlands, beaches, oceans and rivers have no trees. Trees are kept clear of villages (with a margin of three blocks), shores at sea level and the patches where caves open to the sky.

### Special growths

- **Bee nests.** About 3 percent of oak and birch trees in Plains, Forests, Flower Forests, Birch Forests and Meadows carry a [[item:bee_nest]] on one side of the trunk, just below the leaves. See [[mob:bee]].
- **Giant mushrooms** replace some trees in the Dark Forest (7%) and fill the Mushroom Fields: a mushroom stem 5 to 7 blocks tall with either a red cap, which hangs down around the stem, or a flat brown cap.
- **Jungle bushes.** Jungles have small clumps of jungle logs and leaves between the trees.
- **Cactus** grows in deserts (on 14% of cells, 1 to 3 blocks high) and rarely in badlands (3%).
- **Ice spikes** of [[item:packed_ice]] stand in the Ice Spikes biome: slim ones 6 to 13 blocks tall and, rarely, towers up to about 31.
- **Boulders** of mossy cobblestone (mostly) and cobblestone, about 3 blocks across, lie among the trees of Old Growth Taiga.

## Ground plants

How common each plant is varies by biome. Placing is deterministic from the seed.

| Plant | Where it grows |
|---|---|
| [[item:short_grass]] | On grass and podzol. Plentiful in Savanna, Meadow, Plains, Cherry Grove; common in forests, swamps, jungles and Windswept Hills; scattered in taiga. |
| [[item:fern]] | On grass, podzol, coarse dirt and dirt. Common in Old Growth Taiga and jungles; scattered in taigas, swamps and forests. |
| Flowers: [[item:poppy]], [[item:dandelion]], [[item:cornflower]] | On grass. Very common in Flower Forest and Meadow; scattered in Plains, Cherry Grove, jungles, forests and others. |
| [[item:red_mushroom]], [[item:brown_mushroom]] | On grass, podzol or mycelium. Common in Dark Forest, Swamp, Old Growth Taiga and Mushroom Fields; rare in forests and taiga. |
| [[item:dead_bush]] | On sand, red sand, terracotta and coarse dirt, in Desert and Badlands. |
| [[item:sugar_cane]] | Right at sea level beside water, on sand, grass or dirt, in climates that are not frozen. 1 to 3 blocks high. |
| [[item:pumpkin]] | In round patches 7 to 12 blocks across on grass in any land biome; about one 40-block square in five holds a patch. |
| [[item:melon]] | In patches like pumpkins, but only on grass in Jungle and Sparse Jungle; about one 36-block square in three holds one. |

### Patches

Grass, ferns, flowers and mushrooms follow slow patch noise 15 to 36 blocks across. Inside a patch they are dense; between patches they are sparse, but the overall amount stays what the biome calls for. Flowers are one colour per patch: a slow second pattern chooses poppy, dandelion or cornflower, and the strip between two colour zones stays empty, so you see solid fields of red, yellow or blue with the odd stray of the local colour.

None of these plants are placed on the ground of a village or beneath its buildings. Villages have their own flowers; see [[page:villages]].

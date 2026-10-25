---
title: Rivers
category: World generation
---
Every river in Blockfield starts in the highlands and runs all the way to the sea. There are no rivers that dead-end in the middle of a continent, and a river never splits into two as it flows downstream.

## How a river is made

![A river near the coast, seen from above](images/terrain-river.jpg)

The generator covers the land with a loose grid of points about 170 blocks apart. Each point flows to its lowest neighbour, so chains of points always run downhill and join into larger rivers. A point becomes a river source with a chance that grows with its height, so the high ground has the most sources, and nothing starts at the coast or below 8 blocks above sea level. A source only becomes a river if its chain actually reaches the sea within about eighty links (well over ten thousand blocks); otherwise it is dropped.

Where the ground forms a basin with no way out, the water finds its lowest rim and spills over, cutting a channel through it. The channel also continues a couple of hundred blocks past the shoreline into open water, so a coastal ridge never dams a river's mouth.

The result is a branching network of tributaries, with the biggest trunk rivers near the coast.

## Width and depth

Rivers widen as they gather water:

- A small stream far inland is only about four or five blocks across.
- Near the coast a single river is around a dozen blocks wide.
- At every confluence the river below is about as wide as the two above it combined, up to a limit of more than a hundred blocks across, so the largest rivers are very wide.

The water is a few blocks deep, deeper in wide rivers. Each bank has a flat floodplain about one or two blocks above the water, which blends into the surrounding terrain over thirty blocks or more. The river wanders in gentle curves around its path.

## Water level and cascades

A river's surface never rises as it flows. On the high plains it sits at plateau level, a few blocks below the ground. To reach the sea it must lose a thousand blocks of height, and it does so on the escarpment ([[page:terrain]]) in whole-block steps, tumbling down the ramp as a series of terraces and falls. Near the sea the surface is at sea level.

## Beds, ice and caves

- Riverbeds are sand, with patches of clay and gravel. The biome is River, or Frozen River in the coldest climate band; rivers also freeze over in the cold band. See [[page:biomes]].
- Caves stay a good way from rivers: the ground under and beside a river is kept sealed, so rivers do not drain into caverns ([[page:caves-and-ores]]).
- Villages are never placed on a river, and village roads stop at one.
- Villagers that keep swimming across a river can lead the village's [[villager:builder|builders]] to put up a wooden bridge. See [[page:village-structures]].

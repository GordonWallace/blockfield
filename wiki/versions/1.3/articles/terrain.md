---
title: Terrain
category: World generation
---
The shape of the land in a new world is built in layers: how far inland you are sets the base height, a long ramp lifts inland areas onto high plains, and mountain domes stand on top of the plains. Small hills are added last. This page describes each layer. For the list of limits, see [[page:world-generation]].

![A coast: beach, shallow sea and the lowlands behind](images/terrain-coast.jpg)

## Lowlands

Near the sea the ground follows the coast. Ocean floors lie between about y -58 and the shore, with deeper basins far out. On land the base height rises smoothly with distance from the sea, from sea level (y 0) at the beach to about y 100 deep in a continent.

On top of that come rolling hills, from a few blocks high in dry country to a dozen or more in wet, warm country. Hills fade out within a few blocks of sea level, so shorelines are clean lines rather than a scatter of islets and puddles. A coastal plain one to two thousand blocks wide usually lies between the sea and the first ramp.

Some terrain is reshaped by its biome:

- **Swamps and mangrove swamps** are pulled down to just above sea level in wet, mild, low-lying places, so shallow water lies in the hollows.
- **Badlands** get terraced mesas, built from stepped layers of coloured terracotta.
- **Mushroom Fields** are low islands, found only far out in the deep ocean.

## The escarpment

![Rising ground: savanna, desert and badlands on a slope](images/terrain-escarpment.jpg)

Inland, the land climbs onto the high plains over a ramp several thousand blocks long. It eases in at the foot, levels off at the top, and is broken by rolling foothills (up to some fifty blocks of extra relief). The foothills are also where rivers tumble downhill; see [[page:rivers]]. Because the ramp is so long, the climb is usually no steeper than a hill.

## High plains

Most continents have a vast, almost flat plateau at roughly y 900 to 1300, with only slow swells of a few blocks. The exact level changes very gently from place to place. Some regions sit on a lower plateau at about y 400 to 600 instead.

Around the world origin the generator always makes a high plain, at about y 1070, so the spawn area is flat, wide and dry. Mountain domes are held back near the origin and only reach full height several thousand blocks out. Climate on the plains is almost the same as at sea level, but a little drier than the lowlands, so there are more grasslands and savannas and fewer forests.

## Mountains

Mountain massifs rise from the plains as broad domes about five thousand blocks across, with a gentle foot and a steeper summit, reaching up to roughly 2,000 blocks above the plain. The ceiling is soft: above y 2000 height is compressed, so the highest summits level off around y 2500 and nothing comes near the world top at y 3072.

The biome changes with altitude (see [[page:biomes]]):

| Height on a massif | What you find |
|---|---|
| Below y 700 | Ordinary plains biomes |
| y 700 to 1350 | Foothills: taiga, savanna, cherry groves, meadows or forests, depending on climate |
| y 1350 to 1750 | Snowy slopes in cold areas, windswept hills in temperate ones, stony peaks in warm ones |
| Above y 1750 | Jagged peaks (cold or temperate) or stony peaks (warm) |

Higher up the air gets colder, gently on the plains and sharply above about y 1300, so the upper slopes freeze. Bare stone shows wherever the ground is steep. Snow covers Snowy Slopes above about y 1450 and Jagged Peaks above about y 1800 (with patches of packed ice); Stony Peaks never take snow.

## Below the surface

Under the surface the ground is stone, turning gradually to deepslate between y 8 and y -8, with bedrock at the bottom. See [[page:caves-and-ores]].

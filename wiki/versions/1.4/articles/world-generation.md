---
title: World generation
category: World generation
---
Every Blockfield world is built from a single seed. The same seed always gives the same land, rivers, caves, ores, trees and villages, and chunks are generated as you approach them, in any order, without seams. This page is the overview; the detail is on [[page:terrain]], [[page:biomes]], [[page:rivers]], [[page:caves-and-ores]], [[page:trees-and-plants]] and, for settlements, [[page:villages]].

## A mile high

New worlds use the "mile high" generator. Sea level is at y=0, ground can be far below it, and the main inland plains lie about a mile up, at roughly y 900 to 1300. Mountain ranges rise from those plains to around y 2500.

| Limit | Value |
|---|---|
| Bedrock floor | y -64 |
| Sea level | y 0 |
| Deepest ocean floor | about y -58 |
| Coastal lowlands | y 0 to about 100 |
| High plains | y 900 to 1300; a few regions only about 400 to 600 |
| Highest mountains | about y 2500 |
| Build limit | y 3071 (the world is 3072 blocks high) |

Only the layer around the surface is generated at first. Everything below it is plain stone until you dig down, when the deeper layers (stone, deepslate, caves, ores) are generated to match. Digging or building above the generated band simply extends it.

Worlds created with earlier releases keep their original, much shorter terrain (sea level at y 48, ceiling at y 192).

## Continents and oceans

The world is made of enormous continents separated by open ocean. A continent is tens of thousands of blocks across, and roughly a third of the planet is land, with several continents around it. You always start on dry land well inland. The eight corners of the planet's cube are always open sea; see [[page:the-planet]].

Height depends first on how far inland you are:

- **Ocean basins and shelves** fall from the coast down to about y -58.
- **Coastal lowlands** rise from sea level to around y 100.
- **An escarpment**, a long ramp several thousand blocks across, climbs from the lowlands to the high plains.
- **Mountain massifs** stand on the plains in broad domes. See [[page:terrain]].

## Climate and biomes

Two slow maps, temperature and humidity, divide the land into climate bands. Each band is about two thousand blocks across, so a walk of several minutes usually keeps you in one biome. Edges between biomes are ragged rather than straight. Height cools the air only a little on the plains, but strongly in the high ranges, which is why the tops of mountains turn to snow. On the planet, temperature comes from latitude instead: five climate bands run from the equator to the poles, with ragged, wandering edges, and humidity follows rainfall, which is heaviest at the equator and in the middle latitudes. See [[page:biomes]].

Special biomes are laid over the climate map: beaches and stony shores where land meets sea, swamps in wet lowlands, badlands in hot dry country with odd terrain, mountain biomes by altitude, mushroom islands far out at sea, rivers, and on the planet frozen arctic seas. All 30 are listed on [[page:biomes]].

## What is added to the land

- **Rivers** start in the highlands and always run down to the sea. See [[page:rivers]].
- **Caves** thread through the rock below the surface and open to the air only in a few patches; **ores** and rock varieties are scattered by depth. See [[page:caves-and-ores]].
- **Trees, flowers and other plants** are placed by biome, with flowers and grass growing in patches rather than evenly. See [[page:trees-and-plants]].
- **Villages** are placed on flat land in six biomes. See [[page:villages]] and [[page:village-structures]].
- **Wild animals** are placed when an area is first generated; see [[page:mobs]].

## Weather and sky

Rain, snow or dry weather is decided per biome; see [[page:time-and-weather]]. The cloud deck follows the local ground height, so you walk under clouds on the plains and above them on peaks.

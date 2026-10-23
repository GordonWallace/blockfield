---
title: Villages
category: Villages
---
Villages are the only settlements the world generates. They are placed when the land around them is first generated, laid out around a plaza and a bell, and filled with the villagers who live and work there. This page covers where villages appear, how big they are and how they are laid out. The buildings themselves are on [[page:village-structures]]; the people are on [[page:villagers]].

## Where villages appear

The world is divided into squares 384 blocks across, and each square gets at most one village. Most squares (85 percent) try to hold one, making up to a dozen attempts at different spots near the middle of the square. A spot is accepted only if it is:

- in one of six biomes: Plains, Savanna, Desert, Snowy Plains, Taiga or Meadow;
- dry land, with no river through the site;
- reasonably flat, with the ground within 9 blocks of the same height over the whole site;
- not close to oceans, rivers, jungles, swamps, dark forests, badlands or mountains.

So villages sit on open, level country, a few hundred blocks apart. Every village follows these rules, and there is no special village near where you start. The spawn point is dry temperate or subtropical land near 35 degrees north (see [[page:the-planet|the planet]]), and a village close to it happens only by chance, so a new world may have none in sight.

On the [[page:the-planet|planet]], each face of the cube is a flat grid of its own, and the squares are laid out on each face from its corner, so no square ever spans two faces. A village, with its farms, pens, paths and everything its builders add, always stays on one face. The squares along a face's edges, in a band a few hundred blocks wide, never hold a village; that is about 1 percent of the planet's land. So two villages on either side of an edge are always at least several hundred blocks apart. Villagers, traders and you can still walk from one face to the next. Villages look exactly as skewed as the ground around them near the cube's corners, but the corners are open sea, so few villages are near them.

The flat worlds of 1.3 and earlier made with village generator 9 or earlier also had a spawn village, found by searching outward from the spawn point, that could end up in a forest, a snowy taiga or on a beach. The planet has none, whatever the village generator.

## Population and size

Each village draws its population when it is generated. The smallest village has 4 people (a miner, a farmer, a forester and a toolsmith), the largest 100. The most common size is 18, the middle value 25, the average about 28; about one village in twenty has 60 or more. A village gets a bed for each of its people.

A bigger population gives a bigger village. The village spreads over a square that is about 57 blocks to each side of the plaza for four people, 76 for eighteen, 106 for sixty and 125 for a hundred.

A village keeps one [[mob:iron_golem]] for every 15 villagers, at least one. Golems patrol around the houses.

## Layout

- **Plaza.** A 15-by-15 square of dirt path at the centre, with a lamp post on each corner. On it stand a small pile of hay bales, a market stall (a crafting table beside a chest) and two poppies (dead bushes in the desert). Builders' [[item:drafting_table|drafting tables]] and some other workstations stand here too.
- **Well and bell.** In the middle of the plaza is a 4-by-4 well with a 2-by-2 pool, a roof held up by fences on its corners, and a [[item:bell]] hanging under the roof.
- **Roads.** Two to four main roads run out from the plaza in straight lines, 3 blocks wide, of [[item:dirt_path]]. They follow the terrain and stop at water or a sudden step. Main roads are 30 to 49 blocks long in a small village and grow with the population. Side streets branch off about every 16 blocks, and villages of 29 or more people also get cross streets, and those of 59 or more a third level.
- **Plots.** Buildings are placed on both sides of every street, nearest the plaza first, until there are enough beds for the whole population. Each plot is levelled into a terrace with a cobblestone or sandstone foundation. Streets are then trimmed back to their last building.
- **Lamps.** Every 9 blocks along the roads stands a fence-post lamp with a [[item:lantern]] on top.
- **Extras.** The desert garden and the paddocks (pens for shepherds, coops, pastures, sties and stables) are added after the rest; see [[page:village-structures]]. How many a village gets depends on its size and the animals native to its biome.

## Styles by biome

![Plains village](images/village-plains.jpg)
![Desert village](images/village-desert.jpg)
![Savanna village](images/village-savanna.jpg)
![Taiga village](images/village-taiga.jpg)
![Snowy village](images/village-snowy-plains.jpg)

The biome sets the building materials. Every style uses a gabled roof except the desert one, which has flat roofs.

| Biome | Walls | Corner posts | Roof | Foundation and wells | Ground |
|---|---|---|---|---|---|
| Plains, Meadow | [[item:planks|Oak planks]] | [[item:oak_log]] | [[item:spruce_planks]] | [[item:cobblestone]] | Grass |
| Desert | [[item:sandstone]] | [[item:sandstone_bricks]] | sandstone bricks (flat) | sandstone and sandstone bricks | Sand |
| Snowy Plains | [[item:spruce_planks]] | [[item:spruce_log]] | oak planks | cobblestone | [[item:snow_grass]] |
| Savanna | [[item:acacia_planks]] | [[item:acacia_log]] | [[item:orange_terracotta]] | cobblestone | Grass |
| Taiga | spruce planks | spruce log | [[item:dark_oak_log]] | cobblestone; the well is [[item:mossy_cobblestone]] | Grass |

Windows are glass panes. Farms plant the crops that suit the style: snowy villages grow more potatoes, desert villages hardly any beetroot.

## Entry arch and village sign

Every village has an entry arch, usually across the end of one of its main roads: two pillars of corner-post material with a three-block passage between them, a lintel five blocks above the highest ground, a small crown and a hanging lantern. Just outside it, beside the road, stand three signs side by side, whose wood matches the style (oak for plains, birch for desert, spruce for snowy and taiga, acacia for savanna). The signs read:

> Village of *name*
> Villagers: *count*
> Beds: *count*

The name is one of 200 New Zealand town names such as Kaitaia, Rotorua or Hokitika. Names do not repeat among nearby villages. The counts are kept up to date, so the sign shows how many villagers the village has now and how many beds. The sign cannot be edited, and breaking any part of it removes all three signs for good.

## Signposts

Each village also has signposts: one at the outer end of every main road, and one on the plaza beside the well. A signpost lists up to the four nearest villages within 800 blocks, each as an arrow, the name and the distance, rounded to the nearest 10 blocks. A road signpost only lists villages that lie in roughly the direction of that road (within 45 degrees); the plaza one lists all four. A village with no neighbours in range has no posts.

On the planet, distances are measured over the ground around the planet, and a village on the next face is listed like any other, with its arrow pointing the way you would walk over the edge. Villages keep a few hundred blocks back from face edges, so a neighbour on another face is seldom within range.

## Workstations

Villagers need a workstation to hold a profession. The generator places about one for each villager who needs one, give or take a few. Most stand inside the house of the villager they belong to: a [[item:lectern]] in the library, a [[item:brewing_stand]] in the church, the armorer's, weaponsmith's and toolsmith's blocks in the smithy. Others go beside the thing they serve (a [[item:composter]] by a farm, a [[item:loom]] by a pen, a nesting box by the coop, a milk churn by the pasture, a feed trough by the sty gate, a honey extractor by a farm with two beehives and a flower bed), and the builders', furniture makers', merchants' and bakers' workstations stand on the plaza. A workstation with no villager is free for an unemployed villager to take. See [[page:villager-life]].

## Older worlds

Worlds saved by earlier versions keep the village generator they were created with, so some newer features (chicken coops, pastures, sties, bakers, glassmakers, beekeepers, glass panes in windows) may be missing. The newest is village generator 10, which new worlds use. It drops the spawn village and gives each village paddocks and keepers by its size and biome. Worlds made with generator 9 or earlier keep their villages as they were, spawn village included. The oldest villages are smaller, with 8 to 25 buildings and at most 24 villagers.

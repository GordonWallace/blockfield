---
title: Builders
category: Villagers
---
[[villager:builder|Builders]] are the villagers who make a village grow. A builder chooses a structure, finds open ground, then places it block by block out of its own inventory. When it runs short it buys materials from the other villagers. It never creates a block from nothing. The shapes of what it builds are on [[page:village-structures]].

## Working hours
A builder works from morning until shortly before sunset, and only while the ground it stands on is loaded. At dusk it stops wherever it is and goes home, and picks the job up again the next morning. A village has one building site at a time. If a builder dies or stops being a builder, another builder of the village takes over its unfinished structure with its own materials.

## Choosing what to build
Every few seconds an idle builder weighs the structures it could build and picks one at random. A structure's chance is its **need weight** multiplied by an **affordability** factor.

**The first structure a village's builder ever plans is always a small house.** After that, the need weights are:

| Structure | Weight |
|---|---|
| Small house | 1 (0.3 once the village has 8 or more built houses) |
| Medium house | 0.4 |
| Cottage | 0.3 |
| Well | 1.2 until one is built, then 0.15 |
| Lamp posts | 1 until two stand, then 0.2 |
| Garden pen | 0.8 until two stand, then 0.2 |
| Market stall | 0.7 until two stand, then 0.15 |
| Workshop | 0.5 for the first, then 0.1 |
| Chicken coop | 2.4 with 8 or more villagers and no coop, else almost never |
| Pasture | 2 on grass with 10 or more villagers and no pasture |
| Sty | 2 on grass with 12 or more villagers and no pig farmer, if a farmer sells pig feed or wild pigs live nearby |
| Bakehouse | 1.5 with 15 or more villagers and no baker |
| Glassworks | 1.5 with 12 or more villagers and no glassmaker, only with natural sand within 64 blocks |
| Apiary | 1.2 on grass with 6 or more villagers and no beekeeper |
| Stable | 2.5 with 10 or more villagers and no stable, only on horse land (plains, savanna, meadow) |
| Bridge | 1.2, or 2 at a busy crossing; only where villagers keep wading |

Needs push these weights around:

- Each villager with no bed adds 1.6 to the small house weight (counting up to three), two or more add 1.2 to the medium house, and one or more add 0.6 to the cottage.
- If the village has no spare bed, so no child can be born, the houses rise to the weight of the likeliest other structure.
- A structure that has just failed to find a site is skipped for about three game hours.

The weight is then multiplied by what the builder can afford: **x3** if it already holds everything (or can craft the rest from what it holds), **x1.2** if some villager has the missing items for sale right now, and **x0.25** if not. A builder with the materials in hand therefore tends to build what it can build.

It also keeps in mind the structure after the current one, so the materials for that are reserved too ([[page:village-economy]]).

## Which wood
Each structure is built from a single wood: every plank, log and fence in it is that species. The builder picks the species whose blueprint it lacks least. Items that other villagers have for sale count as a fifth of a missing item, because they can be bought. Ties go to the wood the builder holds most of, then to the village's own style wood. The choice is fixed until the structure is finished. Doors are always oak, and crafting tables and chests are made from any planks.

The builder uses only the wood it holds or has bought. A missing door, fence, crafting table, chest, planks (from logs of the same wood), torch (from coal and sticks) or furnace (from cobblestone) is crafted from its inventory on the spot. No other wood stands in: a spruce house never has an oak board in it.

## Finding a site
The builder looks for open ground in and around the village:

- It tries up to 150 spots, evaluating up to 40. Most lie just inside or outside the village, and about two in five are up to 40 blocks outside it, but never more than 40 blocks from the nearest building.
- Each spot is turned so that the door faces the village centre.
- It keeps 3 blocks clear of existing buildings and other built structures, 2 from plots, lamps, decorations, the entry arch and signposts, and 1 from roads and from farm beds.
- The ground must be loaded, natural (grass, dirt, sand, stone and similar), dry, and the heights across the footprint may differ by no more than 2. There must be no water or ice, no trees or other solid blocks in the way, and nobody standing there. Plants are cleared. A gap of up to 2 blocks under the floor is filled with its foundation blocks, so it keeps 8 spare.
- Among the spots that pass, it prefers flat ground about 5 blocks from the nearest building.
- Some structures have extra rules: a stable stands on horse land, a pasture and a sty on grass, and a sty's trough within reach of a villager looking for a workstation.

## Building order
The builder places any foundation fill first, then the structure in phases: the floor, the walls from the bottom up, the roof, the windows, the door, the beds and last the torches and furniture. It takes one item from its inventory for every block, one block every 0.5 to 0.8 seconds. It must be within reach, about 4 blocks, with a clear line to the spot, so it walks around the building to find standing places. It never places a block into a space where someone stands, and waits, then skips. It does not overwrite solid blocks and it does not climb, so structures are limited to what it can reach from the ground. A cell it cannot reach is retried at the end of the job with a longer reach.

- A **well** needs a full water bucket. If the builder has only an empty one it walks to water within about 30 blocks and fills it.
- **Windows** need glass panes. If nobody in the village has any and there is no glassmaker, the builder leaves the windows open and comes back to glaze them once panes turn up.
- A house's first bed becomes the builder's own if it has none (see below).

## Shopping
Short of materials, the builder works out what it lacks and buys it from the nearest villager with a matching offer that can make the deal. It walks over at a quick pace, waits two seconds, and pays from its own purse at the seller's price, giving the seller experience like any trade. If no one sells what it needs, it waits, wandering, and checks again every 30 to 60 seconds. Meanwhile you can sell it what it needs: a builder buys cobblestone, stone, all eight kinds of planks and logs, glass panes, doors, bricks, beds, sandstone, orange terracotta and torches from you, and posts its shortfall as a need for others. In a village with a [[villager:furniture_maker]] a new builder is given no beds and buys them there.

A builder starts with the materials for a small house plus 10 percent, 8 foundation blocks, an empty bucket and 40 to 80 emeralds, and its allowance grows by 4 a day up to 80.

## Bridges
A village counts how often its villagers wade or swim across water, or take a long way round, because water is in the way. Only the last 3 game days count, tracked in 8-block squares. When a spot has seen 12 or more crossings, there is a crossing 3 to 24 water columns wide with land at both ends, no walkable crossing within 32 blocks and fewer than 3 bridges in the village, the builder may build a bridge there (weight 1.2, or 2 at 30 or more crossings). A bridge is a 3-wide plank deck two blocks above the water, so a boat with a rider fits underneath, with ramps to the banks, fence rails on both sides, a torch every 6 blocks and log posts down to the river bed. It is built from one end to the other. Villagers use finished bridges instead of swimming or detouring.

## What builders never do
- They never evict anyone. A builder takes the first bed it places in a house only if it has none of its own, and only if no one already holds that bed. No villager ever takes a bed another villager holds.
- They never use wood, or any material, that they have not paid for or been given. Nothing is placed for free.
- They never build at night, on water, on farm beds, inside existing buildings or on top of the plaza, roads, lamps or signs.
- They never mix woods in one structure.
- They do not pull down or replace the generated buildings.

## How many
A village gets one builder once it has 6 buildings and two at 19 or more. Builders count towards the village's population.

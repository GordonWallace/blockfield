---
title: Village structures
category: Villages
---
This page lists every building a village is generated with, and every structure that [[page:builders|builders]] add later. Sizes are the footprint in blocks. How a village is laid out is on [[page:villages]]; workstation blocks and where they stand are described there too.

## Generated buildings

Every house door is a closed oak door facing the road, with a doorstep of path, and windows of glass panes. Walls, roofs and floors use the village's style ([[page:villages]]). Plots along the roads are drawn at random with these odds, until the village has a bed for every villager:

| Building | Chance per plot | Size | Beds |
|---|---|---|---|
| House | 24% | 5x5, or 5x6 | 1 |
| Two-storey house | 12% | 5x6 | 2 |
| L-shaped house | 10% | 7x7 | 1 |
| Big house | 9% | 7x7 | 2 |
| Library | 5% | 9x7 | 1 |
| Church | 5% | 5x10 | 1 |
| Smithy | 5% | 7x6 | 1 |
| Farm | 12% | 9x7 | 0 |
| Big farm | 5% | 13x9 | 0 |
| Pen | 7% | 9x8 | 0 |
| Hay stack | 6% | 3x3 | 0 |

Libraries, churches and smithies are capped at one each in a village of up to 35 people, two each from 36, and one more of each for every further 24 villagers; big farms are capped at twice that number and pens at three times. A draw over a cap becomes an ordinary house.

### Homes

- **House.** One room with a gabled roof. Contains a bed, and about three houses in five a crafting table.
- **Two-storey house.** Two beds downstairs, a ladder to a hatch in the upper floor, which holds a chest and has its own windows.
- **L-shaped house.** A front wing along the road and a narrower back wing; a bed and a crafting table.
- **Big house.** Taller walls than the others; two beds, a crafting table, a chest and a lantern.

### Special buildings

- **Library.** A long hall with two rows of windows. Chests stand along the back wall between wall blocks as shelves. There is a crafting table and a lantern, and one bed. It houses a [[villager:librarian]], whose [[item:lectern]] is normally placed inside.
- **Church.** A tall nave and a tower about 14 blocks high over the back, with an open belfry holding a second [[item:bell]]. It has a bed and a crafting table. It houses a [[villager:cleric]], whose [[item:brewing_stand]] is normally placed inside.
- **Smithy.** Stone walls (sandstone in the desert), two furnaces, a chest, a crafting table, a lantern and one bed. It houses an [[villager:armorer]], [[villager:weaponsmith]] or [[villager:toolsmith]], chosen at random, whose matching workstation is normally placed inside.

### Farms, pens and stacks

- **Farm.** A log-bordered plot with a channel of water down the middle and farmland on both sides, planted in bands two rows wide with wheat, carrots, potatoes or beetroot. A quarter of farms replace one band with a pumpkin patch. The village's [[villager:farmer]] has a composter beside a farm. See [[page:farming]].
- **Big farm.** The same, 13 by 9, with two water channels.
- **Pen.** A fenced yard with a gate towards the road, two hay bales and a water trough. A [[villager:shepherd]]'s loom stands just outside. Every shepherd's job needs a pen, so extra pens are added if the random draw left too few, up to four. See [[page:animal-husbandry]].
- **Hay stack.** A pile of hay bales one or two high.

### Added after the rest

These are placed last, so they never move any other building, and only if there is room.

| Building | Size | Appears when | Serves |
|---|---|---|---|
| Garden | 11x11 | Desert villages only | The [[villager:forester]]: grass over dirt with one or two oak trees, because sand grows no saplings |
| Chicken coop | 7x7 | Village of 8 or more | The [[villager:poultry_keeper]]: a fenced run with a gate, scratched-up ground, hay bales in the back corners, and a nesting box beside it |
| Pasture | 11x9 | Village of 10 or more on grass | The [[villager:cowherd]]: a fenced field with a gate, hay bales, a four-block water trough along the back, and a milk churn beside it |
| Sty | 7x8 | Village of 10 or more on grass, 60% of the time | The [[villager:pig_farmer]]: a fenced pen with a gate, muddy coarse dirt by the gate, a water trough, a small plank-roofed shelter and a feed trough beside the gate |

"On grass" means not a desert or snowy village. The coop, pasture and sty hold no animals at first; their keepers fetch wild ones. There is no building for bakers, glassmakers or beekeepers at generation. Their workstations stand on the plaza or beside houses, and the glassmaker's kiln comes with a furnace and the beekeeper's extractor with two hives and a flower bed. See [[page:village-economy]].

## Builder structures

Builders ([[page:builders]]) build from their own materials, using the village's style but a single wood species per structure. Their houses use torches instead of lanterns and have a torch inside and out. Doors are always oak. How they choose is explained on [[page:builders]]; the conditions below are the hard ones.

| Structure | Size | What it is |
|---|---|---|
| Small house | 5x5 | The generated house with one bed. A builder's first project is always one. |
| Medium house | 7x5 | A one-storey house with two beds. |
| Cottage | 7x7 | The L-shaped house with one bed. |
| Workshop | 7x6 | A smithy with furnaces, chest and crafting table, without a bed. |
| Well | 3x3 | A small well with a pool, four posts and a roof. |
| Lamp posts | 9x1 | Three fence posts four blocks apart, topped with torches or lanterns. |
| Garden | 7x5 | A fenced yard with a gap to walk in by, and two hay bales if the builder has some. |
| Market stall | 5x3 | A roof on four posts over a crafting table, a chest and a merchant's counter. Every stall is a workstation for a merchant. |
| Chicken coop | 7x7 | A fenced run with a gap to walk in by and a nesting box. Wanted by a village of 8 or more with no coop. |
| Pasture | 11x9 | A fenced field with a gate, water trough and milk churn. Only in a grass village, and wanted at 10 or more villagers. |
| Sty | 7x9 | A fenced pen with a gate, trough, shelter and feed trough. Only in a grass village of 12 or more, where there are wild pigs nearby or a farmer sells feed. |
| Bakehouse | 3x3 | A roof on four posts over a baker's oven. Wanted by a village of 15 or more with no baker or oven. |
| Glassworks | 5x3 | An open-sided shed with a glass kiln, furnace and chest. Only where there is natural sand within 64 blocks, and wanted at 12 or more villagers with no glassmaker or kiln. |
| Apiary | 3x1 | A honey extractor between two fence posts. Only in a grass village, wanted at 6 or more with no beekeeper or extractor. |
| Stable | 13x7 | A 5x5 open shelter with a tack rack against its back wall and an 8x7 paddock with a double gate. Only on horse land (plains, savanna and meadow), wanted most by villages of 10 or more. |
| Bridge | 3 wide | A plank deck on log posts with fence rails and torches, across water 3 to 24 blocks wide. |

A bridge is offered only where villagers keep crossing water: at least 12 crossings at one spot within the last three days. A village can have up to three. Once built, villagers use it to walk across. The coop, pasture, sty, bakehouse, glassworks and apiary are wanted only rarely once the village has one. See [[page:rivers]].

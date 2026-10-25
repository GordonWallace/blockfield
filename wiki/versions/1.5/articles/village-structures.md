---
title: Village structures
category: Villages
---
This page lists every building a village is generated with, and every structure that [[villager:builder|builders]] add later. Sizes are the footprint in blocks. How a village is laid out is on [[page:villages]]; workstation blocks and where they stand are described there too.

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

In worlds made with village generator 10 (the default), no pens are drawn this way and hay stacks take their share, 13 percent. Pens come only with shepherds, below.

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
- **Pen.** A fenced yard with a gate towards the road, two hay bales and a water trough. A [[villager:shepherd]]'s loom stands just outside. Every shepherd's job needs a pen, so extra pens are added if the random draw left too few, up to four. In generator 10 worlds each shepherd's pen is added with the other paddocks, below, and there is no limit of four. See [[page:animal-husbandry]].
- **Hay stack.** A pile of hay bales one or two high.

### Added after the rest

These are placed last, so they never move any other building, and only if there is room.

| Building | Size | Serves |
|---|---|---|
| Garden (desert villages only) | 11x11 | The [[villager:forester]]: grass over dirt with one or two oak trees, because sand grows no saplings |
| Pen | 9x8 | The [[villager:shepherd]], as above |
| Chicken coop | 7x7 | The [[villager:poultry_keeper]]: a fenced run with a gate, scratched-up ground, hay bales in the back corners, and a nesting box beside it |
| Pasture | 11x9 | The [[villager:cowherd]]: a fenced field with a gate, hay bales, a four-block water trough along the back, and a milk churn beside it |
| Sty | 7x8 | The [[villager:pig_farmer]]: a fenced pen with a gate, muddy coarse dirt by the gate, a water trough, a small plank-roofed shelter and a feed trough beside the gate |
| Stable | 13x7 | The [[villager:stable_hand]]: the builder's stable, with its tack rack inside and a gated paddock |

In generator 10 worlds the pens, coops, pastures, sties and stables are decided per village, not by village size alone. A village gets paddocks by this rule:

- The expected number is the population divided by 10, times 0.4 plus 0.15 for each kind of animal native to the village's biome, times a random factor between 0.6 and 1.4. The whole part is kept and the fraction rounds up by chance. There is no cap.
- Native animals are the wild animals of the biome. Open land (plains, meadow, savanna) has chickens, sheep, pigs, cows and horses. Woods have pigs, chickens and sheep. Snowy land has sheep. Desert and everything else has none.
- Each paddock gets an animal by a weighted roll. A native animal starts at weight 4 and another at 1, and the weight halves for each paddock of that animal the village already has. Every animal can be drawn in every biome, deserts included.
- A village has at most one stable, so once a horse paddock is drawn horses are not drawn again.
- A village draws a stable only if wild-horse land lies within 100 blocks of its centre: open land where the herds are horses. Elsewhere its stable hand would never find a horse to catch, so horses are left out of its roll.
- Each paddock gets its own keeper with their jobsite block. The keeper takes the place of an ordinary resident. If only the core four are left, that paddock is left out.
- A paddock can stand on any ground. A pasture always gets a grass floor, in a desert village too. Plots can reach out to the edge of the village.

A plains village of 100 gets about 7 to 16 paddocks, a desert village of 100 about 2 to 6, and a village of 10 between 0 and 2. A generated stable starts with 2 tamed horses. The other paddocks start with their usual few animals. All of them get their animals the first time the village runs, whether you are there or it runs in the background ([[page:village-loading]]). Worlds made with village generator 9 or earlier keep their villages as they were: a coop in a village of 8 or more, a pasture in a village of 10 or more on grass (not a desert or snowy village), and a sty in 60 percent of those.

There is no building for bakers, glassmakers or beekeepers at generation. Their workstations stand on the plaza or beside houses, and the glassmaker's kiln comes with a furnace and the beekeeper's extractor with two hives and a flower bed. See [[page:village-economy]].

## Builder structures

Builders ([[villager:builder]]) build from their own materials, using the village's style but a single wood species per structure. Their houses use torches instead of lanterns and have a torch inside and out. Doors are always oak. How they choose is explained on the [[villager:builder|builder]] page; the conditions below are the hard ones.

| Structure | Size | What it is |
|---|---|---|
| Small house | 5x5 | The generated house with one bed. A builder's first project is always one. |
| Medium house | 7x5 | A one-storey house with two beds. |
| Cottage | 7x7 | The L-shaped house with one bed. |
| Workshop | 7x6 | A smithy with furnaces, chest and crafting table, without a bed. |
| Well | 3x3 | A small well with a pool, four posts and a roof. |
| Lamp posts | 9x1 | Three fence posts four blocks apart, topped with torches or lanterns. |
| Vegetable farm | 10x7 | A bed ringed with logs, with a water channel down the middle and a composter beside it. The builder levels the soil and fills the channel, but leaves it untilled and unplanted for a farmer to work. |
| Sheep pen | 10x8 | The generated pen: a fenced yard with a gate, a sunken water trough, two hay bales if the builder has some, and a loom outside. |
| Market stall | 5x3 | A roof on four posts over a crafting table, a chest and a merchant's counter. Every stall is a workstation for a merchant. |
| Chicken coop | 7x7 | A fenced run with a gap to walk in by and a nesting box. |
| Pasture | 11x9 | A fenced field with a gate, sunken water trough and milk churn. The builder lays a grass floor. |
| Sty | 7x9 | A fenced pen with a gate, sunken water trough, shelter and feed trough. |
| Bakehouse | 3x3 | A roof on four posts over a baker's oven. Wanted by a village of 15 or more with no baker or oven. |
| Glassworks | 5x3 | An open-sided shed with a glass kiln, furnace and chest. Only where there is natural sand within 64 blocks, and wanted at 12 or more villagers with no glassmaker or kiln. |
| Apiary | 3x1 | A honey extractor between two fence posts. Only in a grass village, wanted at 6 or more with no beekeeper or extractor. |
| Stable | 13x7 | A 5x5 open shelter with a tack rack against its back wall and an 8x7 paddock with a double gate. Wanted only when the village has no stable and at least 2 wild horses live within 80 blocks. |
| Bridge | 3 wide | A plank deck on log posts with fence rails and torches, across water 3 to 24 blocks wide. |

A bridge is offered only where villagers keep crossing water: at least 12 crossings at one spot within the last three days. A village can have up to three. Once built, villagers use it to walk across. The vegetable farm, sheep pen, coop, pasture and sty are the five kinds of food jobsite: the builder picks one kind, only a kind the village lacks at first, and a paddock only with at least 2 wild animals of its kind within 80 blocks. The bakehouse, glassworks and apiary are wanted only rarely once the village has one. See [[page:rivers]].

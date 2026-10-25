The explorer walks the land to fill in maps, and sells the finished maps. Its workstation is the [[item:survey_table]]. See [[page:maps-and-compasses]].

### Where explorers come from
An explorer only appears in a village that has a cartographer. Each [[villager:cartographer]] has a 70 percent chance of an explorer to go with it. Explorers walk one and a half times as fast as ordinary villagers and sleep in tents when they are far from home at dusk.

### The working day
- **Buying a map.** With at least 4 emeralds and fewer than 2 finished maps, the explorer walks to a cartographer in its village that has a blank map and buys one for the cartographer's price (4, 8, 16, 32 or 64 emeralds by size). It takes a size it can pay for, mostly small ones, which it can finish.
- **Using it.** It uses the blank map where it stands. The map becomes the filled map of the 8-by-8-chunk zone it is in, or the nearest zone that is not mapped yet.
- **Exploring.** It walks to the nearest blank part of the map, patch by patch, and the map fills in exactly as if you had carried it. The map is finished only when every pixel is drawn. Only loaded chunks can be mapped, so patches far from you wait until you are near. While it has a map to fill, it stays out in the field between patches and in the early morning rather than walking back to its village.
- **Putting a map aside.** When the blank parts left are out of reach (water, cliffs), or it has waited 3 minutes for patches that nobody has loaded, or it has walked one map for about 25 minutes, it puts the map aside for the rest of the day and goes back to it the next day. Its trade screen then says how full the map is. A map it has put aside is never for sale.
- **Camping.** If dusk catches it too far from home to get back, it pitches its tent, waits beside it until bedtime and sleeps in it. Its status reads "camping for the night" from the moment it pitches the tent. In the morning it packs the tent up again. Anywhere inside its own village counts as home, however big the village is, so it never camps there; it walks to bed. The tent goes on natural ground (grass, dirt, sand, snow, stone and the like), never on farmland, a path or anything built.
- **When its village unloads while it camps.** The explorer leaves with its village, and its tent stays where it is. If the village loads again before the night is over, the explorer is back in its tent, asleep. If the night ends first, the tent is taken down (straight away, or when its land next loads) and the explorer has it back in its pack when it next appears.
- **Cooking eggs while out.** While it still has a map to fill, an explorer with raw eggs cooks them at a furnace of whatever village is within 64 blocks of it (buying fuel there if it needs to), instead of walking all the way home. It never uses another village's furnace that has fuel in it. With no village furnace near, it keeps its eggs until it is home.

### What it sells
Its wares are the filled maps it carries: one offer for each. Only complete maps, with every pixel drawn, are for sale. A map costs 7 emeralds for the smallest size, up to 176 for the biggest. It stops fetching new maps once it carries two that are finished or put aside.

### Village log
Explorers write to their village's log (event type Maps) when they finish a map and put it on sale, put an unfinished map aside, and go back to it.

It has no other trades. The explorer has a bigger purse than other villagers: it can hold 100 emeralds and gets 6 a day.

### Starting kit
Emeralds and a tent. It never starts with a map.

---
title: Mob spawning
category: Mobs
---
Animals and monsters follow different rules. Animals are placed once, in groups, when land is first loaded, and after that they only breed. Monsters spawn continually wherever it is dark. Both stay in the world when you are not looking: nothing is removed just because you walked away.

In this page a **chunk** is a square of 16 by 16 blocks, and a **game day** is 20 minutes of real time (see [[page:time-and-weather]]).

## Wild animal groups

### The first-load roll

Every chunk rolls for animals exactly once, the first time it loads (worlds saved before this rule was introduced roll too, the next time each chunk loads). The biome at the chunk's centre decides the odds:

| Habitat | Biomes | Chance a chunk gets a group |
|---|---|---|
| Open land | Plains, Savanna, Meadow | about 8% |
| Woods | Forest, Flower Forest, Birch Forest, Dark Forest, Taiga, Old Growth Taiga, Cherry Grove | about 4% |
| Snow | Snowy Plains, Ice Spikes, Snowy Taiga, Snowy Slopes | under 1% |

Other biomes (desert, badlands, oceans, beaches, rivers, swamps, jungles, mountain peaks, mushroom fields) get no wild animals.

A group is **4 to 8 animals** of one kind, set down on grass within a few blocks of one another inside the chunk. A chunk with no grass it can stand on gets nothing. No animal is set down inside a village's pen, coop, pasture, sty or stable (or on its fence): a herd placed there would be taken in as village stock, over the enclosure's limit. After this single roll a chunk never gets new animals from nowhere: standing still for days does not make more appear. The only way to get more is breeding.

### Zones

Groups of a kind are not spread evenly. The world is divided into **zones** of 4 by 4 chunks (64 by 64 blocks). Within a zone, each habitat favours **one kind**, and every group rolled there is of that kind. The kind is picked from the world seed and the zone's position, weighted by the habitat's odds. So one stretch of plains is cow country, the next is sheep country, and finding every kind means travelling.

- **Open land** zones are cow, sheep, chicken, pig or horse, in roughly that order of likelihood (cows and sheep about a quarter each, horses an eighth).
- **Woods** zones are mostly pigs (nearly half), then chickens (a third) and sheep (a fifth).
- **Snow** zones are always sheep.

Horses live in the same open-land groups, so a horse herd also numbers 4 to 8.

### Wild breeding

Wild animals breed without help, slowly:

- Two adults of a kind must be on grass within 8 blocks of each other and not recently fed or bred.
- Each adult gets one roll per game day, which works out to roughly a one in ten chance per day for a pair.
- They never breed while 8 or more of their kind are within 24 blocks. This keeps herds from exploding.
- A successful roll makes the pair willing as if fed; they then walk together and a young one appears, just as with [[page:animal-husbandry]].

## Monsters

Monsters spawn in any loaded chunk, not only near you or near villages. Each loaded chunk gets about one surface attempt every 8 seconds while it is dark, and one cave attempt every 8 seconds at any hour. Each attempt picks a random chunk and a random spot in it, and picks a kind: [[mob:zombie]] 33%, [[mob:skeleton]] 25%, [[mob:creeper]] 24%, [[mob:spider]] 18%.

### Game options

Each world has its own **game options**, which say which of the four monsters spawn, and how far villages are simulated (*Far villages: Full detail* or *Coarse (faster)*, see [[page:village-loading]]). A new world has zombies and skeletons on, creepers and spiders off, and far villages at full detail; worlds saved before the options existed take the same settings. You can change them in three places:

- **Create New World**: the *Game options* buttons on the form.
- **The world list** on the title screen: *Options* on a world's row, then *Save*. The world uses them the next time it opens.
- **In game**: *Game options* in the pause menu. A change applies at once.

Turning a monster off means:

- None of that kind spawns. An attempt that picks it is simply dropped, not picked again, so the other kinds spawn exactly as often as before.
- Every one of that kind already in the world leaves: the loaded ones disappear on the spot (no drops), and ones stored with unloaded chunks or in the save do not come back.
- Each area's cap shrinks by that kind's share (see Caps below), so the others' numbers stay the same. With creepers and spiders off, for example, the cap is 58% of the usual, and you see as many zombies and skeletons as with all four on.

Turning one back on lets it spawn again from then on. The [[page:commands|/summon]] command still makes any monster, whatever the options say.

### Where and when

A monster appears only on a solid, open spot big enough to stand in, where the **block light is 7 or less**. A torch gives light 14 at its flame and one less with each block of distance, so spots about 7 or more blocks from a torch can still spawn monsters; a few torches spaced out are enough to make a floor safe. Lanterns, glowstone and sea lanterns shine at 15 and reach further. See [[page:light]].

There are two kinds of attempt:

- **Surface:** only while the sky is dark, on the top block of a column. The spot must have been dark for at least **half a game hour** (up to another half hour on top, varying by 8-by-8-block patch and night, so they trickle in rather than all arriving at once). The sky counts as dark once its light drops to 30% of full. That puts the first monsters about an hour and a half after sunset, and the last new ones about an hour before sunrise. Thunderstorms count as night with no wait.
- **Cave:** any time of day, in air pockets at least 3 blocks below the highest block overhead, where the **sky light is 7 or less**: caves and other deeply covered spots, such as the floor of a dense forest. Spots in the open never qualify by day.

Changing a place resets its clock. Taking away a light source, or building something that shades the ground such as a new roof, stops anything spawning in that 8-by-8 patch for another half hour. Lighting a spot with torches makes it safe at once, because the light level alone rules it out.

### Caps

Monsters are limited by area, so a busy night cannot flood a place:

- An area allows **10 monsters per 28 chunks**, never fewer than one, times the share of the spawn kinds switched on in the world's game options (all four: the full cap). Only monsters of kinds that are on count against it.
- Each running village counts as its own area, together with 16 blocks of margin around it and the land kept loaded around its villagers at its edge. So does the corridor along a caravan's trip, and so does each patch of land kept loaded around villagers who have walked well away from their village.
- Everything else loaded around you is one big area.
- When an area is full, no more spawn there until some die.

### Buffer

A monster never spawns within **12 blocks** of you, of any villager, or of an iron golem. Together with the cap, this means that villages do see nightly visits from zombies, but not swarms.

### Daylight

[[mob:zombie|Zombies]] and [[mob:skeleton|skeletons]] burn in sunlight: they lose one point of health each second while standing where the sky light at their head is 12 or more, in daylight. They are safe in water, under cover, in rain or snow, in a thunderstorm and at night. [[mob:creeper|Creepers]] and [[mob:spider|spiders]] do not burn; spiders turn neutral in bright light.

## When a chunk unloads

When a chunk leaves the loaded area, every wild animal and monster in it is **stored with the chunk** along with the game time. When the chunk loads again:

- Within one game hour: each mob returns on the same spot, doing what it was doing.
- After longer: each reappears at a random fitting spot within 8 blocks of where it was: grass outside the village enclosures for animals, a dark spot for monsters (by day, only where a monster could spawn).
- A zombie or skeleton that was standing under open sky when stored does not return if daylight passed while the chunk was away. It would have burned.

Nothing else is ever removed. Wild mobs leave the world only by dying, or by being led into a village's pen, coop, pasture or sty. Time spent unloaded does not age or breed them. Quitting and reloading takes no game time: everything loaded comes back exactly where it stood, facing the same way, with the same health.

---
title: Time and weather
category: Game rules
---
## The day

One game day lasts **20 minutes** of real time: ten minutes of day and ten of night. The clock is the usual 24 hours, with sunrise at 6:00, noon at 12:00, sunset at 18:00 and midnight at 0:00. The debug overlay shows the time of day. Night begins exactly at sunset and ends at sunrise.

Light changes gradually rather than switching:

- The last hour before sunset is slightly dimmer (the golden hour).
- After sunset, dusk takes an hour and a half to darken to full night, which is dim but never black.
- Dawn mirrors this before sunrise.

### One clock for the whole planet

The world is a round planet (see [[page:the-planet]]), but it has **one clock**: it is the same time of day everywhere, wherever you travel, so villagers everywhere keep the same hours. The sun and moon rise in the east and set in the west wherever you are; at a given time they stand at the same height above the horizon everywhere on the planet.

Many things in the game are measured in game days: crops, animal growth and breeding, restocking by traders, weather spells. See [[page:farming]], [[page:animal-husbandry]] and [[page:village-economy]].

## Sleeping

Right click a bed at night, or during a thunderstorm, to sleep. You cannot rest while a hostile mob is within 8 blocks ("You may not rest now, there are monsters nearby"), and by day the bed refuses ("You can only sleep at night").

Sleeping:

- fades the screen and skips to the next morning, just after sunrise;
- sets your respawn point at that bed (see [[page:player]]);
- clears any weather.

A tent, a three-wide, two-long bed that monsters cannot see through, does the same, and nearby monsters do not stop you sleeping in one. Villagers sleep in their own beds from sunset until sunrise; see [[page:villager-life]].

## Weather

Weather comes in spells of **clear**, **rain** and **thunder**, on a schedule fixed by the world's seed.

- A clear spell lasts one to three game days.
- A rain spell lasts a third of a day to a full day, and one in four rain spells is a thunderstorm.
- Rain and snow build up over about fifteen seconds when a spell begins.

Where precipitation falls depends on the biome: deserts, badlands and savannas stay dry under grey skies, snowy biomes get snow, and cold mountain heights get snow while the lowlands below get rain. Nothing falls where there is cover overhead, so it does not rain indoors, in caves or under thick trees.

### Clouds

Clouds drift slowly east, about a block a second near the equator and hardly at all near the poles. They are one pattern over the whole planet, so they carry on unbroken across the edges between the planet's faces. Their height follows the land below: you walk under them on plains and hills and climb above them only on high peaks.

### What weather does

- The world gets darker: noon in rain is about 70% as bright, in a thunderstorm about 40%, and the sky greys, the fog closes in and the clouds thicken.
- **Crops** grow 1.5 times faster while it rains, saplings 1.3 times, and rain hydrates exposed farmland (see [[page:farming]]).
- **Zombies and skeletons** do not burn where rain or snow falls on them, and not in a thunderstorm at all.
- A **thunderstorm** counts as night for monsters: they spawn on the surface and you may sleep through it (see [[page:mob-spawning]]).
- **Bees** stay home in rain (see [[mob:bee]]).
- **Lightning** strikes every 10 to 40 seconds in a storm, at a random wet spot 6 to 64 blocks away, with a flash and thunder. It hurts for 5 points anything within 2.5 blocks, and does not set fires. Dry biomes are never struck.

## Fast-forward

The right arrow key makes the whole world run faster; the left arrow slows it again. The speeds are 1x, 3x, 5x, 10x, 100x and 1000x, and one step further down from 1x is **0x**, which freezes everything: mobs, sky, weather, crops, water and furnaces. `/time set` and `/weather` still work while frozen: the sky and weather change at once and then stay put. You yourself always move at normal speed, so you can look around while time races or stops. An indicator in the top right shows the current speed, and in brackets the real speed when your computer cannot keep up. At 1x it stays hidden unless the world runs at less than 0.8x, for example "▶ 1× (0.4×)" when too many villages are being simulated. The [[page:game-log]] gets a WARN (kind *tick*) when the world drops ticks at 1x, the first time and at most once a minute while it lasts; fast-forward falling short of its speed is expected and is not logged.

The debug screen (`./run.sh`, then port 8001 on a second monitor) controls fast-forward too: the Left and Right arrow keys there step the speed exactly as they do in the game, and a bar in its top line has a button for each speed (0x to 1000x) and ◀ / ▶ to step it. The bar shows the speed asked for and, in brackets, the speed the world actually reaches when it falls short, as the game's own indicator does (at 1x too, when the world falls behind). The keys are left alone while you are typing in one of the screen's text fields or choosing in a dropdown. It works wherever the simulation runs (in the page, a worker or the world server), and each change from the debug screen writes a line to the [[page:game-log]] (kind *warp*).

At 10x and faster, blocks changing more than a chunk away from you (villagers opening doors, planting, felling trees) are redrawn at most a few times a second rather than every frame, which leaves more of each frame to the simulation. Blocks you break or place yourself still show at once, and everything catches up as soon as you slow below 10x.

The world moves in **ticks** of 0.05 seconds of game time, 20 a second at 1x, at every speed and on every computer: fast-forward just runs more ticks a second, so the world behaves exactly as it would at 1x, only sooner. Mobs, items, boats, arrows, bees and the sky are drawn smoothly between ticks, however fast your screen refreshes. When the computer can't fit all the ticks into a frame, the ones that don't fit are skipped rather than run in a burst later. The sky, clouds, stars and water always move at the speed the world actually reaches, so at 1000x on a computer that keeps up only 15x they move at 15x, the same as the world.

## Commands

`/time set` jumps the clock, `/time add` moves it on and `/weather` switches the weather; see [[page:commands]].

---
title: World state hash
category: Game rules
---
The world state hash is a 16-digit fingerprint of everything the game simulates. Two worlds with the same hash at the same game time are in the same state. It is there to check that the simulation is *deterministic*, meaning the same seed played the same way always gives the same world, and to make bug reports exact: "the hash at day 3 was 3f0c...".

## What it covers

The hash is made from separate parts, each with its own hash, so when two worlds differ the parts show where:

- **edits**: every block changed from what the world generated;
- **mobs**: every loaded mob's type, position, health, what it is doing, its inventory and its job's state;
- **villages**: the village records (beds, chests, pens and coops, building plans...);
- **player**: the player's position, health and inventory;
- **chests**, **furnaces** and **signs**: what they hold;
- **drops**: items lying on the ground;
- **clock** and **weather**;
- **wildlife** (wild mobs stored with chunks that aren't loaded), **boats**, **horses**, **bees** (nests and hives) and **farmland**.
- **rand** and **ids**: where the world's random number streams have got to, and the next id to hand out. Two worlds can look the same and still play differently if these differ;
- **villagers**: what the save keeps for villages besides their mobs: builders' structures and how far along they are, farm beds, how old each village is, ovens, pens and coops, newborns and the dead, caravans.

Village logs, economy tallies, happiness and day timelines are not in the hash. They record what happened, and nothing in the simulation reads them back.

Positions are rounded to 1/1024 of a block, and anything that is only drawing or sound (models, walking animation, arm swings, items bobbing on the ground, particles, sound timers) is left out. Working out the hash doesn't change the world. (Until late in 1.5 it did, once: hashing, like saving, made an explorer's working state before its first think, with a random roll of its own, so a world hashed or saved early played differently.)

## Where to see it

- The debug screen (`./run.sh`, then the debug screen) has a **State hash** card: the hash, the game day it was taken at, and the parts. It updates once a minute (every 10 seconds before late 1.5: with several villages loaded the hash takes about a tenth of a second of the simulation's time). **Copy** puts the hash, its day and the parts on the clipboard for a bug report.
- The [[page:game-log]] records the hash as each game day starts (INFO, kind *State hash*).

## The determinism test

`test/determinism.js` starts the same world (seed 3) twice, at the village nearest the spawn, runs each for one game day and compares the hashes every eighth of a day. The simulation is deterministic in 1.5, so the hashes must match at every check: a difference fails the test, which names the parts that differ and shows where each first differs. Chunks load at the same ticks in both copies. In play, when chunk data arrives still depends on how fast the computer generates it.

## Regions in any order

Each tick, the mobs think one simulation region at a time (squares of 64 by 64 blocks, see [[page:the-planet]]), and the changes they ask for are applied region by region. This is how the simulation will later share its work between several threads. The order of the regions must not change anything, and `test/region-tick.js` checks that: it runs the same world for a game day with the regions in order, in reverse order, and as one list, and the hashes must match all day.

The order of the mobs themselves must not matter either: `test/think-order.js` runs a big village with every tick's mobs shuffled into a random order, and the hash must match the usual order. For that, a mob reads the others as they stood at the start of the tick. When a villager does something to another mob while thinking, such as a keeper feeding, milking or shearing an animal, the villager gets its answer at once (the animal was hungry, how much wool it got), but the animal itself only changes once every mob has thought. Two trades can also be asked for one buyer in the same tick, one by the buyer and one by a seller who comes to sell to it. When that happens, they are settled in the order of the villagers who asked, not the order in which they thought. A villager that changes its own inventory while thinking, for example by spinning wool into string, shows the others its stock as it was at the start of the tick, until every mob has thought.

## Your actions, in tick order

The simulation runs in ticks of 1/20 of a game second, and you play in real time between them. Everything you do to the world (breaking and placing blocks, doors, using items on blocks and animals, attacking, shooting, throwing, eating, sleeping, every click in the inventory, chest, furnace and trade screens, sign text and commands) is stamped with the tick it follows and applied straight away, at that point between two ticks. You see it at once, and it comes before anything a villager asks for in the next tick: if a villager and you go for the same block in the same tick, you get it.

Because they are stamped, your actions can be recorded and played back. A recording keeps each action with its tick and where you stood and looked, plus where you stood at every tick you moved. Playing it back on a fresh copy of the same world gives the same world, which `test/player-requests.js` checks with the state hash. Recording and replaying are developer tools (`BF.req.record()` and `BF.req.replay(list)` in the browser console); the [[page:game-log]] notes when one starts and ends.


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

Positions are rounded to 1/1024 of a block, and anything that is only drawing (models, walking animation, particles, sounds) is left out. Working out the hash doesn't change the world.

## Where to see it

- The debug screen (`./run.sh`, then the debug screen) has a **State hash** card: the hash, the game day it was taken at, and the parts. It updates every 10 seconds. **Copy** puts the hash, its day and the parts on the clipboard for a bug report.
- The [[page:game-log]] records the hash as each game day starts (INFO, kind *State hash*).

## The determinism test

`test/determinism.js` starts the same world (seed 3) twice, runs each for one game day and compares the hashes every eighth of a day. Blockfield 1.5 is making the simulation deterministic step by step, so for now the test only reports which parts differ and where they first differ; once that work is in, a difference fails it.

## Your actions, in tick order

The simulation runs in ticks of 1/20 of a game second, and you play in real time between them. Everything you do to the world (breaking and placing blocks, doors, using items on blocks and animals, attacking, shooting, throwing, eating, sleeping, every click in the inventory, chest, furnace and trade screens, sign text and commands) is stamped with the tick it follows and applied straight away, at that point between two ticks. You see it at once, and it comes before anything a villager asks for in the next tick: if a villager and you go for the same block in the same tick, you get it.

Because they are stamped, your actions can be recorded and played back. A recording keeps each action with its tick and where you stood and looked, plus where you stood at every tick you moved. Playing it back on a fresh copy of the same world gives the same world, which `test/player-requests.js` checks with the state hash. Recording and replaying are developer tools (`BF.req.record()` and `BF.req.replay(list)` in the browser console); the [[page:game-log]] notes when one starts and ends.


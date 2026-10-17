---
title: Mobs
category: Mobs
---
Mobs are the animals, monsters and villagers that move around the world. Blockfield has twelve kinds. Each has its own page with health, drops and the biomes it favours; this page covers how they fit together.

## The kinds

- **Farm animals:** [[mob:pig]], [[mob:cow]], [[mob:sheep]], [[mob:chicken]] and [[mob:horse]]. They graze, flee when hurt, and can be bred. See [[page:animal-husbandry]].
- **Monsters:** [[mob:zombie]], [[mob:skeleton]], [[mob:creeper]] and [[mob:spider]]. They hunt the player and, in the case of zombies, villagers. See [[page:mob-spawning]] for where and when they appear.
- **Village mobs:** [[mob:villager]] and [[mob:iron_golem]]. Villagers have their own section starting at [[page:villagers]]; each village keeps a golem or more to guard it.
- **Bees:** [[mob:bee]] are a special case. They cannot be hurt; they are small flying insects tied to nests and hives.

## The world is full of mobs, not just the ones near you

Wild animals and monsters live in the whole loaded world, not only around the player. Animals are placed once, when a patch of land is first generated, and from then on they only increase by breeding. Monsters spawn in every loaded chunk wherever it is dark enough. Mobs far from you (beyond 100 blocks, or your view distance if that is shorter) still move, but they only think four times a second to save effort.

When a chunk unloads, the wild mobs standing in it are stored with it, and they come back when it loads again. Nothing is removed just because you walked away. The details are on [[page:mob-spawning]].

## Fighting

- A mob you hit is briefly immune to further hits (just under half a second) and is knocked back. Hitting while sprinting knocks it back further.
- Hurt animals run away from you for a few seconds. Hurt monsters turn on you.
- Hurting a villager or an iron golem makes every golem of that village angry at you for a minute. Golems never attack a creative-mode player.
- Mobs take fall damage like you do, one point for each block beyond three, except chickens, which flutter down slowly.
- Hostile mobs ignore players in creative mode and players asleep in a tent.

## Drops

Killing a mob yourself drops its items. Young animals drop nothing, and a shorn sheep drops no wool. Iron golems drop their iron however they die.

## Summoning

In any world you can create mobs with the `/summon` command; see [[page:commands]]. Horses can also be placed with a horse spawn egg in the creative menu.

---
title: The player
category: Game rules
---
This page covers your own health and hunger, what hurts you, what happens when you die, and the two game modes.

## Health and hunger

You have **ten hearts** of health and **ten drumsticks** of hunger, both counted in halves. Damage is measured in half-hearts, so "3 points" is a heart and a half.

- **Hunger drains slowly.** Even standing still, your food and hidden saturation fall by one point every few minutes. Sprinting, jumping, swimming, mining and taking hits burn it faster.
- **Eating** takes about 1.2 seconds of holding right click, and only works when your hunger is not full. Each food restores its hunger points and also tops up saturation, a hidden buffer that is used up before the drumsticks start to empty. You start with some saturation.
- **Healing:** while hunger is 9 drumsticks (18 points) or more, you regain half a heart every three seconds, at the cost of some hunger.
- **Sprinting** needs more than 3 drumsticks (6 points) of hunger. Hold Ctrl or R while moving forward.
- **Starving:** at zero hunger you lose half a heart every four seconds, down to death.

## Damage

After a hit you are immune to weaker hits for half a second. A harder hit during that time still deals the difference. Damage from falling, drowning, starving and lightning ignores this window.

| Source | Damage |
|---|---|
| Fall | 1 point for each block beyond 3 (a 10-block fall costs 7, three and a half hearts) |
| Drowning | 2 points a second after your air runs out |
| Starving | 1 point every 4 seconds |
| [[mob:zombie]] | 3 |
| [[mob:spider]] | 2 |
| [[mob:skeleton]] arrow | 2 to 4 |
| [[mob:creeper]] blast | up to about 20 when right beside it, falling off to nothing at 7 blocks |
| Angry [[mob:iron_golem]] | 5 to 9 |
| [[mob:bee]] sting | 1 |
| Lightning strike | 5, within 2.5 blocks |

Falling into water, and climbing ladders, cancel fall damage. Flying also does.

### Air

You can hold your breath for 10 seconds with your head under water. Once the air runs out you drown, taking 2 points a second. Air refills quickly, four times as fast as it drained, once your head is above the surface.

## Moving

Walking is 4.3 blocks a second, sprinting 5.6, sneaking 1.3 (and sneaking never lets you walk off an edge), swimming 2.2. Double-tap Space to start or stop flying: in survival that is about 11 blocks a second, 22 sprinting. Landing ends a flight.

## Fighting

You can hit mobs within 3.5 blocks and reach blocks within 5. After a swing there is a 0.4 second wait. A hit with your bare hand does 1 point; tools do more (see [[page:mining-and-tools]]). A sprinting hit knocks the target back further. A sword loses one use per hit, other tools two.

A bow is drawn by holding right click: a full draw takes a second, and a full-power arrow does 6 points, with an occasional critical hit for up to 9. Each shot uses one arrow and one use of the bow. Arrows that stick in the ground can be picked up again by walking over them.

## Dying and respawning

When your health reaches zero you die, and the death screen tells you how, and on the planet where (face, u, v, layer, latitude and longitude). **You keep your inventory.** Respawning restores full health and hunger and gives you about a second of protection from hits. You return to:

1. your **home bed**, if you have slept in one that still stands, or
2. the world spawn.

If your bed was destroyed, you see "You have no home bed" and start at the world spawn. Tents set your home the same way. You can only sleep at night; see [[page:time-and-weather]].

## Game modes

Choose a mode when you create a world; you can switch it at any time from the pause menu or with the `/gamemode` command.

- **Survival:** you can be hurt and go hungry. Blocks take time to break and need the right tool to drop items. Items are used up.
- **Creative:** you cannot be damaged and never get hungry. Blocks break instantly, placing blocks does not use them up, and you fly faster (16 blocks a second, 32 sprinting). Hostile mobs ignore you, and golems are never angry at you. A creative menu holds every block and item. Maps can teleport you in this mode only (see [[page:maps-and-compasses]]). On the planet, P opens a teleport panel: type a place as you would after `/tp` (such as `face 2 81920 81920` or `35.26N 45E`), or press one of the eight corner buttons or a height button (Ground, Up 1,000, Up 10,000, Up 25,000). It is not available in survival; `/tp` still is (see [[page:commands]]).

Using commands marks a world as having used cheats. See [[page:commands]].

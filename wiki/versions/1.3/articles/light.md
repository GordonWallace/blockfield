---
title: Light
category: Game rules
---
Blockfield has two kinds of light, both measured from 0 (dark) to 15 (brightest): **block light**, from torches and other glowing blocks, and **sky light**, from the open sky. They matter for how the world looks and for where monsters can appear.

## Block light

Glowing blocks give off light that spreads outwards and weakens by one level with each block of distance, flowing around corners and through doorways but stopped by solid blocks.

| Block | Light level at the block |
|---|---|
| Lantern, glowstone, sea lantern | 15 |
| Torch | 14 |
| Magma block | 3 |
| Candle | 3 |

So a torch lights the ground at level 13 one block away and still level 8 six blocks away. Light is worked out again as you build, and breaking or placing blocks changes it at once.

Torches stand on top of a solid block or on the side of one; they cannot hang from a ceiling. A torch pops off as an item if the block holding it is removed.

## Sky light

Open sky is level 15. Sunlight goes straight down through air, glass and plants without weakening, but through leaves, water or ice it falls to 14. Everywhere else it weakens by one level for each step, whether sideways, upwards or down from a shaded spot. Solid blocks, slabs and stairs stop it completely.

The effect is that a spot beside open ground is at 14, a doorway lights a room in even steps down to dark at the back, and a closed room or deep cave is at 0. At night the whole world looks darker whatever the sky light, though the levels themselves do not change (see [[page:time-and-weather]]).

Both lights are drawn smoothly, so a lit corner fades gradually. Surfaces that have both take the brighter of the two, and block-lit surfaces have a warm tint.

## Why it matters

- **Monster spawning.** Monsters need the block light at their spot to be **7 or less**. A torch keeps monsters off the ground within about six blocks of it (counted in steps along the grid, so a diagonal counts double); torches spaced six or so blocks apart leave nowhere to spawn. By day, monsters can still appear in covered places where the sky light is 7 or less, such as caves and dense forest floors, if block light does not stop them. See [[page:mob-spawning]].
- **Burning.** Zombies and skeletons burn only where the sky light at their head is 12 or more, so even a little cover keeps them safe.
- **Crops** do not need light to grow. See [[page:farming]].
- **Beds and sleeping** depend on time, not on light; see [[page:time-and-weather]].
- **Seeing.** The darker a place, the darker it looks, down to a floor so you can still see the shape of things.

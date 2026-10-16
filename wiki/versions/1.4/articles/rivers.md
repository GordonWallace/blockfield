---
title: Rivers
category: World generation
---
Every river on [[page:the-planet|the planet]] runs downhill all the way to the sea or into a lake. A river never splits as it flows, two rivers never cross, and the water never rises on its way down. Lakes sit in the hollows and high basins of the land, each with one river flowing out of it.

## How the rivers are made

Because the planet is finite, its whole drainage network is worked out at once, when a world starts. The loading screen shows this as **Working out the rivers and lakes**: it takes several seconds, once per seed each time the game is opened.

- The planet is covered by a loose grid of points about a kilometre apart, six faces of 160 by 160. Each point reads the shape of the land there, smoothed (without the small hills) and tilted gently towards the sea, so tributaries gather into long trunk rivers instead of wandering.
- Starting from the sea, the land is flooded point by point in order of height. This gives every point a way down to the sea that never climbs. A basin with no way out fills to its lowest rim and spills over it.
- Each point drains to its steepest lower neighbour. Two diagonal steps that would cross each other are bent onto the shared side, so rivers never cross.
- Water is added up from the sources down: rain in wet country, little from ice and snow. A river begins once it has gathered the water of about six square kilometres.

## Course and width

Each stretch of river is a smooth curve through its points: it bends gradually where it passes a point instead of turning a corner, and a side river joins the main one at a slant. Meanders wind along each stretch, fading out where rivers meet. Where two rivers that don't meet would touch, both run straighter.

Rivers widen at every confluence:
- A young river is about five blocks across.
- The biggest rivers, near the coast at the end of catchments hundreds of square kilometres across, are about forty blocks wide.

## Water level

The water fits the land. It sits a block or two below the lowest ground along the river and both its banks, and it keeps the lowest level it has reached: where the ground ahead rises, the river cuts through the rise rather than being built up above it. Rivers that join meet at one level, and for the last stretch before a junction the water is already level with it.

On the high plains the water sits at plateau level, and rivers come down the escarpments ([[page:terrain]]) in the cut of their own valleys.

## Valleys, beds and ice

- The channel is a rounded bed a few blocks deep, deeper in wide rivers. Each bank has a flat floodplain a block or two above the water, blending into the land around it. Where the land stands higher, the valley sides are cut down towards the river, up to about 150 blocks away.
- Riverbeds are sand, with patches of clay and gravel. The biome is River, or Frozen River in the coldest climate band; rivers also ice over in the subarctic band. See [[biome:river]].
- A river ends where it reaches the sea; its channel runs on a little way into the water so a coastal ridge never dams its mouth.
- Caves stay a good way from rivers: the ground under and beside a river is kept sealed, so rivers do not drain into caverns ([[page:caves-and-ores]]).

## Lakes

Lakes form in two kinds of place:
- **Hollows below sea level** inland, cut off from the sea. Their water is at sea level.
- **Highland basins** in the ground itself, at least six blocks deep. The water stands at the level where the basin would spill over, lowered where it would otherwise run out through a gap, or stand higher than a river that reaches it.

A lake is part of the river network. Rivers that reach its shore end there, and one river flows out from the lowest point of its banks, down the lie of the land, carrying the water of every river that flows in. A lake whose outlet would run into a higher lake, or back into itself, finds the lowest way out of its valley instead. Where ground a few blocks lower than the water lies just past a lake's shore, a low natural rim holds the water in.

Lake water fills the columns whose ground is below the lake's level. The bed is sand or gravel, and the biome reads as Lake (Frozen Lake in the coldest band). Lakes freeze over in the arctic and subarctic bands like rivers.

## On the older flat worlds

Flat worlds of earlier versions worked their rivers out piece by piece as chunks were made: points about 170 blocks apart, sources more likely on high ground, and a river kept only if it reached the sea within about eighty links. Their widest rivers were over a hundred blocks across.

---
title: The planet
category: World generation
---
From 1.4, a Blockfield world is a round planet rather than an endless flat plane. This page describes its shape; how the ground on it is made is on the [[page:world-generation|World generation]] pages.

![The planet from orbit, north at the top: continents, seas and the arctic ice](images/planet-orbit.jpg)

## Creating a world

Every new world is a planet: the create-world screen asks for a name, a seed, a game mode and a biome size, as before, and there is no flat-world option. Worlds made with Blockfield 1.3 or 1.4 can't be opened in 1.5. They appear greyed out in the world list, marked "Made with Blockfield 1.4, can't be opened in 1.5" (or 1.3), with only a Delete button (see [[page:saving]]). Where you start is described on [[page:world-generation]].

## Size and shape

The planet is a cube whose six faces are puffed out into a sphere. Each face is a square grid of 163,840 by 163,840 block columns, so walking once around the equator is 655,360 blocks. Columns stand straight up from the planet's centre, which means "up" is always away from the middle of the planet, wherever you are.

The grid is spaced so that columns are close to square everywhere. Right at the middle of a face a column is exactly one block wide at sea level; towards a face's edges and corners they narrow slightly.

Height works exactly as on the mile-high worlds of 1.3: bedrock at -64, sea level at 0 and the build limit at 3072.

## Faces, edges and corners

Two faces that meet along an edge lie flat against each other: block rows on either side line up one to one, so the ground carries on across an edge with no seam, and a straight walk stays straight. Near the ground you see the world exactly as on a flat world: the face you are on is drawn flat, and the faces beside it are laid out flat beyond its edges, so every block is square. When you step over an edge you simply carry on, facing the same way, and the picture doesn't move; only your coordinates change (see below).

Only where three faces meet at one of the planet's eight corners is there no flat way to join them: laid flat, three squares leave a quarter-circle gap. So within about a kilometre of a corner the game draws the world as it really is, on the round planet, and the gap closes up. Close to a corner the ground can look slightly twisted compared with your steps, because the grid itself bends there. The corners are always out in the open ocean.

Everything that spreads from block to block carries on across an edge too. A torch lights the ground on the next face, a roof shades both sides, water flows over and stops where it would anywhere else, water on one face keeps farmland on the other hydrated, grass spreads across, and a tree can grow astride an edge. Signs placed side by side across an edge stay two separate boards. A chest or furnace placed, opened or broken from across an edge is the same one you find from its own face, with the same things inside.

Things that move cross edges the same way. Animals, villagers and monsters walk across and keep going; a zombie chasing you follows you over, and a cow follows wheat across. Dropped items slide over and can be picked up on the other side, arrows fly across, and a boat or horse carries its rider over, still heading the same way. Animals that belong to a village or a pen stay counted with it even when they wander over the edge. A creeper's blast reaches across an edge, two animals that breed astride one have their young between them, and a monster just over an edge keeps you from sleeping.

Two of the faces sit over the poles and four go round the equator. Latitude and longitude are measured on the true sphere, with longitude 0 through the middle of one of the equator faces.

## Flying high

In creative mode you can fly far above the planet. More than 150 blocks above the ground, flying gets faster the higher you are. Hold R for the boost, which is 160 blocks a second times your height divided by 150, so about 1,600 a second at 1,500 up and 16,000 a second at 15,000 up. Up there R works without W, so R and Space reach orbit in a few seconds. You can climb as fast as you fly forward, and flying tops out at three times the planet's radius, about 313,000 blocks up. Closer to the ground, flying is as described in [[page:transport]].

As you climb, the view slowly changes from the flat drawing to the true round planet. It starts about 250 blocks above the ground (or above the sea, whichever is higher) and is fully round by 2,500. Up there you fly along great circles, so a straight flight carries on straight around the planet, even across face edges. From about 3,000 blocks up the sky starts to darken, and it is black space with stars by 60,000.

Above layer 20,000 you are off the planet. The view looks straight down at the planet with north at the top of the screen, and a thin red line marks the axis through the poles. The mouse is let go: drag with it to turn the planet under you, at the same height. Fly back down below 19,400 and the mouse looks around again, starting from straight down.

Survival players can't fly, so none of this changes survival play.

![6,000 blocks up: the ground already curves away to a round horizon](images/planet-curve.jpg)

## Coordinates

A place on the planet is written as its face (0 to 5), its position on that face's grid, `u` and `v` (each from 0 to 163,839), and its layer `y`, as in `face 2  u 81,920  v 81,920  y 64`. The debug screen (F3) shows this, with the latitude and longitude (`35.26°N 45.00°E`) and the compass direction you face, from north through east. Faces 2 and 3 sit over the north and south poles; the middle of face 4 is 0°N 0°E.

When you cross an edge your face number changes and `u` and `v` start again from the new face's corner. On some edges the grid also turns, so walking "towards +u" on one face can be walking "towards -v" on the next. Compass directions never jump: north is always towards the north pole.

Commands take `u y v` on the face you are on, and you can type past its edges onto the neighbouring faces; you can also give a face, a latitude and longitude, or one of the corners. See [[page:commands]]. In creative mode P opens a teleport panel, and in any mode M opens a map of the whole planet (see [[page:maps-and-compasses]]).

## Debug views

Hold F3 and press B, C or R to switch a debug view of the planet on or off. All three are off when the game starts, and the F3 overlay lists any that are on:

- B tints each face's ground its own colour, so you can see where the edges run.
- C turns off the round drawing near the corners, so the open quarter-circle gap where three faces meet shows.
- R draws the true round planet everywhere, to compare with the flat drawing.

The second-screen debug screen has the same three switches in its Planet section. It shows your position as face, `u`, `v` and `y` with the latitude and longitude. Village distances there are measured round the planet, with compass directions towards true north. Its mobs map is drawn in your own face's grid: the faces beside it are laid out flat beyond a dashed line at the edge, and an arrow points to true north. Each village's own map stays in that village's face grid. The mobs map's Regions button shades the simulation regions, squares of 64 by 64 blocks on each face that the simulation is being split into, by how many mobs each one holds, coloured by the worker that thinks for them (see [[page:several-cores]]). Its Region tick card shows how many regions were simulated in the last tick, the time each part of a tick takes, and the regions with the most mobs.

## Continents and corners

The planet's ground is made by the same generator as the mile-high worlds of 1.3, so its land looks the same: coastal lowlands, long escarpments up to high plains about a mile up, mountain massifs, badlands mesas, swamps, mushroom islands far out at sea, and caves, ores, trees and plants (see [[page:terrain]]). Every pattern is laid on the sphere itself, so continents, hills and caves carry straight on across the edges between faces. A tree that grows right at an edge is whole on both sides: the face it grows on decides it, and the next face draws the part that reaches over.

The continents are big enough that several of them fit around the planet, and about a third of the surface is land.

The eight corners of the cube are always open sea. Each seed's continents are turned to the position, out of a few hundred tried, that leaves every corner in open ocean: not a lake, but sea that runs on for tens of kilometres. If a corner were still short of it, a winding gulf a few kilometres wide would be cut from the corner out to the ocean. Any land left within a few kilometres of a corner sinks beneath the waves.

## Climate bands

Climate follows latitude. Five bands run from the equator to the poles: tropical, subtropical, temperate, subarctic and arctic. Their edges wander, high ground is colder, and now and then a biome turns up a band away from home. The arctic seas freeze over (Frozen Ocean). See [[page:biomes]] for which biomes each band holds.

## Rivers and lakes

The planet's rivers are worked out for the whole world at once when it starts (the loading screen shows **Working out the rivers and lakes** for several seconds, then **Creating** or **Loading** with the world's name until it is ready to play). Every river runs down to the sea or into a lake, never crosses another and never splits, and lakes sit in inland hollows and highland basins, each with one river flowing out. See [[page:rivers]].

## Seeing far

Beyond the loaded chunks, the land carries on to the horizon as distant terrain: the true shape of the ground, its colours, its seas and its forests, out to about 65 kilometres. It is drawn in rings around you, each half as detailed as the one inside it, a point every 4 columns within 500 blocks and a point every 512 columns at the far edge. Each ring's cells look about the same size on screen, so nearby hills and far-off coasts are equally sharp, and the detail fades gently from one ring to the next rather than stepping.

The colours come from the blocks themselves: grass, sand, snow and stone take the average colour of their textures, tinted by biome just as the blocks are, and the sea darkens with depth. Where trees grow, the ground takes the colour of their leaves over the share of it the crowns cover, so forests keep their colour however far away they are.

Trees and village buildings stand on the distant land too. Within a kilometre each tree is drawn as a simple trunk and crown, shaped and coloured by its kind (an oak, a tall spruce, a broad dark oak, a cactus, an ice spike), and each house as walls under an overhanging roof, standing exactly where the real ones grow once you get close. Further out each becomes a tiny picture of the same thing, its crown's top, sides and trunk (or a house's roof and walls) as they would look from where you are. Every tree is drawn out to 2 kilometres, and beyond that only some of them, with the forest's leaf colour making up the rest. Once a tree would be smaller than a pixel it fades into that colour, so forests and villages look the same from every distance and height.

Blocks themselves are only loaded while they are big enough to see. Fly higher than about 900 to 1,500 blocks above the ground (it depends on the size of your screen) and chunks stop loading: the land below is all distant terrain until you come back down. Chunks far from you keep only their drawn shape, not their blocks, which lets the render distance go up to 32 chunks (512 blocks), the default. The blocks themselves, and the animals and monsters that live on them, are kept within 12 chunks of you (or your render distance, if that is shorter). The chunks just past your render distance are loaded only while the ones at its edge are being drawn, and go again once they are, so no ring of loaded ground (or mobs) is left out there. Chunks are drawn by background workers too when the game is started with run.sh, nearest first, so loading and redrawing them doesn't take time from the game; the chunks right around you are always redrawn at once, so breaking and placing blocks shows up immediately.

Distant terrain is there at every height, from standing on the ground to high above the planet, and fills in as you travel: the land far ahead is worked out in the background, coarse rings first, without slowing the game down. It is worked out by background workers, which browsers allow only when the game is started with run.sh; opened straight from its file, the game shows the land only as far as the loaded chunks.

Past the distant terrain, the rest of the planet is drawn as a whole globe, with a point every 256 columns everywhere. It is worked out in the background from the moment a world starts, nearest first, and is what you see from orbit: every continent, sea and ice cap on all six faces, with the part beyond the horizon left out.

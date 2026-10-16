---
title: The planet
category: World generation
---
From 1.4, a Blockfield world is a round planet rather than an endless flat plane. This page describes its shape; how the ground on it is made is on the [[page:world-generation|World generation]] pages.

## Size and shape

The planet is a cube whose six faces are puffed out into a sphere. Each face is a square grid of 163,840 by 163,840 block columns, so walking once around the equator is 655,360 blocks. Columns stand straight up from the planet's centre, which means "up" is always away from the middle of the planet, wherever you are.

The grid is spaced so that columns are close to square everywhere. Right at the middle of a face a column is exactly one block wide at sea level; towards a face's edges and corners they narrow slightly.

Height works exactly as on the mile-high worlds of 1.3: bedrock at -64, sea level at 0 and the build limit at 3072.

## Faces, edges and corners

Two faces that meet along an edge lie flat against each other: block rows on either side line up one to one, so the ground carries on across an edge with no seam, and a straight walk stays straight. Near the ground you see the world exactly as on a flat world: the face you are on is drawn flat, and the faces beside it are laid out flat beyond its edges, so every block is square. When you step over an edge you simply carry on, facing the same way, and the picture doesn't move; only your coordinates change (see below).

Only where three faces meet at one of the planet's eight corners is there no flat way to join them: laid flat, three squares leave a quarter-circle gap. So within about a kilometre of a corner the game draws the world as it really is, on the round planet, and the gap closes up. Close to a corner the ground can look slightly twisted compared with your steps, because the grid itself bends there. The corners are always out in the open ocean.

Everything that spreads from block to block carries on across an edge too. A torch lights the ground on the next face, a roof shades both sides, water flows over and stops where it would anywhere else, water on one face keeps farmland on the other hydrated, grass spreads across, and a tree can grow astride an edge. Signs placed side by side across an edge stay two separate boards.

Things that move cross edges the same way. Animals, villagers and monsters walk across and keep going; a zombie chasing you follows you over, and a cow follows wheat across. Dropped items slide over and can be picked up on the other side, arrows fly across, and a boat or horse carries its rider over, still heading the same way. Animals that belong to a village or a pen stay counted with it even when they wander over the edge.

Two of the faces sit over the poles and four go round the equator. Latitude and longitude are measured on the true sphere, with longitude 0 through the middle of one of the equator faces.

## Flying high

In creative mode you can fly far above the planet. Flying gets faster the higher you are: hold Space, with R for the boost, and you reach orbit in a few seconds.

As you climb, the view slowly changes from the flat drawing to the true round planet. It starts about 250 blocks above the ground (or above the sea, whichever is higher) and is fully round by 2,500. Up there you fly along great circles, so a straight flight carries on straight around the planet, even across face edges. From about 3,000 blocks up the sky starts to darken, and it is black space with stars by 60,000.

Above layer 20,000 you are off the planet. The view looks straight down at the planet with north at the top of the screen, and a thin red line marks the axis through the poles. The mouse is let go: drag with it to turn the planet under you, at the same height. Fly back down below 19,400 and the mouse looks around again, starting from straight down.

Survival players can't fly, so none of this changes survival play.

## Coordinates

Each face has its own block of x and z coordinates, so every place on the planet still has a single x and z. Coordinates jump when you cross from one face to the next, and on some edges the directions turn too: what was "towards +x" on one face can be "towards -z" on the next. The game keeps drawing the world from your own position, so it stays sharp and steady however large the numbers get.

## Continents and corners

The planet's ground is made by the same generator as the mile-high worlds of 1.3, so its land looks the same: coastal lowlands, long escarpments up to high plains about a mile up, mountain massifs, badlands mesas, swamps, mushroom islands far out at sea, and caves, ores, trees and plants (see [[page:terrain]]). Every pattern is laid on the sphere itself, so continents, hills and caves carry straight on across the edges between faces.

The continents are big enough that several of them fit around the planet, and about a third of the surface is land.

The eight corners of the cube are always open sea. Each seed's continents are turned to the position, out of a few hundred tried, that leaves every corner in open ocean: not a lake, but sea that runs on for tens of kilometres. If a corner were still short of it, a winding gulf a few kilometres wide would be cut from the corner out to the ocean. Any land left within a few kilometres of a corner sinks beneath the waves.

## While 1.4 is being built

The planet is being brought into the game step by step. For now the biomes are still placed by the flat worlds' temperature and humidity patterns rather than by latitude, and there are no rivers or villages yet. A tree right next to a face edge can be cut off where the edge runs through it. Flying high you only see the patch of ground around you for now: the distant land and the whole globe below are still to come.

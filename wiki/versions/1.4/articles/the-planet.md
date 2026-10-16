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

Two of the faces sit over the poles and four go round the equator. Latitude and longitude are measured on the true sphere, with longitude 0 through the middle of one of the equator faces.

## Coordinates

Each face has its own block of x and z coordinates, so every place on the planet still has a single x and z. Coordinates jump when you cross from one face to the next, and on some edges the directions turn too: what was "towards +x" on one face can be "towards -z" on the next. The game keeps drawing the world from your own position, so it stays sharp and steady however large the numbers get.

## While 1.4 is being built

The planet is being brought into the game step by step. For now its ground is a simple stand-in (grass, sand, snow and stone over the planet's continents and oceans, with the climate bands deciding the biome), with no caves, ores, trees, rivers or villages yet, and the eight corners of the cube are always open ocean.

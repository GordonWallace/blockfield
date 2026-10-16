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

Two faces that meet along an edge lie flat against each other: block rows on either side line up one to one, so the ground carries on across an edge with no seam, and a straight walk stays straight. Only where three faces meet at one of the planet's eight corners is there no flat way to join them.

Two of the faces sit over the poles and four go round the equator. Latitude and longitude are measured on the true sphere, with longitude 0 through the middle of one of the equator faces.

## Coordinates

Each face has its own block of x and z coordinates, so every place on the planet still has a single x and z. Coordinates jump when you cross from one face to the next.

## Continents and corners

The planet's ground is made by the same generator as the mile-high worlds of 1.3, so its land looks the same: coastal lowlands, long escarpments up to high plains about a mile up, mountain massifs, badlands mesas, swamps, mushroom islands far out at sea, and caves, ores, trees and plants (see [[page:terrain]]). Every pattern is laid on the sphere itself, so continents, hills and caves carry straight on across the edges between faces.

The continents are big enough that several of them fit around the planet, and about a third of the surface is land.

The eight corners of the cube are always open sea. Each seed's continents are turned to the position, out of a few hundred tried, that leaves every corner in open ocean: not a lake, but sea that runs on for tens of kilometres. If a corner were still short of it, a winding gulf a few kilometres wide would be cut from the corner out to the ocean. Any land left within a few kilometres of a corner sinks beneath the waves.

## While 1.4 is being built

The planet is being brought into the game step by step. For now the biomes are still placed by the flat worlds' temperature and humidity patterns rather than by latitude, and there are no rivers or villages yet. A tree right next to a face edge can be cut off where the edge runs through it.

# Blockfield 1.6: flowing water (the realistic look)

Owner: the Water thread. Code: `js/real/water.js`. Test: `test/real-water.js`. This fills in section 6 of
`docs/REALISTIC_CONTRACT.md`.

With the realistic look on, water near the player is the Cascade Creek water: a shallow-water simulation (virtual pipes) drawn
with its shader, in a window of 80 x 80 blocks (two cells a block) that follows the view. Everything else about water is 1.5's:
water blocks, the fluid simulation that spreads them, farmland, swimming, buckets, boats, villagers. This is drawing only. It
changes no block and the game never reads it, so a world plays the same with the look on or off.

## How the flowing water meets block water

1. **Blocks decide.** Where the game has water blocks (sea, rivers, lakes, farm channels, wells, a poured bucket) the window has
   water, and the level the blocks give is the level it rests at. Where the blocks have none, it has none for long.
2. **Columns.** Each column of the window is read from the blocks: the top water block in reach (16 blocks above the view to
   44 below) is the surface, the ground under that run of water is the bed. A dry column gives only its ground, which is a
   bank. Leaves are not ground. Water under a roof or a bridge counts when there is air between (a well under its roof); water
   sealed under ground (a cave lake under a field) does not. Columns are read again when their blocks change
   (`chunk.colVer`) or their chunk loads, so digging, building and the fluid simulation show at once.
3. **Rivers slope.** The planet's river network has a continuous surface (`BF.rivers.at(...).rs`); the blocks floor it, which
   is where 1.5's one-block steps come from. A river column is simulated resting at the network's surface, so the water runs
   downhill all the way. It is drawn close to the blocks' level, at most a quarter of a block below it, because boats,
   swimmers and the player's own waterline sit at the blocks' level; each block step shows as a low riffle. Lakes and the
   sea are level and rest still.
4. **Kept in, and pulled back.** The simulation moves water between cells, but only into cells whose column has block water:
   it never runs out over a bank, a cliff lip or dry ground that the block water itself has not crossed. Every cell is also
   pulled towards its rest level (about a second to fill, three to drain) and never stands more than 0.6 blocks above it. So
   as the world was generated, and wherever nobody has changed a river, the water settles to what the blocks say, and nothing
   floods when the player arrives. A column with no ground in the heights read (a drop deeper than 44 blocks) holds no water.
5. **One water, two drawings.** `BF.real.water.material(base)` is the chunks' liquid material: the same colours, sky
   reflection and ripples as the flowing water, lit by the game's sky light and block light. It draws all block water outside
   the window, and inside the window the water the window does not own (under the bed: a cave pool under a river). The faces
   the window owns (between a column's bed and its surface, and faces on the edge of such a column) are not drawn. The two cross-fade over the window's outer 5 blocks,
   where the flowing surface also eases to the blocks' level.
6. **When it is off.** The window is off, and all water is block water in the look's colours, while the view is round (high
   above the ground, near the planet's cube corners) or the window would straddle two faces of the planet.
   `BF.real.water.setEnabled(false)` does the same by hand.
7. **Changed rivers run free.** Where a block has been changed in a river at the height of its water (a dam, a dug bank, a
   trench: any edit, the player's or a villager's, within 3 blocks of the river and between 6 blocks under its surface and
   one above), rule 4 is lifted for 14 blocks around and eases back over the next 12. There the water is only the
   simulation's: it is not pulled to the blocks' level, and once it stands 0.15 above its rest level it may leave the block
   water's columns. Where the free water meets the held river, the river keeps sending what it carries however high the
   free water stands, and the free water cannot run back up it. So a dam fills a pool behind it until the pool goes over the
   dam or round it over the banks (at most 3 blocks above the rest level), the reach below it falls while the pool fills,
   and a bank cut below the water lets the river out over the ground, where it runs downhill and soaks away. Take the dam
   out and the pool runs off and the river is back at its level (the place stays free, because the world remembers the
   edit; a free river with nothing in its way keeps its level by itself). The blocks do not change: farmland, buckets, swimming and boats still read
   the block water, so a boat on a pool floats at the old level (see Not done yet).

Cube channels fill exactly: the surface mesh's vertices sit on block edges and block centres, so a one-block farm channel
between farmland is full from wall to wall. Against a bank the surface continues level half a block into the bank, so there is
no gap whatever shape the smooth terrain gives the shore.

## For other threads

All in atlas coordinates, valid inside the window (`covers(x, z)`), zero or null outside it:

    BF.real.water.depthAt(x, z)        // blocks of water (0 dry)
    BF.real.water.surfaceAt(x, z)      // y of the surface, or null
    BF.real.water.flowAt(x, z, out)    // out.x, out.z in blocks a second
    BF.real.water.foamAt(x, z)         // 0 .. 1
    BF.real.water.disturb(x, z, amount, radius)   // add water (a wake, something falling in); it spreads as waves
    BF.real.splash(x, y, z, strength)  // the contract's splash: a ring of waves and foam (no spray particles yet)
    BF.real.water.bedSource = (x, z) => height | null   // the smooth terrain's height, when it has one (then call rebuild())

- **Foundation**: `js/world.js` uses `BF.real.water.material(liquidMat)` for the liquid pass and gives it its own program
  key in `planetMaterial` (the material carries `userData.realWater`). A terrain height function plugged into `bedSource`
  puts the shoreline exactly where the smooth ground meets the water.
- **Performance**: distant water (the rings) should use the body colour `vec3(0.018, 0.075, 0.06)` under a reflection of the
  sky, as `rwShade` in `js/real/water.js` does, so it matches at the chunk edge.
- **Atmosphere and creatures**: wind is not read yet (still water drifts slowly at a fixed heading); `flowAt` and `surfaceAt`
  are there for fish, ducks and things that float.

## Cost

About 1 ms a frame for the simulation and 1 ms for the mesh on the test machine (26,000 cells, two steps a frame; software GL
for the drawing, so no GPU figure yet). Reading the blocks: 6,400 columns when the window is placed, 640 when it moves 8
blocks, and only changed columns otherwise.

## Not done yet

- A pool behind a dam and the fallen reach below it are drawn, not written to blocks: the game still has the old water
  level there. Writing it back (water blocks placed and removed as the pool settles) is the next step if it should count.
- A changed river is free only within 26 blocks of the change, so a pool is at most that long and the river is back at its
  blocks' level beyond it.
- The mesher's liquid pass is unchanged, so block water beyond the window still has a river's one-block steps.
- Falling water (a poured bucket down a cliff) is a steep sheet of the same surface, with foam but no spray.
- The player and drops are not pushed by the current (that would be the simulation's business, not drawing's).
- No wet band on the shore yet (needs an attribute on the terrain pass).

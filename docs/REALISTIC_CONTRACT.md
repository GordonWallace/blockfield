# Blockfield 1.6: the realistic look (shared contract)

Blockfield 1.6 keeps every system of 1.5 (the planet, villages, jobs, the simulation, saves) and changes only how the world is
drawn: natural terrain, trees, plants, water, sky and creatures get the look of the Cascade Creek prototype. Blocks that are
built (planks, bricks, glass, village houses, anything the player places that is not a natural material) stay cubes.

- Integration branch: `release-1-6`, cut from `release-1-5` at `6606393`. (It was first announced as `realistic-world`; that
  name is not used.) Work on your own branch off `release-1-6` and open a pull request into `release-1-6`: the baseline CI
  runs on pull requests into `release-*`.
- The foundation thread ("Build explorable realistic river ecosystem") is the integrator. Ask it for contract changes; do not
  work around the contract.
- Nothing here runs in the simulation. All of it is drawing: page only, never listed in `js/simfiles.js`, never read by
  game logic. A world must play the same with the look on or off.

## 1. The switch

`BF.real.on` (boolean, fixed for the page's life, set by `js/real/core.js` before any other module runs).

- `?look=real` turns it on, `?look=blocks` turns it off; without the parameter the last choice in
  `localStorage["bf.look"]` is used, and without that it is **off**. Headless hosts (tests, workers, the server) have it off.
  The default flips to on when 1.6 is ready to ship.
- Every hook in existing files is a single guarded line: `if (BF.real.on) ...`. With the look off the game must be
  byte-for-byte the 1.5 drawing, so the 316 existing tests stay green. Never change behaviour when `BF.real.on` is false.
- Modules register with `BF.real.module({ name, init(ctx), frame(dt, t) })`. `init` runs once after the renderer, scene and
  sky exist (only when the look is on); `frame` runs every drawn frame before `BF.view.begin`. `ctx = { THREE, renderer,
  scene, camera, U, atmos, lights, quality }`.

## 2. Spaces and placement (read this before writing a shader)

- Game positions are **atlas** coordinates (x, z on the unfolded cube, y up, 1 unit = 1 block). The scene is drawn in **render
  space**: the camera is at the origin every frame (floating origin), y is up near the ground. `js/view.js` rewrites
  `matrixWorld` of every direct child of the scene each frame. So:
  - Put an object in the scene as a **direct child**, with `position` in atlas coordinates and `matrixAutoUpdate` as usual;
    view.js places it. Keep one object per chunk or per region of at most 32 blocks (an InstancedMesh with chunk-local
    instance matrices is the normal case), so the rigid placement stays accurate where the planet curves.
  - An object that is already in render space (lights, sky dome, a screen effect) sets `userData.renderSpace = true`.
  - Never read `cameraPosition` as a world position: it is the origin. For a pattern that must stay fixed on the ground
    (waves, noise) use `(modelMatrix * position).xz + uEye.xz` where `uEye` is `BF.real.U.uEye`.
- Chunk meshes also carry a `sphere` attribute and are bent to the planet by `world.roundK` (0 near the ground). Only
  `js/world.js` builds those; if you need a new chunk-shaped mesh ask the foundation thread for a pass (section 4).
- `BF.view.toRender(x, y, z, out)` gives the render-space position of an atlas point (null when it is not drawn).

## 3. Light, atmosphere and shared uniforms

Owned by `js/real/core.js` (foundation): the renderer flags (`outputEncoding = sRGBEncoding`, ACES tone mapping,
`physicallyCorrectLights` off, shadow map on when `BF.real.quality.shadows`), and two lights in render space,
`BF.real.lights = { sun: DirectionalLight, hemi: HemisphereLight }`. The sun's target is the origin, so its direction is just
its position.

`BF.atmos` is the one description of the air this frame. The atmosphere thread owns its values; core.js fills in plain
day/night defaults from `BF.sky` until that lands (replace `BF.atmos.update` with your own):

    BF.atmos = {
      sunDir,         // THREE.Vector3, render space, unit, pointing toward the light (sun by day, moon at night)
      sunColor,       // THREE.Color, linear
      sunIntensity,   // number (about 0 .. 3)
      skyColor, groundColor, hemiIntensity,
      fogColor,       // THREE.Color, linear
      fogNear, fogFar,// blocks: the linear fog 1.5 already runs (js/sky.js keeps the camera's far plane behind fogFar)
      dayness,        // 0 night .. 1 day
      wetness,        // 0 .. 1 (rain soaking)
      wind,           // { x, z, strength } in atlas directions, strength 0 .. 1
      flash,          // 0 .. 1 lightning
      update(dt, t)   // called by core.js once per frame, first
    }

After `update`, core.js copies it into the lights, `scene.fog` (the `THREE.Fog` of js/sky.js) and the shared uniform objects
`BF.real.U` (share them by reference, never copy the values):

    U.uSunDir  vec3   U.uSunCol vec3 (colour x intensity)   U.uSkyCol vec3   U.uGroundCol vec3
    U.uFogCol  vec3   U.uFogNear, U.uFogFar float   U.uTime float (seconds, wraps at 3600)
    U.uWind    vec3 (x, z, strength)   U.uWet float   U.uDay float (= BF.world.dayUniform, 0.1 .. 1)   U.uEye vec3

**Blockfield's own light** (caves, interiors, torches) is per vertex on chunk geometry: `skyl` (0..1, how much open sky
reaches the cell) and `bl` (block light level / 15; above 1.5 marks an emissive part). 1.5 multiplies an unlit colour by
`max(skyl' * uDay, bl')`. In the realistic look, lit materials go through one helper so everything agrees:

    BF.real.lit(material, opts) -> material      // patches onBeforeCompile; works on MeshStandard and MeshPhong (not Lambert: r128 lights it per vertex)
      opts.light: "vertex"   geometry has skyl and bl attributes (chunk passes)
                  "cell"     one value for the whole object: material.userData.cell = { value: Vector2(sky, block) },
                             set it from BF.real.cellLight(x, y, z, out) at the object's atlas position (mobs, props, trees)
                  "open"     open sky, no block light (distant terrain)
      opts.round: true       chunk-shaped mesh with a sphere attribute (world.js only)
      opts.wind:  true       sway by uWind using the vertex colour alpha / a `sway` attribute (foliage)

  The patch scales direct sun and hemisphere light by the sky value, adds block light as a warm term that ignores the sun,
  and applies the fog. Do not write your own version of this; ask for an option.

## 4. What the mesher gives you (foundation)

`BF.mesher.build(J, TB)` returns `{ S, L }` as in 1.5 and, when the job has `J.real` (js/real/mesh.js does the work, in the
page and in the mesher workers), also:

- `T`: the natural terrain pass: `{ pos, nrm, col, sky, bl, mat, till, sphere, ind }`. A smooth surface (surface nets, eased once)
  over the natural ground blocks listed in `BF.real.assets.ground` (grass, dirt, sand, gravel, stone and its variants, snow,
  ores under their rock, ...). Those blocks are left out of `S`; every other block stays a cube, and a cube's face against
  natural ground is drawn (the ground may slope away from it). Digging and placing ground materials reshapes the surface.
  A flat floor comes out exactly on the block tops, and collision stays on the block grid. Three rules keep the smooth
  surface honest against the block grid: (1) a vertex that touches a built full block (planks, a job site, a log border)
  sits exactly on the block grid and is not eased, so the ground is flat under such a block and square against
  it, and no quad is drawn against the block's face; (2) beside a wall two blocks high or more (a dug shaft, a trench, a
  cliff foot) a vertex leans at most 0.08 of a block into the open cells, so a player standing in them never ends up
  behind the surface; (3) with the look on a job's ring band (`Y0`..`Y1`) covers the 8 neighbours' loaded bands too, and
  an edit within 3 blocks of a chunk border re-meshes the neighbour, so both sides of a border build the same vertices.
  For the same reason what is ground is decided by column, never by chunk (`J.clay`: the columns where terracotta and
  sandstone are the ground itself), and a chunk meshed while a neighbour's blocks are not loaded takes the neighbour's
  ground to carry on as its own edge column does and is meshed again when those blocks arrive (`nbMiss` in js/world.js).
  Farmland is ground too (tilled soil, an entry with `till: true`): `till` is its share at a vertex, drawn as furrows. `col` is the ground's colour
  (times the biome grass tint where the entry says so), `mat` four weights for the detail layers (section 5).
  Turf (a `tint` entry: the grass block) is green on top only. A vertex is listed once per kind of face that uses it: a face that
  looks up shows the ground whose top it is (so the floor of a dug hole is the soil dug down to), every other face shows a cut
  through the ground, where turf shows the soil under it (the entry's `under` block, dirt by default) unless the foot of that
  side is turf too (the steps of a grassy slope). At such a cut the top's rim vertices carry a little soil and the wall's top
  vertices are turf, so the material breaks the line up (soil biting into the sward, turf hanging over the cut). The riser of a step one
  block high with ground at its foot is not a cut: its vertices are tops, so across the steps of a slope one ground runs into
  the next as it does on the flat. The `mat` weights add up to 1 + the share of turf at the vertex; the terrain
  material draws that share as short grass, the rest of the soil layer as crumbly earth (lumps, grit, a few stones), and `js/real/turf.js` stands blades on it near the player (`BF.real.turf`, by
  quality level; it reads the ground meshes world.js shows and needs no hook).
- `F`: the flora list, plain data, a `Float32Array` with one record of 8 floats per plant:
  `[x, y, z, kind, block, height, seed, extra]`: x, y, z chunk-local (y the base, on the ground); `kind` 0 tree, 2 ground
  plant, 4 big tree (a 2 x 2 trunk, x and z at its centre), 1 and 3 reserved (bushes, rocks); `block` the block id of the
  tree's log or of the plant; `height` the log column's height in blocks; `seed` a stable hash of the atlas cell (0 .. 1);
  `extra` the sky light level at the base (0 .. 15) plus 16 x the block light level (0 .. 15).
  On top of that `extra` carries how the plant sits on the smooth ground, as 256 x (d + 64 tx + 2048 tz): d (1 .. 63) how far the
  surface under the plant is above `y`, (d - 32) / 31 blocks (for a trunk a little lower, so its downhill side is in the ground);
  tx, tz (1 .. 31) the surface's rise per block along x and z, (t - 16) / 15; 0 means not known. `y` itself stays the block's
  height, which the game's logic reads. `BF.real.seat(extra, out)` (js/real/core.js) decodes it to `[dy, gx, gz]`; read the light
  with `& 15` and `>> 4 & 15`. A placer draws the plant at `y + dy`; ground plants lean part of the way to the ground's normal
  (`BF.real.lod.config.lean`), trees and stumps stay upright.
  `kind` 5 is a stump: one to three logs of a tree species standing alone on natural ground with nothing on top (what a felled
  tree leaves). Only where a tree stood: the mesh job carries `J.stood`, the cells of the trunks of the trees and stumps drawn
  in and around the chunk (`BF.real.fell.stood(ox, oz)`, which also remembers stumps per world in localStorage), so a log the
  player places is a block. Its logs leave `S` too; `height` is its log count, x and z the middle of a 2 x 2 stump. `js/real/fell.js` takes
  these records out of the list before the placer sees it and draws them, so a placer never meets kind 5. A log that carries a
  block, or stands in a row of logs or against something built, stays a cube.
  A tree is a column of a registered species' logs standing on natural ground with that species' leaves at its top (a
  `leafless` species, such as a cactus, needs no leaves). Its logs, any logs joined to them, and all leaves of registered
  species leave `S`. Logs without leaves (village posts, what the player builds) stay cubes. A ground plant is a block
  with a registered `cover` entry; every other plant (crops included) stays as 1.5 draws it. Game logic is untouched:
  breaking a log simply rebuilds the mesh. Known gaps: leaf blocks a player places by hand are hidden too, and the
  selection box still outlines hidden leaf blocks.

`js/world.js` draws `T` with `BF.real.terrainMaterial()` and hands `F` to the flora placer:

    BF.real.flora.place(key, ox, oz, F)   // key: the chunk's key; ox, oz: its corner in atlas coordinates; F may be null
    BF.real.flora.remove(key)
    BF.real.flora.resolve(block, biome, logs, seed) -> registry entry or null   // the one rule for which model a record gets

Felled trees (`js/real/fell.js`, loaded after `lod.js`) stands in front of whatever `place` and `remove` are installed: it
remembers each chunk's tree records, and when one goes while its trunk's blocks above the cut are gone from the world it plays the
tree's fall with the same model, hides the item drops of that tree until it lands (`BF.real.fell.hides(drop)`, asked by
`js/entityview.js`), and draws the stumps. It also gives the height an item on natural ground is drawn at
(`BF.real.fell.itemY`: on the smooth surface, not the block grid). The simulation is as in 1.5 with two changes that hold with
the look on or off: item drops fall through leaves (`js/drops.js`, `moveBox` `opts.pass`), and the player's felling
(`fallAbove`) takes trees of up to 512 logs, so a giant cut through comes down.

The foundation ships a simple placer (an InstancedMesh per model part per chunk, hidden beyond about 176 blocks). The
performance thread **replaces `place` and `remove`** with its scheduler (region batching, level of detail, impostors,
culling, time-slicing), keeps `resolve`, and owns everything beyond loaded chunks (distant rings, far trees). It must not
change what a record means.

## 5. Flora toolkit and the registries

`js/real/flora.js` (foundation) exports the Cascade Creek toolkit as `BF.real.kit`: `{ Geo, toGeo, tube, path, at, card,
branch, spray, needles, cells, cellUV, atlasTex, barkTex, barkMat, foliageMat, depthMat, atlases, rng, withRand, conifer,
broadleaf, shrubTree, broadleafP, coniferP }`. The builders draw from the generator set by `kit.withRand(rand, fn)`.
Materials from `barkMat` and `foliageMat` are already lit (`light: "open"`; the placer puts the sky light in the instance
colour). 1 unit = 1 block, origin at the trunk base, y up. Other threads may keep their own toolkits.

    BF.real.assets.species.push({
      id: "sitka_spruce", kind: "tree",
      log: "spruce_log",                    // the block whose trees this draws
      leaves: "spruce_leaves",              // optional: default is the log's name with _leaves
      leafless: false,                      // true: any column of `log` on natural ground is a plant (cactus, mushroom stem)
      biomes: ["Taiga", "Old Growth Taiga"],// optional: only in these biomes (names of js/worldgen.js)
      logs: [4, 9],                         // optional: only for log columns this tall
      weight: 1, variants: 3,               // chosen by seed among the entries that fit; models built per variant
      build(rand, detail) -> { bark: BufferGeometry, foliage: BufferGeometry },   // detail 0 full, 1 medium, 2 low; foliage may be empty, never null
      barkMaterial(), foliageMaterial(),    // shared per species
      modelHeight: 12,                      // the model's height in blocks at scale 1 (or height: [min, max]); the placer scales it to the log column + 2.5
    })
    BF.real.assets.cover.push({ id, block: "fern", biomes, weight, variants, build(rand, detail) -> BufferGeometry, material() })
    BF.real.assets.rocks.push({ id, biomes, build(rand, detail) -> BufferGeometry, material() })
    BF.real.assets.ground.push({ id, blocks: ["grass", ...], color: "#hex" | [r, g, b] (sRGB), layer: 0 | 1 | 2 | 3, tint: bool , under: "dirt" })

Ground: `layer` picks the shared detail texture's channel (0 soil and turf, 1 rock, 2 sand and gravel, 3 snow and ice),
`tint` multiplies the colour by the biome's grass tint. A later entry for the same block wins; js/real/terrain.js holds the
defaults. Everything is generated in code (canvas textures, built geometry): no binary files, no downloads.

Albedo: the game's sun runs up to about 3 with ACES tone mapping, so keep albedos low (the ground and the kit's foliage
multiply their colours by about 0.4 to 0.5 in linear space).

## 6. Water

The water thread owns how liquids look: `js/real/water.js` provides

    BF.real.water.material(base) -> material       // used by world.js for the liquid pass (L) instead of liquidMat
    BF.real.water.frame(dt, t)

and may change how `L` is built (the liquid part of `js/mesher.js`: smooth surface heights, flow direction per vertex, shore
distance, a `foam` attribute). It also owns distant water with the performance thread's rings, splashes (`BF.real.splash(x,
y, z, strength)`, atlas coordinates) and the wet band on shores (the terrain material reads `mat`/a `wet` attribute; ask the
foundation thread for the attribute you need). Water physics is 1.5's fluid simulation, unchanged.

## 7. Who owns which file

| Thread | New files | May edit in existing files |
|---|---|---|
| Foundation | `js/real/core.js`, `mesh.js`, `terrain.js`, `flora.js`, this document | `index.html`, `js/main.js`, `js/world.js`, `js/mesher.js` (solid part), `js/meshworker.js`, `js/view.js` |
| Water | `js/real/water.js` | the liquid part of `js/mesher.js`, `js/planetrivers.js` (drawing only) |
| Performance | `js/real/lod.js` | `js/lod.js`, `js/lodworker.js`, `js/grid.js`, `js/globe.js` |
| Biome assets | `js/real/assets-biomes.js` (stub on the branch), more `js/real/assets-*.js` on request | `js/textures*.js` only if a block texture must change |
| Felled trees and items | `js/real/fell.js` | the stump rule in `js/real/mesh.js`, the drop lines of `js/entityview.js`, `js/drops.js`, `fallAbove` in `js/forester.js` |
| Atmosphere and creatures | `js/real/atmos.js`, `js/real/mobs.js` | `js/sky.js`, `js/weather.js`, `js/mobs.js`, `js/mobview.js`, `js/entityview.js`, `js/audio.js` |
| Digging | `js/real/dig.js` (the wear drawn on smooth ground while it is mined, `BF.real.dig`) | `js/cracks.js`, the break particles' line in `js/player.js` |
| Grass ground | `js/real/turf.js` (blades of short grass on turf near the player, `BF.real.turf`) | the ground's colour rule in `js/real/mesh.js`, the turf drawing in `js/real/terrain.js` |
| Dropped items | `js/real/drops.js` (a dropped ground block as a lit lump of that ground, other items as a lit icon, `BF.real.drops`) | the drop lines of `js/entityview.js`; `js/drops.js` (game rule, both looks: reach, items rising out of blocks) |

`index.html` already loads every file above (empty stubs are on the branch), so nobody else needs to touch it. If you need
another new file, name it `js/real/<yours>-*.js` and ask the foundation thread for the script tag.

## 8. Rules

- Three.js r128, global build, plain scripts in an IIFE on `BF`, as in `CONTRACT.md`. No build step, no packages.
- Budget: the game must hold 60 fps on a laptop GPU at the default view distance. Anything expensive has a
  `BF.real.quality` level (0 low, 1 medium, 2 high; core.js lowers it when frames run slow).
- Tests: add at least one headless test in `test/` (see README "Tests and CI" for the `// @ci` header) that loads your
  module with the look on and checks it builds without throwing. `test/wallclock-lint.js` needs an entry for any file that
  reads the wall clock for drawing.
- Pull requests go into `release-1-6`, one topic each. Do not rebase or force-push `release-1-6`.

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

    BF.real.lit(material, opts) -> material      // patches onBeforeCompile; works on MeshStandard / MeshLambert / MeshPhong
      opts.light: "vertex"   geometry has skyl and bl attributes (chunk passes)
                  "cell"     one value for the whole object: material.userData.cell = { value: Vector2(sky, block) },
                             set it from BF.real.cellLight(x, y, z, out) at the object's atlas position (mobs, props, trees)
                  "open"     open sky, no block light (distant terrain)
      opts.round: true       chunk-shaped mesh with a sphere attribute (world.js only)
      opts.wind:  true       sway by uWind using the vertex colour alpha / a `sway` attribute (foliage)

  The patch scales direct sun and hemisphere light by the sky value, adds block light as a warm term that ignores the sun,
  and applies the fog. Do not write your own version of this; ask for an option.

## 4. What the mesher gives you (foundation)

`BF.mesher.build(J, TB)` returns `{ S, L }` as in 1.5 and, when the job has `J.real`, also:

- `T`: the natural terrain pass: `{ pos, nrm, col, sky, bl, mat, sphere, ind }`. A smooth surface (surface nets) over the
  natural solid blocks: grass, dirt, podzol, mud, sand, red sand, gravel, clay, stone and its natural variants, deepslate,
  sandstone, terracotta in badlands, snow, ice, ores. Those blocks are left out of `S`. Digging and placing these materials
  reshapes the smooth surface. Collision stays on the block grid. `mat` is a per-vertex ground material index
  (section 6); `col` is the biome tint.
- `F`: the flora list, plain data, one record of 8 floats per plant:
  `[x, y, z, kind, species, height, seed, extra]` with x, y, z chunk-local (y the ground surface), `kind` 0 tree, 1 sapling
  or bush, 2 ground plant (a "cross" block: grass, fern, flower, crop stays a cube-world crop: crops are **not** flora),
  3 rock (reserved), `species` an index into `BF.real.assets.species`, `height` in blocks (a tree's log column), `seed` a
  stable hash of the atlas cell (0 .. 1), `extra` the sky light at the base (0 .. 1) plus 2 x the block light (0 .. 1).
  A tree is a column of one species' logs that stands on natural ground and has that species' leaves attached; its logs and
  leaves are left out of `S`. Logs without leaves (village posts, anything the player builds) stay cubes. Breaking a log of a
  tree is unchanged game logic; the mesh simply rebuilds.

`js/world.js` turns `T` into a mesh with the terrain material and hands `F` to the flora placer:

    BF.real.flora.place(key, ox, oz, F)   // key: the chunk's key; ox, oz: its corner in atlas coordinates
    BF.real.flora.remove(key)

The foundation ships a simple placer (one InstancedMesh per species per chunk, full detail). The performance thread
**replaces these two functions** with its scheduler (region batching, level of detail, impostors, culling, time-slicing) and
owns everything beyond loaded chunks (distant rings, far trees). It must not change what a record means.

## 5. Flora toolkit and the species registry

`js/real/flora.js` (foundation) exports the Cascade Creek toolkit as `BF.real.kit`:
`{ Geo, toGeo, tube, path, at, card, branch, conifer, spray, needles, cells, cellUV, atlasTex, barkTex, barkMat,
foliageMat, depthMat, rng }`. Same signatures as `mod_flora.js` in the project files (`/mnt/project-files/cascade-creek/`),
with materials already passed through `BF.real.lit`. 1 unit = 1 block, origin at the trunk base, y up.

The biome assets thread fills the registry (`js/real/assets-*.js`); the foundation ships spruce, oak and birch as examples:

    BF.real.assets.species.push({
      id: "sitka_spruce", kind: "tree",
      log: "spruce_log",                    // the block whose trees this draws (any wood species name of blocks.js)
      biomes: ["Taiga", "Old Growth Taiga"],// optional: only there; several entries for one log are chosen by seed
      weight: 1,
      variants: 4,                          // how many different models to build (chosen by seed)
      build(rand, detail) -> { bark: BufferGeometry, foliage: BufferGeometry },   // detail 0 full, 1 medium, 2 low
      barkMaterial(), foliageMaterial(),    // shared per species, made with the kit (so they are lit and fogged alike)
      height: [6, 14],                      // model height in blocks at scale 1; the placer scales to the log column
      impostor(detail)                      // optional: canvas for a far billboard (performance thread's impostors)
    })
    BF.real.assets.cover.push({ id, block: "fern" | "short_grass" | ..., biomes, build(rand, detail), material() })
    BF.real.assets.ground[index] = { id, blocks: ["grass_block", ...], color, texture() -> CanvasTexture (tiling, 4 blocks),
                                     normal() -> CanvasTexture }       // the terrain pass's `mat` index
    BF.real.assets.rocks.push({ id, biomes, build(rand, detail), material() })

Everything is generated in code (canvas textures, built geometry): no binary files, no downloads.

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
| Foundation | `js/real/core.js`, `terrain.js`, `flora.js`, this document | `index.html`, `js/main.js`, `js/world.js`, `js/mesher.js` (solid part), `js/meshworker.js`, `js/view.js` |
| Water | `js/real/water.js` | the liquid part of `js/mesher.js`, `js/planetrivers.js` (drawing only) |
| Performance | `js/real/lod.js` | `js/lod.js`, `js/lodworker.js`, `js/grid.js`, `js/globe.js` |
| Biome assets | `js/real/assets-biomes.js` (stub on the branch), more `js/real/assets-*.js` on request | `js/textures*.js` only if a block texture must change |
| Atmosphere and creatures | `js/real/atmos.js`, `js/real/mobs.js` | `js/sky.js`, `js/weather.js`, `js/mobs.js`, `js/mobview.js`, `js/entityview.js`, `js/audio.js` |

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

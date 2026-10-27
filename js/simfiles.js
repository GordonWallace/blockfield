// The simulation's files in load order (spec r15-40): the part of index.html's scripts that the headless boot loads (js/boot.js
// BF.boot.headless; tools/headless.js in Node, later a worker and the world server). index.html keeps its own list, with the drawing
// and input files between these; test/headless.js checks that the two agree on the order of the files they share.
// Left out (they draw or take input): faithful, lod, globe, mobview, entityview, cracks, invscreen, commands, coords, mapview, alerts, debugfeed,
// villagerhover, main, audio. Three.js is loaded before these for its maths (Vector3 and friends work without WebGL): headless, from
// the copy of r128 in the repo (.three-test.min.js).
// A new sim file goes in both lists, at the same place; a file that touches the page at load time checks BF.page (js/env.js).
(function (list) {
  if (typeof module !== "undefined" && module.exports) module.exports = list;
  else (globalThis.BF = globalThis.BF || {}).SIM_FILES = list;
})([
  "js/version.js", "js/env.js", "js/gamelog.js", "js/decisioncompare.js", "js/blocks.js", "js/timewarp.js", "js/noise.js",
  "js/rand.js", "js/fx.js", "js/textures.js", "js/textures-colour.js", "js/recipes-colour.js", "js/textures-stone.js",
  "js/textures-light.js", "js/recipes-light.js", "js/textures-shapes.js", "js/textures-jobs.js", "js/textures-bees.js",
  "js/textures-forester.js", "js/textures-furniture.js", "js/textures-miner.js", "js/textures-maps.js", "js/recipes-stone.js",
  "js/recipes-shapes.js", "js/recipes-panes.js", "js/recipes-jobs.js", "js/recipes-maps.js", "js/planet.js", "js/view.js",
  "js/planetgen.js", "js/planetrivers.js", "js/worldgen.js", "js/mesher.js", "js/world.js", "js/requests.js", "js/rworkers.js", "js/blockreqs.js", "js/blockreq.js",
  "js/grid.js", "js/villagesim.js", "js/active.js", "js/farmland.js", "js/grass.js", "js/light.js", "js/skylight.js", "js/sky.js",
  "js/weather.js", "js/ids.js", "js/trading.js", "js/prices.js", "js/market.js", "js/toolwear.js", "js/perf.js", "js/mobs.js",
  "js/mobsave.js", "js/blueprints.js", "js/builder.js", "js/bridges.js", "js/jobs.js", "js/villagelife.js", "js/breeding.js",
  "js/shepherd.js", "js/poultry.js", "js/maps.js", "js/cartography.js", "js/tents.js", "js/explorer.js", "js/forester.js",
  "js/furniture.js", "js/storage.js", "js/miner.js", "js/furnaceuse.js", "js/toolsmith.js", "js/eggcook.js", "js/herd.js",
  "js/cowherd.js", "js/baker.js", "js/glassmaker.js", "js/bees.js", "js/beekeeper.js", "js/pigfarmer.js", "js/fletcher.js",
  "js/playerinv.js", "js/drops.js", "js/boats.js", "js/horses.js", "js/stables.js", "js/merchant.js", "js/sharedtable.js", "js/wildlife.js",
  "js/gameopts.js", "js/player.js", "js/village-names.js", "js/signs.js", "js/logmatch.js", "js/alertsim.js", "js/villagelog.js", "js/economy.js",
  "js/happiness.js", "js/villagestats.js", "js/statehash.js", "js/regions.js", "js/regiontick.js", "js/clusters.js", "js/ctick.js", "js/cworkers.js", "js/villagerstatus.js",
  "js/daytimeline.js",
  "js/save.js", "js/protocol.js", "js/boot.js"
]);

// A Web Worker that works out part of the planet's river network (spec r14-10): the terrain at a range of the network's lattice nodes,
// the slow part of the solve. js/main.js prepareWorld splits the nodes between a few of these and hands the samples to
// BF.worldgen.solveRivers. Message in: { seed, villages, from, to }; out: { from, to, e, p, sea, rain } (arrays over all nodes, filled
// from `from` to `to`).
importScripts("blocks.js", "noise.js", "planet.js", "planetgen.js", "rivers.js", "planetrivers.js", "worldgen.js");
onmessage = ev => {
  const { seed, villages, from, to } = ev.data;
  BF.CS = 16; BF.state = { gen: 4 };
  BF.worldgen.init(BF.makeNoise(seed >>> 0), { gen: 4, villages: villages || 10 });
  const out = BF.worldgen.riverNodes(from, to, BF.planetRivers.newSamples());
  postMessage({ from, to, e: out.e, p: out.p, sea: out.sea, rain: out.rain }, [out.e.buffer, out.p.buffer, out.sea.buffer, out.rain.buffer]);
};

// Background worker for distant terrain (spec r14-05): samples grids of terrain surfaces (js/grid.js) off the main thread. It builds its
// own copy of generator 4 from the world's seed on the first message. The scripts are the generator's sampling path; they use `self`
// where the page has `window`, and nothing that needs a document. A new file on that path (a climate or river module) is added here.
self.window = self;
importScripts("blocks.js", "noise.js", "planet.js", "planetgen.js", "rivers.js", "planetrivers.js", "worldgen.js", "grid.js");
const BF = self.BF;
BF.CS = 16;
onmessage = (e) => {
  const m = e.data;
  if (m.init) {
    BF.state = { gen: m.init.gen, seed: m.init.seed, villages: m.init.villages, biomeScale: m.init.biomeScale };
    BF.worldgen.init(BF.makeNoise(m.init.seed), { gen: m.init.gen, biomeScale: m.init.biomeScale, villages: m.init.villages });
    BF.gridJob.palette(m.palette);
    // the planet's river network (r14-10), solved here once from the node samples the page worked out for it (js/main.js prepareWorld),
    // or from scratch without them
    if (m.init.gen === 4 && BF.worldgen.solveRivers) { let pre = m.init.pre || null; while (BF.worldgen.solveRivers(pre) < 1) pre = null; }
    return;
  }
  if (m.mesh) { const r = BF.gridJob.mesh(m.p, m.raw); postMessage(r, BF.gridJob.meshBuffers(r)); return; }
  const t0 = performance.now(), out = BF.gridJob.alloc(m);
  BF.gridJob.rows(m, out, 0, m.ny);
  if (m.stand) BF.gridJob.stand(m, out);
  out.ms = performance.now() - t0;
  postMessage(out, BF.gridJob.buffers(out));
};

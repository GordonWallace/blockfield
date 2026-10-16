// Trees across the planet's face edges (spec r14-11), node, no browser. Usage: node tools/planet-trees.js [seeds=1337,42]
// Along every side of every face, finds edge chunks where tree-grid features (trees, bushes, ice spikes, boulders, giant mushrooms) stand
// within reach of the edge, and generates each such chunk twice: as itself (canonical) and as its twin in the neighbouring face's margin
// (the same blocks, seen from the other face's frame, where everything on this face reaches it turned through the edge map). Every
// feature block (logs, leaves, packed ice, mushroom blocks, bee nests, boulder stone) must be the same in both, block for block: a tree
// that straddles an edge is decided by the face that owns its cell and drawn whole on both sides. Also checks treesIn against the
// trunks chunk generation draws. Used by test/planet-trees.js.
const { env } = require("./planet-map.js");

function run(seeds, ok, log) {
  const stats = [];
  for (const seed of seeds) {
    const BF = env(seed), W = BF.worldgen, P = BF.planet, B = BF.B, N = P.N, CS = BF.CS;
    const FEAT = new Set(), BOULDER = new Set([B.cobblestone, B.mossy_cobblestone]);
    for (const [k, v] of Object.entries(B)) if (/_log$|_leaves$|^packed_ice$|mushroom_block$|^mushroom_stem$|^bee_nest$|cobblestone$/.test(k)) FEAT.add(v);
    // a column's blocks [lo, hi) from a band
    const col = (band, lx, lz, y) => { const k = y - band.lo * 16; return k < 0 || k >= (band.hi - band.lo) * 16 ? 0 : band.vox[(k * CS + lz) * CS + lx]; };
    let pairs = 0, featBlocks = 0, mism = 0, straddle = 0, first = null;
    const cc = {};
    for (let f = 0; f < 6; f++) for (let s = 0; s < 4; s++) {
      const e = P.EDGE[f][s];
      // chunks of face f along side s (every 64th chunk along the edge)
      for (let k = 2; k < N / CS - 2; k += 61) {
        const u = s === 0 ? 0 : s === 1 ? N - CS : k * CS, v = s === 2 ? 0 : s === 3 ? N - CS : k * CS;
        const a = P.atlas(f, u, v), cx = a.x / CS, cz = a.z / CS;
        // land with trees near the edge? (quick look: the biome by the edge column)
        const h = W.heightAt(a.x + CS / 2, a.z + CS / 2);
        if (h <= BF.SEA + 2) continue;
        // the twin: the chunk of face e.g's frame that shows these blocks (its margin past the side that leads back to f)
        const mid = P.atlas(f, u + CS / 2, v + CS / 2);
        const back = P.UNFOLD[e.g][f]; if (!back) continue;
        // f's point in g's frame: U = A (u, v) + t
        const um = back.A[0] * (u + CS / 2) + back.A[1] * (v + CS / 2) + back.t[0], vm = back.A[2] * (u + CS / 2) + back.A[3] * (v + CS / 2) + back.t[1];
        const tw = P.atlas(e.g, um, vm), tcx = Math.floor(tw.x / CS), tcz = Math.floor(tw.z / CS);
        const A = W.generateBand(cx, cz), Bt = W.generateBand(tcx, tcz);
        pairs++;
        let feats = 0, bad = 0, near = 0;
        const lo = Math.max(A.lo, Bt.lo) * 16, hi = Math.min(A.hi, Bt.hi) * 16;
        for (let lz = 0; lz < CS; lz++) for (let lx = 0; lx < CS; lx++) {
          const X = tcx * CS + lx, Z = tcz * CS + lz, c = P.canonCell(X, Z, cc);
          const ax = c.x - cx * CS, az = c.z - cz * CS;
          if (ax < 0 || ax >= CS || az < 0 || az >= CS) { bad++; continue; }
          const ed = Math.min(c.u, N - 1 - c.u, c.v, N - 1 - c.v);
          const hg = W.heightAt(c.x, c.z);
          for (let y = lo; y < hi; y++) {
            const p = col(A, ax, az, y), q = col(Bt, lx, lz, y);
            if (!FEAT.has(p) && !FEAT.has(q)) continue;
            // (the ground itself may differ in the twin: surface details hashed by the column's coordinates in the asking frame, such as
            // packed ice patches on peaks; the real world never generates a twin. Only boulders sit in the ground.)
            if (y <= hg && !BOULDER.has(p) && !BOULDER.has(q)) continue;
            feats++; if (ed < 2) near++;
            if (p !== q) { bad++; if (!first) first = `seed ${seed} face ${f} side ${s}: ${c.x},${y},${c.z} is ${p} canonically, ${q} through face ${e.g}`; }
          }
        }
        featBlocks += feats; mism += bad; if (near) straddle++;
      }
    }
    ok(mism === 0, `seed ${seed}: edge chunks and their twins through the neighbouring face agree on every tree block (${pairs} pairs, ${featBlocks} feature blocks, ${straddle} with features at the edge${first ? "; first difference: " + first : ""})`);
    ok(straddle >= 3, `seed ${seed}: enough edge chunks have trees right at the edge to mean something (${straddle})`);
    // treesIn matches chunk generation: every trunk treesIn lists on a forested chunk is a log in the generated chunk
    {
      let checked = 0, miss = 0;
      for (let f = 0; f < 6 && checked < 40; f++) for (let k = 0; k < 400 && checked < 40; k++) {
        const u = ((k * 7919) % (N / 16)) * 16, v = ((k * 104729) % (N / 16)) * 16, a = P.atlas(f, u, v);
        if (W.heightAt(a.x + 8, a.z + 8) <= BF.SEA + 2) continue;
        const ts = BF.planetgen.treesIn(f, u >> 2, v >> 2, (u >> 2) + 4, (v >> 2) + 4).filter(t => /oak|birch|spruce|jungle|acacia|cherry|mangrove/.test(t.kind));
        if (!ts.length) continue;
        const band = W.generateBand(a.x / CS, a.z / CS);
        for (const t of ts) {
          if (t.x < a.x || t.x >= a.x + CS || t.z < a.z || t.z >= a.z + CS) continue;
          checked++;
          const id = col(band, t.x - a.x, t.z - a.z, t.kind === "mangrove" ? t.y + 1 : t.y + 1);
          if (!/_log$/.test(Object.keys(B).find(k => B[k] === id) || "")) miss++;
        }
      }
      ok(checked >= 10 && miss === 0, `seed ${seed}: treesIn lists the trees chunk generation grows (${checked} trunks checked, ${miss} missing)`);
    }
    stats.push({ seed, pairs, featBlocks, straddle });
  }
  return stats;
}
if (require.main === module) {
  let fails = 0;
  run((process.argv[2] || "1337,42").split(",").map(Number), (c, m) => { console.log((c ? "ok " : "FAIL ") + m); if (!c) fails++; }, console.log);
  process.exit(fails ? 1 : 0);
}
module.exports = { run };

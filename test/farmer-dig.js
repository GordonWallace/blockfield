// Farmer dirt-digging checks (1.2): node test/run.js /tmp/fd test/farmer-dig.js
// Dirt is taken neatly from outside the village: off natural edges of the land (a bank, a step) first, else from one shallow
// rectangular pit dug out row by row; never scattered single holes. The pit and the dug columns survive a save round trip.
module.exports = async (pg) => {
  const r = await pg.evaluate(() => {
    const out = [], ok = (name, c, info) => out.push((c ? "PASS " : "FAIL ") + name + (c || info === undefined ? "" : " " + JSON.stringify(info)));
    const B = BF.B, W = BF.world, VL = BF.villageLife, X = VL._test, inv = BF.trades.inv;
    const px = Math.floor(BF.player.position.x) + 20, pz = Math.floor(BF.player.position.z) - 10;
    const y0 = W.heightAt(px, pz);
    // flat grass ground well beyond the area the farmer looks at
    const flat = () => {
      for (let x = px - 15; x <= px + 48; x++) for (let z = pz - 15; z <= pz + 35; z++) {
        for (let y = y0 - 3; y <= y0 + 14; y++) W.setBlock(x, y, z, y < y0 ? B.dirt : y === y0 ? B.grass : 0);
      }
    };
    flat();
    // the village box lies to the east: x >= px + 25
    const R = () => ({ key: "digtest" + Math.random(), wg: {} });
    const vd = () => { const D = VL.vdata(R()); D.base = { x0: px + 25, x1: px + 45, z0: pz - 10, z1: pz + 30 }; return D; };
    const farmer = { type: "villager", profession: "farmer", inv: inv.create(), position: new THREE.Vector3(px + 10.5, y0 + 1, pz + 10.5), ai: {} };
    const dig = (D, n) => {
      const got = [];
      for (let i = 0; i < n; i++) {
        const t = X.findGather(farmer, D, null);
        if (!t || !X.gatherBlock(farmer, D, t)) break;
        got.push(t);
        if (inv.count(farmer.inv, B.dirt) > 40) inv.remove(farmer.inv, B.dirt, 40);
      }
      return got;
    };
    // 1. flat ground: one shallow, rectangular pit
    let D = vd(), got = dig(D, 22);
    const xs = got.map(t => t.x), zs = got.map(t => t.z);
    const bw = Math.max(...xs) - Math.min(...xs) + 1, bh = Math.max(...zs) - Math.min(...zs) + 1;
    ok("22 dirt dug on flat ground", got.length === 22, got.length);
    ok("all one block deep", got.every(t => t.y === y0 && W.heightAt(t.x, t.z) === y0 - 1), got.map(t => [t.x, t.z, W.heightAt(t.x, t.z)]));
    ok("no column dug twice", new Set(got.map(t => t.x + "," + t.z)).size === got.length);
    ok("dug cells form one rectangle (last row may be partial)", bw * bh - got.length < Math.max(bw, bh) && bw <= 6 && bh <= 6, { bw, bh, n: got.length });
    ok("first 9 make a 3x3 pit", (() => { const f = got.slice(0, 9); const a = f.map(t => t.x), b = f.map(t => t.z); return Math.max(...a) - Math.min(...a) === 2 && Math.max(...b) - Math.min(...b) === 2; })());
    ok("rim of the farmers' pit is not taken for a natural edge", got.every(t => t.x >= Math.min(...xs) && t.x <= Math.max(...xs)));
    // save round trip of the pit and the dug columns
    const saved = {};
    VL.exportAll(saved);
    const key = Object.keys(saved).find(k => k.startsWith("farmdig:") && saved[k].pit && saved[k].dug.length === 22);
    ok("dig exported", !!key, Object.keys(saved));
    VL.importAll(saved);
    const D2 = VL.vdata({ key: key ? key.slice(8) : "x", wg: {} });
    ok("dig restored", D2.dig.dug.size === 22 && D2.dig.pit && D2.dig.pit.y === y0);
    // 2. a bank: a raised strip 2 high; its lip is cut back first, no pit is begun
    flat();
    for (let x = px + 2; x <= px + 5; x++) for (let z = pz + 4; z <= pz + 16; z++) { W.setBlock(x, y0, z, B.dirt); W.setBlock(x, y0 + 1, z, B.dirt); W.setBlock(x, y0 + 2, z, B.grass); }
    D = vd(); got = dig(D, 12);
    ok("12 dirt from the bank", got.length === 12 && got.every(t => t.x >= px + 2 && t.x <= px + 5 && t.z >= pz + 4 && t.z <= pz + 16), got.map(t => [t.x - px, t.y - y0, t.z - pz]));
    ok("no pit begun beside a bank", !D.dig.pit);
    ok("no hole below the flat ground", got.every(t => W.heightAt(t.x, t.z) >= y0));
    return out;
  });
  console.log(r.join("\n"));
};

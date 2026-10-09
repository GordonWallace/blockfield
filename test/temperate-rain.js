// Rain, not snow, on temperate land in mile-high worlds; snow stays on cold biomes (bug-016):
// NODE_PATH=$(npm root -g) node test/run.js /tmp/tr test/temperate-rain.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(3000);
  const fails = [];
  const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
  const r = await pg.evaluate(() => {
    const stats = {};
    for (let i = 0; i < 3000; i++) {
      const x = Math.round((Math.sin(i * 12.9898) * 43758.5453 % 1) * 20000), z = Math.round((Math.sin(i * 78.233) * 12543.123 % 1) * 20000);
      const h = BF.worldgen.heightAt(x, z);
      if (h < 1) continue;
      const s = stats[BF.worldgen.biomeAt(x, z).name] || (stats[BF.worldgen.biomeAt(x, z).name] = [0, 0, 0]);   // dry, rain, snow
      s[BF.weather.precipAt(x, z, h + 1)]++;
    }
    const p = BF.player.position;
    return { stats, spawn: [BF.worldgen.biomeAt(p.x, p.z).name, BF.weather.precipAt(p.x, p.z, p.y)] };
  });
  console.log(JSON.stringify(r));
  const share = (names, k) => { let a = 0, n = 0; for (const b of names) { const s = r.stats[b]; if (s) { a += s[k]; n += s[0] + s[1] + s[2]; } } return n ? a / n : 1; };
  check(r.spawn[1] === 1, "it rains at spawn (" + r.spawn[0] + ")");
  check(share(["Plains", "Forest", "Birch Forest", "Taiga", "Dark Forest", "Flower Forest"], 2) < 0.05, "temperate plains and forests almost never snow");
  check(share(["Snowy Plains", "Snowy Taiga", "Ice Spikes", "Jagged Peaks", "Snowy Slopes"], 2) > 0.9, "snowy biomes and high peaks still snow");
  check(share(["Desert", "Savanna", "Badlands"], 0) > 0.9, "deserts stay dry");
  if (fails.length) console.log("FAIL " + fails.length + " check(s)");
};

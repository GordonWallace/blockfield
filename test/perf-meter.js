// @ci integration suite=ui hosts=worker,server
// Villager-seconds meter (spec r15-01, js/perf.js). In the seed 123 village: with the meter off, 50 steps run no timing point (BF.perf.laps
// stays 0); with it on, 200 steps of 0.05 s give V·s/s within 1% of villagers x game seconds / real seconds measured here, and the split
// by subsystem adds up to within 10% of the ms per step measured here. Then F3 shows the Sim line, a frozen game greys it, and the
// game log has the meter's on and off lines. The meter and the steps are the simulation's (lib.sim, spec r15-43); F3 is the page's, its
// Sim line from the f3 query (off the page, F3 showing turns the meter on there).
// node test/run.js /tmp/pm test/perf-meter.js [--host page|worker|server]
const lib = require('./lib');
module.exports = async (pg) => {
  await lib.toVillage(pg);
  const fails = [];
  const r = await lib.sim(pg, () => {
    const P = BF.perf, out = {};
    const alive = () => { let v = 0; for (const m of BF.mobs.list) if (!m.dead && !m.removed && m.type === "villager") v++; return v; };
    out.offOn = P.on; out.lapsBefore = P.laps;
    for (let i = 0; i < 50; i++) BF.simStep(0.05);
    out.lapsOff = P.laps;
    P.ask(true); P.reset();
    let vs = 0, game = 0;
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) { BF.simStep(0.05); vs += alive() * 0.05; game += 0.05; }
    const t1 = performance.now();
    const s = P.stats(), tot = P.totals();
    out.villagers = alive(); out.real = (t1 - t0) / 1000; out.game = game; out.expVss = vs / out.real;
    out.vss = s.vss; out.mobss = s.mobss; out.msPerStep = s.msPerStep; out.split = s.split; out.tot = tot;
    out.wallMsPerStep = (t1 - t0) / 200;
    out.splitSum = Object.values(tot.split).reduce((a, b) => a + b, 0) / tot.steps;
    out.text = P.text(s);
    P.ask(false);
    out.onAfter = P.on;
    const l0 = P.laps; BF.simStep(0.05); out.lapsAfterOff = P.laps - l0;
    return out;
  });
  console.log(`villagers ${r.villagers}, ${r.real.toFixed(2)} s real for ${r.game.toFixed(1)} game s: meter ${r.vss.toFixed(1)} V·s/s, expected ${r.expVss.toFixed(1)}; ` +
    `${r.mobss.toFixed(0)} mob-s/s; ${r.msPerStep.toFixed(3)} ms/step (wall ${r.wallMsPerStep.toFixed(3)}), split sums to ${r.splitSum.toFixed(3)}`);
  console.log(r.text);
  if (r.offOn) fails.push('meter on before anything asked for it');
  if (r.lapsBefore !== 0 || r.lapsOff !== 0) fails.push(`timing points ran with the meter off: ${r.lapsBefore}, ${r.lapsOff}`);
  if (r.villagers < 5) fails.push(`only ${r.villagers} villagers loaded`);
  if (Math.abs(r.vss - r.expVss) > 0.01 * r.expVss) fails.push(`V·s/s ${r.vss.toFixed(2)} not within 1% of ${r.expVss.toFixed(2)}`);
  if (Math.abs(r.tot.vs - r.expVss * r.real) > 1e-6 * r.tot.vs + 1e-9) fails.push(`villager-seconds total ${r.tot.vs} != ${r.expVss * r.real}`);
  if (Math.abs(r.splitSum - r.wallMsPerStep) > 0.1 * r.wallMsPerStep) fails.push(`split sums to ${r.splitSum.toFixed(3)} ms, not within 10% of ${r.wallMsPerStep.toFixed(3)} ms per step`);
  if (Math.abs(r.msPerStep - r.splitSum) > 0.1 * r.splitSum) fails.push(`ms/step ${r.msPerStep} vs split ${r.splitSum}`);
  if (!(r.split.villagers > 0) || !(r.split.world > 0)) fails.push('no villager or world time in the split: ' + JSON.stringify(r.split));
  if (r.onAfter || r.lapsAfterOff) fails.push(`meter still timing after the harness let go: on ${r.onAfter}, ${r.lapsAfterOff} points`);

  // F3: the Sim line while the game runs; frozen (0x), the line keeps its figures, greyed
  await pg.keyboard.press('F3');
  await pg.waitForFunction(() => /Sim \d+ V·s\/s .* ms\/step/.test(document.getElementById('debug').textContent), null, { timeout: 30000, polling: 250 }).catch(() => fails.push('F3 has no Sim line'));
  const f3 = await pg.evaluate(() => document.getElementById('debug').textContent.split('\n').find(l => l.startsWith('Sim ')));
  console.log('F3: ' + f3);
  await pg.evaluate(() => BF.warp.freeze());
  await pg.waitForFunction(() => !!document.querySelector('#debug span'), null, { timeout: 30000, polling: 250 }).catch(() => fails.push('frozen game: the Sim line is not greyed'));
  // (the frozen warp reaches the simulation with its next message, and the meter goes stale once no step has run for a while: poll for it)
  let fs = null;
  for (let i = 0; i < 60 && !(fs = await lib.sim(pg, () => BF.perf.stats())).stale; i++) await pg.waitForTimeout(250);
  const frozen = { s: fs, span: await pg.evaluate(() => (document.querySelector('#debug span') || {}).textContent) };
  if (!frozen.s.stale) fails.push('frozen game: the meter is not stale');
  console.log('frozen: ' + frozen.span);
  if (!(frozen.s.vss > 0) || !isFinite(frozen.s.msPerStep)) fails.push('frozen: last figures not kept ' + JSON.stringify(frozen.s));
  await pg.evaluate(() => BF.warp.set(0));
  await pg.keyboard.press('F3');
  await pg.waitForTimeout(500);
  await lib.sim(pg, () => new Promise(r => setTimeout(r, 2500)));   // (off the page the meter goes off once F3 has stopped asking)
  const log = await lib.sim(pg, () => BF.glog.recent(200).filter(e => e && JSON.stringify(e).includes('Performance meter')).map(e => JSON.stringify(e)));
  console.log('log: ' + log.join(' | '));
  if (!log.some(l => l.includes('Performance meter on (a harness)'))) fails.push('no "meter on" log line');
  if (!log.some(l => /Performance meter off: \d+ V·s\/s/.test(l))) fails.push('no "meter off" log line with figures');
  if (await lib.sim(pg, () => BF.perf.on)) fails.push('meter still on with F3 closed');
  if (fails.length) fails.forEach(f => console.log('FAIL ' + f));
  else console.log('PASS perf-meter');
};

// @ci baseline suite=village,jobs,world timeout=900
// Polls replaced by indexes (spec r15-62): the hostile scans of villagers, golems and monsters read the mob grid's counts and the region
// index's hostiles (js/mobs.js nearestMob kind, villagerInDanger; js/regions.js hostilesAround), and the fletcher's seller lookups read
// the village's offer table (js/furnaceuse.js). They must give the old answers, so the world comes out the same. Headless, seed 3:
//   - verify: BF.regions.verifyQueries and BF.polls.verify on for a while: every skipped scan also runs in full and must agree, the
//     offer table matches a full scan (BF.debug.checkOffers), and the region index (with its hostiles) matches the mobs;
//   - a zombie walking up to the village: the tick a villager first flees it and the tick a golem first goes for it are the same with the
//     skipping on as with it off (BF.polls.off: every scan in full), and so is the world hash afterwards.
// Each run is its own Node process (the simulation loads once a process).
// Usage: node test/poll-events.js [seed=3] [seconds=120]
const path = require('path'), cp = require('child_process');
const seed = +(process.argv[2] || 3), seconds = +(process.argv[3] || 120);

if (process.argv[4] === '--child') {
  const mode = process.argv[5];
  const { load } = require(path.join(__dirname, '..', 'tools', 'headless.js'));
  const { BF } = load();
  const h = BF.boot.headless({ seed, settings: { at: 'village' } });
  const out = { mode };
  if (mode === 'verify') {
    BF.regions.verifyQueries = true; BF.regions.resetQueryStats();
    BF.polls.verify = true; BF.polls.reset();
    BF.debug.checkOffers = true; BF.debug.offerStats = null;
    h.tick(seconds * 20);
    const q = BF.regions.queryStats();
    out.diffs = q.diffs; out.last = q.last; out.polls = BF.polls.stats(); out.pollDiffs = BF.polls.diffs;
    out.offers = BF.debug.offerStats; out.check = BF.regions.check().count;
  } else {
    BF.polls.off = mode === 'off';
    h.tick(200);   // (settled)
    BF.sky.setTime(0.3);   // late morning: villagers out and about
    const vs = BF.mobs.list.filter(m => m.type === 'villager' && !m.dead && !m.removed && !m.child && m.onGround && !m.inWater);
    const P = BF.player.position;
    vs.sort((a, b) => Math.hypot(a.position.x - P.x, a.position.z - P.z) - Math.hypot(b.position.x - P.x, b.position.z - P.z));
    // a zombie 13 blocks from the villager nearest the player, on open ground: it hunts villagers within 16 (zombieHuntVillagers)
    let z = null;
    for (const v of vs.slice(0, 10)) {
      for (let a = 0; a < 16 && !z; a++) {
        const x = Math.floor(v.position.x + Math.cos(a * Math.PI / 8) * 13), zz = Math.floor(v.position.z + Math.sin(a * Math.PI / 8) * 13);
        const y = BF.world.heightAt(x, zz) + 1;
        if (Math.abs(y - v.position.y) > 3 || !BF.mobs.standable(x, y, zz, 0.3, 1.95)) continue;
        z = BF.mobs.spawn('zombie', x + 0.5, y, zz + 0.5);
      }
      if (z) { out.villager = v.id; break; }
    }
    out.zombie = !!z;
    for (let t = 1; t <= 40 * 20 && z; t++) {
      h.tick(1);
      if (out.flee == null && BF.mobs.list.some(m => m.type === 'villager' && m.ai.threat === z)) out.flee = t;
      if (out.golem == null && BF.mobs.list.some(m => m.def.golem && m.ai.foe === z)) out.golem = t;
      if (z.dead || z.removed) { out.zombieGone = t; break; }
    }
    h.tick(20 * 20);
    out.hash = h.stateHash().hash;
  }
  console.log('RESULT ' + JSON.stringify(out));
  require('process').exit();
}

let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const run = mode => {
  const r = cp.spawnSync(process.execPath, [__filename, String(seed), String(seconds), '--child', mode], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  if (!line) { console.log((r.stdout || '').slice(-2000), (r.stderr || '').slice(-2000)); return null; }
  return JSON.parse(line.slice(7));
};

const v = run('verify');
check(!!v, 'verify run finished');
if (v) {
  console.log('polls: ' + JSON.stringify(v.polls));
  const scans = ['villager zombie scan', 'golem hostile scan', 'golem rescue scan', 'hostile golem scan'];
  check(scans.every(k => v.polls[k] && v.polls[k].checks > 0), 'every converted scan ran: ' + scans.map(k => k + ' ' + (v.polls[k] ? v.polls[k].checks : 0)).join(', '));
  check(v.diffs === 0, `skipped and indexed scans agree with full scans (${v.diffs} differences${v.last ? ', last ' + JSON.stringify(v.last) : ''})`);
  check(v.pollDiffs === 0, `no skipped check differs from running it (${v.pollDiffs})`);
  check(!v.offers || v.offers.mismatches === 0, `offer table lookups agree with full scans (${v.offers ? v.offers.calls + ' calls, ' + v.offers.mismatches + ' mismatches' : 'none made'})`);
  check(v.check === 0, `region index (hostiles too) matches the mobs (${v.check} differences)`);
}
const on = run('on'), off = run('off');
check(!!on && !!off, 'zombie runs finished');
if (on && off) {
  console.log('skipping on: ' + JSON.stringify(on) + '\nskipping off: ' + JSON.stringify(off));
  check(on.zombie && on.flee != null, `a villager flees the zombie (tick ${on.flee})`);
  check(on.flee === off.flee, `first flee on the same tick as with every scan in full (${on.flee} / ${off.flee})`);
  check(on.golem === off.golem, `a golem goes for it on the same tick (${on.golem} / ${off.golem})`);
  check(on.hash === off.hash, `same world hash afterwards (${on.hash} / ${off.hash})`);
}
console.log(fails ? `FAILED ${fails}` : 'all ok');
process.exit(fails ? 1 : 0);

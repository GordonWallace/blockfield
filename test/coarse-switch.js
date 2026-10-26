// @ci integration suite=village timeout=600
// Far villages coarse mode (spec r15-64), headless: the per-world option and the switch, not the activity bar (test/coarse-parity.js).
//  - off (the default): no mob is ever coarse, and none gets the coarse fields;
//  - turned on in game: the far villages' villagers go coarse at the next tick, the near village stays full detail, the game log says so
//    (INFO "options", INFO "coarse" per village), and switching makes and loses nothing: the census is the same just before and just after;
//  - coarse villagers walk their routes (positions change) and stand in cells they can stand in;
//  - turned off: every mob is back to full detail, each within a block of where it was and not inside a block;
//  - the option is saved with the world and comes back with it; --coarse (the override) wins for the run without being saved.
// node test/coarse-switch.js
const { load } = require('../tools/headless.js');
const fails = [];
const ok = (what, c, d) => { console.log((c ? 'ok   ' : 'FAIL ') + what + (d !== undefined && !c ? ' ' + JSON.stringify(d) : '')); if (!c) fails.push(what); };

try {
  const { BF } = load();
  const h = BF.boot.headless({ seed: 3, settings: { at: 'village', extra: 3 } });
  const G = BF.gameOpts, M = BF.mobs;
  const coarseMobs = () => M.list.filter(m => m._crsT !== undefined);
  const census = () => JSON.stringify(BF.perf.census());
  const inBlock = m => BF.world.boxCollides(m.position.x, m.position.y + 0.01, m.position.z, m.halfWidth * 0.9, Math.min(m.height, 1.8) - 0.02);

  // ---- off by default
  h.tick(200);
  ok('a new world has far villages at full detail', G.coarse() === false && G.coarseOpt() === false && G.all().coarse === false, G.all());
  ok('off: no mob is coarse or carries the coarse fields', M.list.every(m => m._crsT === undefined && m._fineT === undefined) && M.coarse().n === 0);

  // ---- on, in game
  const c0 = census();
  G.set('coarse', true);
  const c1 = census();
  ok('switching on makes and loses nothing', c0 === c1);
  h.tick(1);
  const view = BF.world.viewDist * BF.CS, pp = BF.player.position;
  const far = M.list.filter(m => m.type === 'villager' && !m.dead && Math.hypot(m.position.x - pp.x, m.position.z - pp.z) > view + 4);
  const near = M.list.filter(m => m.type === 'villager' && !m.dead && Math.hypot(m.position.x - pp.x, m.position.z - pp.z) < view - 4);
  ok('far villages simulated', far.length >= 20, far.length);
  ok('on: far villagers go coarse at the next tick (all but those in a fight)', far.filter(m => m._crsT === undefined).length <= 2, far.filter(m => m._crsT === undefined).length);
  ok('on: the near village stays full detail', near.length > 0 && near.every(m => m._crsT === undefined), near.length);
  const at = new Map(far.map(m => [m, m.position.clone()]));
  h.tick(20 * 60);
  const log = BF.glog.recent(4000);
  ok('the switch is in the game log (INFO options)', log.some(e => e.l === 'INFO' && e.k === 'options' && /Far villages: coarse/.test(e.x)));
  ok('each far village going coarse is in the game log (INFO coarse)', log.filter(e => e.l === 'INFO' && e.k === 'coarse' && /coarse \(/.test(e.x)).length >= 3);
  ok('F3 shows the mode', /Far villages: coarse \(\d+ mobs\)/.test(BF.perf.text({ vss: 0, mobss: 0, msPerStep: 0, split: Object.fromEntries(Object.keys(BF.perf.split()).map(k => [k, 0])), far: M.coarse() })));
  const movedN = far.filter(m => !m.dead && !m.removed && at.get(m).distanceTo(m.position) > 2).length;
  ok('coarse villagers still get about (their routes)', movedN >= far.length / 4, { moved: movedN, of: far.length });
  const stuck = coarseMobs().filter(m => m.type === 'villager' && !m.sleeping && inBlock(m));
  ok('coarse villagers stand in open cells', stuck.length <= 2, stuck.map(m => [m.id, m.position.x.toFixed(2), m.position.y.toFixed(2), m.position.z.toFixed(2)]));

  // ---- off again
  const before = new Map(coarseMobs().map(m => [m, m.position.clone()]));
  const c2 = census();
  G.set('coarse', false);
  ok('switching off makes and loses nothing', c2 === census());
  h.tick(1);
  ok('off: every mob is back to full detail', coarseMobs().length === 0);
  const jumped = [...before].filter(([m, p]) => !m.removed && !m.dead && p.distanceTo(m.position) > 1.8);
  ok('back to full detail within a block or so of where it was', jumped.length === 0, jumped.slice(0, 5).map(([m, p]) => [m.type, p.distanceTo(m.position).toFixed(2)]));
  const inside = [...before.keys()].filter(m => !m.removed && !m.dead && !m.sleeping && inBlock(m));
  ok('and not inside a block', inside.length <= 2, inside.map(m => [m.type, m.position.x.toFixed(2), m.position.y.toFixed(2), m.position.z.toFixed(2)]));

  // ---- saved with the world; the override wins for a run and is not saved
  G.set('coarse', true);
  const data = h.save();
  ok('the save carries the option', data.monsters && data.monsters.coarse === true && data.monsters.zombie === true, data.monsters);
  G.setAll({});
  ok('another world: full detail', G.coarse() === false);
  BF.save.restore(JSON.parse(JSON.stringify(data, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v))), null);
  ok('the world comes back coarse', G.coarseOpt() === true && G.coarse() === true);
  G.override(false);
  ok('--coarse off overrides it for the run', G.coarse() === false && G.coarseOpt() === true);
  ok('and the save still says coarse', h.save().monsters.coarse === true);
  G.override(null);
  ok('the override cleared: the world option again', G.coarse() === true);
  ok('a world saved before the option: full detail', G.normalize(undefined).coarse === false && G.normalize({ zombie: true }).coarse === false);
} catch (e) { console.log('FAIL ' + (e.stack || e)); fails.push('threw'); }
if (fails.length) { console.log('FAIL ' + fails.length + ' check(s)'); process.exit(1); }
console.log('PASS');
process.exit(0);

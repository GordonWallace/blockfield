// Tool economy soak test (release 1.1): miners, foresters, farmers and shepherds work with tools that wear out; the toolsmith makes
// new ones from ingots, sticks and planks it buys from miners and foresters (smelting ore in a furnace from the furniture maker when it must).
// Usage: NODE_PATH=$(npm root -g) node test/toolchain.js <seeds e.g. 1,2,3> [days=3] [villagesPerSeed=3] [out.json]
// Env: ONLY=x,z runs one village. NEED=toolsmith,miner only takes villages with those professions. FURNACE_TICK=1 also calls
// BF.inventory.update (furnaces cook in BF.inventory.simTick when it exists, called every step). VERBOSE=1 prints log samples.
// Drives the simulation directly (no rendering), like test/bedchain.js and test/minechain.js. For each village it records, per game hour:
// every villager's tools (with wear), level, key materials, position and status; plus every trade, tool use and break, block broken by
// a villager (ores with their depth below the surface), village log entry and furnace state. Prints one block per village and a summary,
// and FAILs when a tool-using villager spends the whole run unable to work, or a page error happens.
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seeds = (process.argv[2] || '1337').split(',').map(Number);
const DAYS = +(process.argv[3] || 3);
const PER_SEED = +(process.argv[4] || 3);
const OUT = process.argv[5] || null;
const NEED = (process.env.NEED || '').split(',').filter(Boolean);

let b, pageErrors = 0;
async function openWorld(seed) {
  const pg = await b.newPage({ viewport: { width: 320, height: 200 } });
  pg.on('pageerror', e => { pageErrors++; console.log('PAGEERROR', e.stack || e.message); });
  pg.on('console', m => { if (m.type() === 'error') console.log('console.error:', m.text().slice(0, 300)); });
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto('file://' + path.join(root, 'index.html') + '#seed' + seed);
  await pg.waitForTimeout(3000);
  await pg.evaluate(() => { window.__halt = true; if (BF.player.setGameMode) BF.player.setGameMode('creative'); });
  return pg;
}

// ---- in-page recorder, installed before the villagers spawn (starting kits are handed out at spawn)
function install(key) {
  const R = window.__rec = { key, trades: [], calls: [], uses: {}, breaks: [], dug: {}, logs: [], minerLog: [], snaps: [], furn: [], lastTools: {}, appeared: [], vanished: [] };
  const day = () => +(BF.sky.day + BF.sky.time).toFixed(3);
  const inV = m => m && m.village && m.village.key === window.__rec.key;
  // a unique label per villager (names can repeat within a village)
  const who = window.__who = m => (m && m.type === 'villager') ? BF.vlog.nameOf(m) + '#' + (m.__tcid || (m.__tcid = window.__tcn = (window.__tcn || 0) + 1)) : String(m);
  if (window.__hooked) return;
  window.__hooked = true;
  const owner = new WeakMap();
  const findOwner = s => {
    if (owner.has(s)) return owner.get(s);
    const m = BF.mobs.list.find(m => m.type === 'villager' && Array.isArray(m.inv) && m.inv.includes(s)) || null;
    owner.set(s, m);
    return m;
  };
  const oTrade = BF.vlog.trade;
  BF.vlog.trade = function (buyer, seller, o, times) {
    const r = window.__rec;
    if (r && (inV(buyer) || inV(seller)))   // every trade as given, for checking the Economy view's tallies (js/economy.js) at the end
      r.calls.push([buyer === 'player' ? 'Player' : BF.vlog.pretty(buyer.profession), BF.vlog.pretty(seller.profession), typeof o === 'object' ? JSON.parse(JSON.stringify(o)) : String(o), times || 1]);
    if (r && o && typeof o === 'object' && o.sell && (inV(buyer) || inV(seller)))
      r.trades.push({ d: day(), buyer: buyer === 'player' ? 'player' : buyer.profession, bName: who(buyer), seller: seller.profession, sName: who(seller),
        item: BF.itemName(o.sell.id), n: o.sell.n * (times || 1), paid: o.buy.map(x => x.n * (times || 1) + ' ' + BF.itemName(x.id)).join(' + ') });
    return oTrade.apply(this, arguments);
  };
  const oLog = BF.vlog.log;
  BF.vlog.log = function (rec, kind, text) {
    const r = window.__rec;
    if (r && rec && rec.key === r.key && kind !== 'trade') r.logs.push([day(), kind, String(text)]);
    return oLog.apply(this, arguments);
  };
  const oWear = BF.wearStack;
  BF.wearStack = function (s, n) {
    const res = oWear.apply(this, arguments);
    const r = window.__rec, m = s && res ? findOwner(s) : null;
    if (r && m && inV(m)) {
      const k = m.profession + ' ' + BF.itemName(s.id);
      r.uses[k] = (r.uses[k] || 0) + (n || 1);
      if (res === 'broken') r.breaks.push({ d: day(), prof: m.profession, name: who(m), tool: BF.itemName(s.id) });
    }
    return res;
  };
  const oEmit = BF.emit;
  BF.emit = function (ev, x, y, z, id) {
    const r = window.__rec;
    if (r && ev === 'blockBroken' && typeof id === 'number') {
      const n = BF.itemName(id);
      if (/ore|Debris|Raw/i.test(n)) {
        const surf = BF.worldgen.heightAt(x, z), depth = surf - y, k = n;
        const e = r.dug[k] || (r.dug[k] = { n: 0, minDepth: 1e9, maxDepth: -1e9, minY: 1e9 });
        e.n++; e.minDepth = Math.min(e.minDepth, depth); e.maxDepth = Math.max(e.maxDepth, depth); e.minY = Math.min(e.minY, y);
      }
    }
    return oEmit.apply(this, arguments);
  };
}

// The Economy view's tallies (js/economy.js) against the soak's own record of every trade: goods per seller, buyer and item must match.
// Dead ends: a toolsmith the soak saw "Waiting for gold ..." must show as wanting it, and a miner holding cobblestone it hasn't sold
// for 2 days must show as holding it.
function econCheck() {
  const R = window.__rec, E = BF.econ, out = [];
  if (!E) return ['FAIL economy: BF.econ missing'];
  const nm = id => BF.itemName(id).replace(/ Item$/, ''), want = {};
  const add = (k, n) => { want[k] = (want[k] || 0) + n; };
  for (const [b, s, o, t] of R.calls) {
    let gave, got;
    if (typeof o === 'object') { gave = o.buy.map(x => [nm(x.id), x.n * t]); got = [[nm(o.sell.id), o.sell.n * t]]; }
    else { const m = /gave (.+?), got (.+)$/.exec(o); if (!m) continue; const st = x => x.split(' + ').map(y => /^(\d+) (.+)$/.exec(y.trim())).filter(Boolean).map(r => [r[2].replace(/ Item$/, ''), +r[1]]); gave = st(m[1]); got = st(m[2]); }
    for (const [it, n] of got) if (it !== 'Emerald') add(s + '|' + b + '|' + it, n);
    for (const [it, n] of gave) if (it !== 'Emerald') add(b + '|' + s + '|' + it, n);
  }
  const have = {}, v = E.view(R.key);
  for (const d in v.days) for (const f of v.days[d].f) have[f[0] + '|' + f[1] + '|' + f[2]] = (have[f[0] + '|' + f[1] + '|' + f[2]] || 0) + f[4];
  const keys = new Set([...Object.keys(want), ...Object.keys(have)]), bad = [...keys].filter(k => (want[k] || 0) !== (have[k] || 0));
  out.push((bad.length ? 'FAIL' : 'PASS') + ` economy tallies match the soak's ${R.calls.length} trades (${keys.size} flows)` + (bad.length ? ': ' + bad.slice(0, 5).map(k => k + ' soak ' + (want[k] || 0) + ' tally ' + (have[k] || 0)).join('; ') : ''));
  // dead ends
  const rec = BF.mobs.villages.get(R.key), w = {};
  if (rec) E.scan(rec);
  const v2 = E.view(R.key);
  for (const d in v2.days) for (const x of v2.days[d].w) w[x[0] + '|' + x[1]] = (w[x[0] + '|' + x[1]] || 0) + x[2];
  const waits = new Set();
  for (const sn of R.snaps) for (const x of sn.vs) { const m = x.prof === 'toolsmith' && /^Waiting for (\w+)/.exec(x.status || ''); if (m) waits.add(m[1][0].toUpperCase() + m[1].slice(1)); }
  for (const mat of waits) out.push((w['Toolsmith|' + mat] ? 'PASS' : 'FAIL') + ` economy: the toolsmith's wait for ${mat} is a dead end (${w['Toolsmith|' + mat] || 0} h)`);
  const today = v2.days[v2.today], now = BF.sky.day + BF.sky.time, cob = BF.I.cobblestone;
  for (const m of (rec ? rec.members : [])) {
    if (m.profession !== 'miner' || m.dead || !m.position || !(m.trades || []).some(o => o.sell.id === cob)) continue;
    const held = BF.trades.inv.count(m.inv, cob), name = BF.vlog.nameOf(m), first = R.snaps[0] ? R.snaps[0].d : now;
    const lastSale = Math.max(first, ...R.trades.filter(t => t.sName === window.__who(m) && t.item === 'Cobblestone').map(t => t.d));
    if (held < 1 || now - lastSale < E.STUCK) continue;
    const line = today && today.s.find(r => r[0] === name && r[2] === 'Cobblestone');
    out.push((line ? 'PASS' : 'FAIL') + ` economy: miner ${name}'s unsold cobblestone (${held}, last sold day ${lastSale.toFixed(2)}) is a dead end` + (line ? ' (' + line[4] + ' days)' : ''));
  }
  return out;
}

// One snapshot of the village (every game hour).
function snapshot() {
  const R = window.__rec, key = R.key;
  const isTool = id => { const it = BF.items[id]; return !!(it && (it.tool && typeof it.tool === 'object' || /shears/.test(it.name))); };
  const toolType = id => { const it = BF.items[id]; return it.tool && it.tool.type || (/shears/.test(it.name) ? 'shears' : '?'); };
  const KEY = ['emerald', 'stick', 'iron_ingot', 'gold_ingot', 'raw_iron', 'raw_gold', 'iron_ore', 'gold_ore', 'diamond', 'redstone', 'coal', 'cobblestone', 'torch', 'furnace'];
  const t = BF.sky.time, d = +(BF.sky.day + t).toFixed(3);
  const mem = BF.mobs.list.filter(m => m.type === 'villager' && m.village && m.village.key === key && !m.dead && !m.removed);
  const vs = mem.map(m => {
    const tools = (m.inv || []).filter(s => s && isTool(s.id)).map(s => ({ n: BF.itemName(s.id), type: toolType(s.id), wear: s.wear || 0, max: BF.durability(s.id) }));
    const counts = {};
    for (const k of KEY) { const id = BF.I[k]; if (id != null) { const c = BF.trades.inv.count(m.inv || [], id); if (c) counts[k] = c; } }
    let planks = 0, logs = 0;
    for (const s of m.inv || []) if (s) { const nm = BF.items[s.id].name; if (/_planks$|^planks$/.test(nm)) planks += s.count; if (/_log$|^log$/.test(nm)) logs += s.count; }
    if (planks) counts.planks = planks; if (logs) counts.logs = logs;
    const x = Math.floor(m.position.x), z = Math.floor(m.position.z);
    return { name: window.__who(m), prof: m.profession, level: m.level || 1, xp: m.xp || 0, tools, counts, y: +m.position.y.toFixed(1),
      depth: +(BF.worldgen.heightAt(x, z) - m.position.y).toFixed(1), status: BF.villagerStatus ? BF.villagerStatus.text(m) : '' };
  });
  // tools that appeared / vanished since the last snapshot (net of trades this interval)
  for (const v of vs) {
    const now = {};
    for (const tl of v.tools) now[tl.n] = (now[tl.n] || 0) + 1;
    const was = R.lastTools[v.name];
    if (was) {
      const bought = {}, sold = {};
      for (const tr of R.trades) if (tr.d > R.lastSnapD) { if (tr.bName === v.name) bought[tr.item] = (bought[tr.item] || 0) + tr.n; if (tr.sName === v.name) sold[tr.item] = (sold[tr.item] || 0) + tr.n; }
      const broke = {};
      for (const br of R.breaks) if (br.d > R.lastSnapD && br.name === v.name) broke[br.tool] = (broke[br.tool] || 0) + 1;
      for (const n of new Set([...Object.keys(now), ...Object.keys(was)])) {
        const delta = (now[n] || 0) - (was[n] || 0) - (bought[n] || 0) + (sold[n] || 0) + (broke[n] || 0);
        if (delta > 0) R.appeared.push({ d, prof: v.prof, name: v.name, tool: n, k: delta });
        if (delta < 0) R.vanished.push({ d, prof: v.prof, name: v.name, tool: n, k: -delta });
      }
    }
    R.lastTools[v.name] = now;
  }
  R.lastSnapD = d;
  if (window.__TSTRACE && BF.toolsmith) for (const m of mem) if (m.profession === 'toolsmith') {   // TSTRACE=1: what each toolsmith plans, every hour
    let p = null; try { p = BF.toolsmith.plan(m); } catch (e) { p = { err: String(e) }; }
    const v = vs.find(x => x.name === window.__who(m));
    (R.tstrace = R.tstrace || []).push([d, v.name, p && JSON.stringify(p, (k, x) => typeof x === 'function' ? undefined : x), v.tools.map(t => t.n).join('/'), JSON.stringify(v.counts), v.status, JSON.stringify(m.tsm && m.tsm.waitBetter)]);
  }
  // furnaces near the village centre
  const rec = BF.mobs.villages && BF.mobs.villages.get(key);
  const [cx, cz] = key.split(',').map(Number);
  const furn = [];
  for (const f of BF.inventory.furnaces.values()) if (f.pos && Math.hypot(f.pos.x - cx, f.pos.z - cz) < 96)
    furn.push({ at: f.pos.x + ',' + f.pos.y + ',' + f.pos.z, lit: !!f.lit, slots: f.slots.map(s => s ? BF.itemName(s.id) + 'x' + s.count : null) });
  R.snaps.push({ d, t: +t.toFixed(3), vs, furn });
  return !!rec;
}

(async () => {
  b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const results = [];
  for (const seed of seeds) {
    let pg = await openWorld(seed);
    const villages = await pg.evaluate(n => {
      const vs = BF.worldgen.villagesNear(0, 0, 3000).filter(v => v && v.pop).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
      return vs.slice(0, n * 4).map(v => ({ x: v.x, z: v.z, y: v.y, pop: v.pop, biome: v.biome }));
    }, PER_SEED);
    let done = 0;
    for (const v of villages) {
      if (done >= PER_SEED) break;
      const key = Math.round(v.x) + ',' + Math.round(v.z);
      if (process.env.ONLY && process.env.ONLY !== key) continue;
      const t0 = Date.now();
      if (pg.__used) { await pg.close(); pg = await openWorld(seed); }
      pg.__used = true;
      await pg.evaluate(t => { window.__TSTRACE0 = t; }, !!process.env.TSTRACE);
      await pg.evaluate(install, key);
      await pg.evaluate('window.__snap = ' + snapshot.toString());
      await pg.evaluate('window.__econCheck = ' + econCheck.toString());
      const setup = await pg.evaluate(([v, ft]) => {
        window.__FT = ft; window.__TSTRACE = !!(window.__TSTRACE0);
        const key = Math.round(v.x) + ',' + Math.round(v.z);
        BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
        const step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
        for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) step(0.05); }
        BF.sky.setTime(0.02);
        for (let i = 0; i < 200; i++) { BF.world.update(v.x, v.z, 30); step(0.05); }
        const mem = BF.mobs.list.filter(m => m.type === 'villager' && m.village && m.village.key === key && !m.dead);
        const profs = {};
        for (const m of mem) profs[m.profession] = (profs[m.profession] || 0) + 1;
        return { key, profs, biome: v.biome, style: mem[0] && mem[0].village.style };
      }, [v, !!process.env.FURNACE_TICK]);
      if (!Object.keys(setup.profs).length || NEED.some(p => !setup.profs[p])) { console.log(`seed ${seed} village ${key} pop ${v.pop}: skipped ${JSON.stringify(setup.profs)}`); continue; }
      done++;
      await pg.evaluate(() => window.__snap());
      const h = 0.05, HOUR = Math.round(50 / h), total = Math.round(DAYS * 1200 / h), PER_CALL = HOUR * 4;
      for (let s = 0; s < total; s += PER_CALL) {
        await pg.evaluate(([n, h, v, HOUR]) => {
          const R = window.__rec;
          for (let i = 1; i <= n; i++) {
            BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); if (BF.inventory.simTick) BF.inventory.simTick(h); BF.world.tickSim();
            if (window.__FT) BF.inventory.update(h);
            if (i % 50 === 0) BF.world.update(v.x, v.z, 4);
            if (i % HOUR === 0) window.__snap();
          }
          if (BF.miner && BF.miner.LOG) R.minerLog.push(...BF.miner.LOG.splice(0).filter(e => e.village === R.key));
        }, [Math.min(PER_CALL, total - s), h, v, HOUR]);
      }
      results.push(await summarise(pg, seed, v, setup, t0));
      if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
    }
    await pg.close();
  }
  overall(results);
  await b.close();
  if (pageErrors) { console.log('FAIL page errors: ' + pageErrors); process.exitCode = 1; }
})();

// ---- reporting (node side)
const NEEDS = { miner: 'pickaxe', forester: 'axe', farmer: 'hoe', shepherd: 'shears' };
const TOOL_RE = /Pickaxe|Axe|Hoe|Shears|Shovel|Sword/;
const WORK = t => t >= 0.04 && t <= 0.45;
const add = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const top = (o, n = 6) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => k + ' ' + v).join(', ');

async function summarise(pg, seed, v, setup, t0) {
  const econ = await pg.evaluate(() => window.__econCheck());
  const R = await pg.evaluate(() => { const r = Object.assign({}, window.__rec); delete r.lastTools; delete r.calls; return r; });
  const first = R.snaps[0], last = R.snaps[R.snaps.length - 1];
  const profsEnd = {};
  for (const x of last.vs) add(profsEnd, x.prof);
  const alive = new Set(last.vs.map(x => x.name));
  const died = first.vs.filter(x => !alive.has(x.name)).map(x => x.name + ' (' + x.prof + ')');
  const trades = {}, toolTrades = {};
  for (const t of R.trades) { const k = t.item + ': ' + t.seller + ' > ' + t.buyer; add(trades, k, t.n); if (TOOL_RE.test(t.item)) add(toolTrades, k, t.n); }
  const made = {};
  for (const a of R.appeared) if (a.d > first.d + 0.001) add(made, a.prof + ' got ' + a.tool, a.k);
  const lost = {};
  for (const a of R.vanished) add(lost, a.prof + ' lost ' + a.tool, a.k);
  const breaks = {};
  for (const x of R.breaks) add(breaks, x.prof + ' ' + x.tool);
  // can each tool user work? share of working-hour snapshots holding the tool its job needs
  const per = {};
  for (const s of R.snaps) for (const x of s.vs) {
    const need = NEEDS[x.prof];
    if (!need) continue;
    const p = per[x.name] || (per[x.name] = { prof: x.prof, work: 0, has: 0, best: {}, lvl0: x.level, lvl1: x.level, maxDepth: -1e9, statuses: {} });
    p.lvl1 = x.level; p.maxDepth = Math.max(p.maxDepth, x.depth);
    if (!WORK(s.t)) continue;
    p.work++;
    const tl = x.tools.filter(t => t.type === need);
    if (tl.length) { p.has++; for (const t of tl) add(p.best, t.n); }
    add(p.statuses, x.status);
  }
  const workers = Object.entries(per).map(([name, p]) => ({ name, prof: p.prof, toolShare: p.work ? +(p.has / p.work).toFixed(2) : null, tools: Object.keys(p.best).join('/'),
    level: p.lvl0 + (p.lvl1 !== p.lvl0 ? '>' + p.lvl1 : ''), maxDepth: p.prof === 'miner' ? p.maxDepth : undefined, status: top(p.statuses, 3) }));
  // toolsmith and furnace
  const ts = {};
  for (const s of R.snaps) for (const x of s.vs) if (x.prof === 'toolsmith') {
    const p = ts[x.name] || (ts[x.name] = { stockMax: 0, statuses: {}, counts: {} });
    p.stockMax = Math.max(p.stockMax, x.tools.length); p.end = x.tools.map(t => t.n).join(', '); p.counts = x.counts; p.level = x.level;
    if (WORK(s.t)) add(p.statuses, x.status);
  }
  let litHours = 0, furnMax = 0;
  for (const s of R.snaps) { furnMax = Math.max(furnMax, s.furn.length); if (s.furn.some(f => f.lit)) litHours++; }
  const logKinds = {};
  for (const l of R.logs) add(logKinds, l[1]);
  const minerKinds = {};
  for (const e of R.minerLog) add(minerKinds, e.kind);
  const row = { seed, key: setup.key, biome: setup.biome, pop: v.pop, profs: setup.profs, profsEnd, died, trades, toolTrades, made, lost, breaks, uses: R.uses, dug: R.dug,
    workers, toolsmiths: ts, furnaces: { max: furnMax, litHours, end: last.furn }, logKinds, minerKinds, logs: R.logs, trades_: R.trades, secs: Math.round((Date.now() - t0) / 1000) };
  console.log(`\n== seed ${seed} village ${row.key} (${row.biome}) pop ${row.pop}, ${DAYS} days, ${row.secs}s`);
  console.log('   professions', JSON.stringify(row.profs), '-> end', JSON.stringify(profsEnd), died.length ? 'died: ' + died.join(', ') : '');
  console.log('   tool trades:', top(toolTrades, 20) || 'none');
  console.log('   other trades:', top(Object.fromEntries(Object.entries(trades).filter(([k]) => !TOOL_RE.test(k))), 20) || 'none');
  console.log('   tools appeared (made / kit / crafted):', top(made, 20) || 'none');
  if (Object.keys(lost).length) console.log('   tools vanished (not sold or broken):', top(lost, 10));
  console.log('   broke:', top(breaks, 20) || 'none', '| uses:', top(R.uses, 12));
  console.log('   ores dug:', Object.entries(R.dug).map(([k, e]) => `${k} ${e.n} (depth ${e.minDepth}-${e.maxDepth}, y>=${e.minY})`).join(', ') || 'none');
  for (const w of workers) console.log(`   ${w.prof.padEnd(9)} ${w.name.padEnd(18)} tool ${w.toolShare === null ? '-' : Math.round(w.toolShare * 100) + '%'} [${w.tools}] level ${w.level}${w.maxDepth !== undefined ? ' deepest ' + w.maxDepth : ''} | ${w.status}`);
  for (const [n, p] of Object.entries(ts)) console.log(`   toolsmith ${n}: level ${p.level}, stock max ${p.stockMax}, end [${p.end}], has ${JSON.stringify(p.counts)} | ${top(p.statuses, 3)}`);
  console.log(`   furnaces: up to ${furnMax}, lit ${litHours} h`, JSON.stringify(last.furn));
  console.log('   village log kinds:', JSON.stringify(logKinds), 'miner log:', JSON.stringify(minerKinds));
  if (process.env.TSTRACE) for (const l of R.tstrace || []) console.log('     ts', JSON.stringify(l));
  if (process.env.VERBOSE) for (const l of R.logs.slice(-40)) console.log('     log', JSON.stringify(l));
  for (const l of econ) console.log(l.startsWith('FAIL') ? l : '   ' + l);
  for (const w of workers) if (w.toolShare === 0) console.log(`WARN seed ${seed} village ${row.key}: ${w.prof} ${w.name} never held a ${NEEDS[w.prof]} during work hours`);
  return row;
}

// Which of the requested 1.1 capabilities happened at least once, and in how many villages.
const CAPS = [
  ['forester bought an axe', r => r.trades_.some(t => t.buyer === 'forester' && /Axe$/.test(t.item) && !/Pickaxe/.test(t.item))],
  ['forester sold sticks', r => r.trades_.some(t => t.seller === 'forester' && t.item === 'Stick')],
  ['forester sold sticks to the toolsmith', r => r.trades_.some(t => t.seller === 'forester' && t.buyer === 'toolsmith' && t.item === 'Stick')],
  ['toolsmith made a tool', r => r.logs.some(l => l[1] === 'craft') || Object.keys(r.made).some(k => k.startsWith('toolsmith'))],
  ['toolsmith used a furnace (village log)', r => r.logs.some(l => l[1] === 'furnace')],
  ['toolsmith made a gold tool', r => Object.keys(r.made).some(k => k.startsWith('toolsmith') && /Gold/.test(k))],
  ['toolsmith made a diamond tool', r => Object.keys(r.made).some(k => k.startsWith('toolsmith') && /Diamond/.test(k))],
  ['toolsmith made shears', r => Object.keys(r.made).some(k => k.startsWith('toolsmith') && /Shears/.test(k))],
  ['toolsmith bought raw ore from a miner', r => r.trades_.some(t => t.buyer === 'toolsmith' && t.seller === 'miner' && /Raw|Ore/.test(t.item))],
  ['toolsmith bought ingots', r => r.trades_.some(t => t.buyer === 'toolsmith' && /Ingot/.test(t.item))],
  ['toolsmith bought planks/logs/cobblestone/diamond', r => r.trades_.some(t => t.buyer === 'toolsmith' && /Planks|Log|Cobblestone|Diamond|Coal/.test(t.item))],
  ['toolsmith bought a furnace', r => r.trades_.some(t => t.buyer === 'toolsmith' && t.item === 'Furnace')],
  ['furniture maker bought cobblestone', r => r.trades_.some(t => t.buyer === 'furniture_maker' && t.item === 'Cobblestone')],
  ['a village furnace was lit', r => r.furnaces.litHours > 0],
  ['miner bought a pickaxe', r => r.trades_.some(t => t.buyer === 'miner' && /Pickaxe/.test(t.item))],
  ['farmer bought a hoe', r => r.trades_.some(t => t.buyer === 'farmer' && /Hoe/.test(t.item))],
  ['shepherd bought shears', r => r.trades_.some(t => t.buyer === 'shepherd' && /Shears/.test(t.item))],
  ['a pickaxe broke', r => Object.keys(r.breaks).some(k => /Pickaxe/.test(k))],
  ['an axe broke', r => Object.keys(r.breaks).some(k => / [A-Z][a-z]+ Axe$/.test(k))],
  ['a hoe broke', r => Object.keys(r.breaks).some(k => /Hoe/.test(k))],
  ['shears broke', r => Object.keys(r.breaks).some(k => /Shears/.test(k))],
  ['a miner levelled up', r => r.workers.some(w => w.prof === 'miner' && />/.test(w.level))],
  ['a miner dug gold ore', r => Object.keys(r.dug).some(k => /Gold/.test(k))],
  ['a miner dug diamond ore', r => Object.keys(r.dug).some(k => /Diamond/.test(k))],
  ['a miner dug redstone ore', r => Object.keys(r.dug).some(k => /Redstone/.test(k))],
  ['a miner sold raw iron / raw gold', r => r.trades_.some(t => t.seller === 'miner' && /Raw (Iron|Gold)/.test(t.item))],
  ['toolsmith made a bucket', r => Object.keys(r.made).some(k => k.startsWith('toolsmith') && /Bucket/.test(k)) || r.logs.some(l => l[1] === 'craft' && /Bucket/.test(l[2]))],
  ['farmer bought a bucket', r => r.trades_.some(t => t.buyer === 'farmer' && /Bucket/.test(t.item))],
  ['miner stored finds in its chest', r => r.logs.some(l => l[1] === 'chest' && /\(Miner\) put /.test(l[2]))],
  ['furniture maker placed a chest for a miner', r => r.logs.some(l => l[1] === 'chest' && /placed a chest .* house of .*\(Miner\)/.test(l[2]))],
  ['a gold tool was traded', r => r.trades_.some(t => /Gold(en)? (Pickaxe|Axe|Hoe|Shovel|Sword)/.test(t.item))],
];
function overall(results) {
  console.log(`\n==== ${results.length} villages, ${DAYS} game days each`);
  const sumT = {}, sumB = {}, sumM = {};
  for (const r of results) { for (const [k, n] of Object.entries(r.toolTrades)) add(sumT, k, n); for (const [k, n] of Object.entries(r.breaks)) add(sumB, k, n); for (const [k, n] of Object.entries(r.made)) add(sumM, k, n); }
  console.log('tool trades:', top(sumT, 30) || 'none');
  console.log('tools appeared:', top(sumM, 30) || 'none');
  console.log('broke:', top(sumB, 30) || 'none');
  const ws = results.flatMap(r => r.workers);
  for (const p of Object.keys(NEEDS)) {
    const w = ws.filter(x => x.prof === p && x.toolShare !== null);
    if (w.length) console.log(`${p}s: ${w.length}, held a ${NEEDS[p]} ${Math.round(100 * w.reduce((a, x) => a + x.toolShare, 0) / w.length)}% of work hours on average, ${w.filter(x => x.toolShare === 0).length} never`);
  }
  console.log('CAPABILITIES (villages where it happened / villages)');
  for (const [name, f] of CAPS) { const n = results.filter(r => { try { return f(r); } catch (e) { return false; } }).length; console.log(`  ${n ? '   ' : 'NEVER'} ${String(n).padStart(3)}/${results.length}  ${name}`); }
}

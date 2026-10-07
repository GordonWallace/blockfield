// Villager screens: node test/run.js /tmp/vs test/villager-screens.js
// Nitwits and unemployed villagers open the trade screen (no offers), a hungry unemployed villager buys food, every villager has a status,
// and a claimed bed survives pack/unpack.
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "survival"; BF.sky.setTime(0.2); });
  await require('./lib').toVillage(pg);
  const r = await pg.evaluate(() => {
    const M = BF.mobs, T = BF.trades, I = BF.I, r = {};
    M.spawning = false;
    for (let i = 0; i < 200; i++) { BF.sky.setTime(0.2); M.update(0.05); }
    const vs = M.list.filter(m => m.type === "villager" && !m.dead && !m.child);
    const open = m => { m.sleeping = false; const msg = M.interact(m); const o = BF.inventory.isOpen(); const title = document.querySelector(".bf-trade-title, #bf-trade-title") ; return { msg, open: o }; };
    // statuses of everyone (screen title text)
    r.status = {};
    for (const m of vs) {
      const st = BF.villagerStatus.text(m);
      r.status[m.profession + "#" + m.slot.idx] = st;
    }
    r.blank = Object.entries(r.status).filter(([, s]) => !s).map(([k]) => k);
    // a nitwit (made one if the village has none)
    let nit = vs.find(m => m.profession === "nitwit");
    if (!nit) { nit = vs.find(m => m.profession !== "builder" && m.profession !== "explorer"); BF.jobs.setProfession(nit, "nitwit"); nit.trades = null; nit.inv = null; }
    r.nitwit = open(nit);
    r.nitwit.trades = nit.trades.length; r.nitwit.inv = nit.inv.filter(Boolean).map(s => BF.items[s.id].name + " x" + s.count);
    r.nitwit.title = [...document.querySelectorAll("*")].map(e => e.childElementCount === 0 ? e.textContent : "").find(t => /^Nitwit/.test(t || ""));
    BF.inventory.close();
    // an unemployed villager, fed and then starving
    let un = vs.find(m => m.profession === "unemployed");
    if (!un) { un = vs.find(m => m !== nit && m.profession !== "builder" && m.profession !== "explorer"); BF.jobs.release ? BF.jobs.release(un) : BF.jobs.setProfession(un, "unemployed"); BF.jobs.setProfession(un, "unemployed"); un.trades = null; un.inv = null; }
    T.init(un);
    T.inv.add(un.inv, I.bread, 20);
    r.unFed = open(un); r.unFed.trades = un.trades.length; BF.inventory.close();
    // empty its food and make it starving
    for (const s of un.inv) if (s && BF.food.isFood(s.id)) s.count = 0;
    un.inv = un.inv.map(s => s && s.count > 0 ? s : null);
    un.life.sat = 0; un.life.lastAte = BF.food.dayNow() - 2; BF.food.digest(un, BF.food.dayNow());
    T.inv.add(un.inv, I.emerald, 3 - T.inv.count(un.inv, I.emerald));
    r.unHungry = open(un);
    r.unHungry.starving = un.starving;
    r.unHungry.offers = un.trades.map(o => o.buy.map(b => b.n + " " + BF.items[b.id].name).join("+") + " > " + o.sell.n + " " + BF.items[o.sell.id].name + (T.blockReason(un, o) ? " [" + T.blockReason(un, o) + "]" : ""));
    r.unHungry.status = BF.villagerStatus.text(un);
    const bread = un.trades.find(o => o.buy[0].id === I.bread);
    const before = BF.food.available(un);
    r.unHungry.exchange = T.exchange(un, bread);
    r.unHungry.foodAfter = [before, BF.food.available(un), T.inv.count(un.inv, I.emerald)];
    return r;
  });
  await pg.screenshot({ path: out + '-unemployed.png' });
  const r2 = await pg.evaluate(() => {
    const M = BF.mobs, T = BF.trades, r = {};
    BF.inventory.close();
    const un = M.list.find(m => m.type === "villager" && m.profession === "unemployed");
    r.offersAfterClose = un.trades.length;
    // claimed bed round trip
    const v = M.list.find(m => m.type === "villager" && m.bed && m.bed.claimed) || M.list.find(m => m.type === "villager" && !m.child);
    if (!v.bed || !v.bed.claimed) v.bed = { x: 1, y: 2, z: 3, f: 1, claimed: true };
    const p = T.pack(v), copy = { profession: v.profession, bed: null };
    T.unpack(copy, JSON.parse(JSON.stringify(p)));
    r.bedSaved = p.bed; r.bedRestored = copy.bed;
    // a villager on the screen shows status in the title
    const fm = M.list.find(m => m.type === "villager" && !m.child && m.profession !== "nitwit" && m.profession !== "unemployed");
    fm.sleeping = false; M.interact(fm);
    r.openTitle = [...document.querySelectorAll("*")].filter(e => e.childElementCount === 0 && / — /.test(e.textContent || "")).map(e => e.textContent);
    return r;
  });
  await pg.screenshot({ path: out + '-status.png' });
  await pg.evaluate(() => BF.inventory.close());
  console.log(JSON.stringify({ ...await Promise.resolve(r), ...r2 }, null, 1));
};

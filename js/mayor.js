// Village mayors (experimental, branch exp-llm-villager): a Claude-run mayor who looks after a village over many days and steers its builders.
// Prototype: one mayor, for the loaded village nearest the world spawn. Like the Sage (js/claudevillager.js) it only exists when the game
// server has an API key (GET /claude/status); ?mayor=0 (or ?claude=0) turns it off. The player can't talk to it yet.
// - Wakes: the game decides when the mayor thinks (WAKES below): when it is appointed, each morning, and on events that matter (a death,
//   villagers starting to starve, an order that can't be carried out, a builder that finished its orders, a goal's judging day, a builder
//   it couldn't reach). Lesser events wait for the next review. One review at a time; after a failed or capped one, a short wait.
// - A review: the game writes a briefing (brief) from the village's own numbers and the mayor's records, POSTs it to /claude/mayor
//   (debug/claude.js: prompt prompts/mayor-system.md, the tools, a $1/hour spend cap), and answers the model's tool calls live (TOOLS).
//   Nothing carries over between reviews except the records the mayor keeps with its tools: strategy, journal, lessons, goals, orders.
// - Orders reach builders in person: give_orders only queues them here; the mayor then walks to each builder (its errand, js/mobs.js
//   claudeErrand) and, once there, tells it (BF.builder.direct). A builder finishes what it is on first (js/builder.js "a mayor's orders").
// - check_structure and give_orders use the builders' own tests (BF.builder.assess): nothing is ordered that a builder couldn't start now.
// - Goals are measured by the game (measure), never judged by the model; the result comes back in the briefing.
// Saved with the world (js/save.js "mayors": serialize / deserialize). Builders' orders, once told, are saved with the builders (builder.js).
// Game log kind "mayor": INFO appointed, reviews (tokens, cost), tools used, orders given and delivered; WARN refused or blocked orders,
// unreachable builders, the spend cap; ERROR failed reviews. Village log kind "mayor": orders delivered and each review's summary.
// The reference for all of this (wakes, prompt, briefing, tools, records): docs/MAYOR.md.
// API: BF.mayor = { state(key?) -> records, mob(key?), busy(), wake(reason), brief(key?) -> briefing text, runTool(name, input, key?) -> text,
//                   measure(metric, structure?, key?), serialize(), deserialize(o), WAKES }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const off = /[?&](mayor|claude)=0\b/.test(location.search);
const NAMES = ["Odessa Thorn", "Bram Whitlow", "Marigold Ashby", "Tobias Fenn", "Ione Callow", "Silas Brook", "Wren Hallet", "Agatha Pell"];
const TEMPERS = ["careful: you prefer to secure food and shelter before anything grand", "ambitious: you like to see the village grow and try new things",
  "thrifty: you dislike waste and prefer what the village can supply easily", "warm-hearted: you put the villagers' comfort and happiness first"];
const JOURNAL = 15, MAX_GOALS = 5;       // journal entries kept in the briefing; open goals allowed
const EVENT_GAP = 0.15;                  // game days after a review before an event can wake the mayor again (the rest wait for the morning)
const TALK_R = 3, RETRY = 20, MAX_TRIES = 5;   // blocks from a builder to talk; seconds before trying to reach it again; tries before giving up
const PICK_R = 600;                      // the prototype's village: the nearest loaded one within this many blocks of the world spawn
// What wakes the mayor (an API call). `wake: false` events wait for the next review. Kept here so docs/MAYOR.md can list them.
const WAKES = {
  appointed: { wake: true, about: "the mayor was just appointed (first review)" },
  morning: { wake: true, about: "a new day began (once per game day, at dawn)" },
  death: { wake: true, about: "a villager died" },
  starving: { wake: true, about: "villagers started starving (none before, or 2 more than at the last review)" },
  blocked: { wake: true, about: "a builder couldn't carry out an order (materials gone, no room, land not suited)" },
  orders_done: { wake: true, about: "a builder finished everything it was ordered to build" },
  goal: { wake: true, about: "a goal reached its judging day (met or missed)" },
  unreachable: { wake: true, about: "the mayor couldn't walk to a builder to give it orders" },
  built: { wake: false, about: "a builder finished a structure (ordered or not)" },
  born: { wake: false, about: "a child was born" },
  homeless: { wake: false, about: "more villagers without a bed than at the last review" },
  delivered: { wake: false, about: "the mayor told a builder its orders" },
};

const T = () => BF.trades;
const B = () => BF.builder;
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const dayNow = () => (BF.sky ? (BF.sky.day || 0) + skyT() : 0);
const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;
const pretty = s => String(s || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
const nameOf = m => (BF.vlog ? BF.vlog.nameOf(m) : m.vname || "someone");
// Days as the village log counts them (js/villagelog.js stamp): the world starts on day 1, at 06:00 (sky time 0 is sunrise). Goals use the same day numbers.
const dayNo = d => Math.floor(d) + 1;
const clock = d => { const h = (((d - Math.floor(d)) * 24 + 6) % 24 + 24) % 24; return "day " + dayNo(d) + ", " + String(Math.floor(h)).padStart(2, "0") + ":" + String(Math.floor((h % 1) * 60)).padStart(2, "0"); };
const glog = (level, text, at) => { try { if (BF.glog) BF.glog.log(level, "mayor", text, at ? { at } : undefined); } catch (e) { /* ignore */ } };
const label = t => (BF.blueprints ? BF.blueprints.label(t) : t);

let status = null, busy = false, holdUntil = 0, picked = null;   // holdUntil: performance.now() before which no review starts (after a failure)
const mayors = new Map();   // village key -> records (saved)
const mobs = new Map();     // village key -> the mayor's mob while spawned

if (!off && typeof fetch === "function") {
  fetch("/claude/status", { cache: "no-store" }).then(r => (r.ok ? r.json() : null)).then(s => { status = s; }).catch(() => { status = null; });
}

// ---------------------------------------------------------------- the village and its people
const loaded = R => (R.members || []).some(m => m.type === "villager" && !m.dead && !m.removed && m.position);
const villagers = R => (R.members || []).filter(m => m.type === "villager" && !m.dead && !m.removed && m.position);
const builders = R => villagers(R).filter(m => m.profession === "builder" && !m.child);
const bySlot = (R, idx) => builders(R).find(m => m.slot && String(m.slot.idx) === String(idx)) || null;
const villageName = R => (BF.signs && BF.signs.villageName && BF.signs.villageName(R.key)) || "the village";
const hasBed = m => !!(m.bed && !m.bed.tent ? m.bed : m.homeBed);
function findBuilder(R, name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  return builders(R).find(b => nameOf(b).toLowerCase() === n) || builders(R).find(b => nameOf(b).toLowerCase().split(" ")[0] === n.split(" ")[0]) || null;
}
function pickVillage() {
  const w = BF.worldSpawn, V = BF.mobs && BF.mobs.villages;
  if (!w || !V) return null;
  let best = null, bd = PICK_R;
  for (const R of V.values()) {
    if (!loaded(R) || !R.wg) continue;
    const d = BF.planet && BF.planet.distance ? BF.planet.distance(w, R) : Math.hypot(R.x - w.x, R.z - w.z);
    if (d < bd) { bd = d; best = R; }
  }
  return best;
}

// ---------------------------------------------------------------- goals: measured by the game
function measure(metric, structure, R) {
  const Br = BF.breeding, vs = villagers(R), H = BF.happiness;
  switch (metric) {
    case "population": return Br ? Br.villagerCount(R) : vs.length;
    case "free_beds": return Br ? Br.bedCount(R) - Br.villagerCount(R) : 0;
    case "homeless": return vs.filter(m => !hasBed(m)).length;
    case "starving": return vs.filter(m => m.starving).length;
    case "food_days": { const F = BF.food; if (!F) return 0; let have = 0, eat = 0; for (const m of vs) { have += F.available(m); eat += F.rate(m); } return eat ? r1(have / eat) : 0; }
    case "happiness": return H ? H.score(R).score : 0;
    case "unemployed": return vs.filter(m => !m.child && m.profession === "unemployed").length;
    case "structures": return B().builtOf(R).filter(e => e.type === structure && e.state === "done").length;
    case "births_week": return H ? H.week(R.key, "birth") : 0;
    case "deaths_week": return H ? H.week(R.key, "death") : 0;
  }
  return 0;
}
const goalText = g => "#" + g.id + " " + g.text + " (" + g.metric.replace(/_/g, " ") + (g.structure ? " of " + label(g.structure) : "") + " " + g.op + " " + g.target + " by day " + g.by + ")";

// ---------------------------------------------------------------- records
function create(R) {
  const n = mayors.size, seed = Math.abs((R.key || "").split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7));
  const S = { v: 1, key: R.key, name: NAMES[(seed + n) % NAMES.length], temper: TEMPERS[seed % TEMPERS.length], village: villageName(R), founded: r2(dayNow()),
    strategy: "", lessons: "", journal: [], rolled: [], goals: [], nextGoal: 1, orders: {}, nextOrder: 1, reviews: 0, last: null, morning: Math.floor(dayNow()) - 1,
    events: [{ kind: "appointed", day: r2(dayNow()), text: "You have just been appointed mayor." }], seen: null, spot: null, spent: 0 };
  mayors.set(R.key, S);
  glog("INFO", S.name + " was appointed mayor of " + S.village + " (" + S.temper.split(":")[0] + ")", [Math.round(R.x), 0, Math.round(R.z)]);
  return S;
}
function note(S, kind, text) {
  S.events.push({ kind, day: r2(dayNow()), text });
  if (S.events.length > 40) S.events.splice(0, S.events.length - 40);
}
// What the watcher compares against: counts at the last check.
function snapshot(R) {
  const vs = villagers(R);
  return { deaths: (R.deadInfo || []).length, starving: vs.filter(m => m.starving).length, homeless: vs.filter(m => !hasBed(m)).length, births: BF.happiness ? BF.happiness.week(R.key, "birth") : 0 };
}
function watch(S, R) {
  const now = snapshot(R), was = S.seen;
  S.seen = now;
  if (!was) return;
  if (now.deaths > was.deaths) for (const d of (R.deadInfo || []).slice(was.deaths)) note(S, "death", (d.name || "Someone") + " (" + pretty(d.prof || "villager") + ") died" + (d.cause ? ": " + d.cause : "") + ".");
  if (now.starving > 0 && (was.starving === 0 || now.starving >= (S.starvingAtReview || 0) + 2) && now.starving > was.starving) note(S, "starving", now.starving + " villagers are starving now (" + was.starving + " shortly before).");
  if (now.homeless > was.homeless) note(S, "homeless", now.homeless + " villagers have no bed now.");
  if (now.births > was.births) note(S, "born", "A child was born.");
  const d = dayNow();
  for (const g of S.goals) if (g.status === "open" && dayNo(d) >= g.by) {
    const v = measure(g.metric, g.structure, R), ok = g.op === ">=" ? v >= g.target : v <= g.target;
    g.status = ok ? "met" : "missed"; g.result = v; g.judged = r2(d);
    note(S, "goal", "Goal " + goalText(g) + " was " + g.status + ": " + v + ".");
    glog("INFO", S.name + "'s goal " + goalText(g) + " " + g.status + " (" + v + ")");
  }
}
function hookBuilders() {
  if (!BF.on || hookBuilders.done) return;
  hookBuilders.done = true;
  BF.on("builderDone", (m, e) => { const S = m.village && mayors.get(m.village.key); if (S) note(S, "built", nameOf(m) + " (Builder) finished " + (e.directed ? "your ordered " : "a ") + label(e.type) + "."); });
  BF.on("orderBlocked", (m, q) => {
    const S = m.village && mayors.get(m.village.key); if (!S) return;
    note(S, "blocked", nameOf(m) + " (Builder) can't build the " + label(q.type) + " you ordered: " + q.blocked + ".");
    glog("WARN", nameOf(m) + " can't carry out " + S.name + "'s order for a " + label(q.type) + ": " + q.blocked, m);
  });
  BF.on("orderDone", (m, q, o) => { const S = m.village && mayors.get(m.village.key); if (S && !o.queue.length) note(S, "orders_done", nameOf(m) + " (Builder) has built everything you ordered and now chooses for itself" + (o.avoid.length ? " (still avoiding " + o.avoid.map(label).join(", ") + ")" : "") + "."); });
  BF.on("newWorld", () => { mayors.clear(); mobs.clear(); picked = null; busy = false; });
}

// ---------------------------------------------------------------- the mayor in the world
function spawn(S, R) {
  let m = mobs.get(S.key);
  if (m && !m.dead && !m.removed) return m;
  if (m && m.dead) { S.deadAt = S.deadAt || performance.now(); if (performance.now() - S.deadAt < 60000) return null; }
  mobs.delete(S.key); S.deadAt = 0;
  // where it last stood (feet height kept: the top of the column may be a roof), else beside one of its villagers (the village centre
  // is often a roofed well)
  const v = villagers(R).find(x => !x.sleeping && x.onGround !== false) || villagers(R)[0];
  const at = S.spot && S.spot.y != null && BF.world.isLoaded(S.spot.x, S.spot.z) ? S.spot : v ? { x: v.position.x, y: v.position.y, z: v.position.z } : null;
  if (!at || !BF.world.isLoaded(at.x, at.z)) return null;
  m = BF.mobs.spawn("villager", at.x, at.y + 0.01, at.z, "unemployed");
  if (!m) return null;
  m.claude = true; m.mayor = S.key; m.vname = S.name; m.claudeTitle = "Mayor"; m.trades = []; m.claudeHome = { x: R.x, z: R.z };
  mobs.set(S.key, m);
  return m;
}
const localOf = (who, p) => (BF.planet && BF.planet.local ? BF.planet.local(who.position, p, {}) : { x: p.x, z: p.z });
// Walk to the next builder with orders it hasn't been told, and tell it. One at a time; builders asleep or at rest wait for the day.
function deliver(S, R, m) {
  const e = m.claudeErrand;
  if (e && !e.result) return;
  if (e && e.result) {
    m.claudeErrand = null; m.ai.route = null;
    const o = S.orders[e.slot], b = bySlot(R, e.slot);
    if (!o || o.told) return;
    if (e.result === "arrived" && b) tell(S, R, m, b, o);
    else {
      o.tries = (o.tries || 0) + 1; o.wait = performance.now() + RETRY * 1000; o.lastFail = e.result;
      if (o.tries >= MAX_TRIES) { note(S, "unreachable", "You couldn't reach " + o.builder + " to give your orders (" + e.result.replace(/^failed: /, "") + "); the orders are still waiting."); o.tries = 0; o.wait = performance.now() + 120000; glog("WARN", S.name + " couldn't reach " + o.builder + ": " + e.result, m); }
    }
    return;
  }
  if (m.tradingWith) return;
  for (const slot in S.orders) {
    const o = S.orders[slot];
    if (o.told || (o.wait && performance.now() < o.wait)) continue;
    const b = bySlot(R, slot);
    if (!b) { if (!R.members.some(x => x.slot && String(x.slot.idx) === slot && !x.dead && x.profession === "builder")) { note(S, "unreachable", o.builder + " is no longer a builder here; your orders for them were dropped."); delete S.orders[slot]; } continue; }
    if (b.sleeping || skyT() > 0.47) continue;   // builders stop at dusk (js/builder.js BUILD_END)
    const p = localOf(m, b.position), d = Math.hypot(p.x - m.position.x, p.z - m.position.z);
    if (d <= TALK_R) { tell(S, R, m, b, o); return; }
    m.claudeErrand = { goal: () => (b.dead || b.removed ? null : (q => ({ x: Math.floor(q.x), z: Math.floor(q.z), r: TALK_R - 0.5 }))(localOf(m, b.position))),
      label: o.builder, max: 60 + d * 3, from: { x: m.position.x, z: m.position.z }, t0: 0, why: "orders for " + o.builder, slot };
    m.ai.route = null;
    return;
  }
}
const ordersText = o => (o.queue.length ? "build " + o.queue.map(q => label(q.type)).join(", then ") : "choose for yourself again") + (o.avoid.length ? "; leave " + o.avoid.map(label).join(", ") + " alone" : "");
function tell(S, R, m, b, o) {
  B().direct(b, { id: o.id, queue: o.queue, avoid: o.avoid, why: o.why, made: o.made });
  o.told = r2(dayNow());
  m.lookAt = b; m.ai.lookT = 3; b.lookAt = m; if (b.ai) b.ai.lookT = 3;
  const line = S.name + " (Mayor) told " + nameOf(b) + " (Builder) to " + ordersText(o) + (o.why ? ": " + o.why : "");
  if (BF.vlog) BF.vlog.log(R, "mayor", line, b);
  glog("INFO", line, b);
  note(S, "delivered", "You told " + nameOf(b) + " your orders (" + ordersText(o) + ").");
}

// ---------------------------------------------------------------- the briefing
function builderLine(S, R, b) {
  const st = BF.villagerStatus ? BF.villagerStatus.text(b) : B().statusText(b);
  const told = B().ordersOf(b), mine = S.orders[b.slot.idx];
  let s = "- " + nameOf(b) + ": " + (st || "idle") + ".";
  const entry = B().builtOf(R).find(e => e.state === "building" && e.owner === b.slot.idx);
  if (entry) s += " On: " + label(entry.type) + " " + Math.floor(100 * entry.prog / Math.max(1, entry.n)) + "% (" + (entry.directed ? "your order" : "its own choice") + ").";
  if (b.bs && b.bs.next) s += " Next it means to build: " + label(b.bs.next.type) + ".";
  if (mine && !mine.told) s += " Your orders given " + clock(mine.made) + " are NOT told yet (" + ordersText(mine) + "): it follows its own choices until you reach it.";
  if (told) {
    s += " Following your orders told " + clock(told.told) + ": " + (told.queue.length ? told.queue.map(q => label(q.type) + " (" + (q.state === "blocked" ? "blocked: " + q.blocked : q.state) + ")").join(", ") : "queue finished, choosing for itself") + ".";
    if (told.avoid.length) s += " Avoiding: " + told.avoid.map(label).join(", ") + ".";
    if (told.done.length) s += " Built for you: " + told.done.map(x => label(x.type) + " (day " + dayNo(x.day) + ")").join(", ") + ".";
  } else if (!mine) s += " No orders from you: chooses for itself.";
  return s;
}
function counts(list) { const o = {}; for (const x of list) o[x] = (o[x] || 0) + 1; return Object.entries(o).sort((a, b) => b[1] - a[1]); }
function brief(S, R) {
  const L = [], d = dayNow(), vs = villagers(R), Br = BF.breeding, H = BF.happiness;
  L.push("You are " + S.name + ", mayor of " + S.village + " since " + clock(S.founded) + ". Your temperament: " + S.temper + ".");
  L.push("It is " + clock(d) + (skyT() < 0.47 ? " (builders work until dusk, about " + clock(Math.floor(d) + 0.47).split(", ")[1] + ")" : " (night: builders are resting)") + ". This is review " + (S.reviews + 1) +
    (S.last ? "; the last was at " + clock(S.last.day) + ": \"" + S.last.summary + "\"" : "") + ".");
  L.push("", "YOUR STRATEGY", S.strategy || "(none written yet)");
  L.push("", "YOUR LESSONS", S.lessons || "(none yet)");
  L.push("", "GOALS");
  const open = S.goals.filter(g => g.status === "open"), recent = S.goals.filter(g => g.status !== "open").slice(-5);
  if (!open.length && !recent.length) L.push("(none)");
  for (const g of open) L.push(goalText(g) + ": now " + measure(g.metric, g.structure, R) + " (was " + g.start + " when set on day " + dayNo(g.set) + ")");
  for (const g of recent) L.push(goalText(g) + ": " + g.status.toUpperCase() + (g.result != null ? " with " + g.result : "") + (g.reason ? " (" + g.reason + ")" : "") + (g.judged ? " on day " + dayNo(g.judged) : ""));
  L.push("", "YOUR JOURNAL (newest last)");
  if (!S.journal.length) L.push("(empty)");
  for (const j of S.journal) L.push(clock(j.day) + ": " + j.text);
  if (S.rolled.length) { L.push("Rolling off the journal after this review (fold anything worth keeping into your lessons):"); for (const j of S.rolled) L.push("  " + clock(j.day) + ": " + j.text); }
  L.push("", "SINCE YOUR LAST REVIEW");
  const ev = S.events.filter(e => e.kind !== "appointed");
  if (!ev.length) L.push("(nothing of note)");
  for (const e of ev) L.push("- " + clock(e.day) + ": " + e.text);
  // the village now
  L.push("", "THE VILLAGE NOW");
  const adults = vs.filter(m => !m.child), kids = vs.length - adults.length, pop7 = BF.vstats ? BF.vstats.popChange(R.key) : null;
  L.push("Population: " + vs.length + " (" + adults.length + " adults, " + kids + " children)" + (pop7 ? "; " + (pop7.change >= 0 ? "+" : "") + pop7.change + " over " + pop7.days + " days" : "") + ".");
  if (Br) L.push("Beds: " + Br.bedCount(R) + ", free: " + (Br.bedCount(R) - Br.villagerCount(R)) + ". Without a bed: " + measure("homeless", null, R) + ". (The village grows only while a bed is free.)");
  const F = BF.food;
  if (F) {
    let have = 0, eat = 0;
    for (const m of vs) { have += F.available(m); eat += F.rate(m); }
    L.push("Food held: " + Math.round(have) + " bread's worth; eaten per day: " + r1(eat) + " (" + (eat ? r1(have / eat) : 0) + " food days). Hungry (under a day's food): " + vs.filter(m => F.available(m) < F.rate(m)).length + ". Starving: " + measure("starving", null, R) + ".");
  }
  if (H) {
    const sc = H.score(R), terms = sc.terms.filter(t => t.points).map(t => t.count + " " + t.label + " (" + (t.points > 0 ? "+" : "") + t.points + ")");
    L.push("Happiness: " + sc.score + "/100" + (terms.length ? ": " + terms.join(", ") : "") + ".");
    L.push("Last 7 days: " + H.week(R.key, "birth") + " births, " + H.week(R.key, "death") + " deaths, " + H.week(R.key, "trade") + " trades.");
  }
  L.push("Jobs: " + counts(adults.map(m => pretty(m.profession))).map(([k, n]) => k + " " + n).join(", ") + ".");
  const free = BF.jobs && BF.jobs.unclaimed ? BF.jobs.unclaimed(R) : [];
  L.push("Jobsites nobody works: " + (free.length ? counts(free.map(s => pretty(s.prof))).map(([k, n]) => n + " " + k).join(", ") : "none") + ".");
  const fc = B().foodCounts(R);
  L.push("Food producers (farms and paddocks, built or generated): " + Object.entries(fc).map(([t, n]) => label(t) + " " + n).join(", ") + ".");
  const built = B().builtOf(R);
  const done = counts(built.filter(e => e.state === "done").map(e => label(e.type)));
  L.push("Built by the village's builders so far: " + (done.length ? done.map(([k, n]) => n + " " + k).join(", ") : "nothing yet") + ".");
  const wild = [["horse", "horses"], ["sheep", "sheep"], ["cow", "cows"], ["chicken", "chickens"], ["pig", "pigs"]].map(([k, n]) => { const c = B().wildCount(R, k); return n + " " + (k !== "horse" && c >= 2 ? "2+" : c); });
  L.push("Wild animals within " + B().ANIMAL_R + " blocks: " + wild.join(", ") + " (a paddock or stable needs 2 or more of its kind).");
  const E = BF.econ && BF.econ.view(R.key), T0 = E ? E.today : 0, want = {}, stuck = {};
  if (E) for (const day in E.days) if (+day >= T0 - 1) { for (const [, item, h] of E.days[day].w) want[item] = (want[item] || 0) + h; for (const [, , item, n] of E.days[day].s) stuck[item] = Math.max(stuck[item] || 0, n); }
  const wl = Object.entries(want).sort((a, b) => b[1] - a[1]).slice(0, 6), sl = Object.entries(stuck).sort((a, b) => b[1] - a[1]).slice(0, 6);
  L.push("Wanted and not for sale (last 2 days, hours waited): " + (wl.length ? wl.map(([k, h]) => k + " " + h + "h").join(", ") : "nothing") + ".");
  L.push("Held for sale and not selling: " + (sl.length ? sl.map(([k, n]) => k + " " + n).join(", ") : "nothing") + ".");
  // builders
  L.push("", "BUILDERS");
  const bs = builders(R);
  if (!bs.length) L.push("(the village has no builder: orders can't be carried out)");
  for (const b of bs) L.push(builderLine(S, R, b));
  // buildable now, the quick way
  L.push("", "CAN BE BUILT NOW (materials and land, as the builders check them; use check_structure for detail and room)");
  const yes = [], no = [];
  for (const t of STRUCTS) { const a = B().assess(R, t); (a.ok ? yes : no).push(a.ok ? label(t) + (a.have ? "" : " (needs buying)") : label(t) + ": " + (a.why[0] || "no")); }
  L.push("Yes: " + (yes.join(", ") || "nothing") + ".");
  for (const n of no) L.push("No - " + n);
  return L.join("\n");
}
const STRUCTS = ["small_house", "medium_house", "cottage", "veg_farm", "pen", "pasture", "coop", "sty", "well", "lamp_posts", "market_stall", "workshop",
  "bakehouse", "glassworks", "apiary", "stable", "bridge"];

// ---------------------------------------------------------------- tools (debug/claude.js MAYOR_TOOLS), answered live
function assessText(a) {
  let s = label(a.type) + ": " + (a.ok ? "CAN be built now" : "can NOT be built now") + ".";
  if (a.why.length) s += " Why not: " + a.why.join("; ") + ".";
  if (a.site !== "not checked") s += " Room for it: " + (a.site === "found" ? "yes" : "no") + ".";
  const per = a.builders || [];
  for (const b of per) s += "\n- " + b.name + ": " + (b.have ? "holds everything it needs" : b.missing.length ? "would need " + b.missing.map(x => x.n + " " + x.item + (x.dig ? " (digs it)" : x.sold ? " (" + x.sold + " for sale in the village)" : " (NOBODY SELLS IT)")).join(", ") : "") + (b.ok ? "" : " -> can't: " + b.why.join("; "));
  if (!per.length && a.missing.length) s += " Missing: " + a.missing.map(x => x.n + " " + x.item + (x.dig ? " (digs it)" : x.sold ? " (" + x.sold + " for sale)" : " (nobody sells it)")).join(", ") + ".";
  if (!per.length && a.have) s += " The builder holds everything it needs.";
  return s;
}
const TOOLS = {
  check_structure(S, R, inp) {
    if (!STRUCTS.includes(inp.type)) return "Unknown structure: use one of " + STRUCTS.join(", ") + ".";
    const b = inp.builder ? findBuilder(R, inp.builder) : null;
    if (inp.builder && !b) return "No builder called " + inp.builder + " here. Builders: " + builders(R).map(nameOf).join(", ") + ".";
    const a = B().assess(R, inp.type, b, { site: true });
    glog("INFO", S.name + " checked whether a " + label(inp.type) + " can be built" + (b ? " by " + nameOf(b) : "") + ": " + (a.ok ? "yes" : "no (" + a.why.join("; ") + ")"));
    return assessText(a);
  },
  list_villagers(S, R) {
    const F = BF.food;
    return villagers(R).map(m => nameOf(m) + " - " + (m.child ? "child" : pretty(m.profession)) + ", " + ((BF.villagerStatus && BF.villagerStatus.text(m)) || "idle").toLowerCase() +
      (m.starving ? ", STARVING" : F && F.available(m) < F.rate(m) ? ", hungry" : "") + (hasBed(m) ? "" : ", no bed") + (F ? ", food " + r1(F.available(m)) : "")).join("\n") || "Nobody is here.";
  },
  market_report(S, R) {
    const E = BF.econ && BF.econ.view(R.key);
    if (!E) return "No market records.";
    const want = {}, stuck = {}, flows = {};
    for (const day in E.days) if (+day >= E.today - 1) {
      for (const [who, item, h] of E.days[day].w) { const k = item + " (wanted by " + who + ")"; want[k] = (want[k] || 0) + h; }
      for (const [, job, item, n, days] of E.days[day].s) stuck[item + " (" + job + ")"] = n + " unsold for " + days + " days";
      for (const [, , item, , n] of E.days[day].f) flows[item] = (flows[item] || 0) + n;
    }
    const top = o => Object.entries(o).sort((a, b) => (typeof b[1] === "number" ? b[1] - a[1] : 0));
    return "Wanted and couldn't buy (hours waited, last 2 days):\n" + (top(want).slice(0, 15).map(([k, h]) => "- " + k + ": " + h + "h").join("\n") || "- nothing") +
      "\nHeld for sale and not selling:\n" + (Object.entries(stuck).slice(0, 15).map(([k, v]) => "- " + k + ": " + v).join("\n") || "- nothing") +
      "\nMost traded items (count, last 2 days): " + (top(flows).slice(0, 10).map(([k, n]) => k + " " + n).join(", ") || "none");
  },
  give_orders(S, R, inp) {
    const list = String(inp.builder || "").toLowerCase() === "all" ? builders(R) : [findBuilder(R, inp.builder)].filter(Boolean);
    if (!list.length) return "No builder called " + inp.builder + " here. Builders: " + (builders(R).map(nameOf).join(", ") || "none") + ".";
    const build = (Array.isArray(inp.build) ? inp.build : []).slice(0, 5).filter(q => q && STRUCTS.includes(q.type));
    const avoid = (Array.isArray(inp.avoid) ? inp.avoid : []).filter(t => STRUCTS.includes(t));
    const out = [];
    for (const b of list) {
      const ok = [], refused = [];
      for (const q of build) { const a = B().assess(R, q.type, b, { site: true }); if (a.ok) ok.push({ type: q.type, why: String(q.why || "").slice(0, 160) }); else refused.push(label(q.type) + " (" + a.why.join("; ") + ")"); }
      if (build.length && !ok.length) { out.push(nameOf(b) + ": nothing queued; every structure was refused: " + refused.join("; ") + "."); glog("WARN", S.name + "'s orders for " + nameOf(b) + " were all refused: " + refused.join("; ")); continue; }
      const o = { id: S.nextOrder++, builder: nameOf(b), queue: ok, avoid, why: String(inp.reason || "").slice(0, 200), made: r2(dayNow()), told: null };
      S.orders[b.slot.idx] = o;
      out.push(nameOf(b) + ": queued " + (ok.length ? ok.map(q => label(q.type)).join(", then ") : "nothing (free to choose)") + (avoid.length ? "; avoid " + avoid.map(label).join(", ") : "") +
        (refused.length ? ". Refused: " + refused.join("; ") : "") + ". You'll walk over and tell them; they finish what they are on first.");
      glog(refused.length ? "WARN" : "INFO", S.name + " gave orders for " + nameOf(b) + ": " + ordersText(o) + (refused.length ? " (refused: " + refused.join("; ") + ")" : ""), b);
    }
    return out.join("\n");
  },
  set_goal(S, R, inp) {
    if (S.goals.filter(g => g.status === "open").length >= MAX_GOALS) return "You already have " + MAX_GOALS + " open goals: close one first.";
    if (inp.metric === "structures" && !STRUCTS.includes(inp.structure)) return "For metric structures, say which structure to count.";
    const by = Math.floor(+inp.by_day), target = +inp.target;
    if (!(by > dayNo(dayNow()))) return "by_day must be a later day than today (day " + dayNo(dayNow()) + ").";
    if (!Number.isFinite(target)) return "target must be a number.";
    const g = { id: S.nextGoal++, text: String(inp.text || "").slice(0, 120), metric: inp.metric, structure: inp.metric === "structures" ? inp.structure : undefined, op: inp.op === "<=" ? "<=" : ">=",
      target, by, set: r2(dayNow()), start: measure(inp.metric, inp.structure, R), status: "open" };
    S.goals.push(g);
    if (S.goals.length > 30) S.goals.splice(0, S.goals.length - 30);
    glog("INFO", S.name + " set goal " + goalText(g) + " (now " + g.start + ")");
    return "Goal " + goalText(g) + " set; it is " + g.start + " now.";
  },
  close_goal(S, R, inp) {
    const g = S.goals.find(x => x.id === +inp.id && x.status === "open");
    if (!g) return "No open goal #" + inp.id + ".";
    g.status = "closed"; g.reason = String(inp.reason || "").slice(0, 160); g.result = measure(g.metric, g.structure, R); g.judged = r2(dayNow());
    return "Closed goal #" + g.id + ".";
  },
  update_strategy(S, R, inp) { S.strategy = String(inp.text || "").slice(0, 800); glog("INFO", S.name + " updated the strategy: " + S.strategy); return "Strategy saved."; },
  write_journal(S, R, inp) {
    S.journal.push({ day: r2(dayNow()), text: String(inp.text || "").slice(0, 300) });
    while (S.journal.length > JOURNAL) S.rolled.push(S.journal.shift());
    return "Noted.";
  },
  update_lessons(S, R, inp) { S.lessons = String(inp.text || "").slice(0, 600); glog("INFO", S.name + " updated the lessons: " + S.lessons); return "Lessons saved."; },
};

// ---------------------------------------------------------------- reviews
async function post(body) {
  const r = await fetch("/claude/mayor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => null);
  if (!r.ok || !out || out.error) { const e = new Error((out && out.error) || "server answered " + r.status); e.status = r.status; throw e; }
  return out;
}
function wakeReason(evs) {
  const ks = [...new Set(evs.filter(e => WAKES[e.kind] && WAKES[e.kind].wake).map(e => e.kind))];
  return ks.map(k => k === "morning" ? "a new day has begun" : k === "appointed" ? "you have just been appointed mayor; look the village over, write a strategy and decide what to do first" : WAKES[k].about).join("; ");
}
async function review(S, R, m) {
  busy = true;
  const evs = S.events.slice(), wake = wakeReason(evs) || "a new day has begun", briefing = brief(S, R), t0 = performance.now(), used = [];
  S.events = [];
  S.starvingAtReview = measure("starving", null, R);
  glog("INFO", S.name + " is reviewing " + S.village + " (" + wake + ")", m);
  try {
    let out = await post({ mayor: { name: S.name, village: S.village }, wake, briefing });
    for (let i = 0; out.pending && i < 12; i++) {
      const results = out.pending.calls.map(c => {
        const f = TOOLS[c.name];
        used.push(c.name);
        if (!f) return { id: c.id, content: "Unknown tool", is_error: true };
        try { return { id: c.id, content: String(f(S, R, c.input || {}, m)) }; }
        catch (e) { console.error(e); return { id: c.id, content: "Couldn't do that just now (" + (e && e.message) + ")", is_error: true }; }
      });
      out = await post({ turn: out.pending.turn, results });
    }
    const summary = String(out.reply || "").slice(0, 600) || "(no summary)";
    const u = out.usage || {};
    S.reviews++; S.rolled = []; S.spent = r2((S.spent || 0) + (u.cost || 0)) ;
    S.last = { day: r2(dayNow()), wake, summary, tools: used, cost: u.cost || 0 };
    if (BF.vlog) BF.vlog.log(R, "mayor", S.name + " (Mayor) reviewed the village: " + summary, m);
    glog("INFO", S.name + " finished a review in " + Math.round(performance.now() - t0) + " ms: " + (u.input || 0) + " in (" + (u.cacheRead || 0) + " cached) / " + (u.output || 0) + " out tokens, $" + (u.cost || 0).toFixed(4) +
      (used.length ? ", tools: " + used.join(", ") : "") + (out.hour != null ? "; $" + out.hour.toFixed(3) + " spent in the last hour" : ""), m);
  } catch (e) {
    S.events = evs.concat(S.events);   // told next time
    const capped = e.status === 429;
    glog(capped ? "WARN" : "ERROR", S.name + "'s review " + (capped ? "was put off: " : "failed: ") + (e instanceof TypeError ? "couldn't reach the game server" : e.message), m);
    holdUntil = performance.now() + (capped ? 120000 : 30000);   // wait before the next try
  }
  busy = false;
}
function due(S) {
  if (busy || performance.now() < holdUntil) return false;
  const today = Math.floor(dayNow());
  if (today > S.morning && skyT() < 0.47) { S.morning = today; note(S, "morning", "A new day began."); }
  const waking = S.events.some(e => WAKES[e.kind] && WAKES[e.kind].wake);
  if (!waking) return false;
  if (S.events.some(e => e.kind === "morning" || e.kind === "appointed")) return true;
  return !S.last || dayNow() - S.last.day >= EVENT_GAP;
}

function tick() {
  if (!status || !status.configured || !BF.mobs || !BF.world || !B() || !B().assess) return;
  hookBuilders();
  if (!picked) { const R = pickVillage(); if (!R) return; picked = R.key; if (!mayors.has(R.key)) create(R); }
  const S = mayors.get(picked), R = BF.mobs.villages.get(picked);
  if (!S || !R || !loaded(R)) return;
  const m = spawn(S, R);
  if (!m) return;
  if (!m.claudeErrand && m.onGround !== false) S.spot = { x: m.position.x, y: m.position.y, z: m.position.z };
  watch(S, R);
  deliver(S, R, m);
  if (due(S)) review(S, R, m);
}
setInterval(() => { try { tick(); } catch (e) { console.error(e); } }, 1000);

// ---------------------------------------------------------------- save
function serialize() {
  if (!mayors.size) return undefined;
  const out = {};
  for (const [k, S] of mayors) { const o = Object.assign({}, S); delete o.deadAt; out[k] = JSON.parse(JSON.stringify(o)); }
  return out;
}
function deserialize(o) {
  mayors.clear(); mobs.clear(); picked = null;
  if (!o || typeof o !== "object") return;
  for (const k in o) { const S = o[k]; if (S && S.v === 1 && S.name) { S.events = S.events || []; S.orders = S.orders || {}; S.goals = S.goals || []; S.journal = S.journal || []; S.rolled = S.rolled || []; mayors.set(k, S); picked = picked || k; } }
}

const pick = key => mayors.get(key || picked) || null;
BF.mayor = {
  WAKES, STRUCTS,
  state: pick, mob: key => mobs.get(key || picked) || null, busy: () => busy,
  village: key => BF.mobs && BF.mobs.villages.get(key || picked),
  wake(reason) { const S = pick(); if (S) note(S, "morning", reason || "Woken by hand."); holdUntil = 0; },
  brief(key) { const S = pick(key), R = S && BF.mobs.villages.get(S.key); return S && R ? brief(S, R) : ""; },
  runTool(name, input, key) { const S = pick(key), R = S && BF.mobs.villages.get(S.key); return S && R && TOOLS[name] ? TOOLS[name](S, R, input || {}, mobs.get(S.key)) : "no mayor"; },
  measure(metric, structure, key) { const S = pick(key), R = S && BF.mobs.villages.get(S.key); return R ? measure(metric, structure, R) : null; },
  serialize, deserialize,
};
})();

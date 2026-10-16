// Blockfieldpedia: a wiki for Blockfield that reads the game's own data. wiki/data.html loads the game scripts in a hidden iframe;
// block, item, recipe, smelting, trade, jobsite and mob facts all come from there, so the pages follow the game as it changes.
// Versions (wiki/versions.json): one wiki per Blockfield release. Each has its own hand-written pages in wiki/versions/<id>/: articles/*.md
// (listed in articles/index.json; prof-<profession>.md and mob-<type>.md add the behaviour sections of the generated villager and mob
// pages) and natural.json (where blocks generate). The version under development reads the running game; a released one reads the copy of
// the game frozen with it (versions/<id>/game/). The selector in the header picks the version: by default the game's (js/version.js),
// then whatever the reader chose, kept for the browser session. See wiki/README.md.
// Routes (hash): #/ home, #/items, #/item/<name>, #/villagers, #/villager/<profession>, #/mobs, #/mob/<type>, #/page/<article id>.
(() => {
"use strict";
const MD = window.WikiMD, esc = MD.esc;
const main = document.getElementById("main"), nav = document.getElementById("nav");
let BF = null, W = null;   // the game's BF and window (iframe)
const D = {};              // derived indexes, built once
const articles = new Map();   // id -> {id, title, category, body}
const extra = new Map();      // "prof-farmer" / "mob-cow" -> markdown body | null
let natural = { blocks: {}, rules: [] }, biomeNames = [];
let biomeFacts = null, hostileWeights = [], villageBiomes = [];   // versions/<id>/biomes.json (wiki/capture.js), the game's monster mix and village biomes
let ver = null, dir = "";     // the version shown and its folder ("versions/1.3/")
const STORE = "blockfieldpedia.version";
const store = { get() { try { return sessionStorage.getItem(STORE); } catch (e) { return null; } }, set(v) { try { sessionStorage.setItem(STORE, v); } catch (e) { /* private mode */ } } };

const CATS = ["World generation", "Villages", "Villagers", "Mobs", "Game rules", "Items and blocks"];
const LEVEL_NAMES = ["Novice", "Apprentice", "Journeyman", "Expert", "Master"];
const TOOL_MATS = [["wooden", "Wooden"], ["stone", "Stone"], ["iron", "Iron"], ["golden", "Golden"], ["diamond", "Diamond"]];
const PROF_GROUPS = [
  ["Food and farming", ["farmer", "baker", "butcher", "fisherman", "poultry_keeper", "cowherd", "pig_farmer", "shepherd", "beekeeper"]],
  ["Crafts and materials", ["miner", "forester", "toolsmith", "fletcher", "furniture_maker", "glassmaker", "mason", "leatherworker", "armorer", "weaponsmith"]],
  ["Knowledge and travel", ["librarian", "cleric", "cartographer", "explorer", "merchant", "stable_hand"]],
  ["Village life", ["builder", "unemployed", "nitwit"]],
];

// ---------------------------------------------------------------- helpers
const title = s => s.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase());
const nameOf = id => BF.itemName(id).replace(/ Item$/, "");
const item = id => BF.items[id];
const pageId = id => { const it = item(id); return it && it.hidden && it.item != null && item(it.item) ? it.item : id; };   // door / bed states -> their item
const hrefItem = id => "#/item/" + encodeURIComponent(item(pageId(id)).name);
const profName = p => p === "unemployed" ? "Unemployed villager" : title(p);
const iconImg = (id, cls = "ic") => { let u = ""; try { u = BF.inventory.iconURL(id); } catch (e) { /* no icon */ } return `<img class="${cls}" src="${u}" alt="" loading="lazy">`; };
const itemLink = (id, label, n) => item(id) ? `<a class="il" href="${hrefItem(id)}" title="${esc(nameOf(id))}">${iconImg(id)}${n > 1 ? `<span class="n">${n}</span>` : ""}${label === false ? "" : `<span>${esc(label || nameOf(id))}</span>`}</a>` : esc(label || "?");
const stackLink = (id, n) => itemLink(id, false, n);
const fmt = (x, d = 2) => (Math.round(x * 10 ** d) / 10 ** d).toString();
const slug = s => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const listOr = (a, f) => a.length ? a.map(f).join("") : "";
const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };

// Everything a page links to must exist in the version being read (a 1.3 page never leads to something added in 1.4):
// links are checked against this version's game data and articles, and a missing target is plain red text (test/wiki.js fails on it).
// tool types made in more than one material (pickaxe, axe...): each gets a comparison page, #/tool/<type>
const toolsOf = type => BF.items.filter(it => it && !it.isBlock && it.tool && it.tool.type === type);
const toolTypes = () => [...new Set(BF.items.filter(it => it && !it.isBlock && it.tool).map(it => it.tool.type))].filter(t => toolsOf(t).length > 1);
const mobTypes = () => BF.mobs.types.filter(t => t !== "villager").concat(BF.bees ? ["bee"] : []);
const biomeId = sl => biomeNames.findIndex(n => slug(n) === sl);
const exists = (kind, name) => kind === "item" ? BF.I[name] !== undefined : kind === "biome" ? biomeId(name) >= 0 : kind === "villager" ? D.profs.includes(name) :
  kind === "mob" ? name === "villager" || mobTypes().includes(name) : kind === "page" ? articles.has(name) : kind === "tool" ? toolTypes().includes(name) : false;
const missing = (text, why) => `<span class="bad" title="${esc(why)}">${esc(text)}</span>`;
function wikiLink(kind, name, label) {
  if (!exists(kind, name)) return missing(label || title(name), `not in version ${ver ? ver.id : ""}`);
  if (kind === "item") return itemLink(BF.I[name], label);
  if (kind === "biome") return `<a href="#/biome/${name}">${esc(label || biomeNames[biomeId(name)])}</a>`;
  if (kind === "villager") return `<a href="#/villager/${name}">${esc(label || profName(name))}</a>`;
  if (kind === "mob") return `<a href="${name === "villager" ? "#/page/villagers" : "#/mob/" + name}">${esc(label || title(name))}</a>`;
  if (kind === "tool") return `<a href="#/tool/${name}">${esc(label || title(name) + "s")}</a>`;
  return `<a href="#/page/${name}">${esc(label || articles.get(name).title)}</a>`;
}
// a page that is not in this version (an old link, a bookmark, or a page from another version after switching)
const notFound = (what, crumbs) => setPage(`<h1>Not in version ${esc(ver.id)}</h1><p>${what} is not part of Blockfield ${esc(ver.id)}. ` +
  `<a href="#/">Go to the home page</a>, or pick another version at the top.</p>`, crumbs);
const md = src => MD.render(src || "", wikiLink, slug);

// ---------------------------------------------------------------- boot
async function boot() {
  main.innerHTML = `<p class="muted">Loading the game's data&hellip;</p>`;
  // pick the version: the reader's choice this session, else the running game's, else the newest
  const [vs, gameSrc] = await Promise.all([
    fetch("versions.json", { cache: "no-cache" }).then(r => r.json()).then(o => o.versions || []).catch(() => []),
    fetch("../js/version.js", { cache: "no-cache" }).then(r => r.text()).catch(() => ""),
  ]);
  const gm = /VERSION\s*=\s*"([^"]+)"/.exec(gameSrc), gameVer = gm && gm[1];
  ver = vs.find(v => v.id === store.get()) || vs.find(v => v.id === gameVer) || vs[0] || { id: gameVer || "?", status: "development" };
  dir = `versions/${ver.id}/`;
  MD.base = dir;
  const game = ver.status === "released" ? dir + "game/" : "../";
  const sel = document.getElementById("version");
  sel.innerHTML = vs.map(v => `<option value="${esc(v.id)}"${v.id === ver.id ? " selected" : ""}>Version ${esc(v.id)}${v.status === "development" ? " (in development)" : ""}${v.id === gameVer ? " \u2022 this game" : ""}</option>`).join("");
  sel.addEventListener("change", () => { store.set(sel.value); location.reload(); });
  const frame = document.createElement("iframe");
  frame.src = "data.html?game=" + encodeURIComponent(game);
  frame.hidden = true;
  const ready = new Promise(res => addEventListener("message", e => { if (e.data === "bf-data-ready") res(); }));
  document.body.appendChild(frame);
  const [, idx, nat, wg, bf, mobsSrc] = await Promise.all([
    ready,
    fetch(dir + "articles/index.json", { cache: "no-cache" }).then(r => r.json()).catch(() => []),
    fetch(dir + "natural.json", { cache: "no-cache" }).then(r => r.json()).catch(() => ({})),
    fetch(game + "js/worldgen.js", { cache: "no-cache" }).then(r => r.text()).catch(() => ""),
    fetch(dir + "biomes.json", { cache: "no-cache" }).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(game + "js/mobs.js", { cache: "no-cache" }).then(r => r.text()).catch(() => ""),
  ]);
  W = frame.contentWindow;
  BF = W.BF;
  if (!W.bfReady) { main.innerHTML = `<p class="bad">Could not load the game's data: ${esc(W.bfError || "unknown error")}.</p>`; return; }
  natural = { blocks: (nat && nat.blocks) || {}, rules: ((nat && nat.rules) || []).map(r => ({ re: new RegExp(r.match), text: r.text })) };
  const m = /const NAMES = \[([^\]]+)\]/.exec(wg);   // biome names, in biome id order
  biomeNames = m ? [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]) : [];
  // biome constants (OCEAN = 0, ...) to read the village biome list by name
  const ids = {};
  for (const [, k, v] of wg.matchAll(/\b([A-Z_]+) = (\d+)[,;]/g)) if (!(k in ids)) ids[k] = +v;
  const vb = /const VILLAGE_BIOMES = \[([^\]]+)\]/.exec(wg);
  villageBiomes = vb ? vb[1].split(",").map(k => ids[k.trim()]).filter(v => v !== undefined) : [];
  const hw = /const HOSTILE_WEIGHTS = (\[[^;]+\]);/.exec(mobsSrc);
  try { hostileWeights = hw ? JSON.parse(hw[1]) : []; } catch (e) { hostileWeights = []; }
  biomeFacts = bf && bf.biomes ? bf : null;
  const srcs = await Promise.all(idx.map(id => fetch(`${dir}articles/${id}.md`, { cache: "no-cache" }).then(r => r.ok ? r.text() : null).catch(() => null)));
  idx.forEach((id, i) => {   // in index.json order: the menu lists them that way
    if (!srcs[i]) return;
    const { meta, body } = MD.frontMatter(srcs[i]);
    articles.set(id, { id, title: meta.title || title(id), category: meta.category || "Game rules", body });
  });
  index();
  buildNav();
  addEventListener("hashchange", route);
  route();
}

async function extraMd(key) {
  if (!extra.has(key)) extra.set(key, await fetch(`${dir}articles/${key}.md`, { cache: "no-cache" }).then(r => r.ok ? r.text() : null).catch(() => null));
  return extra.get(key);
}

// ---------------------------------------------------------------- indexes
function index() {
  const inv = BF.inventory;
  D.made = new Map(); D.used = new Map();
  for (const r of inv.recipes) {
    push(D.made, pageId(r.out), r);
    const ings = new Set(r.type === "shaped" ? Object.values(r.key).flat() : r.ings.flat());
    for (const i of ings) push(D.used, pageId(i), r);
  }
  D.smeltFrom = new Map();
  for (const [i, o] of inv.smelting) push(D.smeltFrom, pageId(o), i);
  // trades: every pool of every table
  D.sold = new Map(); D.bought = new Map(); D.tables = {};
  const T = BF.trades.TRADES || {};
  for (const prof of Object.keys(T)) {
    D.tables[prof] = T[prof].map((pool, li) => pool.map(s => BF.trades.parseTrade(s)).filter(Boolean).map(o => ({ ...o, level: li + 1 })));
    for (const pool of D.tables[prof]) for (const o of pool) {
      push(D.sold, pageId(o.sell.id), { prof, o });
      for (const b of o.buy) push(D.bought, pageId(b.id), { prof, o });
    }
  }
  D.jobsiteOf = new Map();
  for (const [prof, b] of Object.entries(BF.jobs.JOBSITE)) if (BF.I[b] !== undefined) push(D.jobsiteOf, BF.I[b], prof);
  D.mobDrops = new Map();
  for (const t of BF.mobs.types) for (const [n, a, b] of (BF.mobs.typeDef(t) || {}).drops || []) if (BF.I[n] !== undefined) push(D.mobDrops, pageId(BF.I[n]), { t, a, b });
  D.blockDrops = new Map();
  for (const b of BF.blocks) {
    if (!b || !b.id) continue;
    const src = pageId(b.id);
    if (b.drop != null && pageId(b.drop) !== src) push(D.blockDrops, pageId(b.drop), { src, a: 1, b: 1, p: 1 });
    for (const [n, a, c, p] of b.extraDrops || []) if (BF.I[n] !== undefined && pageId(BF.I[n]) !== src) push(D.blockDrops, pageId(BF.I[n]), { src, a, b: c, p });
  }
  for (const [k, v] of D.blockDrops) D.blockDrops.set(k, v.filter((e, i) => v.findIndex(f => f.src === e.src) === i));
  D.cre = inv.creativeItems ? inv.creativeItems() : BF.items.filter(i => i && i.id && !i.hidden).map(i => ({ id: i.id, cat: "misc" }));
  D.tabs = (inv.creativeTabs || []).filter(t => D.cre.some(e => e.cat === t.key));
  D.profs = BF.mobs.professions.slice();
}

// ---------------------------------------------------------------- layout
const artHref = id => id === "biomes" ? "#/biomes" : `#/page/${id}`;   // the biome summary page wraps the biomes article
function buildNav() {
  const byCat = CATS.map(c => [c, [...articles.values()].filter(a => a.category === c)]);
  nav.innerHTML = `<a class="home" href="#/">Home</a>` +
    `<h3>Browse</h3><a href="#/items">Blocks and items</a><a href="#/villagers">Villagers</a><a href="#/mobs">Mobs</a><a href="#/tools">Tools</a>` +
    byCat.filter(([, l]) => l.length).map(([c, l]) => `<h3>${esc(c)}</h3>` + l.map(a => `<a href="${artHref(a.id)}">${esc(a.title)}</a>`).join("")).join("");
}

function setPage(html, crumbs) {
  main.innerHTML = (crumbs ? `<div class="crumbs"><a href="#/">Blockfieldpedia</a>${crumbs.map(c => ` &rsaquo; ${c}`).join("")}</div>` : "") + html;
  scrollTo(0, 0);
  for (const a of nav.querySelectorAll("a")) a.classList.toggle("on", a.getAttribute("href") === location.hash || (location.hash === "" && a.classList.contains("home")));
  document.body.classList.remove("nav-open");
}

function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  const [kind, arg] = [h.split("/")[0], h.split("/").slice(1).join("/")];
  try {
    if (!kind) return home();
    if (kind === "items") return items(arg);
    if (kind === "item") return itemPage(arg);
    if (kind === "villagers") return villagers();
    if (kind === "villager") return villagerPage(arg);
    if (kind === "mobs") return mobs();
    if (kind === "mob") return mobPage(arg);
    if (kind === "page") return articlePage(arg);
    if (kind === "search") return searchPage(arg);
    if (kind === "biomes") return biomesPage();
    if (kind === "biome") return biomePage(arg);
    if (kind === "tools") return toolsPage();
    if (kind === "tool") return toolPage(arg);
  } catch (e) { console.error(e); setPage(`<p class="bad">This page failed to build: ${esc(e.message)}</p>`); return; }
  notFound(`The page ${esc(h)}`);
}

// ---------------------------------------------------------------- home and indexes
function home() {
  const n = D.cre.length;
  const cards = CATS.map(c => {
    const l = [...articles.values()].filter(a => a.category === c);
    const gen = c === "Villagers" ? `<a href="#/villagers">All ${D.profs.length} professions</a>` : c === "Mobs" ? `<a href="#/mobs">Every mob</a>` :
      c === "Items and blocks" ? `<a href="#/items">All ${n} blocks and items</a>` : "";
    if (!l.length && !gen) return "";
    return `<section class="card"><h2>${esc(c)}</h2>${gen}${l.map(a => `<a href="#/page/${a.id}">${esc(a.title)}</a>`).join("")}</section>`;
  }).join("");
  setPage(`<h1>Blockfieldpedia</h1>
    <p class="lead">The Blockfield wiki: every block and item with how to get it, every villager profession and mob, and the rules of the world.
    Block, recipe, trade and mob facts are read from the game itself, so they always match the version you are running.</p>
    <div class="cards">${cards}</div>`);
}

function items(tab) {
  const tabs = D.tabs;
  const cur = tabs.find(t => t.key === tab) ? tab : "";
  const shown = D.cre.filter(e => !cur || e.cat === cur);
  setPage(`<h1>Blocks and items</h1>
    <div class="tabs"><a href="#/items" class="${cur ? "" : "on"}">All</a>${tabs.map(t => `<a href="#/items/${t.key}" class="${cur === t.key ? "on" : ""}">${iconImg(BF.I[t.icon])}${esc(t.label)}</a>`).join("")}</div>
    <input id="filter" class="filter" type="search" placeholder="Filter ${shown.length} entries" autocomplete="off">
    <div class="grid" id="grid">${shown.map(e => `<a class="tile" href="${hrefItem(e.id)}" data-n="${esc(nameOf(e.id).toLowerCase() + " " + item(e.id).name)}">${iconImg(e.id, "big")}<span>${esc(nameOf(e.id))}</span></a>`).join("")}</div>`,
    [cur ? `<a href="#/items">Blocks and items</a> &rsaquo; ${esc(tabs.find(t => t.key === cur).label)}` : "Blocks and items"]);
  const f = document.getElementById("filter");
  f.addEventListener("input", () => {
    const q = f.value.trim().toLowerCase();
    for (const t of document.getElementById("grid").children) t.hidden = !!q && !t.dataset.n.includes(q);
  });
}

function villagers() {
  const groups = PROF_GROUPS.map(([g, list]) => [g, list.filter(p => D.profs.includes(p))]);
  const rest = D.profs.filter(p => !groups.some(([, l]) => l.includes(p)));
  if (rest.length) groups.push(["Other", rest]);
  const a = articles.get("villagers");
  setPage(`<h1>Villagers</h1>
    ${a ? `<p>Start with the article on <a href="#/page/villagers">villagers in general</a>; every profession has its own page below.</p>` : ""}
    ${groups.map(([g, l]) => `<h2>${esc(g)}</h2><div class="grid wide">${l.map(p => {
      const b = BF.jobs.JOBSITE[p], id = b && BF.I[b];
      return `<a class="tile" href="#/villager/${p}">${id !== undefined && id !== null ? iconImg(id, "big") : `<span class="noicon"></span>`}<span>${esc(profName(p))}</span></a>`;
    }).join("")}</div>`).join("")}`, ["Villagers"]);
}

function mobs() {
  const ts = mobTypes();
  const row = t => {
    const d = BF.mobs.typeDef(t);
    return `<tr><td><a href="#/mob/${t}">${esc(title(t))}</a></td><td>${d ? (d.hostile ? "Hostile" : d.golem ? "Village guard" : "Passive") : "Passive"}</td><td>${d ? hearts(d.hp) : "None"}</td></tr>`;
  };
  setPage(`<h1>Mobs</h1>${articles.get("mobs") ? `<p>See also the <a href="#/page/mobs">mobs overview</a> and <a href="#/page/mob-spawning">how mobs spawn</a>.</p>` : ""}
    <table class="wt"><thead><tr><th>Mob</th><th>Kind</th><th>Health</th></tr></thead><tbody>${ts.map(row).join("")}
    <tr><td><a href="#/villagers">Villager</a></td><td>Villager</td><td>${hearts(BF.mobs.typeDef("villager").hp)}</td></tr></tbody></table>`, ["Mobs"]);
}

// a picture the capture script (wiki/capture.js) took for this version; hidden when the version has none
const photo = (name, alt) => `<div class="photo"><img src="${dir}images/${name}.jpg" alt="${esc(alt)}" onerror="this.parentNode.remove()"></div>`;
const hearts = hp => `${hp} <span class="muted">(${fmt(hp / 2, 1)} hearts)</span>`;

// ---------------------------------------------------------------- crafting grids
function recipeHTML(r) {
  const size = r.big || r.w > 2 || r.h > 2 ? 3 : 2;
  const cells = new Array(size * size).fill(null);
  if (r.type === "shaped") r.pattern.forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== " ") cells[y * size + x] = r.key[ch]; }));
  else r.ings.forEach((alts, i) => { cells[i] = alts; });
  const cell = alts => {
    if (!alts) return `<span class="slot"></span>`;
    const tip = alts.length > 1 ? "Any of: " + alts.map(nameOf).join(", ") : nameOf(alts[0]);
    return `<a class="slot" href="${hrefItem(alts[0])}" title="${esc(tip)}"${alts.length > 1 ? ` data-alts="${alts.join(",")}"` : ""}>${iconImg(alts[0])}${alts.length > 1 ? `<span class="any">+${alts.length - 1}</span>` : ""}</a>`;
  };
  return `<div class="recipe"><div class="cg s${size}">${cells.map(cell).join("")}</div><span class="arrow">&rarr;</span>` +
    `<a class="slot out" href="${hrefItem(r.out)}" title="${esc(nameOf(r.out))}">${iconImg(r.out)}${r.n > 1 ? `<span class="n">${r.n}</span>` : ""}</a>` +
    `<div class="rdesc">${esc(r.desc || "")}${size === 3 ? ` <span class="muted">(crafting table)</span>` : ""}</div></div>`;
}

function offerHTML(o, prof, showProf) {
  return `<span class="offer">${o.buy.map(b => stackLink(b.id, b.n)).join(`<span class="plus">+</span>`)}<span class="arrow">&rarr;</span>${stackLink(o.sell.id, o.sell.n)}` +
    `<span class="otext">${o.buy.map(b => `${b.n} ${esc(nameOf(b.id))}`).join(" + ")} for ${o.sell.n} ${esc(nameOf(o.sell.id))}` +
    (showProf ? ` &middot; <a href="#/villager/${prof}">${esc(profName(prof))}</a>, ${LEVEL_NAMES[o.level - 1]}` : "") + `</span></span>`;
}

// ---------------------------------------------------------------- item pages
function naturalText(name) {
  if (natural.blocks[name]) return natural.blocks[name];
  const r = natural.rules.find(r => r.re.test(name));
  return r ? r.text : "";
}

function miningTable(b) {
  const P = BF.player;
  if (!P || !P.mineSeconds || !(b.hardness > 0)) return "";
  const rows = [["Hand", null]];
  if (b.tool && b.tool !== "shears") for (const [m, label] of TOOL_MATS) { const id = BF.I[`${m}_${b.tool}`]; if (id !== undefined) rows.push([`${label} ${b.tool}`, id]); }
  if (b.shearSpeed && BF.I.shears !== undefined) rows.push(["Shears", BF.I.shears]);
  const cells = rows.map(([label, id]) => {
    const s = P.mineSeconds(b.id, id), ok = P.minedDrops(b.id, id);
    return `<tr><td>${id != null ? itemLink(id, label) : label}</td><td>${s === Infinity ? "Never" : fmt(s) + " s"}</td><td>${ok ? "Yes" : "No"}</td></tr>`;
  }).join("");
  return `<h2 id="mining">Mining</h2><table class="wt"><thead><tr><th>Tool</th><th>Time</th><th>Drops its item</th></tr></thead><tbody>${cells}</tbody></table>`;
}

function propsTable(it) {
  const rows = [];
  rows.push(["Name in commands", `<code>${esc(it.name)}</code>`]);
  rows.push(["Type", it.isBlock ? "Block" : "Item"]);
  rows.push(["Stacks to", it.stack || 64]);
  if (it.isBlock) {
    rows.push(["Hardness", it.hardness == null ? "Unbreakable" : it.hardness < 0 ? "Unbreakable" : it.hardness]);
    if (it.tool) rows.push(["Best tool", exists("tool", it.tool) ? `<a href="#/tool/${it.tool}">${esc(title(it.tool))}</a>` : title(it.tool)]);
    if (it.needsTool) rows.push(["Needs a tool to drop", it.minTier ? `Yes, ${["", "wooden", "stone", "iron", "diamond"][it.minTier] || "tier " + it.minTier} ${it.tool || "tool"} or better` : "Yes"]);
    const e = BF.EMIT && BF.EMIT[it.id];
    if (e) rows.push(["Light level", e]);
    rows.push(["Solid", it.solid === false ? "No" : "Yes"]);
    if (it.opaque === false && it.solid !== false) rows.push(["Transparent", "Yes"]);
  }
  if (it.tool && !it.isBlock) {
    rows.push(["Tool", `${exists("tool", it.tool.type) ? `<a href="#/tool/${it.tool.type}">${esc(title(it.tool.type))}</a>` : title(it.tool.type || "")}${it.tool.tier ? `, tier ${it.tool.tier}` : ""}`]);
    if (it.tool.speed) rows.push(["Mining speed", it.tool.speed]);
    if (it.tool.damage) rows.push(["Attack damage", it.tool.damage]);
  }
  const dur = BF.durability ? BF.durability(it.id) : it.durability;
  if (dur) rows.push(["Durability", `${dur} uses`]);
  if (it.food) rows.push(["Food", `${it.food} hunger points (${fmt(it.food / 2, 1)} shanks)`]);
  const fuel = BF.inventory.fuel.get(it.id);
  if (fuel) rows.push(["Furnace fuel", `${fuel} s (${fmt(fuel / 10, 1)} items)`]);
  const v = BF.trades.VALUE && BF.trades.VALUE[it.name];
  if (v != null && it.name !== "emerald") rows.push(["Trade value", `${fmt(v, 3)} emerald`]);
  return `<table class="props">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table>`;
}

function itemPage(name) {
  const id0 = BF.I[name];
  if (id0 === undefined) return notFound(`The block or item <code>${esc(name)}</code>`, [`<a href="#/items">Blocks and items</a>`]);
  const id = pageId(id0), it = item(id);
  const sec = [];
  // ---- obtaining
  const get = [];
  const nat = it.isBlock ? naturalText(it.name) : "";
  if (nat) get.push(`<h3>Natural generation</h3>${md(nat)}`);
  if (it.isBlock && it.hardness >= 0) {
    const drops = [];
    if (it.drop != null) drops.push(it.drop === id ? "itself" : itemLink(it.drop));
    for (const [n, a, b, p] of it.extraDrops || []) if (BF.I[n] !== undefined) drops.push(`${itemLink(BF.I[n])} ${a === b ? a : `${a}-${b}`}${p < 1 ? ` <span class="muted">(${fmt(p * 100, 1)}% chance)</span>` : ""}`);
    get.push(`<h3>Breaking it</h3><p>${drops.length ? "Drops " + drops.join(", ") + (it.needsTool ? " when mined with the right tool" : "") + "." : "Drops nothing."}</p>`);
  }
  const from = D.blockDrops.get(id) || [];
  if (from.length) get.push(`<h3>Dropped by blocks</h3><ul class="links">${from.map(f => `<li>${itemLink(f.src)} ${f.a === f.b ? (f.a > 1 ? f.a : "") : `${f.a}-${f.b}`}${f.p < 1 ? ` <span class="muted">(${fmt(f.p * 100, 1)}% chance)</span>` : ""}</li>`).join("")}</ul>`);
  const md2 = D.mobDrops.get(id) || [];
  if (md2.length) get.push(`<h3>Dropped by mobs</h3><ul class="links">${md2.map(d => `<li><a href="#/mob/${d.t}">${esc(title(d.t))}</a> ${d.a === d.b ? d.a : `${d.a}-${d.b}`}</li>`).join("")}</ul>`);
  const made = D.made.get(id) || [];
  if (made.length) get.push(`<h3>Crafting</h3>${made.map(recipeHTML).join("")}`);
  const sm = D.smeltFrom.get(id) || [];
  if (sm.length) get.push(`<h3>Smelting</h3><p>Smelt ${sm.map(i => itemLink(i)).join(", ")} in a furnace.</p>`);
  const sold = D.sold.get(id) || [];
  if (sold.length) get.push(`<h3>Bought from villagers</h3><p class="muted">Default prices; in a running village they drift with supply and demand (see <a href="#/page/village-economy">village economy</a>).</p><ul class="offers">${sold.map(s => `<li>${offerHTML(s.o, s.prof, true)}</li>`).join("")}</ul>`);
  if (get.length) sec.push(`<h2 id="obtaining">How to get it</h2>${get.join("")}`);
  else if (!it.isBlock || it.hardness == null) sec.push(`<h2 id="obtaining">How to get it</h2><p class="muted">Only from the creative menu or <code>/give</code>.</p>`);
  // ---- mining
  if (it.isBlock) sec.push(miningTable(it));
  // ---- usage
  const use = [];
  const jobs = D.jobsiteOf.get(id) || [];
  if (jobs.length) use.push(`<h3>Jobsite</h3><p>Jobsite block of the ${jobs.map(p => `<a href="#/villager/${p}">${esc(profName(p).toLowerCase())}</a>`).join(" and ")}: an unemployed villager who claims it takes that profession.</p>`);
  const used = (D.used.get(id) || []).filter(r => pageId(r.out) !== id);
  if (used.length) {
    const outs = [...new Set(used.map(r => pageId(r.out)))];
    use.push(`<h3>Crafting ingredient</h3><div class="chips">${outs.map(o => itemLink(o)).join("")}</div>` +
      (used.length <= 6 ? used.map(recipeHTML).join("") : `<details><summary>Show the ${used.length} recipes</summary>${used.map(recipeHTML).join("")}</details>`));
  }
  const into = BF.inventory.smelting.get(id);
  if (into !== undefined) use.push(`<h3>Smelting</h3><p>Smelts into ${itemLink(into)}.</p>`);
  const bought = D.bought.get(id) || [];
  if (bought.length) use.push(`<h3>Sold to villagers</h3><ul class="offers">${bought.map(s => `<li>${offerHTML(s.o, s.prof, true)}</li>`).join("")}</ul>`);
  if (use.length) sec.push(`<h2 id="usage">Uses</h2>${use.join("")}`);
  const cat = D.cre.find(e => e.id === id), tab = cat && D.tabs.find(t => t.key === cat.cat);
  setPage(`<div class="infobox"><div class="pic">${iconImg(id, "huge")}</div>${propsTable(it)}</div>
    <h1>${esc(nameOf(id))}</h1>${sec.join("")}`,
    [`<a href="#/items">Blocks and items</a>`].concat(tab ? [`<a href="#/items/${tab.key}">${esc(tab.label)}</a>`] : []));
}

// ---------------------------------------------------------------- villager pages
async function villagerPage(prof) {
  if (!D.profs.includes(prof)) return notFound(`The profession ${esc(prof)}`, [`<a href="#/villagers">Villagers</a>`]);
  const T = BF.trades, b = BF.jobs.JOBSITE[prof], jid = b && BF.I[b];
  const facts = [];
  facts.push(["Jobsite", jid !== undefined && jid !== null ? itemLink(jid) : prof === "nitwit" ? "None: nitwits never work" : prof === "unemployed" ? "None: looks for an unclaimed jobsite" : "None"]);
  const st = T.STARTER_TOOLS && T.STARTER_TOOLS[prof];
  if (st && st.length) facts.push(["Founding villagers start with", st.filter(n => BF.I[n] !== undefined).map(n => itemLink(BF.I[n])).join(" ")]);
  const pr = (T.PRODUCE && T.PRODUCE[prof]) || [];
  facts.push(["Restocked daily from nothing", pr.length ? pr.filter(n => BF.I[n] !== undefined).map(n => itemLink(BF.I[n])).join(" ") : "Nothing: every ware comes from work or trade"]);
  const pools = D.tables[prof] || [];
  let trades = "";
  if (pools.some(p => p.length)) {
    trades = `<h2 id="trades">Trades</h2><p class="muted">The trade table with its default prices. A villager offers every trade up to its level; each trade gives it experience
      (${T.TRADE_XP.map((x, i) => `${LEVEL_NAMES[i]} ${x}`).join(", ")} per trade) and it levels up at ${T.LEVEL_XP.slice(1).map((x, i) => `${x} (${LEVEL_NAMES[i + 1]})`).join(", ")}.
      Prices with emeralds on one side drift with demand in a running village (see <a href="#/page/village-economy">village economy</a>).</p>` +
      `<table class="wt trades"><thead><tr><th>Level</th><th>Trade</th></tr></thead><tbody>` +
      pools.map((p, i) => p.map((o, j) => `<tr>${j === 0 ? `<td rowspan="${p.length}" class="lv">${LEVEL_NAMES[i]}</td>` : ""}<td>${offerHTML(o, prof, false)}</td></tr>`).join("")).join("") +
      `</tbody></table>`;
  } else trades = `<h2 id="trades">Trades</h2><p>No trade table.</p>`;
  setPage(`<div class="infobox">${photo("villager-" + prof, profName(prof))}<table class="props">${facts.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table></div>
    <h1>${esc(profName(prof))}</h1><div id="beh"></div>${trades}`, [`<a href="#/villagers">Villagers</a>`]);
  const body = await extraMd("prof-" + prof);
  const el = document.getElementById("beh");
  if (el && body) el.innerHTML = `<h2 id="behaviour">Behaviour</h2>${md(body)}`;
  if (el) el.dataset.done = 1;
}

// ---------------------------------------------------------------- mob pages
async function mobPage(t) {
  if (t === "villager") { location.hash = "#/page/villagers"; return; }
  const d = BF.mobs.typeDef(t);
  if (!mobTypes().includes(t)) return notFound(`The mob ${esc(t)}`, [`<a href="#/mobs">Mobs</a>`]);
  const rows = [];
  if (d) {
    rows.push(["Kind", d.hostile ? "Hostile" : d.golem ? "Village guard" : "Passive"]);
    rows.push(["Health", hearts(d.hp)]);
    if (d.attack) rows.push(["Attack damage", hearts(d.attack)]);
    rows.push(["Walking speed", `${d.speed} blocks/s`]);
    if (d.flee) rows.push(["Fleeing speed", `${d.flee} blocks/s`]);
    rows.push(["Size", `${fmt(d.hw * 2)} &times; ${fmt(d.h)} blocks`]);
    if (d.burns) rows.push(["Burns in daylight", "Yes"]);
    if (d.climbs) rows.push(["Climbs walls", "Yes"]);
    if (d.slowFall) rows.push(["Falls slowly", "Yes"]);
    if (d.noKnock) rows.push(["Knockback", "None"]);
    const dr = (d.drops || []).filter(([n]) => BF.I[n] !== undefined);
    rows.push(["Drops", dr.length ? dr.map(([n, a, b]) => `${itemLink(BF.I[n])} ${a === b ? a : `${a}-${b}`}`).join("<br>") : "Nothing"]);
  } else rows.push(["Health", "None: bees cannot be hurt"]);
  let habitat = "";
  const H = BF.wildlife && BF.wildlife.HABITAT;
  if (H) {
    const where = Object.entries(H).map(([b, l]) => [+b, (l.find(e => e[0] === t) || [])[1]]).filter(e => e[1]);
    if (where.length) {
      const G = BF.wildlife.GROUP || [];
      habitat = `<h2 id="habitat">Where it lives</h2><p>Wild groups of ${G[0]}-${G[1]} spawn the first time a chunk loads, by the biome at its centre
        (see <a href="#/page/mob-spawning">mob spawning</a>). Odds per chunk:</p><table class="wt"><thead><tr><th>Biome</th><th>Chance of a group</th></tr></thead><tbody>` +
        where.map(([b, p]) => `<tr><td>${biomeNames[b] ? `<a href="#/biome/${slug(biomeNames[b])}">${esc(biomeNames[b])}</a>` : "Biome " + b}</td><td>${fmt(p * 100, 1)}%</td></tr>`).join("") + "</tbody></table>";
    }
  }
  setPage(`<div class="infobox">${photo("mob-" + t, title(t))}<table class="props">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table></div>
    <h1>${esc(title(t))}</h1><div id="beh"></div>${habitat}`, [`<a href="#/mobs">Mobs</a>`]);
  const body = await extraMd("mob-" + t);
  const el = document.getElementById("beh");
  if (el && body) el.innerHTML = `<h2 id="behaviour">Behaviour</h2>${md(body)}`;
  if (el) el.dataset.done = 1;
}

// ---------------------------------------------------------------- biomes
const pct = x => x >= 0.995 ? "100%" : x < 0.005 && x > 0 ? "under 1%" : Math.round(x * 100) + "%";
const animalsOf = id => ((BF.wildlife && BF.wildlife.HABITAT && BF.wildlife.HABITAT[id]) || []).filter(([t]) => mobTypes().includes(t));
const mobThumb = (t, size) => `<a class="mt" href="#/mob/${t}" title="${esc(title(t))}" style="width:${size}px;height:${size}px"><img src="${dir}images/mob-${t}.jpg" alt="${esc(title(t))}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${esc(title(t)).replace(/'/g, "")}'}))"></a>`;
// a little crowd: each kind as a cluster of portraits, more of them the likelier it is
function cluster(list) {
  const max = Math.max(...list.map(e => e[1]));
  return `<div class="clusters">${list.map(([t, p]) => {
    const k = Math.max(1, Math.round(4 * p / max));
    return `<div class="cl"><div class="crowd">${Array.from({ length: k }, () => mobThumb(t, 44)).join("")}</div><div class="cap"><a href="#/mob/${t}">${esc(title(t))}</a> <span class="muted">${fmt(p * 100, 1)}%</span></div></div>`;
  }).join("")}</div>`;
}
const precipText = f => !f ? "" : [f.rain && `rain ${pct(f.rain)}`, f.snow && `snow ${pct(f.snow)}`, f.none && `dry ${pct(f.none)}`].filter(Boolean).join(", ");

function biomesPage() {
  const a = articles.get("biomes");
  const rows = biomeNames.map((n, id) => {
    const f = biomeFacts && biomeFacts.biomes[id], an = animalsOf(id);
    return `<tr><td><a href="#/biome/${slug(n)}">${esc(n)}</a></td><td>${f ? pct(f.share) : "?"}</td><td>${f ? `${f.height[1]} <span class="muted">(${f.height[0]} to ${f.height[2]})</span>` : "?"}</td>` +
      `<td>${f ? precipText(f.precip) : "?"}</td><td>${an.length ? an.map(([t]) => mobThumb(t, 26)).join("") : `<span class="muted">none</span>`}</td><td>${villageBiomes.includes(id) ? "Yes" : "No"}</td></tr>`;
  }).join("");
  setPage(`<h1>Biomes</h1>
    <p>Every biome has its own page. ${biomeFacts ? `Shares, heights and weather were measured over a ${biomeFacts.square}-block square around spawn of a world with seed ${biomeFacts.seed}.` : ""}</p>
    <table class="wt biomes"><thead><tr><th>Biome</th><th>Share of the world</th><th>Ground height</th><th>Weather</th><th>Wild animals</th><th>Villages</th></tr></thead><tbody>${rows}</tbody></table>
    ${a ? `<div class="article">${md(a.body)}</div>` : ""}`, ["World generation", "Biomes"]);
}

async function biomePage(sl) {
  const id = biomeId(sl);
  if (id < 0) return notFound(`The biome ${esc(sl)}`, [`<a href="#/biomes">Biomes</a>`]);
  const name = biomeNames[id], f = biomeFacts && biomeFacts.biomes[id];
  const rows = [];
  if (f) {
    rows.push(["Share of the world", pct(f.share)]);
    rows.push(["Ground height", `${f.height[1]} <span class="muted">(mostly ${f.height[0]} to ${f.height[2]}; sea level is ${BF.SEA || 0})</span>`]);
    rows.push(["Temperature", f.temperature]);
    rows.push(["Humidity", f.humidity]);
    rows.push(["Weather", precipText(f.precip) || "?"]);
    rows.push(["Villages", villageBiomes.includes(id) ? `Yes${f.villages ? ` (${f.villages} in the sample)` : ""}` : "No"]);
    if (f.near) rows.push(["Nearest to spawn (seed " + biomeFacts.seed + ")", `<code>/tp ${f.near[0]} ${f.near[1]}</code>`]);
  } else rows.push(["Villages", villageBiomes.includes(id) ? "Yes" : "No"]);
  const an = animalsOf(id);
  const G = (BF.wildlife && BF.wildlife.GROUP) || [];
  const animals = an.length ? `<p>Wild groups of ${G[0]}-${G[1]} animals of one kind; the chance that a chunk gets one, by kind (see <a href="#/page/mob-spawning">mob spawning</a>):</p>${cluster(an)}`
    : `<p>No wild animals spawn here.</p>`;
  const monsters = hostileWeights.length ? `<p>Monsters spawn in the dark here as everywhere, in this mix:</p>${cluster(hostileWeights.filter(([t]) => mobTypes().includes(t)))}` : "";
  const borders = f ? Object.entries(f.borders).filter(([b]) => biomeNames[b]).sort((a, b) => b[1] - a[1]) : [];
  const tot = borders.reduce((s, e) => s + e[1], 0);
  const bordersHtml = borders.length ? `<div class="chips">${borders.filter(([, c]) => c / tot >= 0.01).map(([b, c]) => `<a href="#/biome/${slug(biomeNames[b])}">${esc(biomeNames[b])} <span class="muted">${pct(c / tot)}</span></a>`).join("")}</div>
    <p class="muted">Share of this biome's edge each neighbour takes, in the sample world.</p>` : "";
  setPage(`<div class="infobox">${photo("biome-" + sl, name)}<table class="props">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table></div>
    <h1>${esc(name)}</h1><div id="beh"></div>
    <div class="gallery"><figure><img src="${dir}images/biome-${sl}-ground.jpg" alt="" onerror="this.parentNode.remove()"><figcaption>On the ground</figcaption></figure></div>
    <h2 id="animals">Wild animals</h2>${animals}
    <h2 id="monsters">Monsters</h2>${monsters}
    ${bordersHtml ? `<h2 id="borders">Borders</h2>${bordersHtml}` : ""}`, [`<a href="#/biomes">Biomes</a>`]);
  const body = await extraMd("biome-" + sl);
  const el = document.getElementById("beh");
  if (el && body) el.innerHTML = md(body);
  if (el) el.dataset.done = 1;
}

// ---------------------------------------------------------------- articles and search
function articlePage(id) {
  if (id === "biomes") { location.replace("#/biomes"); return; }
  const a = articles.get(id);
  if (!a) return notFound(`The article ${esc(id)}`);
  const html = md(a.body);
  const heads = [...html.matchAll(/<h2 id="([^"]+)">(.*?)<\/h2>/g)];
  const toc = heads.length >= 3 ? `<nav class="toc"><b>Contents</b>${heads.map(h => `<a href="javascript:void 0" data-to="${h[1]}">${h[2].replace(/<[^>]+>/g, "")}</a>`).join("")}</nav>` : "";
  setPage(`<h1>${esc(a.title)}</h1>${toc}<div class="article">${html}</div>`, [esc(a.category), esc(a.title)]);
  for (const l of main.querySelectorAll(".toc a")) l.addEventListener("click", () => { const t = document.getElementById(l.dataset.to); if (t) t.scrollIntoView(); });
}

// ---------------------------------------------------------------- tool comparison pages
// Blocks timed in each tool table (the first few that exist and are the tool's own); a sword is timed on the blocks it cuts faster.
const TOOL_SAMPLES = { pickaxe: ["cobblestone", "stone", "iron_ore", "diamond_ore", "obsidian"], axe: ["oak_log", "planks", "chest"],
  shovel: ["dirt", "sand", "gravel"], hoe: ["oak_leaves", "hay_bale"], sword: ["oak_leaves", "pumpkin", "melon"] };
const tierTools = (type, tier) => toolsOf(type).filter(t => t.tool.tier === tier).map(t => nameOf(t.id).replace(new RegExp(" " + type + "$", "i"), "").toLowerCase());
function toolsPage() {
  const ts = toolTypes();
  setPage(`<h1>Tools</h1><p>Each tool comes in several materials. A tool's page compares them: mining speed, durability, attack damage and how long each takes on common blocks.</p>
    <div class="grid">${ts.map(t => `<a class="tile" href="#/tool/${t}">${iconImg(toolsOf(t).slice(-1)[0].id, "big")}<span>${esc(title(t))}s</span></a>`).join("")}</div>
    <p>See also <a href="#/page/mining-and-tools">mining and tools</a>.</p>`);
}
function toolPage(type) {
  if (!exists("tool", type)) return notFound(`The tool type <code>${esc(type)}</code>`, [`<a href="#/tools">Tools</a>`]);
  const P = BF.player, plural = title(type) + "s";
  const tools = toolsOf(type).sort((a, b) => a.tool.tier - b.tool.tier || a.tool.speed - b.tool.speed);
  const own = b => b && b.isBlock && b.hardness > 0 && (type === "sword" ? b.swordSpeed : b.tool === type);
  let samples = (TOOL_SAMPLES[type] || []).map(n => BF.I[n]).filter(id => id !== undefined && own(item(id)));
  if (!samples.length) samples = D.cre.map(e => e.id).filter(id => own(item(id))).slice(0, 3);
  samples = samples.slice(0, 4);
  const cols = [["Mining speed", t => t.tool.speed], ["Durability", t => (BF.durability ? BF.durability(t.id) : t.durability) + " uses"], ["Attack damage", t => t.tool.damage]];
  const same = cols.filter(([, f]) => tools.every(t => f(t) === f(tools[0])));   // a column every material shares becomes a sentence
  const shown = cols.filter(c => !same.includes(c));
  const time = (bid, tid) => {
    if (!P || !P.mineSeconds) return "";
    const s = P.mineSeconds(bid, tid), ok = P.minedDrops(bid, tid);
    return (s === Infinity ? "Never" : fmt(s) + " s") + (ok ? "" : ` <span class="muted">(no drop)</span>`);
  };
  const head = `<tr><th>Tool</th><th>Tier</th>${shown.map(c => `<th>${c[0]}</th>`).join("")}${samples.map(id => `<th>${itemLink(id)}</th>`).join("")}</tr>`;
  const hand = `<tr><td>Hand</td><td>&ndash;</td>${shown.map(c => `<td>${c[0] === "Attack damage" ? 1 : "&ndash;"}</td>`).join("")}${samples.map(id => `<td>${time(id, null)}</td>`).join("")}</tr>`;
  const rows = tools.map(t => `<tr><td>${itemLink(t.id)}</td><td>${t.tool.tier}</td>${shown.map(c => `<td>${c[1](t)}</td>`).join("")}${samples.map(id => `<td>${time(id, t.id)}</td>`).join("")}</tr>`).join("");
  const notes = same.map(([k, f]) => `Every ${type} has ${k.toLowerCase()} ${f(tools[0])}.`);
  // harvest levels: blocks of this tool's kind that drop nothing below a tier (creative-menu blocks only, so stair shapes are not repeated)
  const levels = new Map();
  for (const e of D.cre) { const b = item(e.id); if (b && b.isBlock && b.needsTool && b.tool === type && b.minTier > 1) push(levels, b.minTier, e.id); }
  const lv = [...levels.keys()].sort().map(tier => {
    const names = tierTools(type, tier), more = tools.some(t => t.tool.tier > tier);
    return `<tr><td>${esc(names.length ? names.join(" or ") : "tier " + tier)}${more ? " or better" : ""}</td><td><div class="chips">${levels.get(tier).map(id => itemLink(id)).join("")}</div></td></tr>`;
  }).join("");
  const wear = type === "sword" ? "A sword wears 1 use per hit and 2 per block broken." : `A ${type} wears 1 use per block broken and 2 per hit.`;
  setPage(`<h1>${esc(plural)}</h1>
    <p>Every ${type} in Blockfield ${esc(ver.id)}, side by side. Times are for the player standing on dry ground; a tool only speeds up blocks it is meant for${type === "sword" ? " (a sword cuts leaves, pumpkins and melons faster)" : ""}.
    The tier decides what a tool can harvest: wooden 1, stone 2, iron 3, diamond 4.${notes.length ? " " + notes.join(" ") : ""} ${esc(wear)}</p>
    <h2 id="compare">Comparison</h2><div class="scroll"><table class="wt">${head}${hand}${rows}</table></div>
    ${lv ? `<h2 id="harvest">Harvest levels</h2><p>These blocks drop nothing unless mined with at least:</p><table class="wt"><thead><tr><th>${esc(title(type))}</th><th>Blocks</th></tr></thead><tbody>${lv}</tbody></table>` : ""}
    <p>See also <a href="#/page/mining-and-tools">mining and tools</a>.</p>`,
    [`<a href="#/tools">Tools</a>`]);
}

function searchAll(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  const score = s => { s = s.toLowerCase(); return s === q ? 0 : s.startsWith(q) ? 1 : s.includes(q) ? 2 : -1; };
  for (const a of articles.values()) { const s = score(a.title); if (s >= 0) out.push({ s, href: `#/page/${a.id}`, html: esc(a.title), kind: "Article" }); }
  for (const t of toolTypes()) { const s = Math.min(...[score(title(t)), score(title(t) + "s")].map(x => x < 0 ? 9 : x)); if (s < 9) out.push({ s: s + 0.25, href: `#/tool/${t}`, html: iconImg(toolsOf(t).slice(-1)[0].id) + esc(title(t) + "s compared"), kind: "Tools" }); }
  biomeNames.forEach(n => { const s = score(n); if (s >= 0) out.push({ s, href: `#/biome/${slug(n)}`, html: esc(n), kind: "Biome" }); });
  for (const p of D.profs) { const s = score(profName(p)); if (s >= 0) out.push({ s, href: `#/villager/${p}`, html: esc(profName(p)), kind: "Villager" }); }
  for (const t of mobTypes().concat(["villager"])) { const s = score(title(t)); if (s >= 0) out.push({ s, href: t === "villager" ? "#/page/villagers" : `#/mob/${t}`, html: esc(title(t)), kind: "Mob" }); }
  for (const e of D.cre) { const n = nameOf(e.id), s = Math.min(...[score(n), score(item(e.id).name)].map(x => x < 0 ? 9 : x)); if (s < 9) out.push({ s: s + 0.5, href: hrefItem(e.id), html: iconImg(e.id) + esc(n), kind: item(e.id).isBlock ? "Block" : "Item" }); }
  return out.sort((a, b) => a.s - b.s);
}

function searchPage(q) {
  const r = searchAll(q);
  setPage(`<h1>Search: ${esc(q)}</h1>${r.length ? `<ul class="results">${r.map(x => `<li><a href="${x.href}">${x.html}</a> <span class="muted">${x.kind}</span></li>`).join("")}</ul>` : "<p>Nothing found.</p>"}`);
}

const box = document.getElementById("search"), drop = document.getElementById("drop");
box.addEventListener("input", () => {
  if (!BF) return;
  const r = searchAll(box.value).slice(0, 12);
  drop.innerHTML = r.map(x => `<a href="${x.href}">${x.html}<span class="muted">${x.kind}</span></a>`).join("");
  drop.hidden = !r.length;
});
box.addEventListener("keydown", e => {
  if (e.key === "Enter" && box.value.trim()) { location.hash = "#/search/" + encodeURIComponent(box.value.trim()); drop.hidden = true; box.blur(); }
  if (e.key === "Escape") { drop.hidden = true; box.blur(); }
});
drop.addEventListener("click", () => { drop.hidden = true; box.value = ""; });
document.addEventListener("click", e => { if (!e.target.closest(".search")) drop.hidden = true; });
// slots that take any of several items show each in turn, as the game's recipe screens do
let tick = 0;
setInterval(() => {
  if (!BF) return;
  tick++;
  for (const el of main.querySelectorAll(".slot[data-alts]")) {
    const a = el.dataset.alts.split(","), id = +a[tick % a.length], img = el.querySelector("img");
    if (img) img.src = BF.inventory.iconURL(id);
    el.href = hrefItem(id);
  }
}, 1000);
document.getElementById("menu").addEventListener("click", () => document.body.classList.toggle("nav-open"));

boot();
})();

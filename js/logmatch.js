// Reading village log entries: who did what. Shared by the game (alerts, js/alerts.js) and the debug screen (log filters and
// the alert editor, debug/index.html loads this same file), so a filter and an alert always agree on what an entry is.
// Entries are [t, kind, text, [x, y, z]?] (js/villagelog.js). Who did what is read from the text, whose formats come from
// js/villagelog.js (and mobs.js, storage.js, toolwear.js, villagelife.js): "Name (Job) traded with Name (Job): ...", "Name (Job)
// placed a bed at ...", "Name (Job) claimed the bed/chest at ...", "Name became a Job", "Name was born to ...", "Name (Job)
// died: ...", "Name (Job)'s Iron Pickaxe broke", "Name (Farmer) started harvesting Wheat at ...", "Name (Builder) started building a ... at ...".
// API: BFLog = { ACTIONS, KINDS, ACTS_FOR(type), kindName(k), typeOf(party), actorsOf(entry), matches(alert, entry), describe(alert) }
// (BF.logmatch in the game is the same object.)
(() => {
"use strict";

const ACTIONS = { buy: "Buying", sell: "Selling", bed: "Placing or claiming beds", chest: "Claiming chests", job: "Taking the job", tool: "Wearing out tools", harvest: "Harvesting", build: "Building", born: "Being born", death: "Dying", horse: "Handling horses", caravan: "Travelling with goods" };
const ACTS_FOR = t => t === "Player" ? ["buy", "bed", "chest"] : t === "Child" ? ["born", "death"] :
  t === "Farmer" ? ["buy", "sell", "bed", "chest", "job", "tool", "harvest", "death"] : t === "Builder" ? ["buy", "sell", "bed", "chest", "job", "tool", "build", "death"] : t === "Stable Hand" ? ["buy", "sell", "bed", "chest", "job", "tool", "horse", "death"] : t === "Merchant" ? ["buy", "sell", "bed", "job", "caravan", "death"] : ["buy", "sell", "bed", "chest", "job", "tool", "death"];
const KINDS = { trade: "Trades", bed: "Beds and tents", chest: "Chests", job: "Job changes", tool: "Tools wearing out", farm: "Harvests", build: "Building", birth: "Births", death: "Deaths", horse: "Horses", caravan: "Caravans" };
const kindName = k => KINDS[k] || k.charAt(0).toUpperCase() + k.slice(1);
const typeOf = party => party === "Player" ? "Player" : (/\(([^()]+)\)\s*$/.exec(party) || [])[1] || null;

// -> [[type, action], ...] (a trade has a buyer and a seller); null = names no villager type
function actorsOf(e) {
  const k = e[1], tx = e[2];
  let m;
  if (k === "trade" && (m = /^(.*?) traded with (.*?\)):/.exec(tx))) {
    const out = [], b = typeOf(m[1]), s = typeOf(m[2]);
    if (b) out.push([b, "buy"]); if (s) out.push([s, "sell"]);
    return out.length ? out : null;
  }
  if ((k === "bed" || k === "chest") && (m = /^(Player|.*?\([^()]+\)) (?:placed a |claimed the )/.exec(tx))) { const t = typeOf(m[1]); return t ? [[t, k]] : null; }
  if (k === "job" && (m = / became an? (.+?)(?: \(was |$)/.exec(tx))) return [[m[1], "job"]];
  if (k === "tool" && (m = /^(.*?\))'s .* broke$/.exec(tx))) { const t = typeOf(m[1]); return t ? [[t, "tool"]] : null; }
  if (k === "farm" && (m = /^(.*?\)) started harvesting /.exec(tx))) { const t = typeOf(m[1]); return t ? [[t, "harvest"]] : null; }
  if (k === "build" && (m = /^(.*?\([^()]+\)) /.exec(tx))) { const t = typeOf(m[1]); return t ? [[t, "build"]] : null; }
  if (k === "horse" && (m = /^(.*?\([^()]+\)) /.exec(tx))) { const t = typeOf(m[1]); return t ? [[t, "horse"]] : null; }   // js/stables.js
  if (k === "caravan" && (m = /^(.*?\(Merchant\)) /.exec(tx))) return [["Merchant", "caravan"]];   // js/merchant.js
  if (k === "birth") return [["Child", "born"]];
  if (k === "death" && (m = /^(.*?\)) died/.exec(tx))) { const t = typeOf(m[1]); return t ? [[t, "death"]] : null; }
  return null;
}

// An alert: { who: villager type or "" (anyone), act: action or "" (any), kind: event type or "" (any), text: "" or words the
// entry must contain }. With who or act set, the entry has to name a villager that fits: Forester + Trades fires on a forester
// buying or selling, Farmer + Harvesting + "wheat" on a farmer starting on its wheat.
function matches(a, e) {
  if (!a || !e) return false;
  if (a.kind && e[1] !== a.kind) return false;
  if (a.text && !String(e[2]).toLowerCase().includes(String(a.text).toLowerCase().trim())) return false;
  if (!a.who && !a.act) return true;
  return (actorsOf(e) || []).some(([t, act]) => (!a.who || t === a.who) && (!a.act || act === a.act));
}
// "Farmer harvesting, containing "wheat"", "Births", "Anyone trading"
function describe(a) {
  const who = a.who || "", act = a.act ? ACTIONS[a.act] || a.act : "", kind = a.kind ? kindName(a.kind) : "";
  let s = who && act ? who + ": " + act.toLowerCase() : who ? who + (kind ? ": " + kind.toLowerCase() : ": anything") : act ? "Anyone: " + act.toLowerCase() : kind || "Every event";
  if ((who || act) && kind && act) s += " (" + kind.toLowerCase() + ")";
  if (a.text) s += ', containing "' + a.text + '"';
  return s;
}

const api = { ACTIONS, KINDS, ACTS_FOR, kindName, typeOf, actorsOf, matches, describe };
window.BFLog = api;
if (window.BF) window.BF.logmatch = api; else window.BF = { logmatch: api };
})();

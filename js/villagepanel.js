// The F3 village panel and the names floating over villagers (spec r15-37: moved here from js/villagelog.js so the page draws them from
// the protocol, not the simulation). With F3 on:
//   names   over every villager within LABEL_R blocks: its name and occupation, from the client's mirror (BF.client.world entities: name,
//           prof), placed where js/mobview.js draws it;
//   panel   the village the player stands in (#vlog): name, villagers and beds, unclaimed job blocks, occupations and the newest log lines,
//           from the "vpanel" query (js/protocol.js) twice a second.
// API: BF.villagePanel = { update(dt, on), labels() -> count }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const LABEL_R = 40;       // names float over villagers this close to the player
const SHOW = 26;          // log lines in the panel

const labels = new Map();     // protocol number -> { sp, key }
const texCache = new Map();
let panelEl = null, panelT = 0, gen = -1, asking = false;

const pretty = s => String(s || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// ---------------------------------------------------------------- floating names
function labelTexture(name, prof) {
  const k = name + "|" + prof;
  let t = texCache.get(k);
  if (t) return t;
  const c = document.createElement("canvas"); c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.textAlign = "center"; g.textBaseline = "middle";
  g.font = "bold 26px sans-serif"; g.lineWidth = 5; g.strokeStyle = "#000a"; g.strokeText(name, 128, 22); g.fillStyle = "#fff"; g.fillText(name, 128, 22);
  g.font = "18px sans-serif"; g.strokeText(prof, 128, 47); g.fillStyle = "#cfe8b0"; g.fillText(prof, 128, 47);
  t = new THREE.CanvasTexture(c);
  texCache.set(k, t);
  if (texCache.size > 400) { const f = texCache.keys().next().value; texCache.get(f).dispose(); texCache.delete(f); }
  return t;
}
function dropLabel(n, l) { if (BF.scene) BF.scene.remove(l.sp); l.sp.material.dispose(); labels.delete(n); }
let _lp = null;
function updateLabels(on) {
  if (!BF.scene || typeof THREE === "undefined") return;
  if (!_lp) _lp = new THREE.Vector3();
  const pp = BF.player && BF.player.position, M = BF.client && BF.client.world;
  if (!on || !pp || !M) { for (const [n, l] of [...labels]) dropLabel(n, l); return; }
  const seen = new Set();
  for (const m of M.entities.values()) {
    if (m.kind !== "mob" || m.type !== "villager" || m.dead) continue;
    if (BF.planet.distance(m, pp) > LABEL_R) continue;
    seen.add(m.n);
    const prof = m.child ? "Child" : pretty(m.prof), name = m.name || "Villager", key = name + "|" + prof;
    let l = labels.get(m.n);
    if (!l) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(name, prof), transparent: true, depthWrite: false }));
      sp.scale.set(1.6, 0.4, 1); sp.renderOrder = 10;
      BF.scene.add(sp); labels.set(m.n, l = { sp, key });
    } else if (l.key !== key) { l.sp.material.map = labelTexture(name, prof); l.sp.material.needsUpdate = true; l.key = key; }
    const dp = BF.mobView.drawPos(m, _lp);   // where the villager is drawn (js/mobview.js)
    l.sp.position.set(dp.x, dp.y + (m.h || 1.95) + 0.45, dp.z);
  }
  for (const [n, l] of [...labels]) if (!seen.has(n)) dropLabel(n, l);
}

// ---------------------------------------------------------------- the panel
function renderPanel(d) {
  if (!panelEl) return;
  if (!d || !d.ok || d.none) { panelEl.hidden = true; return; }
  const occ = d.occupations.map(([p, n]) => n + " " + p).join(", "), free = d.free.map(([p, n]) => n + " " + p).join(", ");
  const at = e => Array.isArray(e[3]) && !e[2].includes(e[3].join(", ")) ? " at " + e[3].join(", ") : "";   // where, unless the text says already
  const rows = d.log.map(e => `<div class="vl-${e[1]}"><span>${e[0]}</span> ${esc(e[2] + at(e))}</div>`).join("");
  panelEl.innerHTML = `<h4>${esc(d.name)}</h4><div class="vl-tally">${d.villagers} villagers &middot; ${d.beds} beds &middot; ${d.unclaimed} unclaimed job blocks${free ? " (" + esc(free) + ")" : ""}</div>` +
    `<div class="vl-tally">Occupations: ${esc(occ || "none loaded")}${d.loaded < d.villagers ? " (rest not loaded)" : ""}</div>` +
    (rows || `<div class="vl-none">No events yet.</div>`) + (d.total > SHOW ? `<div class="vl-none">${d.total - SHOW} older entries not shown</div>` : "");
  panelEl.hidden = false;
}

BF.villagePanel = {
  // once a frame (js/main.js); on: F3 is showing
  update(dt, on) {
    const M = BF.client && BF.client.world;
    if (M && M.gen !== gen) { gen = M.gen; for (const [n, l] of [...labels]) dropLabel(n, l); }   // a new world
    updateLabels(on);
    if (!panelEl) panelEl = document.getElementById("vlog");
    if (!on) { if (panelEl) panelEl.hidden = true; panelT = 0; return; }
    const t = performance.now();                  // wall clock: the game's dt is clamped at low frame rates
    const pp = BF.player && BF.player.position;
    if (t - panelT > 500 && !asking && pp && BF.client) {
      panelT = t; asking = true;
      BF.client.query("vpanel", { x: pp.x, z: pp.z, n: SHOW }, r => { asking = false; renderPanel(r); });
    }
  },
  labels: () => labels.size,
};
})();

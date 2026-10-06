// Sound: every effect, ambience loop and music note is synthesized (Web Audio, no audio files).
// Samples are generated in JS once (lazily, per name) into AudioBuffers and reused; music is a seeded generative
// piano + pad piece through a generated convolution reverb. Nothing is created before the first user gesture.
// Hooks into the game through events (see CONTRACT.md "Audio") and light polling of BF.player / BF.mobs / BF.world.
// Loaded after main.js; drives its own requestAnimationFrame loop (no main.js change needed).
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
const ACtor = window.AudioContext || window.webkitAudioContext;
const SR = 44100;          // effect sample rate
const MSR = 22050;         // music notes and ambience loops
const MAX_VOICES = 24;
const TAU = Math.PI * 2;

// ---------- seeded random ----------
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let seedCounter = 1;
const rnd = (a, b) => a + (b - a) * Math.random();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------- DSP helpers (sample generation only, never per frame) ----------
const mk = (sec, sr = SR) => new Float32Array(Math.max(1, Math.round(sec * sr)));
function bqNew() { return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0 }; }
function bqSet(f, type, freq, q, sr) {
  freq = clamp(freq, 10, sr * 0.45);
  const w = TAU * freq / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
  let b0, b1, b2;
  const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  if (type === "lp") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
  else if (type === "hp") { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
  else { b0 = al; b1 = 0; b2 = -al; }  // bp, 0 dB peak
  f.b0 = b0 / a0; f.b1 = b1 / a0; f.b2 = b2 / a0; f.a1 = a1 / a0; f.a2 = a2 / a0;
  return f;
}
function bq(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y;
  return y;
}
const filt = (type, freq, q, sr = SR) => bqSet(bqNew(), type, freq, q || 0.707, sr);
// in-place filter of a whole buffer
function filter(out, type, freq, q, sr = SR) { const f = filt(type, freq, q, sr); for (let i = 0; i < out.length; i++) out[i] = bq(f, out[i]); return out; }
// piecewise-linear curve over u in [0,1]: pts([[0, a], [0.3, b], [1, c]])
function pts(p) {
  return u => {
    if (u <= p[0][0]) return p[0][1];
    for (let i = 1; i < p.length; i++) if (u <= p[i][0]) { const [u0, v0] = p[i - 1], [u1, v1] = p[i]; return v0 + (v1 - v0) * (u - u0) / (u1 - u0 || 1); }
    return p[p.length - 1][1];
  };
}
// attack / release envelope as fractions of the duration (smooth edges)
const adr = (a, r) => u => { const x = u < a ? u / a : u > 1 - r ? (1 - u) / r : 1; return x * x * (3 - 2 * x); };
// filtered noise burst: linear attack, exponential decay (tau), ends at dur with a short fade
function burst(out, r, t0, dur, amp, attack, tau, filters, sr = SR) {
  const fs = (filters || []).map(f => filt(f[0], f[1], f[2], sr));
  const n0 = Math.round(t0 * sr), n = Math.min(out.length - n0, Math.round(dur * sr));
  const na = Math.max(1, attack * sr), k = Math.exp(-1 / (tau * sr)), nf = Math.min(n, Math.round(0.006 * sr));
  let e = 1;
  for (let i = 0; i < n; i++) {
    let x = r() * 2 - 1;
    for (const f of fs) x = bq(f, x);
    let g = i < na ? i / na : (e *= k);
    if (i > n - nf) g *= (n - i) / nf;
    out[n0 + i] += x * g * amp;
  }
}
// short noise grains with a band-pass each, scattered over [t0, t0 + span]
function grains(out, r, t0, span, count, fLo, fHi, q, lenLo, lenHi, aLo, aHi, sr = SR, skew = 1) {
  for (let g = 0; g < count; g++) {
    const t = t0 + Math.pow(r(), skew) * span, len = lenLo + r() * (lenHi - lenLo);
    burst(out, r, t, len * 3, aLo + r() * (aHi - aLo), 0.0008, len, [["bp", fLo + r() * (fHi - fLo), q]], sr);
  }
}
// sine with exponential glide f0 -> f1 and exponential decay
function tone(out, t0, f0, f1, amp, tau, dur, sr = SR, attack = 0.002, h2 = 0) {
  const n0 = Math.round(t0 * sr), n = Math.min(out.length - n0, Math.round(dur * sr));
  if (n <= 0) return;
  const k = Math.exp(-1 / (tau * sr)), na = Math.max(1, attack * sr), q = Math.pow(f1 / f0, 1 / n), nf = Math.min(n, Math.round(0.005 * sr));
  let ph = 0, e = 1, w = TAU * f0 / sr;
  for (let i = 0; i < n; i++) {
    ph += w; w *= q;
    let g = i < na ? i / na : (e *= k);
    if (i > n - nf) g *= (n - i) / nf;
    out[n0 + i] += (h2 ? Math.sin(ph) + h2 * Math.sin(2 * ph) : Math.sin(ph)) * g * amp;
  }
}
// sum of damped sines (struck body / bell)
function modes(out, t0, list, amp, sr = SR) { for (const [f, tau, a] of list) tone(out, t0, f, f, amp * a, tau, Math.min(tau * 7, 3), sr, 0.0005); }
// chirp with sin^2 envelope (birds)
function chirp(out, t0, f0, f1, dur, amp, sr = SR, fm = 0, fmDepth = 0) {
  const n0 = Math.round(t0 * sr), n = Math.min(out.length - n0, Math.round(dur * sr));
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n, f = f0 * Math.pow(f1 / f0, u) * (1 + fmDepth * Math.sin(TAU * fm * i / sr));
    ph += TAU * f / sr;
    const e = Math.sin(Math.PI * u);
    out[n0 + i] += (Math.sin(ph) + 0.12 * Math.sin(2 * ph)) * e * e * amp;
  }
}
function polyblep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
// formant "voice": band-limited saw (+breath noise) through moving band-pass formants
function voc(o, r, sr = SR) {
  const out = mk(o.dur, sr), n = out.length;
  const forms = o.formants.map(f => ({ f: f[0], q: f[1], g: f[2], s: bqNew() }));
  let ph = 0, jt = 0, js = 0, sub = 0, f = 100, rough = 1, amp = 0;
  const breath = o.breath || 0, direct = o.direct || 0.05, nF = forms.length;
  for (let i = 0; i < n; i++) {
    if ((i & 15) === 0) {
      const t = i / sr, u = i / n;
      if ((i & 31) === 0) {
        for (const F of forms) bqSet(F.s, "bp", typeof F.f === "function" ? F.f(u) : F.f, F.q, sr);
        jt = jt * 0.85 + (r() * 2 - 1) * (o.jitter || 0);
      }
      js += (jt - js) * 0.15;
      f = o.f0(u) * (1 + js);
      if (o.vib) f *= 1 + o.vib[1] * Math.sin(TAU * o.vib[0] * t);
      rough = o.rough ? 1 - o.rough[1] * (0.5 + 0.5 * Math.sin(TAU * o.rough[0] * t)) : 1;
      amp = o.amp(u);
    }
    const dt = f / sr;
    ph += dt; if (ph >= 1) { ph -= 1; sub = -sub || 1; }
    let s = 2 * ph - 1 - polyblep(ph, dt);
    if (o.sub) s += o.sub * sub * 0.5;
    s = s * rough + (r() * 2 - 1) * breath;
    let y = s * direct;
    for (let j = 0; j < nF; j++) y += bq(forms[j].s, s) * forms[j].g;
    out[i] = y * amp;
  }
  if (o.lp) filter(out, "lp", o.lp, 0.7, sr);
  return out;
}
// mix src into dst at time t (seconds), scaled
function mixIn(dst, src, t, amp = 1, sr = SR) {
  const n0 = Math.round(t * sr);
  for (let i = 0; i < src.length && n0 + i < dst.length; i++) dst[n0 + i] += src[i] * amp;
  return dst;
}
// finish: DC block, normalise to peak, de-click edges
function fin(out, peak = 0.7, sr = SR) {
  let px = 0, py = 0;
  const a = Math.exp(-TAU * 25 / sr);
  for (let i = 0; i < out.length; i++) { const x = out[i]; py = x - px + a * py; px = x; out[i] = py; }
  let m = 0;
  for (let i = 0; i < out.length; i++) { const v = Math.abs(out[i]); if (v > m) m = v; }
  const g = m > 1e-9 ? peak / m : 0;
  const fi = Math.min(out.length, Math.round(0.0015 * sr)), fo = Math.min(out.length, Math.round(0.008 * sr));
  for (let i = 0; i < out.length; i++) {
    let e = g;
    if (i < fi) e *= i / fi;
    if (i >= out.length - fo) e *= (out.length - 1 - i) / fo;
    out[i] *= e;
  }
  return out;
}
// seamless loop: generate L + X samples, crossfade the tail into the head (equal power)
function loopify(a, X) {
  const L = a.length - X, out = new Float32Array(L);
  for (let i = 0; i < L; i++) out[i] = a[i];
  for (let i = 0; i < X; i++) { const w = i / X; out[i] = a[i] * Math.sqrt(w) + a[L + i] * Math.sqrt(1 - w); }
  return out;
}
function brown(n, r, leak = 0.02) {
  const out = new Float32Array(n);
  let b = 0;
  for (let i = 0; i < n; i++) { b = (b + leak * (r() * 2 - 1)) / (1 + leak); out[i] = b; }
  return out;
}

// ---------- materials ----------
const MAT_NAMES = ["stone", "wood", "gravel", "dirt", "grass", "sand", "snow", "glass", "wool", "plant", "metal", "water"];
function matOf(b) {
  if (!b) return "stone";
  const n = b.name || "";
  if (b.render === "liquid") return "water";
  if (/glass|^ice$|packed_ice|blue_ice/.test(n)) return "glass";
  if (b.bed || /wool|carpet|sponge|cactus/.test(n)) return "wool";
  if (/leaves|short_grass|fern|dead_bush|poppy|dandelion|cornflower|mushroom$|sugar_cane|wheat|carrots|potatoes|beetroots|torch|vine|flower|sapling|tulip/.test(n)) return "plant";
  if (/^snow$|snow_layer|powder_snow/.test(n)) return "snow";
  if (/^(red_)?sand$|concrete_powder|soul_sand/.test(n)) return "sand";
  if (n === "gravel") return "gravel";
  if (/grass|mycelium|podzol|moss_block|hay_bale/.test(n)) return "grass";
  if (/dirt|farmland|clay|^mud$|_path$/.test(n)) return "dirt";
  if (/^(iron|gold|copper|raw_iron|raw_gold|raw_copper|netherite|diamond|emerald)_block$|lantern|^bell$|iron_bars|iron_door|anvil|cauldron|hopper|chain/.test(n)) return "metal";
  if (b.tool === "axe" || /planks|_log|_wood|fence|door|ladder|chest|bookshelf|crafting|barrel|pumpkin|melon/.test(n)) return "wood";
  if (b.tool === "shovel") return "dirt";
  if (b.render === "cross") return "plant";
  return "stone";
}
let MAT = null; // Uint8Array blockId -> index into MAT_NAMES
function buildMats() {
  const B = BF.blocks || [];
  MAT = new Uint8Array(Math.max(B.length, (BF.MAX_BLOCK || 4095) + 1));
  for (let i = 0; i < B.length; i++) if (B[i]) MAT[i] = MAT_NAMES.indexOf(matOf(B[i]));
}
const matName = id => { if (!MAT) buildMats(); return MAT_NAMES[MAT[id] || 0]; };

// ---------- sound definitions ----------
// def: gen(r, variantIndex) -> Float32Array, n variants, group, vol, pitch [lo, hi], dist (0 = never spatial), prio, sr, reverb
const DEFS = {};
function def(name, o) { DEFS[name] = Object.assign({ n: 1, group: "blocks", vol: 1, pitch: [0.92, 1.08], dist: 24, prio: 2, sr: SR }, o); }

// -- block materials: dig (break) and step; hit = step at half pitch, place = dig at 0.8 pitch
const MATDEF = {
  stone(r, o, step) {
    const d = step ? 0.13 : 0.32;
    grains(o, r, 0, d * 0.6, step ? 5 : 16, 1500, 3400, 1.3, 0.006, 0.02, 0.4, 1, SR, 1.6);
    tone(o, 0, step ? 170 : 150, 90, step ? 0.4 : 0.7, 0.03, 0.12);
    burst(o, r, 0, d, step ? 0.3 : 0.45, 0.001, step ? 0.02 : 0.04, [["hp", 700], ["lp", 5500]]);
  },
  wood(r, o, step) {
    const k = 0.9 + r() * 0.2;
    modes(o, 0, [[190 * k, 0.07, 1], [420 * k, 0.05, 0.6], [830 * k, 0.03, 0.35], [1350 * k, 0.02, 0.2]], step ? 0.6 : 1);
    burst(o, r, 0, 0.03, 0.5, 0.0005, 0.006, [["bp", 1800, 0.8]]);
    if (!step) { grains(o, r, 0.01, 0.12, 7, 800, 1700, 1.5, 0.008, 0.02, 0.2, 0.5); modes(o, 0.06 + r() * 0.04, [[230 * k, 0.05, 0.5], [510 * k, 0.03, 0.3]], 0.6); }
  },
  gravel(r, o, step) { grains(o, r, 0, step ? 0.1 : 0.3, step ? 14 : 42, 600, 2000, 0.9, 0.008, 0.03, 0.3, 1, SR, 1.4); burst(o, r, 0, step ? 0.12 : 0.3, 0.3, 0.003, step ? 0.03 : 0.07, [["lp", 1400]]); },
  dirt(r, o, step) { grains(o, r, 0, step ? 0.1 : 0.26, step ? 12 : 34, 350, 1200, 0.8, 0.01, 0.035, 0.3, 1, SR, 1.4); burst(o, r, 0, step ? 0.12 : 0.28, 0.4, 0.003, step ? 0.03 : 0.06, [["lp", 900]]); },
  grass(r, o, step) {
    burst(o, r, 0, step ? 0.16 : 0.34, 0.6, step ? 0.01 : 0.02, step ? 0.04 : 0.09, [["bp", 3200, 0.6], ["lp", 7000]]);
    grains(o, r, 0, step ? 0.1 : 0.26, step ? 10 : 26, 1500, 5000, 1, 0.004, 0.018, 0.2, 0.7, SR, 1.3);
    burst(o, r, 0, 0.1, 0.25, 0.002, 0.03, [["lp", 600]]);
  },
  plant(r, o, step) { burst(o, r, 0, step ? 0.12 : 0.24, 0.5, 0.01, step ? 0.03 : 0.06, [["bp", 3800, 0.7]]); grains(o, r, 0, step ? 0.08 : 0.18, step ? 6 : 16, 2500, 6000, 1, 0.003, 0.012, 0.15, 0.5); },
  sand(r, o, step) { burst(o, r, 0, step ? 0.16 : 0.32, 0.5, step ? 0.015 : 0.03, step ? 0.05 : 0.1, [["hp", 2200], ["lp", 7500]]); grains(o, r, 0, step ? 0.1 : 0.22, step ? 14 : 30, 2500, 6000, 0.8, 0.003, 0.01, 0.1, 0.35); },
  snow(r, o, step) { grains(o, r, 0, step ? 0.12 : 0.26, step ? 16 : 34, 900, 2600, 1, 0.012, 0.035, 0.25, 0.8, SR, 1.2); burst(o, r, 0, step ? 0.14 : 0.28, 0.35, 0.01, step ? 0.04 : 0.08, [["lp", 1800]]); },
  wool(r, o, step) { burst(o, r, 0, step ? 0.12 : 0.24, 0.8, 0.008, step ? 0.03 : 0.06, [["lp", 650], ["lp", 900]]); burst(o, r, 0, 0.1, 0.15, 0.01, 0.03, [["bp", 1500, 0.8]]); },
  metal(r, o, step) {
    const k = 0.9 + r() * 0.25;
    modes(o, 0, [[1250 * k, 0.32, 1], [2780 * k, 0.2, 0.6], [4100 * k, 0.12, 0.4], [5650 * k, 0.08, 0.25], [620 * k, 0.15, 0.3]], step ? 0.35 : 1);
    burst(o, r, 0, 0.02, 0.6, 0.0003, 0.004, [["hp", 2000]]);
    if (!step) { grains(o, r, 0, 0.12, 8, 1500, 3400, 1.3, 0.006, 0.02, 0.3, 0.8); tone(o, 0, 150, 90, 0.5, 0.03, 0.12); }
  },
  glass(r, o, step) {
    if (step) { grains(o, r, 0, 0.03, 3, 1800, 3500, 2, 0.004, 0.01, 0.4, 0.8); tone(o, 0, 3800 + r() * 800, 3800, 0.25, 0.02, 0.1); return; }
    burst(o, r, 0, 0.12, 1, 0.0005, 0.03, [["hp", 2500]]);
    for (let i = 0; i < 28; i++) { const t = Math.pow(r(), 1.8) * 0.5, f = 2200 + r() * 5500; tone(o, t, f, f * (0.97 + r() * 0.03), 0.15 + r() * 0.45, 0.02 + r() * 0.1, 0.5, SR, 0.0005); }
    grains(o, r, 0, 0.3, 20, 3000, 8000, 2, 0.002, 0.008, 0.2, 0.6, SR, 2);
  },
  water(r, o, step) { burst(o, r, 0, 0.3, 0.6, 0.01, 0.08, [["lp", 1800]]); for (let i = 0; i < 5; i++) { const f = 300 + r() * 700; tone(o, 0.02 + r() * 0.2, f, f * 2.2, 0.3, 0.03, 0.08); } },
};
for (const m of MAT_NAMES) {
  def("dig." + m, { n: 3, group: "blocks", vol: 0.75, pitch: [0.88, 1.08], prio: 3, gen: r => { const o = mk(0.55); MATDEF[m](r, o, false); return fin(o, 0.75); } });
  def("step." + m, { n: 4, group: "player", vol: 0.32, pitch: [0.9, 1.1], prio: 2, gen: r => { const o = mk(0.25); MATDEF[m](r, o, true); return fin(o, 0.7); } });
}
def("place.glass", { n: 2, vol: 0.5, prio: 3, pitch: [0.95, 1.1], gen: r => { const o = mk(0.4); for (let i = 0; i < 3; i++) { const f = 2800 + r() * 2200; tone(o, i * 0.012, f, f, 0.6, 0.06 + r() * 0.05, 0.38, SR, 0.0005); } grains(o, r, 0, 0.02, 2, 2000, 4000, 2, 0.003, 0.008, 0.4, 0.6); return fin(o, 0.6); } });

// -- player
def("hurt", { n: 2, group: "player", vol: 0.8, pitch: [0.92, 1.08], prio: 4, dist: 0, gen: (r, v) => fin(voc({ dur: 0.24, f0: pts([[0, 205 + v * 25], [0.3, 185 + v * 20], [1, 135]]), formants: [[pts([[0, 720], [1, 480]]), 3, 1], [pts([[0, 1150], [1, 950]]), 4, 0.5], [2500, 6, 0.12]], breath: 0.15, jitter: 0.01, amp: adr(0.06, 0.55), lp: 3500 }, r), 0.75) });
def("eat", { n: 3, group: "player", vol: 0.5, pitch: [0.8, 1.2], prio: 3, dist: 0, gen: r => { const o = mk(0.22); grains(o, r, 0, 0.12, 16, 1200, 4200, 1, 0.005, 0.02, 0.3, 1, SR, 1.5); tone(o, 0, 130, 90, 0.4, 0.02, 0.08); burst(o, r, 0, 0.1, 0.3, 0.002, 0.03, [["lp", 800]]); return fin(o, 0.7); } });
def("burp", { group: "player", vol: 0.45, pitch: [0.9, 1.1], prio: 3, dist: 0, gen: r => fin(voc({ dur: 0.42, f0: pts([[0, 92], [0.4, 88], [1, 72]]), formants: [[380, 3, 1], [900, 4, 0.5]], breath: 0.08, jitter: 0.05, rough: [17, 0.55], amp: adr(0.05, 0.5), lp: 2200 }, r), 0.7) });
def("land", { group: "player", vol: 0.55, pitch: [0.9, 1.1], prio: 3, dist: 0, gen: r => { const o = mk(0.2); tone(o, 0, 85, 50, 1, 0.05, 0.18); burst(o, r, 0, 0.12, 0.45, 0.001, 0.04, [["lp", 350]]); return fin(o, 0.8); } });
def("fall_big", { group: "player", vol: 0.8, prio: 4, dist: 0, gen: r => { const o = mk(0.45); tone(o, 0, 72, 38, 1, 0.1, 0.4); burst(o, r, 0, 0.25, 0.7, 0.001, 0.08, [["lp", 600]]); grains(o, r, 0, 0.12, 9, 400, 1300, 1, 0.01, 0.03, 0.3, 0.7); return fin(o, 0.85); } });
def("splash", { group: "player", vol: 0.7, prio: 4, pitch: [0.9, 1.1], gen: r => {
  const o = mk(0.9);
  burst(o, r, 0, 0.6, 1, 0.008, 0.16, [["lp", 3200], ["hp", 200]]);
  burst(o, r, 0, 0.4, 0.6, 0.004, 0.08, [["lp", 600]]);
  for (let i = 0; i < 14; i++) { const t = 0.05 + Math.pow(r(), 1.5) * 0.6, f = 300 + r() * 900; tone(o, t, f, f * (2 + r()), 0.18 + r() * 0.2, 0.025 + r() * 0.03, 0.09); }
  return fin(o, 0.75);
} });
def("swim", { n: 3, group: "player", vol: 0.35, pitch: [0.85, 1.15], prio: 2, gen: r => {
  const o = mk(0.5), lpf = filt("bp", 700, 0.8);
  for (let i = 0; i < o.length; i++) { const u = i / o.length; if ((i & 63) === 0) bqSet(lpf, "bp", 600 + 700 * u, 0.8, SR); o[i] = bq(lpf, Math.random() * 2 - 1) * Math.sin(Math.PI * Math.min(1, u * 1.3)) ** 2; }
  for (let i = 0; i < 3; i++) { const f = 400 + r() * 500; tone(o, 0.1 + r() * 0.3, f, f * 2, 0.12, 0.03, 0.08); }
  return fin(o, 0.6);
} });
def("bubble", { n: 3, group: "ambient", vol: 0.3, pitch: [0.8, 1.25], prio: 0, gen: r => { const o = mk(0.4); const k = 1 + Math.floor(r() * 3); for (let i = 0; i < k; i++) { const f = 350 + r() * 600; tone(o, i * (0.05 + r() * 0.08), f, f * 2.5, 0.5, 0.03, 0.1); } return fin(o, 0.6); } });
def("ui_click", { group: "player", vol: 0.35, pitch: [0.97, 1.03], prio: 5, dist: 0, gen: r => { const o = mk(0.06); tone(o, 0, 1500, 1350, 0.8, 0.012, 0.05, SR, 0.0004); burst(o, r, 0, 0.012, 0.3, 0.0003, 0.003, [["hp", 3000]]); return fin(o, 0.6); } });
function bell(o, t, midi, amp, sr = SR) {
  const f = 440 * Math.pow(2, (midi - 69) / 12);
  modes(o, t, [[f, 0.7, 1], [f * 2, 0.35, 0.3], [f * 3, 0.18, 0.1], [f * 2.76, 0.25, 0.12], [f * 5.4, 0.08, 0.05]], amp, sr);
}
def("levelup", { group: "player", vol: 0.5, pitch: [1, 1], prio: 4, dist: 0, gen: r => { const o = mk(1.6); [72, 76, 79, 84].forEach((m, i) => bell(o, i * 0.085, m, 0.7)); bell(o, 0.34, 88, 0.5); return fin(o, 0.7); } });
def("xp", { group: "player", vol: 0.3, pitch: [0.85, 1.25], prio: 3, dist: 0, gen: r => { const o = mk(0.7); bell(o, 0, 86, 1); return fin(o, 0.6); } });
def("door_open", { group: "blocks", vol: 0.6, prio: 3, gen: r => {
  const o = mk(0.45);
  const cr = voc({ dur: 0.3, f0: pts([[0, 70], [0.5, 95], [1, 80]]), formants: [[1400, 3, 1], [900, 4, 0.6], [2600, 5, 0.3]], breath: 0.05, jitter: 0.08, rough: [45, 0.8], amp: adr(0.2, 0.3) }, r);
  mixIn(o, cr, 0, 0.6);
  modes(o, 0.28, [[210, 0.05, 1], [470, 0.03, 0.5]], 0.5);
  return fin(o, 0.6);
} });
def("door_close", { group: "blocks", vol: 0.65, prio: 3, gen: r => { const o = mk(0.35); modes(o, 0, [[160, 0.08, 1], [380, 0.05, 0.6], [760, 0.03, 0.3], [1250, 0.02, 0.15]], 1); tone(o, 0, 90, 60, 0.6, 0.04, 0.15); burst(o, r, 0, 0.03, 0.4, 0.0005, 0.006, [["bp", 1500, 0.8]]); return fin(o, 0.7); } });
def("door_bash", { group: "mobs", vol: 0.8, prio: 3, gen: r => { const o = mk(0.5); modes(o, 0, [[120, 0.1, 1], [300, 0.07, 0.7], [610, 0.04, 0.4], [1100, 0.03, 0.2]], 1); tone(o, 0, 80, 50, 0.8, 0.06, 0.25); grains(o, r, 0, 0.15, 10, 700, 1800, 1.2, 0.008, 0.025, 0.2, 0.5); return fin(o, 0.8); } });
def("bow", { group: "mobs", vol: 0.5, prio: 2, gen: r => { const o = mk(0.35); tone(o, 0, 270, 240, 0.7, 0.08, 0.3, SR, 0.001, 0.3); tone(o, 0, 540, 480, 0.25, 0.04, 0.2); const f = filt("bp", 1500, 1); for (let i = 0; i < o.length; i++) { const u = i / o.length; if ((i & 63) === 0) bqSet(f, "bp", 1500 + 2500 * u, 1, SR); o[i] += bq(f, Math.random() * 2 - 1) * Math.exp(-u * 8) * 0.5; } return fin(o, 0.6); } });
def("explode", { n: 2, group: "mobs", vol: 1, pitch: [0.85, 1.05], prio: 6, dist: 64, gen: r => {
  const o = mk(2.6), lp = filt("lp", 3000, 0.7), lp2 = filt("lp", 3000, 0.7);
  for (let i = 0; i < o.length; i++) {
    const t = i / SR;
    if ((i & 31) === 0) { const fc = 150 + 2900 * Math.exp(-t / 0.18); bqSet(lp, "lp", fc, 0.7, SR); bqSet(lp2, "lp", fc, 0.7, SR); }
    const e = (t < 0.004 ? t / 0.004 : 1) * (0.75 * Math.exp(-t / 0.35) + 0.25 * Math.exp(-t / 1.1));
    o[i] = bq(lp2, bq(lp, Math.random() * 2 - 1)) * e * 1.6;
  }
  tone(o, 0, 62, 28, 0.9, 0.55, 2.2, SR, 0.003);
  grains(o, r, 0.05, 1.2, 40, 300, 2200, 1, 0.006, 0.03, 0.05, 0.3, SR, 2);
  return fin(o, 0.9);
} });

// -- mobs
const V = (o, r) => voc(o, r);
def("cow", { n: 3, group: "mobs", vol: 0.55, pitch: [0.9, 1.08], prio: 1, gen: r => {
  const k = 0.92 + r() * 0.16, dur = 0.95 + r() * 0.5;
  return fin(V({ dur, f0: pts([[0, 104 * k], [0.15, 126 * k], [0.7, 116 * k], [1, 94 * k]]), formants: [[pts([[0, 260], [0.3, 520], [1, 420]]), 5, 1], [pts([[0, 700], [0.4, 950], [1, 780]]), 6, 0.45], [2500, 8, 0.06]], breath: 0.04, jitter: 0.006, rough: [38, 0.25], sub: 0.3, amp: adr(0.18, 0.35), lp: 3000 }, r), 0.7);
} });
def("cow_hurt", { n: 2, group: "mobs", vol: 0.65, pitch: [0.9, 1.1], prio: 3, gen: r => fin(V({ dur: 0.45, f0: pts([[0, 150], [0.3, 168], [1, 118]]), formants: [[620, 4, 1], [1100, 5, 0.5]], breath: 0.06, rough: [40, 0.3], sub: 0.3, amp: adr(0.06, 0.5), lp: 3000 }, r), 0.7) });
def("pig", { n: 3, group: "mobs", vol: 0.5, pitch: [0.9, 1.1], prio: 1, gen: r => {
  const n = 2 + Math.floor(r() * 2), o = mk(0.75);
  let t = 0;
  for (let i = 0; i < n; i++) { const d = 0.12 + r() * 0.08, k = 0.9 + r() * 0.25; mixIn(o, V({ dur: d, f0: pts([[0, 125 * k], [1, 98 * k]]), formants: [[450, 4, 1], [1300, 5, 0.6], [2600, 6, 0.25]], breath: 0.25, jitter: 0.03, rough: [28, 0.6], amp: adr(0.15, 0.5) }, r), t); t += d + 0.04 + r() * 0.08; }
  return fin(o, 0.7);
} });
def("pig_hurt", { n: 2, group: "mobs", vol: 0.55, pitch: [0.9, 1.1], prio: 3, gen: r => fin(V({ dur: 0.38, f0: pts([[0, 620], [0.35, 960], [1, 760]]), formants: [[1000, 3, 1], [2400, 5, 0.6], [3500, 6, 0.3]], breath: 0.08, vib: [28, 0.02], amp: adr(0.08, 0.4), lp: 5000 }, r), 0.65) });
def("pig_death", { group: "mobs", vol: 0.55, prio: 3, gen: r => fin(V({ dur: 0.7, f0: pts([[0, 820], [0.3, 760], [1, 380]]), formants: [[1000, 3, 1], [2300, 5, 0.6]], breath: 0.1, vib: [24, 0.02], amp: adr(0.05, 0.5), lp: 5000 }, r), 0.65) });
def("sheep", { n: 3, group: "mobs", vol: 0.5, pitch: [0.9, 1.12], prio: 1, gen: r => {
  const k = 0.9 + r() * 0.2;
  return fin(V({ dur: 0.6 + r() * 0.25, f0: pts([[0, 240 * k], [0.25, 292 * k], [1, 258 * k]]), vib: [7, 0.045], rough: [7, 0.5], formants: [[pts([[0, 350], [0.1, 780], [1, 700]]), 4, 1], [1250, 5, 0.6], [2600, 7, 0.2]], breath: 0.1, amp: adr(0.08, 0.35), lp: 4500 }, r), 0.65);
} });
def("sheep_hurt", { n: 2, group: "mobs", vol: 0.55, prio: 3, gen: r => fin(V({ dur: 0.35, f0: pts([[0, 320], [0.3, 365], [1, 300]]), vib: [9, 0.05], rough: [9, 0.4], formants: [[780, 4, 1], [1300, 5, 0.6]], breath: 0.12, amp: adr(0.06, 0.4), lp: 4500 }, r), 0.65) });
def("chicken", { n: 4, group: "mobs", vol: 0.42, pitch: [0.92, 1.12], prio: 1, gen: (r, v) => {
  const o = mk(0.9), n = 2 + Math.floor(r() * 3);
  let t = 0;
  for (let i = 0; i < n; i++) { const d = 0.06 + r() * 0.035; mixIn(o, V({ dur: d, f0: pts([[0, 440], [1, 330]]), formants: [[1100, 4, 1], [2300, 5, 0.5]], breath: 0.2, rough: [60, 0.3], amp: adr(0.1, 0.6) }, r), t); t += d + 0.07 + r() * 0.07; }
  if (v % 2) mixIn(o, V({ dur: 0.18, f0: pts([[0, 600], [0.5, 860], [1, 700]]), formants: [[1300, 4, 1], [2600, 5, 0.5]], breath: 0.2, amp: adr(0.1, 0.5) }, r), t + 0.03);
  return fin(o, 0.6);
} });
def("chicken_hurt", { n: 2, group: "mobs", vol: 0.5, prio: 3, gen: r => fin(V({ dur: 0.22, f0: pts([[0, 900], [0.4, 1300], [1, 880]]), formants: [[1500, 3, 1], [3000, 5, 0.5]], breath: 0.35, amp: adr(0.08, 0.5), lp: 6000 }, r), 0.6) });
def("zombie", { n: 3, group: "mobs", vol: 0.6, pitch: [0.9, 1.08], prio: 1, gen: (r, v) => {
  const c = [[[0, 80], [0.4, 94], [1, 70]], [[0, 92], [0.6, 76], [1, 66]], [[0, 74], [0.3, 88], [0.6, 80], [1, 64]]][v % 3];
  return fin(V({ dur: 1.1 + r() * 0.4, f0: pts(c), formants: [[pts([[0, 400], [0.4, 560], [1, 440]]), 4, 1], [pts([[0, 850], [1, 1000]]), 5, 0.5], [2300, 7, 0.1]], breath: 0.3, jitter: 0.03, rough: [22, 0.55], sub: 0.5, amp: adr(0.2, 0.35), lp: 2500 }, r), 0.7);
} });
def("zombie_hurt", { n: 2, group: "mobs", vol: 0.65, prio: 3, gen: r => fin(V({ dur: 0.36, f0: pts([[0, 125], [1, 85]]), formants: [[600, 3, 1], [1100, 4, 0.5]], breath: 0.35, jitter: 0.03, rough: [30, 0.5], sub: 0.4, amp: adr(0.05, 0.6), lp: 2800 }, r), 0.7) });
def("zombie_death", { group: "mobs", vol: 0.65, prio: 3, gen: r => fin(V({ dur: 1.5, f0: pts([[0, 98], [0.3, 90], [1, 48]]), formants: [[pts([[0, 560], [1, 380]]), 4, 1], [900, 5, 0.5]], breath: 0.3, jitter: 0.03, rough: [20, 0.6], sub: 0.5, amp: adr(0.06, 0.65), lp: 2400 }, r), 0.7) });
function rattle(o, r, t0, span, n, skew = 1) {
  for (let i = 0; i < n; i++) {
    const t = t0 + Math.pow(r(), skew) * span;
    burst(o, r, t, 0.03, 0.5 + r() * 0.5, 0.0004, 0.004 + r() * 0.006, [["bp", 1500 + r() * 1800, 5]]);
    const f = 600 + r() * 400; tone(o, t, f, f, 0.25, 0.012, 0.06, SR, 0.0004);
  }
}
def("skeleton", { n: 3, group: "mobs", vol: 0.55, pitch: [0.9, 1.1], prio: 1, gen: r => { const o = mk(0.75); const k = 2 + Math.floor(r() * 2); for (let c = 0; c < k; c++) rattle(o, r, c * (0.16 + r() * 0.1), 0.12, 4 + Math.floor(r() * 4)); return fin(o, 0.6); } });
def("skeleton_hurt", { n: 2, group: "mobs", vol: 0.6, prio: 3, gen: r => { const o = mk(0.4); rattle(o, r, 0, 0.14, 11, 1.4); grains(o, r, 0, 0.05, 6, 1500, 3500, 1.3, 0.006, 0.02, 0.3, 0.8); return fin(o, 0.65); } });
def("skeleton_death", { group: "mobs", vol: 0.6, prio: 3, gen: r => { const o = mk(1.2); rattle(o, r, 0, 0.9, 28, 1.8); modes(o, 0.6, [[420, 0.05, 1], [900, 0.03, 0.5]], 0.4); modes(o, 0.75, [[380, 0.05, 1], [820, 0.03, 0.5]], 0.3); return fin(o, 0.65); } });
function chitter(o, r, t0, dur, rate, f0, f1, amp) {
  let t = 0;
  while (t < dur) { const u = t / dur; burst(o, r, t0 + t, 0.03, amp * (0.5 + r() * 0.5) * Math.sin(Math.PI * Math.min(1, u * 1.2)), 0.0005, 0.005, [["bp", f0 + (f1 - f0) * u + r() * 600, 3]]); t += (1 / rate) * (0.7 + r() * 0.6); }
}
def("spider", { n: 3, group: "mobs", vol: 0.45, pitch: [0.9, 1.1], prio: 1, gen: r => { const o = mk(0.85); chitter(o, r, 0, 0.6 + r() * 0.15, 38, 3200, 2800, 1); burst(o, r, 0.05, 0.6, 0.25, 0.25, 0.15, [["hp", 4500], ["lp", 9000]]); return fin(o, 0.6); } });
def("spider_hurt", { n: 2, group: "mobs", vol: 0.5, prio: 3, gen: r => { const o = mk(0.4); chitter(o, r, 0, 0.3, 55, 2800, 2400, 1); burst(o, r, 0, 0.25, 0.4, 0.01, 0.08, [["hp", 3500]]); return fin(o, 0.65); } });
def("spider_death", { group: "mobs", vol: 0.5, prio: 3, gen: r => { const o = mk(1.1); chitter(o, r, 0, 1.0, 30, 3500, 1400, 1); return fin(o, 0.65); } });
def("creeper_fuse", { group: "mobs", vol: 0.55, pitch: [0.97, 1.03], prio: 5, gen: r => {
  const o = mk(1.6), hp = filt("hp", 2600, 0.7), bp = filt("bp", 5200, 0.8);
  for (let i = 0; i < o.length; i++) { const u = i / o.length, x = Math.random() * 2 - 1; o[i] = (bq(hp, x) * 0.6 + bq(bp, x) * 0.5) * (0.25 + 0.75 * u) * Math.min(1, u * 40) * (u > 0.97 ? (1 - u) / 0.03 : 1); }
  grains(o, r, 0.1, 1.4, 30, 2000, 6000, 2, 0.002, 0.006, 0.1, 0.4);
  return fin(o, 0.6);
} });
def("creeper_hurt", { n: 2, group: "mobs", vol: 0.55, prio: 3, gen: r => { const o = mk(0.35); MATDEF.grass(r, o, false); tone(o, 0, 140, 90, 0.5, 0.04, 0.15); return fin(o, 0.65); } });
def("creeper_death", { group: "mobs", vol: 0.6, pitch: [0.8, 0.9], prio: 3, gen: r => { const o = mk(0.55); MATDEF.grass(r, o, false); grains(o, r, 0.1, 0.3, 20, 800, 3000, 1, 0.006, 0.02, 0.2, 0.6); return fin(o, 0.65); } });
const VIL_F = [[pts([[0, 260], [1, 300]]), 4, 1], [1000, 8, 0.22], [2300, 8, 0.12]];
def("villager", { n: 3, group: "mobs", vol: 0.5, pitch: [0.95, 1.05], prio: 1, gen: (r, v) => {
  const c = [[[0, 150], [0.4, 174], [1, 140]], [[0, 166], [1, 124]], [[0, 140], [1, 186]]][v % 3];
  return fin(V({ dur: 0.42 + r() * 0.1, f0: pts(c), formants: VIL_F, breath: 0.04, rough: v % 3 === 1 ? [26, 0.45] : null, jitter: 0.005, amp: adr(0.15, 0.3), direct: 0.02, lp: 1600 }, r), 0.65);
} });
def("villager_yes", { group: "mobs", vol: 0.55, prio: 3, gen: r => { const o = mk(0.5); mixIn(o, V({ dur: 0.16, f0: pts([[0, 150], [1, 172]]), formants: VIL_F, breath: 0.04, amp: adr(0.2, 0.3), lp: 1600 }, r), 0); mixIn(o, V({ dur: 0.2, f0: pts([[0, 172], [1, 205]]), formants: VIL_F, breath: 0.04, amp: adr(0.2, 0.35), lp: 1600 }, r), 0.22); return fin(o, 0.65); } });
def("villager_no", { group: "mobs", vol: 0.55, prio: 3, gen: r => fin(V({ dur: 0.55, f0: pts([[0, 176], [1, 114]]), formants: VIL_F, breath: 0.05, rough: [24, 0.5], amp: adr(0.12, 0.3), lp: 1600 }, r), 0.65) });
def("villager_trade", { n: 2, group: "mobs", vol: 0.55, prio: 3, gen: r => fin(V({ dur: 0.45, f0: pts([[0, 135], [0.5, 150], [1, 192]]), formants: [[pts([[0, 270], [1, 360]]), 4, 1], [1000, 8, 0.22], [2300, 8, 0.12]], breath: 0.04, amp: adr(0.15, 0.3), lp: 1800 }, r), 0.65) });
def("villager_hurt", { n: 2, group: "mobs", vol: 0.6, prio: 3, gen: r => fin(V({ dur: 0.26, f0: pts([[0, 235], [1, 168]]), formants: [[650, 3, 1], [1150, 5, 0.4]], breath: 0.3, amp: adr(0.05, 0.5), lp: 3000 }, r), 0.65) });
def("villager_death", { group: "mobs", vol: 0.6, prio: 3, gen: r => fin(V({ dur: 0.9, f0: pts([[0, 192], [1, 88]]), formants: [[pts([[0, 520], [1, 300]]), 3, 1], [1100, 5, 0.4]], breath: 0.2, amp: adr(0.06, 0.55), lp: 2500 }, r), 0.65) });
def("golem_step", { n: 3, group: "mobs", vol: 0.55, pitch: [0.9, 1.08], dist: 20, prio: 1, gen: r => { const o = mk(0.5); tone(o, 0, 62, 44, 1, 0.1, 0.35); burst(o, r, 0, 0.15, 0.5, 0.002, 0.05, [["lp", 300]]); modes(o, 0, [[180, 0.2, 1], [460, 0.14, 0.6], [930, 0.08, 0.35], [1520, 0.05, 0.2]], 0.25); return fin(o, 0.75); } });
def("golem_hurt", { n: 2, group: "mobs", vol: 0.65, prio: 3, gen: r => { const o = mk(0.9); const k = 0.9 + r() * 0.2; modes(o, 0, [[220 * k, 0.45, 1], [530 * k, 0.35, 0.6], [1100 * k, 0.22, 0.4], [1700 * k, 0.15, 0.25], [2600 * k, 0.08, 0.15]], 1); tone(o, 0, 90, 60, 0.6, 0.05, 0.2); return fin(o, 0.7); } });
def("golem_death", { group: "mobs", vol: 0.7, prio: 3, gen: r => { const o = mk(1.8); modes(o, 0, [[180, 0.9, 1], [410, 0.6, 0.6], [950, 0.35, 0.35], [1600, 0.2, 0.2]], 1); tone(o, 0.35, 70, 35, 1, 0.15, 0.6); burst(o, r, 0.35, 0.3, 0.6, 0.002, 0.08, [["lp", 400]]); return fin(o, 0.75); } });
def("golem_attack", { group: "mobs", vol: 0.6, prio: 3, gen: r => { const o = mk(0.4); burst(o, r, 0, 0.25, 0.6, 0.06, 0.06, [["bp", 900, 0.8]]); tone(o, 0.12, 80, 50, 0.9, 0.06, 0.25); return fin(o, 0.7); } });
const MOB_SND = {
  cow: { amb: "cow", hurt: "cow_hurt", death: "cow_hurt", dp: 0.82, iv: [8, 22] },
  pig: { amb: "pig", hurt: "pig_hurt", death: "pig_death", iv: [7, 20] },
  sheep: { amb: "sheep", hurt: "sheep_hurt", death: "sheep_hurt", dp: 0.82, iv: [8, 22] },
  chicken: { amb: "chicken", hurt: "chicken_hurt", death: "chicken_hurt", dp: 0.85, iv: [6, 16] },
  zombie: { amb: "zombie", hurt: "zombie_hurt", death: "zombie_death", iv: [6, 14] },
  skeleton: { amb: "skeleton", hurt: "skeleton_hurt", death: "skeleton_death", iv: [7, 16] },
  spider: { amb: "spider", hurt: "spider_hurt", death: "spider_death", iv: [6, 14] },
  creeper: { amb: null, hurt: "creeper_hurt", death: "creeper_death" },
  villager: { amb: "villager", hurt: "villager_hurt", death: "villager_death", iv: [6, 16] },
  iron_golem: { amb: null, hurt: "golem_hurt", death: "golem_death" },
};

// -- ambience one-shots
def("bird", { n: 6, group: "ambient", vol: 0.22, pitch: [0.9, 1.12], dist: 40, prio: 0, gen: (r, v) => {
  const o = mk(1.0), k = 0.9 + r() * 0.2;
  if (v === 0) { chirp(o, 0, 4200 * k, 4450 * k, 0.1, 1); chirp(o, 0.16, 3600 * k, 2950 * k, 0.15, 0.9); }
  else if (v === 1) for (let i = 0; i < 9; i++) chirp(o, i * 0.045, 5000 * k, 4200 * k, 0.035, 0.8);
  else if (v === 2) { chirp(o, 0, 2600 * k, 3600 * k, 0.26, 0.9); chirp(o, 0.3, 3600 * k, 3350 * k, 0.1, 0.7); }
  else if (v === 3) [4800, 4300, 3900].forEach((f, i) => chirp(o, i * 0.13, f * k, f * k * 0.93, 0.09, 0.9));
  else if (v === 4) { let t = 0; for (let i = 0; i < 5; i++) { const d = 0.04 + r() * 0.06, f = (3000 + r() * 2500) * k; chirp(o, t, f, f * (0.85 + r() * 0.3), d, 0.8); t += d + 0.03 + r() * 0.05; } }
  else chirp(o, 0, 3800 * k, 3700 * k, 0.42, 0.9, SR, 18, 0.15);
  return fin(o, 0.6);
} });
def("cricket", { n: 2, group: "ambient", vol: 0.16, pitch: [0.95, 1.05], dist: 28, prio: 0, gen: (r, v) => {
  const o = mk(1.1), f = v ? 4800 : 4400;
  for (let c = 0; c < 3; c++) for (let p = 0; p < 4; p++) chirp(o, c * 0.33 + p * 0.03, f, f * 0.99, 0.018, 1);
  return fin(o, 0.5);
} });
def("cave", { n: 4, group: "ambient", vol: 0.5, pitch: [0.9, 1.05], dist: 48, prio: 1, reverb: true, sr: MSR, gen: (r, v) => {
  const sr = MSR;
  if (v === 0) { // low drone with beating fifths
    const o = mk(6.5, sr);
    for (const [f, a] of [[55, 1], [55.6, 0.7], [82.4, 0.5], [110.3, 0.2]]) { let ph = 0; for (let i = 0; i < o.length; i++) { ph += TAU * f / sr; const u = i / o.length; o[i] += Math.sin(ph) * a * Math.sin(Math.PI * u) ** 2; } }
    const b = brown(o.length, r); filter(b, "lp", 200, 0.7, sr); for (let i = 0; i < o.length; i++) o[i] += b[i] * 6 * Math.sin(Math.PI * i / o.length);
    return fin(o, 0.7, sr);
  }
  if (v === 1) { // howling whoosh
    const o = mk(5, sr), f1 = filt("bp", 400, 7, sr), f2 = filt("lp", 900, 0.7, sr);
    for (let i = 0; i < o.length; i++) { const u = i / o.length; if ((i & 63) === 0) { bqSet(f1, "bp", 380 + 300 * Math.sin(Math.PI * u), 7, sr); bqSet(f2, "lp", 250 + 700 * Math.sin(Math.PI * u), 0.7, sr); } const x = Math.random() * 2 - 1; o[i] = (bq(f1, x) * 2 + bq(f2, x) * 0.6) * Math.sin(Math.PI * u) ** 2; }
    return fin(o, 0.6, sr);
  }
  if (v === 2) { // distant creak / scrape
    const o = voc({ dur: 3, f0: pts([[0, 52], [0.5, 70], [1, 58]]), formants: [[620, 6, 1], [1250, 6, 0.4]], breath: 0.1, jitter: 0.1, rough: [9, 0.7], amp: adr(0.3, 0.4) }, r, sr);
    return fin(o, 0.55, sr);
  }
  const o = mk(5.5, sr); // eerie high whistle
  for (const [f, a] of [[880, 0.6], [1318, 0.3], [659, 0.4]]) { let ph = 0; for (let i = 0; i < o.length; i++) { const u = i / o.length; ph += TAU * f * (1 - 0.04 * u) * (1 + 0.004 * Math.sin(TAU * 5 * i / sr)) / sr; o[i] += Math.sin(ph) * a * Math.sin(Math.PI * u) ** 3; } }
  return fin(o, 0.45, sr);
} });
def("thunder_near", { group: "ambient", vol: 0.9, pitch: [0.85, 1.05], dist: 0, prio: 5, sr: MSR, gen: r => {
  const sr = MSR, o = mk(5.5, sr);
  burst(o, r, 0, 0.3, 1.2, 0.002, 0.06, [["hp", 900], ["lp", 7000]], sr);
  const b = brown(o.length, r, 0.05); filter(b, "lp", 500, 0.7, sr);
  let swell = 0, target = 1;
  for (let i = 0; i < o.length; i++) { const t = i / sr; if ((i & 1023) === 0) target = r() < 0.3 ? 0.3 + r() : target; swell += (target - swell) * 0.0005; o[i] += b[i] * 14 * swell * Math.exp(-t / 1.8) * Math.min(1, t * 20); }
  return fin(o, 0.9, sr);
} });
def("thunder_far", { group: "ambient", vol: 0.7, pitch: [0.85, 1.05], dist: 0, prio: 4, sr: MSR, gen: r => {
  const sr = MSR, o = brown(Math.round(6 * sr), r, 0.04); filter(o, "lp", 280, 0.7, sr);
  let swell = 0, target = 1;
  for (let i = 0; i < o.length; i++) { const t = i / sr; if ((i & 1023) === 0) target = r() < 0.25 ? 0.2 + r() : target; swell += (target - swell) * 0.0004; o[i] *= swell * Math.min(1, t / 0.5) * Math.exp(-t / 2.2); }
  return fin(o, 0.8, sr);
} });
// -- loops (non-positional, gains driven by update)
const LOOPS = {
  wind: r => { const sr = MSR, L = 8 * sr, X = sr; const b = brown(L + X, r, 0.03); filter(b, "lp", 1400, 0.7, sr); return loopify(fin(b, 0.8, sr), X); },
  rain: r => {
    const sr = MSR, L = 4 * sr, X = Math.round(0.5 * sr), o = new Float32Array(L + X);
    burst(o, r, 0, (L + X) / sr, 0.25, 0.001, 1e4, [["hp", 1200], ["lp", 8000]], sr);
    for (let i = 0; i < 1500; i++) { const t = r() * (L + X) / sr, f = 1800 + r() * 4000; tone(o, t, f, f * 0.9, 0.05 + r() * 0.2, 0.002 + r() * 0.005, 0.03, sr, 0.0003); }
    return loopify(fin(o, 0.7, sr), X);
  },
  water: r => {
    const sr = MSR, L = 6 * sr, X = Math.round(0.6 * sr), o = new Float32Array(L + X);
    burst(o, r, 0, (L + X) / sr, 1, 0.001, 1e4, [["lp", 520], ["hp", 60]], sr);
    for (let i = 0; i < o.length; i++) { const t = i / sr; o[i] *= 0.55 + 0.45 * Math.sin(TAU * t / 3 + 0.4 * Math.sin(TAU * t / 1.5)); }
    for (let i = 0; i < 26; i++) { const f = 250 + r() * 600; tone(o, r() * (L + X) / sr, f, f * 1.8, 0.04 + r() * 0.05, 0.03, 0.1, sr); }
    return loopify(fin(o, 0.7, sr), X);
  },
  underwater: r => { const sr = MSR, L = 6 * sr, X = sr; const b = brown(L + X, r, 0.02); filter(b, "lp", 260, 0.7, sr); for (let i = 0; i < b.length; i++) b[i] *= 0.7 + 0.3 * Math.sin(TAU * i / sr / 3); return loopify(fin(b, 0.8, sr), X); },
};

// ---------- buffers (generated lazily, shared by every context) ----------
const bank = {};
function toBuffer(arr, sr, ctx) {
  let b;
  try { b = new AudioBuffer({ length: arr.length, sampleRate: sr, numberOfChannels: 1 }); }
  catch (_) { b = ctx.createBuffer(1, arr.length, sr); }
  if (b.copyToChannel) b.copyToChannel(arr, 0); else b.getChannelData(0).set(arr);
  return b;
}
function genVariant(name, v, ctx) {
  const d = DEFS[name], list = bank[name] || (bank[name] = new Array(d.n));
  if (list[v]) return;
  const t0 = performance.now();
  let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0;
  list[v] = toBuffer(d.gen(mulberry(h + v * 7919), v), d.sr, ctx);
  list.done = (list.done || 0) + 1;
  stats.genMs += performance.now() - t0;
}
function buffers(name, ctx) {
  const d = DEFS[name];
  if (!d) return null;
  let list = bank[name];
  if (list && list.done === d.n) return list;
  for (let v = 0; v < d.n; v++) genVariant(name, v, ctx);
  return bank[name];
}
// idle-time pre-generation (pure JS data, no AudioContext needed): loops first, then every sound variant
const warmQ = [];
function warmStep(deadline) {
  const t0 = performance.now();
  try {
    while (warmQ.length && (deadline && deadline.timeRemaining ? deadline.timeRemaining() > 6 : performance.now() - t0 < 8)) {
      const it = warmQ.shift();
      if (typeof it === "number") pianoNote(it);
      else if (it[0] === "@") loopBuffer(it.slice(1), ctx);
      else genVariant(it[0], it[1], ctx);
    }
  } catch (e) { console.error(e); }
  if (warmQ.length) schedWarm();
}
let warmPending = false;
function schedWarm() {
  if (warmPending) return;
  warmPending = true;
  const run = d => { warmPending = false; warmStep(d); };
  if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 1500 }); else setTimeout(run, 40);
}
function queueWarm() {
  for (const l of Object.keys(LOOPS)) warmQ.push("@" + l);
  for (const n of Object.keys(DEFS)) for (let v = 0; v < DEFS[n].n; v++) warmQ.push([n, v]);
  schedWarm();
}
const loopBank = {};
function loopBuffer(name, ctx) { return loopBank[name] || (loopBank[name] = toBuffer(LOOPS[name](mulberry(name.length * 977)), MSR, ctx)); }

// ---------- music ----------
const pianoBank = new Map();
function pianoNote(midi) {
  let b = pianoBank.get(midi);
  if (b) return b;
  const t0 = performance.now(), sr = MSR, f = 440 * Math.pow(2, (midi - 69) / 12);
  const dur = clamp(2.2 + 180 / f, 2.2, 5), n = Math.round(dur * sr), out = new Float32Array(n);
  const B = 0.00035;
  for (let k = 1; k <= 10; k++) {
    const fk = k * f * Math.sqrt(1 + B * k * k);
    if (fk > sr * 0.42) break;
    const amp = Math.pow(k, -1.5) / (1 + Math.max(0, fk - 1200) / 900);
    const tau = 1.8 * Math.pow(261 / f, 0.4) / (1 + 0.55 * (k - 1));
    for (const det of [0.9997, 1.0004]) {   // two slightly detuned strings
      const w = TAU * fk * det / sr, c2 = 2 * Math.cos(w);
      let s1 = 0, s2 = -Math.sin(w);                                  // sin recurrence
      const kf = Math.exp(-1 / (tau * 0.22 * sr)), ks = Math.exp(-1 / (tau * sr));
      let ef = 0.55 * amp * 0.5, es = 0.45 * amp * 0.5;
      for (let i = 0; i < n; i++) { const s = c2 * s1 - s2; s2 = s1; s1 = s; out[i] += s * (ef + es); ef *= kf; es *= ks; }
    }
  }
  const r = mulberry(midi * 131);
  burst(out, r, 0, 0.05, 0.04, 0.0005, 0.012, [["lp", 1400]], sr);  // felt hammer
  const lp = filt("lp", 3200, 0.6, sr);
  const na = Math.round(0.004 * sr), nf = Math.round(0.08 * sr);
  for (let i = 0; i < n; i++) { let x = bq(lp, out[i]); if (i < na) x *= i / na; if (i > n - nf) x *= (n - i) / nf; out[i] = x; }
  let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(out[i]));
  const g = 0.5 / (m || 1); for (let i = 0; i < n; i++) out[i] *= g;
  b = toBuffer(out, sr, null);
  pianoBank.set(midi, b);
  stats.genMs += performance.now() - t0;
  return b;
}
const MOODS = {
  day:      { scale: [0, 2, 4, 5, 7, 9, 11], mel: [0, 2, 4, 7, 9], roots: [53, 55, 57, 60, 50], bpm: [62, 74], dens: 0.3, rest: 0.25, lo: 62, hi: 81, padLo: 50, ext: 0.4, arp: 0.5, bass: 0.7,
              progs: [[0, 4, 5, 3], [0, 3, 5, 4], [3, 0, 4, 5], [0, 2, 3, 3], [5, 3, 0, 4]] },
  night:    { scale: [0, 2, 3, 5, 7, 8, 10], mel: [0, 3, 5, 7, 10], roots: [50, 52, 53, 55, 57], bpm: [54, 64], dens: 0.22, rest: 0.35, lo: 57, hi: 77, padLo: 46, ext: 0.5, arp: 0.25, bass: 0.6,
              progs: [[0, 5, 2, 6], [0, 3, 0, 4], [5, 6, 0, 0], [0, 6, 5, 6]] },
  under:    { scale: [0, 1, 3, 5, 7, 8, 10], mel: [0, 3, 5, 7, 8], roots: [45, 47, 48, 50], bpm: [48, 56], dens: 0.13, rest: 0.45, lo: 50, hi: 70, padLo: 40, ext: 0.3, arp: 0, bass: 0.8,
              progs: [[0, 1, 0, 6], [0, 5, 0, 6], [0, 0, 5, 5]] },
  creative: { scale: [0, 2, 4, 6, 7, 9, 11], mel: [0, 2, 4, 7, 9, 11], roots: [55, 57, 60, 62], bpm: [70, 82], dens: 0.4, rest: 0.15, lo: 64, hi: 86, padLo: 52, ext: 0.5, arp: 0.7, bass: 0.7,
              progs: [[0, 1, 4, 3], [0, 4, 5, 1], [3, 4, 0, 0], [0, 5, 3, 4]] },
};
// Deterministic piece: sorted events {t, k: "pn"|"pad", m | notes, v, dur}
function compose(seed, moodName) {
  const r = mulberry(seed), M = MOODS[moodName] || MOODS.day;
  const pick = a => a[Math.floor(r() * a.length)];
  const bpm = M.bpm[0] + r() * (M.bpm[1] - M.bpm[0]), beat = 60 / bpm;
  const root = pick(M.roots), prog = pick(M.progs), sc = M.scale;
  const chordLen = 8 * beat, lead = 1.5;
  const cycles = Math.max(2, Math.round((90 + r() * 90) / (prog.length * chordLen)));
  const deg = d => sc[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
  const mel = [];
  for (let m = M.lo; m <= M.hi; m++) if (M.mel.includes((((m - root) % 12) + 12) % 12)) mel.push(m);
  const motif = () => {
    const slots = [];
    for (let s = 0; s < 16; s++) if (r() < M.dens * (s % 4 === 0 ? 1.7 : s % 2 ? 0.45 : 1)) slots.push(s);
    if (!slots.length) slots.push(0);
    return { slots, steps: slots.map(() => Math.round((r() * 2 - 1) * 2.2)) };
  };
  const motifs = [motif(), motif(), motif()];
  const arp = r() < M.arp;
  const ev = [];
  let mi = Math.floor(mel.length / 2);
  for (let c = 0; c < cycles; c++) {
    const intro = c === 0, outro = c === cycles - 1;
    for (let k = 0; k < prog.length; k++) {
      const t0 = lead + (c * prog.length + k) * chordLen, d = prog[k];
      const chord = [deg(d), deg(d + 2), deg(d + 4)];
      if (r() < M.ext) chord.push(deg(d + (r() < 0.5 ? 6 : 8)));
      const pcs = chord.map(x => (((root + x) % 12) + 12) % 12);
      const pad = chord.map(x => { let m = root + x; while (m < M.padLo) m += 12; while (m >= M.padLo + 14) m -= 12; return m; });
      ev.push({ t: t0, k: "pad", notes: pad, dur: chordLen, v: intro ? 0.7 : outro ? 0.8 : 1 });
      let bassM = root + deg(d); while (bassM >= M.padLo) bassM -= 12; while (bassM < 33) bassM += 12;
      if (r() < M.bass) ev.push({ t: t0 + r() * 0.02, k: "pn", m: bassM, v: 0.3 + r() * 0.12 });
      if (r() < M.bass * 0.5) ev.push({ t: t0 + 4 * beat + r() * 0.02, k: "pn", m: bassM + 7, v: 0.22 + r() * 0.1 });
      if (arp && !intro) for (let b = 0; b < 8; b++) if (r() < 0.65) ev.push({ t: t0 + b * beat + (r() - 0.5) * 0.02, k: "pn", m: pad[b % pad.length] + (b >= 4 ? 12 : 0), v: 0.13 + r() * 0.08 });
      if ((intro && r() < 0.6) || r() < M.rest) continue;
      const mo = motifs[r() < 0.7 ? (k % 2) : 2];
      for (let j = 0; j < mo.slots.length; j++) {
        mi += mo.steps[j];
        if (mi < 2) mi += 3; if (mi > mel.length - 3) mi -= 3;
        mi = clamp(mi, 0, mel.length - 1);
        if (mo.slots[j] % 8 === 0) for (let o = 0; o < 3; o++) {
          if (mi + o < mel.length && pcs.includes(mel[mi + o] % 12)) { mi += o; break; }
          if (mi - o >= 0 && pcs.includes(mel[mi - o] % 12)) { mi -= o; break; }
        }
        ev.push({ t: t0 + mo.slots[j] * beat / 2 + (r() - 0.5) * 0.03, k: "pn", m: mel[mi], v: (outro ? 0.28 : 0.4) + r() * 0.25 });
      }
    }
  }
  const end = lead + cycles * prog.length * chordLen;
  let fm = root; while (fm < M.lo) fm += 12;
  let fb = root; while (fb >= M.padLo) fb -= 12;
  ev.push({ t: end, k: "pn", m: fm, v: 0.3 }, { t: end, k: "pn", m: fb, v: 0.28 });
  ev.push({ t: end, k: "pad", notes: [root, root + sc[2], root + 7].map(m => { while (m < M.padLo) m += 12; return m; }), dur: 5, v: 0.7 });
  ev.sort((a, b) => a.t - b.t);
  return { ev, length: end + 8, mood: moodName, bpm: Math.round(bpm), root, seed, cycles };
}

// ---------- audio graph (one per context: the live one, or an OfflineAudioContext for tests/export) ----------
const GROUPS = ["blocks", "mobs", "ambient", "player"];
function makeImpulse(ctx, sec = 2.6) {
  const sr = ctx.sampleRate, n = Math.round(sec * sr), b = ctx.createBuffer(2, n, sr), r = mulberry(4242);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, a = 0.25 + 0.7 * Math.min(1, t / 1.5);       // darker tail
      lp += (r() * 2 - 1 - lp) * (1 - a);
      d[i] = lp * Math.exp(-t / 0.55) * Math.min(1, t / 0.01) * (i > n - 200 ? (n - i) / 200 : 1);
    }
  }
  return b;
}
function makeGraph(ctx) {
  const G = { ctx, voices: [], loops: {} };
  G.limiter = ctx.createDynamicsCompressor();
  G.limiter.threshold.value = -6; G.limiter.knee.value = 6; G.limiter.ratio.value = 12; G.limiter.attack.value = 0.003; G.limiter.release.value = 0.25;
  G.master = ctx.createGain();
  G.master.connect(G.limiter); G.limiter.connect(ctx.destination);
  G.muffle = ctx.createBiquadFilter(); G.muffle.type = "lowpass"; G.nyq = Math.min(20000, ctx.sampleRate * 0.45); G.muffle.frequency.value = G.nyq; G.muffle.Q.value = 0.7;
  G.muffle.connect(G.master);
  G.reverb = ctx.createConvolver(); G.reverb.buffer = makeImpulse(ctx);
  G.wet = ctx.createGain(); G.wet.gain.value = 1;
  G.reverb.connect(G.wet); G.wet.connect(G.master);
  G.groups = {};
  for (const g of GROUPS) {
    const gn = ctx.createGain(), send = ctx.createGain();
    gn.connect(G.muffle); send.gain.value = 0.6; send.connect(G.reverb);
    G.groups[g] = { gain: gn, send };
  }
  G.music = ctx.createGain(); G.music.connect(G.master);              // music: not muffled underwater
  G.musicIn = ctx.createGain(); G.musicIn.connect(G.music);
  G.musicSend = ctx.createGain(); G.musicSend.gain.value = 0.42; G.musicIn.connect(G.musicSend); G.musicSend.connect(G.reverb);
  G.padLP = ctx.createBiquadFilter(); G.padLP.type = "lowpass"; G.padLP.frequency.value = 1100; G.padLP.Q.value = 0.5; G.padLP.connect(G.musicIn);
  const real = new Float32Array([0, 1, 0.28, 0.1, 0.04, 0.015]), imag = new Float32Array(real.length);
  G.padWave = ctx.createPeriodicWave(real, imag);
  return G;
}
function applyVolumes(G) {
  if (!G) return;
  const now = G.ctx.currentTime, set = (p, v) => { p.cancelScheduledValues(now); p.setTargetAtTime(v, now, 0.05); };
  set(G.master.gain, settings.muted ? 0 : settings.master);
  for (const g of GROUPS) { set(G.groups[g].gain.gain, settings[g]); set(G.groups[g].send.gain, settings[g] * 0.6); }
  set(G.music.gain, settings.music * (state.paused ? 0.45 : 1));
}

// ---------- voices ----------
const listener = { x: 0, y: 0, z: 0, rx: 1, rz: 0 };
const EMPTY = {};
function startVoice(G, name, o, when) {
  const d = DEFS[name];
  if (!d) return null;
  o = o || EMPTY;
  const ctx = G.ctx;
  let vol = (o.volume == null ? 1 : o.volume) * d.vol, pan = 0;
  const maxD = o.dist || d.dist;
  if (o.x != null && maxD) {
    const dx = o.x - listener.x, dy = (o.y == null ? listener.y : o.y) - listener.y, dz = o.z - listener.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist >= maxD) return null;
    const g = 1 - dist / maxD;
    vol *= Math.pow(g, 1.4);
    const hd = Math.sqrt(dx * dx + dz * dz);
    if (hd > 0.01) pan = clamp((dx * listener.rx + dz * listener.rz) / hd, -1, 1) * Math.min(1, hd / 2.5) * 0.85;
  }
  if (vol < 0.002) return null;
  const prio = o.prio == null ? d.prio : o.prio;
  const vs = G.voices;
  if (vs.length >= MAX_VOICES) {
    let worst = -1;
    for (let i = 0; i < vs.length; i++) if (worst < 0 || vs[i].prio < vs[worst].prio || (vs[i].prio === vs[worst].prio && vs[i].start < vs[worst].start)) worst = i;
    if (worst < 0 || vs[worst].prio > prio) { stats.dropped++; return null; }
    killVoice(G, vs[worst]); stats.stolen++;
  }
  const list = buffers(name, ctx);
  const buf = list[o.variant != null ? o.variant % list.length : Math.floor(Math.random() * list.length)];
  const t = when != null ? when : ctx.currentTime + (o.delay || 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const rate = (o.pitch == null ? 1 : o.pitch) * (d.pitch[0] + Math.random() * (d.pitch[1] - d.pitch[0]));
  src.playbackRate.value = rate;
  const gn = ctx.createGain(); gn.gain.value = vol;
  src.connect(gn);
  let out = gn;
  if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; gn.connect(p); out = p; }
  const grp = G.groups[o.group || d.group] || G.groups.blocks;
  out.connect(grp.gain);
  if (d.reverb || o.reverb) out.connect(grp.send);
  src.start(t);
  const v = { src, gn, name, prio, start: t, end: t + buf.duration / rate, vol };
  vs.push(v);
  src.onended = () => { const i = vs.indexOf(v); if (i >= 0) vs.splice(i, 1); try { out.disconnect(); } catch (_) {} };
  stats.plays++;
  stats.count[name] = (stats.count[name] || 0) + 1;
  return v;
}
function killVoice(G, v) {
  const i = G.voices.indexOf(v);
  if (i >= 0) G.voices.splice(i, 1);
  try { const now = G.ctx.currentTime; v.gn.gain.cancelScheduledValues(now); v.gn.gain.setValueAtTime(v.gn.gain.value, now); v.gn.gain.linearRampToValueAtTime(0, now + 0.02); v.src.stop(now + 0.03); } catch (_) {}
}
function startLoop(G, name, group, filterType) {
  const ctx = G.ctx, src = ctx.createBufferSource();
  src.buffer = loopBuffer(name, ctx); src.loop = true;
  const f = ctx.createBiquadFilter(); f.type = filterType || "lowpass"; f.frequency.value = G.nyq;
  const g = ctx.createGain(); g.gain.value = 0;
  src.connect(f); f.connect(g); g.connect(G.groups[group].gain);
  src.start(ctx.currentTime + Math.random() * 0.1, Math.random() * src.buffer.duration);
  return (G.loops[name] = { src, f, g, level: 0, cut: G.nyq });
}
// smooth loop level / cutoff changes (only touches AudioParams when the value moved)
function setLoop(L, level, cut) {
  const now = L.g.context.currentTime;
  if (Math.abs(level - L.level) > 0.004) { L.level = level; L.g.gain.setTargetAtTime(level, now, 0.6); }
  if (cut && Math.abs(cut - L.cut) > L.cut * 0.03) { L.cut = cut; L.f.frequency.setTargetAtTime(cut, now, 0.3); }
}

// ---------- music playback ----------
function scheduleEvent(G, piece, e, t) {
  const ctx = G.ctx;
  if (e.k === "pn") {
    const src = ctx.createBufferSource(); src.buffer = pianoNote(e.m);
    const g = ctx.createGain(); g.gain.value = e.v * 0.8;
    src.connect(g); g.connect(piece.gain);
    src.start(t);
    src.onended = () => { try { g.disconnect(); } catch (_) {} };
  } else {
    const att = Math.min(2.5, e.dur * 0.35), rel = 3, peak = 0.032 * e.v;
    for (const m of e.notes) {
      const f = 440 * Math.pow(2, (m - 69) / 12), g = ctx.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + att);
      g.gain.setValueAtTime(peak, t + e.dur); g.gain.linearRampToValueAtTime(0, t + e.dur + rel);
      g.connect(piece.padOut);
      for (const det of [-6, 6]) {
        const osc = ctx.createOscillator(); osc.setPeriodicWave(G.padWave); osc.frequency.value = f; osc.detune.value = det;
        osc.connect(g); osc.start(t); osc.stop(t + e.dur + rel + 0.05);
        if (det > 0) osc.onended = () => { try { g.disconnect(); } catch (_) {} };
      }
      piece.padNodes++;
    }
  }
}
function startPiece(G, piece, t0) {
  const ctx = G.ctx;
  piece.t0 = t0; piece.idx = 0; piece.padNodes = 0;
  piece.gain = ctx.createGain(); piece.gain.gain.value = 1; piece.gain.connect(G.musicIn);
  piece.padOut = ctx.createGain(); piece.padOut.gain.value = 1; piece.padOut.connect(G.padLP);
  piece.end = t0 + piece.length;
  return piece;
}
function pumpPiece(G, piece, until) {
  const ev = piece.ev;
  while (piece.idx < ev.length && piece.t0 + ev[piece.idx].t < until) { scheduleEvent(G, piece, ev[piece.idx], Math.max(G.ctx.currentTime, piece.t0 + ev[piece.idx].t)); piece.idx++; }
}

// ---------- settings ----------
const DEFAULTS = { master: 0.8, music: 0.5, blocks: 1, mobs: 1, ambient: 1, player: 1, muted: false };
const settings = Object.assign({}, DEFAULTS);
const KEY = "blockfield.audio";
try { const s = JSON.parse(localStorage.getItem(KEY) || "null"); if (s && typeof s === "object") for (const k in DEFAULTS) if (typeof s[k] === typeof DEFAULTS[k]) settings[k] = typeof s[k] === "number" ? clamp(s[k], 0, 1) : s[k]; } catch (_) {}
function saveSettings() { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (_) {} }

// ---------- live state ----------
let ctx = null, G = null;
const state = { paused: false, menu: true, hidden: false, menuT: 0 };
const stats = { plays: 0, dropped: 0, stolen: 0, count: {}, frames: 0, updMs: 0, updMax: 0, genMs: 0 };
const music = { piece: null, wait: rnd(30, 60), mood: null, played: 0, seed: 0 };
const env = { t: 0, slowT: 0, birdT: 3, cricketT: 2, caveT: rnd(20, 60), bubbleT: 4, windLvl: 0, covered: false, under: false, dark: false, open: 1,
  waterD: 99, biomeT: 0, forest: 0, grassy: 0, top: -1, swimT: 0, windCut: 600, windDrift: 0 };
const pl = { x: 0, y: 0, z: 0, vy: 0, ground: true, water: false, head: false, stepD: 0, ladderD: 0, init: false };
let lastHitT = 0, lastEatT = 0, lastPlaceT = 0;

function unlock() {
  if (!ACtor) return;
  const ua = navigator.userActivation;
  if (ua && !ua.isActive && !ua.hasBeenActive) return;     // modifier keys etc. are not a user activation
  try {
    if (!ctx) {
      ctx = new ACtor({ latencyHint: "interactive" });
      G = makeGraph(ctx);
      applyVolumes(G);
      buildMats();
      for (const n of ["wind", "rain", "water", "underwater"]) startLoop(G, n, "ambient", "lowpass");
      G.loops.wind.f.frequency.value = 600; G.loops.wind.cut = 600;
      if (document.hidden) ctx.suspend();
    }
    if (ctx.state === "suspended" && !document.hidden) ctx.resume().catch(() => {});
  } catch (e) { console.error(e); }
}
const live = () => !!(ctx && ctx.state === "running");

// ---------- public play ----------
function play(name, o) {
  if (!G || !live() || settings.muted || settings.master <= 0) return null;
  try { return startVoice(G, name, o); } catch (e) { console.error(e); return null; }
}
function blockSound(kind, id, x, y, z, vol) {
  const m = matName(id);
  const o = { x: x + 0.5, y: y + 0.5, z: z + 0.5, volume: vol == null ? 1 : vol };
  if (kind === "break") return play("dig." + m, o);
  if (kind === "place") { if (m === "glass") return play("place.glass", o); o.pitch = 0.8; o.volume *= 0.7; return play("dig." + m, o); }
  if (kind === "hit") { o.pitch = 0.55; o.volume *= 0.75; o.group = "blocks"; return play("step." + m, o); }
  o.group = "player";
  return play("step." + m, o);
}
const mobPos = m => ({ x: m.position.x, y: m.position.y + (m.height || 1) * 0.75, z: m.position.z });
function mobSound(m, kind) {
  const s = MOB_SND[m.type];
  if (!s || !s[kind] || !m.position) return null;
  const o = mobPos(m);
  if (m.type === "villager") o.pitch = vpitch(m);
  if (kind === "death" && s.dp) o.pitch = (o.pitch || 1) * s.dp;
  return play(s[kind], o);
}
function vpitch(m) { if (m._sndP == null) m._sndP = 0.86 + Math.random() * 0.28; return m._sndP; }

// ---------- per-frame update ----------
function blockUnderFeet(p) {
  const W = BF.world, y = Math.floor(p.y - 0.08);
  let id = W.getBlock(Math.floor(p.x), y, Math.floor(p.z));
  if (BF.SOLID[id]) return id;
  for (let i = 0; i < 4; i++) {
    id = W.getBlock(Math.floor(p.x + (i & 1 ? 0.29 : -0.29)), y, Math.floor(p.z + (i & 2 ? 0.29 : -0.29)));
    if (BF.SOLID[id]) return id;
  }
  id = W.getBlock(Math.floor(p.x), y - 1, Math.floor(p.z));   // fences / slabs ledge
  return BF.SOLID[id] ? id : 0;
}
function updatePlayer(dt) {
  const P = BF.player;
  if (!P || !P.position || !BF.world) return;
  const p = P.position, vy = P.velocity ? P.velocity.y : 0;
  if (!pl.init) { pl.x = p.x; pl.y = p.y; pl.z = p.z; pl.ground = P.onGround; pl.water = P.inWater; pl.init = true; return; }
  const dx = p.x - pl.x, dz = p.z - pl.z, dyy = p.y - pl.y;
  let hd = Math.sqrt(dx * dx + dz * dz);
  if (hd > 3 || Math.abs(dyy) > 6) hd = 0;                 // teleport / respawn
  const ground = P.onGround, water = P.inWater, flying = P.flying, dead = P.dead;
  if (!dead) {
    // landing / jumping
    if (ground && !pl.ground && !water && !flying) {
      const fall = -pl.vy;
      if (fall > 5) {
        const id = blockUnderFeet(p);
        if (id) blockSound("step", id, p.x - 0.5, p.y - 1, p.z - 0.5, clamp(fall / 12, 0.4, 1.2));
        if (fall > 15) play("fall_big", { volume: clamp((fall - 15) / 8 + 0.6, 0.6, 1) });
        else if (fall > 8.5) play("land", { volume: clamp((fall - 8.5) / 7, 0.2, 0.8) });   // > ~1 block
      }
      pl.stepD = 0;
    } else if (!ground && pl.ground && vy > 4 && !water && !flying) {
      const id = blockUnderFeet({ x: p.x, y: pl.y, z: p.z });
      if (id) blockSound("step", id, p.x - 0.5, pl.y - 1, p.z - 0.5, 0.45);
    }
    // footsteps
    if (ground && !water && !flying && hd > 0) {
      pl.stepD += hd;
      const stride = P.sprinting ? 1.9 : P.sneaking ? 1.1 : 1.65;
      if (pl.stepD >= stride) {
        pl.stepD = 0;
        const id = blockUnderFeet(p);
        if (id) blockSound("step", id, p.x - 0.5, p.y - 1, p.z - 0.5, P.sneaking ? 0.35 : P.sprinting ? 1.1 : 0.9);
      }
    }
    // ladders: a step every 0.7 blocks climbed
    if (!ground && !flying && !water && BF.blocks) {
      const b = BF.blocks[BF.world.getBlock(Math.floor(p.x), Math.floor(p.y + 0.1), Math.floor(p.z))];
      if (b && b.ladder && Math.abs(dyy) > 0) { pl.ladderD += Math.abs(dyy); if (pl.ladderD > 0.7) { pl.ladderD = 0; play("step.wood", { group: "player", volume: 0.8 }); } }
    }
    // water
    if (water && !pl.water) { const sp = -pl.vy; if (sp > 4) play("splash", { volume: clamp(sp / 14, 0.35, 1) }); else play("swim", { volume: 0.7 }); env.swimT = 0.6; }
    if (water && !flying) {
      env.swimT -= dt;
      if (env.swimT <= 0 && (hd / Math.max(dt, 1e-3) > 0.8 || Math.abs(vy) > 1.5)) { env.swimT = 0.75 + Math.random() * 0.3; play("swim", { volume: 0.55 }); }
    }
    if (P.headInWater) { env.bubbleT -= dt; if (env.bubbleT <= 0) { env.bubbleT = rnd(2, 7); play("bubble", { x: p.x + rnd(-2, 2), y: p.y + 1.5, z: p.z + rnd(-2, 2) }); } }
  }
  pl.x = p.x; pl.y = p.y; pl.z = p.z; pl.vy = vy; pl.ground = ground; pl.water = water;
}
function updateMobs(dt, now) {
  const M = BF.mobs;
  if (!M || !M.list) return;
  const L = M.list, R2 = 26 * 26;
  for (let i = 0; i < L.length; i++) {
    const m = L[i];
    if (m.dead || m.removed || !m.position) continue;
    const dx = m.position.x - listener.x, dy = m.position.y - listener.y, dz = m.position.z - listener.z;
    if (dx * dx + dy * dy + dz * dz > R2) { m._sndT = 0; continue; }
    const s = MOB_SND[m.type];
    if (!s) continue;
    if (!m._sndT) m._sndT = now + rnd(1, s.iv ? s.iv[1] : 10);
    if (now >= m._sndT) { m._sndT = now + (s.iv ? rnd(s.iv[0], s.iv[1]) : 10); if (s.amb && !m.sleeping && m.hurtT <= 0) mobSound(m, "amb"); }
    const ai = m.ai || EMPTY;
    if (m.type === "creeper") { if (ai.fuse > 0 && !m._sndFuse) { m._sndFuse = true; play("creeper_fuse", mobPos(m)); } else if (!(ai.fuse > 0)) m._sndFuse = false; }
    else if (m.type === "iron_golem") {
      if (m._sx == null) { m._sx = m.position.x; m._sz = m.position.z; m._sd = 0; }
      const mx = m.position.x - m._sx, mz = m.position.z - m._sz; m._sx = m.position.x; m._sz = m.position.z;
      const md = Math.sqrt(mx * mx + mz * mz);
      if (m.onGround && md < 2) { m._sd += md; if (m._sd > 1.6) { m._sd = 0; play("golem_step", { x: m.position.x, y: m.position.y, z: m.position.z }); } }
      if (ai.swingT > 0 && !m._sndSw) { m._sndSw = true; play("golem_attack", mobPos(m)); } else if (!(ai.swingT > 0)) m._sndSw = false;
    } else if (m.type === "zombie") {
      const k = ai.doorAt ? Math.floor(ai.doorT || 0) : -1;   // pounding on a door: one bash per second
      if (k > (m._sndDoor == null ? -1 : m._sndDoor)) play("door_bash", { x: ai.doorAt[0] + 0.5, y: ai.doorAt[1] + 1, z: ai.doorAt[2] + 0.5, volume: 0.7 });
      m._sndDoor = k;
    } else if (m.type === "villager") {
      if (m.tradingWith && !m._sndTr) play("villager_trade", Object.assign(mobPos(m), { pitch: vpitch(m) }));
      m._sndTr = !!m.tradingWith;
    }
  }
}
// ambience: cheap world probes a few times per second
function probeEnv() {
  const P = BF.player, W = BF.world;
  const p = P.position, ey = p.y + 1.6, fx = Math.floor(p.x), fz = Math.floor(p.z);
  env.top = W.heightAt(fx, fz);
  env.covered = env.top >= Math.floor(ey);
  env.under = env.covered && env.top - ey > 5;
  const bl = W.getBlockLight ? W.getBlockLight(p.x, p.y + 1, p.z) : 0;
  env.dark = env.under && bl < 7;
  // openness: columns around whose top is below the eye
  let open = 0;
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4, rr = i & 1 ? 9 : 5;
    if (W.heightAt(p.x + Math.cos(a) * rr, p.z + Math.sin(a) * rr) < ey) open++;
  }
  env.open = open / 8;
  // nearest water surface within 6 blocks (sparse grid)
  let best = 99;
  const fy = Math.floor(p.y);
  for (let ddx = -6; ddx <= 6; ddx += 2) for (let ddz = -6; ddz <= 6; ddz += 2) {
    const d2 = ddx * ddx + ddz * ddz;
    if (d2 >= best * best) continue;
    for (let y = fy - 3; y <= fy + 1; y++) if (BF.RENDER[W.getBlock(fx + ddx, y, fz + ddz)] === 3 && BF.RENDER[W.getBlock(fx + ddx, y + 1, fz + ddz)] !== 3) { best = Math.sqrt(d2 + (y - fy) * (y - fy)); break; }
  }
  env.waterD = best;
}
function probeBiome() {
  const P = BF.player, wg = BF.worldgen;
  if (!wg || !wg.biomeAt) return;
  const b = wg.biomeAt(P.position.x, P.position.z), n = (b && b.name) || "";
  env.forest = /Jungle/.test(n) ? 1.3 : /Forest|Birch|Taiga|Cherry|Swamp|Mangrove/.test(n) && !/Snowy/.test(n) ? 1 : /Plains|Meadow|Savanna/.test(n) && !/Snowy/.test(n) ? 0.3 : 0;
  env.grassy = /Plains|Meadow|Forest|Birch|Savanna|Swamp|Jungle|Cherry|Taiga|Mangrove/.test(n) && !/Snowy|Ice/.test(n) ? 1 : 0;
}
function updateEnv(dt) {
  const P = BF.player;
  if (!P || !P.position || !BF.world) return;
  env.slowT -= dt;
  if (env.slowT <= 0) { env.slowT = 0.3; probeEnv(); }
  env.biomeT -= dt;
  if (env.biomeT <= 0) { env.biomeT = 3; probeBiome(); }
  const p = P.position, Wx = BF.weather, sky = BF.sky || EMPTY;
  const head = P.headInWater;
  const duck = state.paused ? 0.4 : 1;
  // weather
  let rain = 0, snow = 0;
  if (Wx && Wx.type && Wx.type !== "clear") {
    const k = Wx.precipAt ? Wx.precipAt(p.x, p.z, p.y) : 1;
    if (k === 1) rain = Wx.intensity || 0; else if (k === 2) snow = Wx.intensity || 0;
  }
  // wind: stronger high up and in the open, a gust random walk drives the cut-off
  const alt = clamp((p.y + 1.6 - (BF.SEA || 48) - 6) / 55, 0, 1);
  let wind = (0.1 + 0.9 * alt) * (0.25 + 0.75 * env.open) * (env.covered ? 0.35 : 1) * (1 + 0.8 * Math.max(rain, snow));
  if (env.under) wind *= 0.15;
  env.windDrift = clamp(env.windDrift + (Math.random() * 2 - 1) * dt * 0.6, -1, 1);
  const gust = 0.75 + 0.25 * env.windDrift;
  const L = G.loops;
  setLoop(L.wind, wind * gust * 0.32 * duck * (head ? 0.3 : 1), 380 + 500 * alt + 260 * env.windDrift);
  setLoop(L.rain, rain * (env.covered ? 0.45 : 0.6) * duck, env.covered ? 650 : 10000);
  const wd = P.inWater ? 0 : env.waterD;
  setLoop(L.water, (head ? 0 : clamp(1 - wd / 7, 0, 1) * 0.35) * duck);
  setLoop(L.underwater, (head ? 0.55 : 0) * duck);
  if (state.paused || P.dead) return;
  // birds by day in woods (sparse), crickets at night in grass
  const t = sky.time == null ? 0.25 : sky.time, day = t < 0.46 || t > 0.98, night = sky.isNight ? sky.isNight() : false;
  const outside = !env.covered || env.top - (p.y + 1.6) < 3;
  if (day && outside && env.forest > 0 && !head && rain < 0.3) {
    env.birdT -= dt * env.forest;
    if (env.birdT <= 0) { env.birdT = rnd(3, 11); const a = Math.random() * TAU, r = rnd(6, 18); play("bird", { x: p.x + Math.cos(a) * r, y: p.y + rnd(3, 9), z: p.z + Math.sin(a) * r, variant: Math.floor(Math.random() * 6) }); }
  }
  if (night && outside && env.grassy && !head && rain < 0.3) {
    env.cricketT -= dt;
    if (env.cricketT <= 0) { env.cricketT = rnd(0.8, 3); const a = Math.random() * TAU, r = rnd(4, 15); play("cricket", { x: p.x + Math.cos(a) * r, y: p.y, z: p.z + Math.sin(a) * r }); }
  }
  if (env.dark) {
    env.caveT -= dt;
    if (env.caveT <= 0) { env.caveT = rnd(50, 160); const a = Math.random() * TAU, r = rnd(6, 16); play("cave", { x: p.x + Math.cos(a) * r, y: p.y + rnd(-4, 4), z: p.z + Math.sin(a) * r }); }
  }
}
function pickMood() {
  const P = BF.player;
  if (P && P.gameMode === "creative") return "creative";
  if (env.under) return "under";
  if (BF.sky && BF.sky.isNight && BF.sky.isNight()) return "night";
  return "day";
}
function updateMusic(dt) {
  const now = ctx.currentTime;
  if (music.piece) {
    pumpPiece(G, music.piece, now + 0.8);
    if (now > music.piece.end) { try { music.piece.gain.disconnect(); music.piece.padOut.disconnect(); } catch (_) {} music.piece = null; music.wait = rnd(180, 480); }
    return;
  }
  if (state.menu || state.paused) return;
  music.wait -= dt;
  if (music.wait > 0) return;
  if (settings.music <= 0 || settings.muted) { music.wait = 30; return; }
  startMusic(pickMood());
}
function startMusic(mood, seed) {
  if (!G) return null;
  stopMusic(0.5);
  music.seed = seed != null ? seed : ((BF.state && BF.state.seed) || 0) * 31 + (++seedCounter) * 7777 + Math.floor(Math.random() * 1e6);
  const piece = compose(music.seed, mood);
  music.mood = mood; music.played++;
  const notes = new Set(); for (const e of piece.ev) if (e.k === "pn" && !pianoBank.has(e.m)) notes.add(e.m);
  warmQ.unshift(...notes); schedWarm();
  music.piece = startPiece(G, piece, ctx.currentTime + 0.2);
  return { mood, bpm: piece.bpm, length: +piece.length.toFixed(1), seed: music.seed };
}
function stopMusic(fade = 2) {
  const pc = music.piece;
  if (!pc || !G) return;
  const now = ctx.currentTime;
  pc.gain.gain.setTargetAtTime(0, now, fade / 4); pc.padOut.gain.setTargetAtTime(0, now, fade / 4);
  pc.idx = pc.ev.length;
  setTimeout(() => { try { pc.gain.disconnect(); pc.padOut.disconnect(); } catch (_) {} }, fade * 1000 + 6000);
  music.piece = null; music.wait = rnd(180, 480);
}
let startEl = null;
function update(dt) {
  if (!G || ctx.state !== "running") return;
  const t0 = performance.now(), g0 = stats.genMs;
  const cam = BF.camera, P = BF.player;
  if (cam) { listener.x = cam.position.x; listener.y = cam.position.y; listener.z = cam.position.z; }
  if (P && typeof P.yaw === "number") { listener.rx = Math.cos(P.yaw); listener.rz = -Math.sin(P.yaw); }
  const paused = !!(BF.state && BF.state.paused);
  state.menuT -= dt;
  if (state.menuT <= 0) {
    state.menuT = 0.25;
    if (P && P.menu) state.menu = P.menu() === "start";
    else { if (!startEl) startEl = document.querySelector(".bfp-start"); state.menu = !!(startEl && startEl.classList.contains("on")); }
    ensureUI();
  }
  if (paused !== state.paused) { state.paused = paused; applyVolumes(G); }
  const head = !!(P && P.headInWater);
  if (head !== state.head) { state.head = head; G.muffle.frequency.setTargetAtTime(head ? 480 : G.nyq, ctx.currentTime, 0.08); }
  const now = ctx.currentTime;
  try {
    if (!paused && !state.menu) { updatePlayer(dt); updateMobs(dt, now); }
    else pl.init = false;
    if (!state.menu) updateEnv(dt);
    else for (const k in G.loops) setLoop(G.loops[k], 0);
    updateMusic(dt);
  } catch (e) { console.error(e); }
  const ms = performance.now() - t0 - (stats.genMs - g0);   // sample generation is reported separately (genMs)
  stats.frames++; stats.updMs += ms; if (ms > stats.updMax) stats.updMax = ms;
}

// ---------- event hooks ----------
function hook() {
  if (!BF.on) return;
  BF.on("blockBroken", (x, y, z, id) => blockSound("break", id, x, y, z));
  BF.on("blockPlaced", (x, y, z, id) => {
    const now = performance.now();
    if (now - lastPlaceT < 60) return;                        // doors / beds emit twice
    lastPlaceT = now;
    if (BF.RENDER && BF.RENDER[id] === 3) play("swim", { x: x + 0.5, y: y + 0.5, z: z + 0.5, volume: 0.8 });
    else blockSound("place", id, x, y, z);
  });
  // mining hit ticks: cracks.js emits "blockHit" every 0.25 s of mining
  BF.on("blockHit", (x, y, z, id) => { const now = performance.now(); if (now - lastHitT >= 200) { lastHitT = now; blockSound("hit", id, x, y, z); } });
  BF.on("playerEating", () => { const now = performance.now(); if (now - lastEatT >= 210) { lastEatT = now; play("eat"); } });
  BF.on("playerAte", () => play("burp", { delay: 0.05 }));
  BF.on("playerDamaged", () => play("hurt"));
  BF.on("mobHurt", m => { if (m && m.hp > 0) mobSound(m, "hurt"); });
  BF.on("mobKilled", m => { if (m && !m.exploded) mobSound(m, "death"); });
  BF.on("mobExploded", (m, c) => { const p = c || (m && m.position); if (p) play("explode", { x: p.x, y: p.y, z: p.z }); });
  BF.on("arrowShot", (m, from) => { const p = from || (m && m.position); if (p) play("bow", { x: p.x, y: p.y, z: p.z }); });
  BF.on("doorBroken", (m, x, y, z) => { play("door_bash", { x: x + 0.5, y: y + 1, z: z + 0.5 }); play("dig.wood", { x: x + 0.5, y: y + 1, z: z + 0.5 }); });
  BF.on("villagerTrade", v => { if (v && v.position) play("villager_yes", Object.assign(mobPos(v), { pitch: vpitch(v) })); play("xp", { volume: 0.7 }); });
  BF.on("villagerLevelUp", () => play("levelup", { delay: 0.15 }));
  BF.on("lightning", e => {
    if (!e) return;
    const p = BF.player && BF.player.position;
    const dist = e.dist != null ? e.dist : p ? Math.hypot(e.x - p.x, e.z - p.z) : 50;
    const near = dist < 48;
    play(near ? "thunder_near" : "thunder_far", { volume: near ? 1 : clamp(1.3 - dist / 250, 0.35, 1), delay: Math.min(3.5, dist / 340 * 3) });
  });
  BF.on("gameModeChanged", () => { music.mood = null; });
  BF.on("newWorld", () => { stopMusic(1); music.wait = rnd(30, 60); pl.init = false; });
  BF.on("worldLoaded", () => { pl.init = false; });
  // doors (player and villagers go through world.setDoor): wrap it once
  const W = BF.world;
  if (W && W.setDoor && !W.setDoor._snd) {
    const orig = W.setDoor;
    W.setDoor = function (x, y, z, open) {
      const before = BF.blocks[W.getBlock(x, y, z)], was = before && before.door ? before.door.open : null;
      const res = orig.apply(this, arguments);
      if (res != null && res !== was) play(res ? "door_open" : "door_close", { x: x + 0.5, y: y + 1, z: z + 0.5 });
      return res;
    };
    W.setDoor._snd = true;
  }
}

// ---------- settings UI (injected into the pause menu) ----------
const CSS = `
.bfa-panel{margin:6px 0 4px;padding:10px 12px 8px;background:rgba(0,0,0,.28);border:1px solid var(--panel-edge);border-radius:3px;text-align:left}
.bfa-row{display:grid;grid-template-columns:68px 1fr 40px;align-items:center;gap:10px;margin:6px 0;font:12px/1.2 var(--mono);color:var(--muted)}
.bfa-row span:last-child{text-align:right;color:var(--ink);font-variant-numeric:tabular-nums}
.bfa-row input[type=range]{width:100%;accent-color:var(--accent);margin:0;min-width:0}
.bfa-panel button.bfa-mute{margin:6px 0 2px}
`;
const SLIDERS = [["master", "Master"], ["music", "Music"], ["blocks", "Blocks"], ["mobs", "Mobs"], ["ambient", "Ambient"], ["player", "Player"]];
let uiBuilt = false, uiPanel = null, uiBtn = null;
function ensureUI() {
  if (uiBuilt) return;
  const card = document.querySelector(".bfp-pause .bfp-card");
  if (!card) return;
  uiBuilt = true;
  const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
  uiBtn = document.createElement("button"); uiBtn.type = "button"; uiBtn.className = "bfa-open"; uiBtn.textContent = "Sound…";
  uiBtn.setAttribute("aria-expanded", "false");
  uiPanel = document.createElement("div"); uiPanel.className = "bfa-panel"; uiPanel.hidden = true;
  uiPanel.innerHTML = SLIDERS.map(([k, l]) => `<label class="bfa-row"><span>${l}</span><input type="range" min="0" max="100" step="1" data-k="${k}" aria-label="${l} volume"><span data-v="${k}"></span></label>`).join("") +
    `<button type="button" class="bfa-mute"></button>`;
  const anchor = card.querySelector('[data-act="help"]') || card.querySelector('[data-act="quit"]');
  card.insertBefore(uiBtn, anchor); card.insertBefore(uiPanel, anchor);
  uiBtn.addEventListener("click", () => { uiPanel.hidden = !uiPanel.hidden; uiBtn.setAttribute("aria-expanded", String(!uiPanel.hidden)); });
  uiPanel.addEventListener("input", e => { const k = e.target.dataset && e.target.dataset.k; if (k) setVolume(k, e.target.value / 100); });
  uiPanel.querySelector(".bfa-mute").addEventListener("click", () => setMuted(!settings.muted));
  uiPanel.addEventListener("keydown", e => { if (e.code !== "Escape") e.stopPropagation(); });
  refreshUI();
}
function refreshUI() {
  if (!uiPanel) return;
  for (const [k] of SLIDERS) {
    const i = uiPanel.querySelector(`[data-k="${k}"]`), v = uiPanel.querySelector(`[data-v="${k}"]`);
    if (i && document.activeElement !== i) i.value = Math.round(settings[k] * 100);
    if (v) v.textContent = Math.round(settings[k] * 100) + "%";
  }
  const b = uiPanel.querySelector(".bfa-mute");
  b.textContent = settings.muted ? "Sound: Off" : "Sound: On";
  b.classList.toggle("primary", !settings.muted);
}
function setVolume(group, v) {
  if (!(group in DEFAULTS) || group === "muted") return false;
  settings[group] = clamp(+v || 0, 0, 1);
  saveSettings(); applyVolumes(G); refreshUI();
  if (group === "music" && settings.music <= 0) stopMusic(1);
  return true;
}
function setMuted(m) { settings.muted = !!m; saveSettings(); applyVolumes(G); refreshUI(); if (settings.muted) stopMusic(0.5); }

// ---------- offline rendering + WAV (tests / export) ----------
async function renderOffline(name, o, seconds = 2, sampleRate = 44100) {
  const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const oc = new OC(2, Math.round(seconds * sampleRate), sampleRate);
  const g = makeGraph(oc);
  const saved = Object.assign({}, settings), sl = Object.assign({}, listener);
  Object.assign(settings, DEFAULTS, { master: 1 }); applyVolumes(g); Object.assign(settings, saved);
  g.master.gain.value = 1; for (const k of GROUPS) g.groups[k].gain.gain.value = 1; g.music.gain.value = 1;
  listener.x = listener.y = listener.z = 0; listener.rx = 1; listener.rz = 0;
  const list = Array.isArray(name) ? name : [[name, o, 0]];
  for (const [n, oo, t] of list) startVoice(g, n, oo, t || 0);
  Object.assign(listener, sl);
  return oc.startRendering();
}
async function renderMusic(seconds = 20, mood = "day", seed = 1, sampleRate = 44100) {
  const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const oc = new OC(2, Math.round(seconds * sampleRate), sampleRate);
  const g = makeGraph(oc);
  g.music.gain.value = 1;
  const piece = startPiece(g, compose(seed, mood), 0);
  pumpPiece(g, piece, seconds);
  const buf = await oc.startRendering();
  return { buffer: buf, info: { mood, bpm: piece.bpm, root: piece.root, cycles: piece.cycles, length: +piece.length.toFixed(1), events: piece.ev.length } };
}
function encodeWav(buf) {
  const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate, bytes = 44 + n * ch * 2;
  const dv = new DataView(new ArrayBuffer(bytes));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); dv.setUint32(4, bytes - 8, true); w(8, "WAVE"); w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
  w(36, "data"); dv.setUint32(40, n * ch * 2, true);
  const data = []; for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { dv.setInt16(o, clamp(data[c][i], -1, 1) * 32767, true); o += 2; }
  return new Uint8Array(dv.buffer);
}

// ---------- boot ----------
const gesture = () => unlock();
for (const ev of ["pointerdown", "keydown", "touchstart"]) addEventListener(ev, gesture, { capture: true, passive: true });
document.addEventListener("visibilitychange", () => {
  state.hidden = document.hidden;
  if (!ctx) return;
  if (document.hidden) ctx.suspend().catch(() => {}); else ctx.resume().catch(() => {});
});
// small click on menu buttons
document.addEventListener("click", e => { const b = e.target && e.target.closest && e.target.closest("#ui button"); if (b) { unlock(); play("ui_click"); } }, true);
let lastFrame = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0.016;
  lastFrame = now;
  update(dt);
}
requestAnimationFrame(frame);
setTimeout(queueWarm, 2500);
hook();
ensureUI();

BF.audio = {
  play, blockSound, mobSound, setVolume, setMuted, unlock,
  get muted() { return settings.muted; },
  getVolume: g => settings[g],
  settings,
  material: id => matName(id),
  names: () => Object.keys(DEFS),
  loopNames: () => Object.keys(LOOPS),
  music: {
    start: (mood, seed) => startMusic(mood || pickMood(), seed),
    stop: fade => stopMusic(fade),
    get playing() { return !!music.piece; },
    get mood() { return music.piece ? music.piece.mood : null; },
    get wait() { return music.wait; },
    set wait(v) { music.wait = +v || 0; },
    compose,
    moods: Object.keys(MOODS),
  },
  update,      // driven by audio.js's own requestAnimationFrame loop; exposed for tests
  get ctx() { return ctx; },
  get graph() { return G; },
  get voices() { return G ? G.voices.length : 0; },
  maxVoices: MAX_VOICES,
  stats, env,
  renderOffline, renderMusic, encodeWav,
  samples: name => buffers(name, ctx),   // generated AudioBuffers of a sound (tests)
};
})();

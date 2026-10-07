// Forester pack tiles. The band saw (the forester villager's jobsite) is the artwork of the villager-planter mod (GordonWallace/villager-planter,
// 16x16 RGBA, each pixel doubled to the game's 32px tile); the saplings are procedural. Registered on BF.texKit before the atlas is drawn.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
const K = BF.texKit;
if (!K) { console.warn("textures-forester: BF.texKit missing (textures.js must load first)"); return; }
const { T, hex, pal, ramp, jit } = K;

const SAW = {
  top: "LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/x4eI/8eHiP/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv9aWl//oKCo/7S0vv+goKj/PDxB/zw8Qf88PEH/PDxB/zw8Qf88PEH/tLS+/6CgqP+goKj/Wlpf/y0tMv8tLTL/oKCo/7S0vv+goKj/oKCo/zw8Qf88PEH/PDxB/zw8Qf88PEH/PDxB/6CgqP+goKj/oKCo/7S0vv8tLTL/LS0y/7S0vv+goKj/oKCo/6CgqP+0tL7/oKCo/8PI0v/S1+H/tLS+/6CgqP+goKj/PDxB/4KCh/+goKj/LS0y/y0tMv+goKj/oKCo/6CgqP+0tL7/oKCo/6CgqP/DyNL/0tfh/6CgqP+goKj/oKCo/zw8Qf+Cgof/oKCo/y0tMv8tLTL/oKCo/6CgqP+0tL7/oKCo/6CgqP+goKj/w8jS/9LX4f+goKj/oKCo/7S0vv88PEH/goKH/6CgqP8tLTL/LS0y/6CgqP+0tL7/oKCo/6CgqP+goKj/tLS+/8PI0v/S1+H/oKCo/7S0vv+goKj/PDxB/4KCh/+0tL7/LS0y/y0tMv+0tL7/oKCo/6CgqP+goKj/tLS+/6CgqP/DyNL/0tfh/7S0vv+goKj/oKCo/zw8Qf9aWl//oKCo/y0tMv8tLTL/oKCo/6CgqP+goKj/tLS+/6CgqP+goKj/w8jS/9LX4f+goKj/oKCo/6CgqP88PEH/Wlpf/6CgqP8tLTL/LS0y/6CgqP+goKj/tLS+/6CgqP+goKj/oKCo/8PI0v/S1+H/oKCo/6CgqP+0tL7/PDxB/4KCh/+goKj/LS0y/y0tMv+goKj/tLS+/6CgqP+goKj/oKCo/7S0vv/DyNL/0tfh/6CgqP+0tL7/oKCo/zw8Qf+Cgof/tLS+/y0tMv8tLTL/tLS+/6CgqP+goKj/oKCo/7S0vv+goKj/w8jS/9LX4f+0tL7/oKCo/6CgqP88PEH/goKH/6CgqP8tLTL/LS0y/6CgqP+goKj/oKCo/7S0vv+goKj/oKCo/8PI0v/S1+H/oKCo/6CgqP+goKj/PDxB/4KCh/+goKj/LS0y/y0tMv+goKj/oKCo/7S0vv+goKj/oKCo/6CgqP/DyNL/0tfh/6CgqP+goKj/tLS+/6CgqP+goKj/oKCo/y0tMv8tLTL/Wlpf/7S0vv+goKj/oKCo/6CgqP+0tL7/w8jS/9LX4f+goKj/tLS+/6CgqP+goKj/oKCo/1paX/8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/x4eI/8eHiP/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/w==",
  front: "LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv9aWl//rzw3/688N/+vPDf/rzw3/688N/+vPDf/rzw3/688N/+vPDf/rzw3/688N/+vPDf/Wlpf/y0tMv8tLTL/eCYh/6AyLf+gMi3/oDIt/zw8Qf88PEH/PDxB/zw8Qf88PEH/PDxB/6AyLf+gMi3/oDIt/3gmIf8tLTL/LS0y/3gmIf+gMi3/oDIt/zw8Qf88PEH/PDxB/1paX/9aWl//PDxB/zw8Qf88PEH/oDIt/6AyLf94JiH/LS0y/y0tMv94JiH/oDIt/6AyLf88PEH/PDxB/zw8Qf+goKj/Wlpf/zw8Qf88PEH/PDxB/6AyLf+gMi3/eCYh/y0tMv8tLTL/eCYh/6AyLf+gMi3/oDIt/zw8Qf88PEH/PDxB/zw8Qf88PEH/PDxB/6AyLf+gMi3/oDIt/3gmIf8tLTL/LS0y/6CgqP+goKj/oKCo/6CgqP+goKj/PDxB/8PI0v/S1+H/PDxB/6CgqP+goKj/oKCo/6CgqP+goKj/LS0y/y0tMv+Cgof/goKH/4KCh/+Cgof/goKH/zw8Qf/DyNL/0tfh/zw8Qf+Cgof/goKH/4KCh/+Cgof/goKH/y0tMv8tLTL/oKCo/6CgqP+goKj/oKCo/6CgqP+goKj/Hh4j/x4eI/+goKj/oKCo/6CgqP+goKj/oKCo/6CgqP8tLTL/LS0y/7S0vv+0tL7/tLS+/7S0vv+0tL7/tLS+/x4eI/8eHiP/tLS+/7S0vv+0tL7/tLS+/7S0vv+0tL7/LS0y/y0tMv88PEH/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/PDxB/y0tMv8tLTL/PDxB/4KCh/+Cgof/goKH/zw8Qf88PEH/PDxB/zw8Qf88PEH/PDxB/4KCh/+Cgof/goKH/zw8Qf8tLTL/LS0y/zw8Qf+Cgof/goKH/zw8Qf88PEH/PDxB/1paX/9aWl//PDxB/zw8Qf88PEH/goKH/4KCh/88PEH/LS0y/y0tMv88PEH/goKH/4KCh/88PEH/PDxB/zw8Qf+goKj/Wlpf/zw8Qf88PEH/PDxB/4KCh/+Cgof/PDxB/y0tMv8tLTL/Wlpf/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/1paX/8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/w==",
  side: "LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv9aWl//rzw3/688N/+vPDf/rzw3/688N/+vPDf/rzw3/688N/+vPDf/rzw3/688N/+vPDf/Wlpf/y0tMv8tLTL/eCYh/6AyLf+gMi3/oDIt/6AyLf+gMi3/oDIt/6AyLf+gMi3/oDIt/6AyLf+gMi3/oDIt/3gmIf8tLTL/LS0y/3gmIf+gMi3/eCYh/3gmIf94JiH/eCYh/3gmIf94JiH/eCYh/3gmIf94JiH/eCYh/6AyLf94JiH/LS0y/y0tMv94JiH/oDIt/6AyLf+gMi3/oDIt/6AyLf+gMi3/oDIt/6AyLf+gMi3/oDIt/6AyLf+gMi3/eCYh/y0tMv8tLTL/eCYh/6AyLf94JiH/eCYh/3gmIf94JiH/eCYh/3gmIf94JiH/eCYh/3gmIf94JiH/oDIt/3gmIf8tLTL/LS0y/6CgqP+goKj/oKCo/6CgqP+goKj/oKCo/6CgqP+goKj/oKCo/6CgqP+goKj/oKCo/6CgqP+goKj/LS0y/y0tMv+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/y0tMv8tLTL/oKCo/6CgqP+goKj/oKCo/6CgqP+goKj/oKCo/6CgqP+goKj/oKCo/6CgqP+goKj/oKCo/6CgqP8tLTL/LS0y/7S0vv+0tL7/tLS+/7S0vv+0tL7/tLS+/7S0vv+0tL7/tLS+/7S0vv+0tL7/tLS+/7S0vv+0tL7/LS0y/y0tMv88PEH/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/PDxB/y0tMv8tLTL/PDxB/zw8Qf88PEH/PDxB/zw8Qf88PEH/PDxB/zw8Qf88PEH/PDxB/zw8Qf88PEH/PDxB/zw8Qf8tLTL/LS0y/zw8Qf88PEH/oKCo/6CgqP+goKj/oKCo/6CgqP+goKj/oKCo/6CgqP+goKj/oKCo/zw8Qf88PEH/LS0y/y0tMv88PEH/PDxB/6CgqP+goKj/oKCo/6CgqP+goKj/oKCo/6CgqP+goKj/oKCo/6CgqP88PEH/PDxB/y0tMv8tLTL/Wlpf/zw8Qf88PEH/PDxB/zw8Qf88PEH/PDxB/zw8Qf88PEH/PDxB/zw8Qf88PEH/PDxB/1paX/8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/w==",
  bottom: "LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/y0tMv8tLTL/goKH/zw8Qf88PEH/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/88PEH/PDxB/4KCh/8tLTL/LS0y/4KCh/88PEH/PDxB/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/PDxB/zw8Qf+Cgof/LS0y/y0tMv+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/y0tMv8tLTL/PDxB/zw8Qf88PEH/PDxB/zw8Qf88PEH/PDxB/zw8Qf88PEH/PDxB/zw8Qf88PEH/PDxB/zw8Qf8tLTL/LS0y/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/LS0y/y0tMv+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/y0tMv8tLTL/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/8tLTL/LS0y/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/LS0y/y0tMv88PEH/PDxB/zw8Qf88PEH/PDxB/zw8Qf88PEH/PDxB/zw8Qf88PEH/PDxB/zw8Qf88PEH/PDxB/y0tMv8tLTL/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/8tLTL/LS0y/4KCh/88PEH/PDxB/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/PDxB/zw8Qf+Cgof/LS0y/y0tMv+Cgof/PDxB/zw8Qf+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/zw8Qf88PEH/goKH/y0tMv8tLTL/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/+Cgof/goKH/4KCh/8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/y0tMv8tLTL/LS0y/w==",
};
function sawTile(key) {
  return p => {
    const raw = atob(SAW[key]);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const i = ((y >> 1) * 16 + (x >> 1)) * 4;
      p.set(x, y, [raw.charCodeAt(i), raw.charCodeAt(i + 1), raw.charCodeAt(i + 2)], 255);
      p.setH(x, y, 0.5);
    }
    p.relief(0.6);
  };
}
T.band_saw_top = sawTile("top");
T.band_saw_front = sawTile("front");
T.band_saw_side = sawTile("side");
T.band_saw_bottom = sawTile("bottom");

// ---------- saplings: a thin trunk with a few leaf clumps, tinted per species ----------
const SAPLING = {
  oak: ["#2c5a1c", "#3a7024", "#4a8a2e", "#5ea23a"],
  birch: ["#4a7a30", "#5c9040", "#72a850", "#8ac062"],
  spruce: ["#1f3f26", "#294f30", "#336038", "#3f7244"],
  jungle: ["#1f6a14", "#2a8a1a", "#38a424", "#4cc030"],
  acacia: ["#4a7a1c", "#5c9226", "#72aa30", "#88c23c"],
  dark_oak: ["#24441a", "#2e5a22", "#3a6e2a", "#488434"],
  cherry: ["#d878a0", "#e898b8", "#f4b4cc", "#fcd0e0"],
};
const TRUNK = { birch: "#d8d3c5", spruce: "#3b2a18", jungle: "#594420", acacia: "#8a7a68", dark_oak: "#3c2a16", cherry: "#5a3a3a", oak: "#6b5233" };
for (const sp in SAPLING) {
  T[sp + "_sapling"] = p => {
    p.clear();
    const L = pal(SAPLING[sp]), tr = hex(TRUNK[sp]);
    for (let y = 31; y >= 17; y--) { p.set(15, y, jit(p, tr, 0.06)); p.set(16, y, jit(p, tr, 0.06)); }
    const clump = (cx, cy, r) => {
      for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r - 1; x <= cx + r + 1; x++) {
        const d = Math.hypot((x - cx) / (r + 1), (y - cy) / r);
        if (d > 1 || p.rand() < 0.14) continue;
        p.set(x, y, jit(p, ramp(L, 0.9 - d * 0.7 + (p.rand() - 0.5) * 0.3), 0.05));
      }
    };
    if (sp === "spruce") {
      for (let k = 0; k < 4; k++) { const w = 2 + k * 2, y = 10 + k * 5; for (let x = 16 - w; x <= 15 + w; x++) { p.set(x, y, jit(p, ramp(L, 0.8 - k * 0.1), 0.05)); p.set(x, y + 1, jit(p, ramp(L, 0.4), 0.05)); } }
    } else { clump(15, 14, 6); clump(9, 20, 3); clump(22, 19, 3); clump(15, 8, 3); }
  };
}
})();

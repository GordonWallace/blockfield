// Mining times and drop rules against vanilla Minecraft (Java 1.21; times from the wiki's breaking-time tables).
// Each row: block, tool item (null = hand), expected seconds on dry ground, whether it drops anything.
// node test/run.js /tmp/mining test/mining-vanilla.js
module.exports = async (pg) => {
  const rows = [
    ["dirt", null, 0.75, true], ["dirt", "wooden_shovel", 0.4, true], ["grass", "diamond_shovel", 0.15, true],
    ["stone", null, 7.5, false], ["stone", "wooden_pickaxe", 1.15, true], ["stone", "stone_pickaxe", 0.6, true],
    ["stone", "iron_pickaxe", 0.4, true], ["stone", "diamond_pickaxe", 0.3, true], ["stone", "diamond_axe", 7.5, false],
    ["cobblestone", null, 10, false], ["cobblestone", "wooden_pickaxe", 1.5, true],
    ["deepslate", "diamond_pickaxe", 0.6, true], ["coal_ore", "wooden_pickaxe", 2.25, true],
    ["iron_ore", "wooden_pickaxe", 7.5, false], ["iron_ore", "stone_pickaxe", 1.15, true],
    ["diamond_ore", "stone_pickaxe", 3.75, false], ["diamond_ore", "iron_pickaxe", 0.75, true],
    ["obsidian", null, 250, false], ["obsidian", "iron_pickaxe", 41.7, false], ["obsidian", "diamond_pickaxe", 9.4, true],
    ["oak_log", null, 3, true], ["oak_log", "wooden_axe", 1.5, true], ["oak_log", "diamond_axe", 0.4, true],
    ["planks", "stone_axe", 0.75, true], ["oak_leaves", null, 0.3, true], ["oak_leaves", "shears", 0, true],
    ["oak_leaves", "iron_sword", 0.2, true], ["oak_leaves", "wooden_hoe", 0.15, true], ["white_wool", null, 1.2, true],
    ["white_wool", "shears", 0.25, true], ["glass", null, 0.45, true], ["sand", null, 0.75, true],
    ["bricks", null, 10, false], ["lantern", null, 17.5, false], ["iron_bars", null, 25, false],
    ["snow", null, 1, false], ["snow", "wooden_shovel", 0.15, true], ["torch", null, 0, true], ["bedrock", "diamond_pickaxe", Infinity, true],
    ["stone_slab", "wooden_pickaxe", 1.5, true], ["packed_mud", null, 1.5, true],
  ];
  const res = await pg.evaluate(rows => rows.map(([b, t, sec, drops]) => {
    const bid = BF.B[b], iid = t == null ? null : BF.I[t];
    if (bid == null || (t != null && iid == null)) return { b, t, err: "unknown name" };
    return { b, t, sec, drops, got: BF.player.mineSeconds(bid, iid), gotDrops: BF.player.minedDrops(bid, iid) };
  }), rows);
  let fail = 0;
  for (const r of res) {
    const ok = !r.err && (r.sec === Infinity ? r.got === Infinity : Math.abs(r.got - r.sec) < 0.051) && r.gotDrops === r.drops;
    if (!ok) fail++;
    console.log((ok ? "ok   " : "FAIL ") + r.b + " / " + (r.t || "hand") + ": " + (r.err || r.got + "s drops=" + r.gotDrops + " (vanilla " + r.sec + "s drops=" + r.drops + ")"));
  }
  const ore = await pg.evaluate(() => [BF.rollDrops(BF.B.iron_ore)[0].id === BF.I.raw_iron, BF.rollDrops(BF.B.gold_ore)[0].id === BF.I.raw_gold]);
  if (!ore.every(Boolean)) { fail++; console.log("FAIL iron/gold ore should drop raw iron/gold", ore); }
  console.log(fail ? "MINING: " + fail + " FAILED" : "MINING: all " + (res.length + 1) + " passed");
};

// Wood variant checks: NODE_PATH=$(npm root -g) node test/run.js /tmp/wv test/wood-variants.js
// every wood species has its door, fence gate, fence, sign, slab, stairs, wood and stripped wood with a recipe from its own planks / logs;
// doors and gates keep their wood when opened; a zombie-broken door drops its own wood; screenshots a row of doors and gates.
module.exports = async (pg, out) => {
  const r = await pg.evaluate(() => {
    const I = BF.I, R = BF.inventory.recipes, res = { missing: [], wrong: [] };
    // the crafting matcher of inventory.js over a 3x3 grid of item names ("" = empty), first match wins
    const craft = rows => {
      const g = rows.map(r => r.map(n => (n ? I[n] : 0)));
      let x0 = 3, y0 = 3, x1 = -1, y1 = -1; const filled = [];
      g.forEach((row, y) => row.forEach((id, x) => { if (id) { filled.push(id); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } }));
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      for (const rc of R) {
        if (rc.type === "shapeless") { if (filled.length !== rc.ings.length) continue; const left = rc.ings.slice(); if (filled.every(id => { const k = left.findIndex(a => a.includes(id)); if (k < 0) return false; left.splice(k, 1); return true; })) return rc; continue; }
        if (rc.w !== bw || rc.h !== bh) continue;
        for (const mir of [false, true]) {
          let ok = true;
          for (let y = 0; y < bh && ok; y++) for (let x = 0; x < bw && ok; x++) { const ch = rc.pattern[y].padEnd(rc.w, " ")[mir ? bw - 1 - x : x], id = g[y0 + y][x0 + x]; ok = ch === " " ? !id : !!id && rc.key[ch].includes(id); }
          if (ok) return rc;
        }
      }
      return null;
    };
    const made = (rows, want) => { const rc = craft(rows); return rc ? BF.items[rc.out].name + (rc.out === I[want] ? "" : " (wanted " + want + ")") : "nothing (wanted " + want + ")"; };
    for (const sp of BF.WOOD_SPECIES) {
      const P = sp === "oak" ? "planks" : sp + "_planks", L = sp + "_log", SL = "stripped_" + sp + "_log";
      for (const n of [P, L, SL, sp + "_wood", "stripped_" + sp + "_wood", sp + "_fence", sp + "_fence_gate", sp + "_door", sp + "_sign", sp + "_slab", sp + "_stairs"])
        if (I[n] === undefined) res.missing.push(n);
      const checks = [
        [[[L]], P], [[[SL]], P], [[[sp + "_wood"]], P],
        [[[L, L], [L, L]], sp + "_wood"], [[[SL, SL], [SL, SL]], "stripped_" + sp + "_wood"],
        [[[P, P], [P, P], [P, P]], sp + "_door"],
        [[["stick", P, "stick"], ["stick", P, "stick"]], sp + "_fence_gate"],
        [[[P, "stick", P], [P, "stick", P]], sp + "_fence"],
        [[[P, P, P], [P, P, P], ["", "stick", ""]], sp + "_sign"],
        [[[P, P, P]], sp + "_slab"],
        [[[P, "", ""], [P, P, ""], [P, P, P]], sp + "_stairs"],
        [[[P], [P]], "stick"], [[[P, P], [P, P]], "crafting_table"], [[[P, P, P], [P, "", P], [P, P, P]], "chest"],
        [[[P, P, P], ["", "stick", ""], ["", "stick", ""]], "wooden_pickaxe"],
      ];
      for (const [rows, want] of checks) { const got = made(rows, want); if (got !== want) res.wrong.push(sp + ": " + got); }
      // a door / gate / fence of one wood can't be made from another wood's planks
      const other = sp === "oak" ? "spruce_planks" : "planks";
      const d = craft([[other, other], [other, other], [other, other]]);
      if (d && d.out === I[sp + "_door"]) res.wrong.push(sp + " door from " + other);
    }
    // mixed planks still make sticks, tools and tables (any wood, like Minecraft)
    res.mixed = [made([["planks"], ["birch_planks"]], "stick"), made([["cherry_planks", "planks"], ["spruce_planks", "jungle_planks"]], "crafting_table"),
      made([["planks", "birch_planks", "cherry_planks"], ["", "stick", ""], ["", "stick", ""]], "wooden_pickaxe")];
    res.ladder = made([["stick", "", "stick"], ["stick", "stick", "stick"], ["stick", "", "stick"]], "ladder");
    res.fuel = BF.WOOD_SPECIES.map(sp => [BF.inventory.fuel.get(I[sp + "_door"]), BF.inventory.fuel.get(I[sp + "_fence_gate"])].join("/")).join(" ");
    // textures and icons
    res.tiles = BF.WOOD_SPECIES.filter(sp => !(BF.textures.has(sp + "_door_top") && BF.textures.has(sp + "_door_bottom"))).map(sp => sp + " door tiles");
    res.icons = BF.WOOD_SPECIES.flatMap(sp => [sp + "_door", sp + "_fence_gate"]).filter(n => !BF.textures.icon(I[n]));
    return res;
  });
  console.log(JSON.stringify(r));

  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(3000);
  const r2 = await pg.evaluate(() => {
    const W = BF.world, B = BF.B, p = BF.player.position, res = {};
    // a stone platform in the air above the highest ground around, so nothing hides the row
    const x0 = Math.floor(p.x) + 3, z0 = Math.floor(p.z) + 6;
    let top = 0; for (let dx = -3; dx <= 20; dx++) for (let dz = -8; dz <= 12; dz++) top = Math.max(top, W.heightAt(x0 + dx, z0 + dz));
    const y = top + 4;
    for (let dx = -3; dx <= 20; dx++) for (let dz = -8; dz <= 12; dz++) { W.setBlock(x0 + dx, y - 1, z0 + dz, B.stone); for (let k = 0; k < 8; k++) W.setBlock(x0 + dx, y + k, z0 + dz, 0); }
    BF.WOOD_SPECIES.forEach((sp, i) => {
      const x = x0 + i * 2;
      W.setBlock(x, y, z0, BF.doorId(0, 0, 0, sp)); W.setBlock(x, y + 1, z0, BF.doorId(0, 1, 0, sp));
      W.setBlock(x, y, z0 - 3, BF.gateId("x", 0, sp)); W.setBlock(x + 1, y, z0 - 3, B[sp + "_fence"] != null ? B[sp + "_fence"] : B.oak_fence);
    });
    // toggling keeps the wood
    res.kept = BF.WOOD_SPECIES.map((sp, i) => {
      const x = x0 + i * 2;
      W.setDoor(x, y + 1, z0, true); const a = BF.blocks[W.getBlock(x, y, z0)], b = BF.blocks[W.getBlock(x, y + 1, z0)];
      W.setDoor(x, y, z0, false); const c = BF.blocks[W.getBlock(x, y, z0)];
      W.setGate(x, y, z0 - 3, true); const g = BF.blocks[W.getBlock(x, y, z0 - 3)]; W.setGate(x, y, z0 - 3, false);
      return [a.door.open && a.door.wood === sp, b.door.wood === sp && b.door.upper, !c.door.open && c.door.wood === sp, g.gate.open && g.gate.wood === sp, BF.rollDrops(a.id)[0].id === BF.I[sp + "_door"], BF.rollDrops(g.id)[0].id === BF.I[sp + "_fence_gate"]].every(Boolean) ? sp : sp + " BROKEN";
    });
    // blueprint rotation keeps a door's wood
    res.rot = BF.blocks[BF.blueprints.rotId(BF.doorId(0, 0, 0, "cherry"), 1)].name;
    BF.player.position.set(x0 + 7.5, y + 0.2, z0 + 6);
    BF.player.setLook(0, -0.15);
    window.__wv = { x0, y, z0 };
    return res;
  });
  console.log(JSON.stringify(r2));
  await pg.waitForTimeout(1500);
  await pg.screenshot({ path: out + "-closed.png" });
  await pg.evaluate(() => { const { x0, y, z0 } = window.__wv; BF.WOOD_SPECIES.forEach((sp, i) => BF.world.setDoor(x0 + i * 2, y, z0, true)); BF.player.setLook(0.35, -0.25); });
  await pg.waitForTimeout(1500);
  await pg.screenshot({ path: out + "-open.png" });
  // inventory icons: doors, then fence gates, then fences, oak first
  await pg.evaluate(() => {
    const d = document.createElement("div"); d.id = "wv-icons";
    d.style.cssText = "position:fixed;left:20px;top:20px;z-index:99999;background:#8b8b8b;padding:10px;display:grid;grid-template-columns:repeat(8,64px);gap:6px";
    for (const kind of ["_door", "_fence_gate", "_fence"]) for (const sp of BF.WOOD_SPECIES) { const im = new Image(64, 64); im.src = BF.textures.icon(BF.I[sp + kind]); im.style.imageRendering = "pixelated"; d.appendChild(im); }
    document.body.appendChild(d);
  });
  await pg.waitForTimeout(500);
  await pg.screenshot({ path: out + "-icons.png", clip: { x: 0, y: 0, width: 600, height: 260 } });
  await pg.evaluate(() => document.getElementById("wv-icons").remove());
};

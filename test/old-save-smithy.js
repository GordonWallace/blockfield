// The smithy chest per village generator (bug-033): node test/run.js /tmp/os test/old-save-smithy.js
// 1.1 moved the generated smith chest in front of its crafting table for village generator 3, so that a 1.0 world (village generator 2),
// which regenerates its buildings from the seed, kept its saved chest contents in the chest. 1.4 opens no 1.0 to 1.3 worlds (spec r14-19,
// the blank slate), and the old check that loaded a 1.0 save went with the flat generators (spec r14-24); the building generator still
// keeps both layouts, which this checks.
// The smith building: village generator 2 keeps the 1.0 layout, village generator 3 and later (new worlds) put the chest in front of the table.
module.exports = async (pg, out) => {
  const ok = (cond, what) => console.log((cond ? "PASS " : "FAIL ") + what);
  const r = await pg.evaluate(() => {
    // the smith layout per village generator, from the building generator itself (no world to load)
    const smith = vg => { BF.worldgen.init(BF.noise, { biomeScale: BF.state.biomeScale, villages: vg }); const cells = BF.worldgen.recordBuilding("smith", 7, 6);
      const at = id => cells.filter(c => c[1] === 1 && (id === "chest" ? BF.isChest(c[3]) : c[3] === BF.B[id])).map(c => c[2]);
      return { chest: at("chest"), table: at("crafting_table") }; };
    const v3 = smith(3), v10 = smith(10), v2 = smith(2);
    smith(BF.state.villages);   // back to the world's own village generator
    return { v2, v3, v10 };
  });
  console.log(JSON.stringify(r));
  ok(r.v2.chest.join() === "4" && r.v2.table.join() === "3", "village generator 2 (1.0): chest against the back wall, table in front of it");
  ok(r.v3.chest.join() === "3" && r.v3.table.join() === "4", "village generator 3: chest in front of the table, so its lid is clear");
  ok(r.v10.chest.join() === "3" && r.v10.table.join() === "4", "village generator 10 (new worlds): chest in front of the table");
};

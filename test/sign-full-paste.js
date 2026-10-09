// Pasting or typing into a sign that has no room left never deletes the text already on it: a paste keeps only as much
// of itself as fits, and a letter typed into a full sign is refused (it used to push the last letter off).
// node test/run.js /tmp/sp test/sign-full-paste.js
module.exports = async (pg) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(1500);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  const openSign = (text, caret) => pg.evaluate(([text, caret]) => {
    const p = BF.player.position, x = Math.floor(p.x) + 2, z = Math.floor(p.z) + 2, y = BF.world.heightAt(x, z) + 1;
    BF.world.setBlock(x, y, z, BF.signs.signId("oak", 0, 0));
    BF.signs.setText(x, y, z, text);
    window._sg = [x, y, z];
    BF.signs.openEditor(x, y, z);
    const ta = document.querySelector(".bfs-board textarea"); ta.focus(); ta.setSelectionRange(caret, caret);
    return BF.signs.capacity(1, 1);
  }, [text, caret]);
  const stored = () => pg.evaluate(() => { BF.signs.closeEditor(); return BF.signs.get(...window._sg).text; });
  // paste a long sentence at the start of a sign with two lines on it
  await openSign("Welcome home\nBeware of dog", 0);
  await pg.waitForTimeout(200);
  await pg.keyboard.insertText("Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ");
  await pg.waitForTimeout(200);
  let t = await stored();
  check(/^Lorem/.test(t) && t.endsWith("Welcome home\nBeware of dog"), "a paste keeps the old text and as much of itself as fits: " + JSON.stringify(t));
  // a full sign: typing one letter in the middle changes nothing
  const cap = await openSign("x", 0);
  const full = await pg.evaluate(cap => {
    const ta = document.querySelector(".bfs-board textarea");
    let s = "";
    for (let i = 0; BF.signs.layout(s + "abcdefghij"[i % 10], cap.cols).lines.length <= cap.rows && i < 1000; i++) s += "abcdefghij"[i % 10];
    return s;
  }, cap);
  await pg.evaluate(() => BF.signs.closeEditor());
  await openSign(full, 5);
  await pg.waitForTimeout(200);
  await pg.keyboard.type("Z");
  await pg.waitForTimeout(200);
  t = await stored();
  check(t === full, `typing into a full sign (${full.length} letters) leaves it as it was: ${JSON.stringify(t)}`);
  // a sign with room: typing still works
  await openSign("Hi", 2);
  await pg.waitForTimeout(200);
  await pg.keyboard.type("!");
  t = await stored();
  check(t === "Hi!", "typing into a sign with room works: " + JSON.stringify(t));
  console.log(bad ? "FAIL sign-full-paste" : "PASS sign-full-paste");
};

// @ci baseline
// Title screen: the world list is wide enough to show a whole seed, and the copy button next to it puts the seed on the
// clipboard. node test/run.js /tmp/sc test/seed-copy.js
module.exports = async (pg, out) => {
  const seed = 4294967295;   // the longest seed there is (ten digits)
  await pg.evaluate(s => BF.save.create({ name: "A long world name for the seed test", seed: String(s), gameMode: "creative", biomeScale: 4 }), seed);
  await pg.reload();
  await pg.waitForTimeout(5000);
  await pg.evaluate(() => { window._copied = []; const w = navigator.clipboard && navigator.clipboard.writeText;
    if (w) navigator.clipboard.writeText = t => { _copied.push(t); return w.call(navigator.clipboard, t).catch(() => {}); }; });
  const r = await pg.evaluate(() => {
    const meta = document.querySelector(".bfp-wmeta"), card = document.querySelector(".bfp-start .bfp-card");
    return { text: meta && meta.textContent, cut: meta ? meta.scrollWidth > meta.clientWidth : true, card: card && card.getBoundingClientRect().width };
  });
  console.log("world row:", JSON.stringify(r));
  await pg.screenshot({ path: out + "-title.png" });
  let fails = 0;
  if (!r.text || !r.text.includes("seed " + seed)) { console.log("FAIL seed missing from the world row"); fails++; }
  if (r.cut) { console.log("FAIL world row is truncated"); fails++; }
  await pg.click(".bfp-copy");
  await pg.waitForTimeout(300);
  const after = await pg.evaluate(() => ({ copied: _copied, btn: document.querySelector(".bfp-copy").textContent, playing: !document.querySelector(".bfp-start.on") }));
  console.log("after click:", JSON.stringify(after));
  await pg.screenshot({ path: out + "-copied.png", clip: { x: 0, y: 0, width: 1280, height: 760 } });
  if (after.copied[0] !== String(seed)) { console.log("FAIL clipboard got " + JSON.stringify(after.copied)); fails++; }
  if (after.btn !== "✓") { console.log("FAIL copy button shows " + after.btn); fails++; }
  if (after.playing) { console.log("FAIL clicking copy left the title screen"); fails++; }
  console.log(fails ? "seed-copy FAIL " + fails : "seed-copy PASS");
};

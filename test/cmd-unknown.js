// Command names that are also built-in object properties (constructor, __proto__, toString) are unknown commands,
// and /help on them says so, instead of an "unexpected error" or an empty line.
// node test/run.js /tmp/cu test/cmd-unknown.js
module.exports = async (pg) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(500);
  const r = await pg.evaluate(() => ["constructor", "__proto__", "toString", "hasOwnProperty"].map(n => [n, BF.commands.execute("/" + n), BF.commands.execute("/help " + n)]));
  let bad = 0;
  for (const [n, run, help] of r) {
    const ok = !run.ok && run.msg === `Unknown command '${n.toLowerCase()}'. Type /help for a list.` && !help.ok && /^Unknown command/.test(help.msg);
    console.log((ok ? "ok " : "FAIL ") + `/${n} -> ${JSON.stringify(run.msg)}; /help ${n} -> ${JSON.stringify(help.msg)}`);
    if (!ok) bad++;
  }
  const tp = await pg.evaluate(() => BF.commands.execute("/help tp"));
  console.log((tp.ok ? "ok" : "FAIL") + " /help tp still works");
  console.log(bad || !tp.ok ? "FAIL cmd-unknown" : "PASS cmd-unknown");
};

// @ci integration suite=world timeout=300
// The realistic look's smooth farm animals (1.6, js/real/creatures.js): with ?look=real&creatures=a|b a pig, cow, sheep, chicken and
// horse are drawn with smooth models that keep the box model's part names and pivots (so js/mobview.js animates them unchanged), a
// horse's saddle still follows partVis, a shorn sheep gets its own model; without the parameter the boxes are drawn as before.
// node test/real-creatures.js
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const lib = require('./lib');
const root = path.resolve(__dirname, '..');
(async () => {
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? 'ok ' : 'FAIL ') + what); if (!ok) bad++; };
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const open = async q => {
    const pg = await b.newPage({ viewport: { width: 480, height: 300 } });
    pg.on('console', m => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) { console.log('FAIL console.error: ' + m.text()); bad++; } });
    pg.on('pageerror', e => { console.log('PAGEERROR', e.stack || e.message); bad++; });
    await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
    await pg.route('https://fonts.**', r => r.abort());
    await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
    await pg.goto('file://' + path.join(root, 'index.html') + '?nolod&look=real' + q + '#seed123gen4v10');
    await lib.ready(pg);
    await pg.waitForTimeout(3000);
    await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = 'creative'; });
    return pg;
  };
  const TYPES = ['pig', 'cow', 'sheep', 'chicken', 'horse'];
  const spawnAll = async pg => {
    await pg.evaluate(T => { const p = BF.player.position; window.__m = T.map((t, i) => BF.mobs.spawn(t, p.x + 2 + i * 1.5, p.y, p.z + 2)); }, TYPES);
    await pg.waitForFunction(() => window.__m.every(m => BF.mobView.viewOf(m)), null, { timeout: 30000 });
    await pg.waitForTimeout(500);
    return pg.evaluate(() => window.__m.map(m => {
      const v = BF.mobView.viewOf(m), o = {};
      for (const k in v.meshes) { const g = v.meshes[k].geometry, p = v.meshes[k].position; o[k] = { smooth: !!g.index, nrm: !!g.attributes.normal, n: g.attributes.position.count, at: [p.x, p.y, p.z].map(x => +x.toFixed(4)), vis: v.meshes[k].visible }; }
      return o;
    }));
  };
  const boxes = await (async () => { const pg = await open(''); const r = await spawnAll(pg); await pg.close(); return r; })();
  check(boxes.every(o => Object.values(o).every(p => !p.smooth)), 'without ?creatures the animals are the box models');
  for (const style of ['a', 'b']) {
    const pg = await open('&creatures=' + style);
    const got = await spawnAll(pg);
    TYPES.forEach((t, i) => {
      const A = boxes[i], B = got[i], names = Object.keys(A).sort().join(), same = names === Object.keys(B).sort().join();
      check(same, style + ' ' + t + ': the same parts as the box model (' + names + ')');
      check(same && Object.keys(A).every(k => B[k].smooth && B[k].nrm && B[k].n > 20), style + ' ' + t + ': every part is a smooth, lit mesh');
      check(same && Object.keys(A).every(k => A[k].at.join() === B[k].at.join()), style + ' ' + t + ': every part hangs from the box model\'s pivot');
      check(same && Object.keys(A).every(k => A[k].vis === B[k].vis), style + ' ' + t + ': parts shown and hidden as on the box model');
    });
    // a saddle follows partVis; a shorn sheep is rebuilt with its own model
    const more = await pg.evaluate(async () => {
      const [, , sheep, , horse] = window.__m, V = BF.mobView, wait = n => new Promise(r => setTimeout(r, n));
      const woolly = V.viewOf(sheep).meshes.body.geometry.attributes.position.count;
      horse.partVis = { saddle: true }; BF.mobs.setSheepLook(sheep, true);
      await wait(1200);
      const on = V.viewOf(horse).meshes.saddle.visible, shorn = V.viewOf(sheep).meshes.body.geometry;
      horse.partVis = { saddle: false };
      await wait(1200);
      return { on, off: V.viewOf(horse).meshes.saddle.visible, woolly, shorn: shorn.attributes.position.count, smooth: !!shorn.index };
    });
    check(more.on && !more.off, style + ' horse: the saddle is shown and hidden by partVis');
    check(more.smooth && more.shorn !== more.woolly, style + ' sheep: shorn, it is rebuilt with the shorn model');
    await pg.close();
  }
  await b.close();
  console.log(bad ? bad + ' FAILED' : 'all ok');
  process.exit(bad ? 1 : 0);
})();

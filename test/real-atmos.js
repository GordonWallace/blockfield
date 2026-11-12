// @ci integration suite=world timeout=300
// The realistic look's air and creatures (1.6, docs/REALISTIC_CONTRACT.md): js/real/atmos.js and js/real/mobs.js build and run with the
// look on (?look=real) without throwing; BF.atmos carries sensible light for noon, night and rain; the pixel sky is hidden; a mob is drawn
// with the lit material; and with the look off none of it exists and the pixel sky is drawn as in 1.5.
// NODE_PATH=$(npm root -g) node test/real-atmos.js
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const lib = require('./lib');
const root = path.resolve(__dirname, '..');
(async () => {
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? 'ok ' : 'FAIL ') + what); if (!ok) bad++; };
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const open = async look => {
    const pg = await b.newPage({ viewport: { width: 480, height: 300 } });
    pg.on('console', m => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) { console.log('FAIL console.error: ' + m.text()); bad++; } });
    pg.on('pageerror', e => { console.log('PAGEERROR', e.stack || e.message); bad++; });
    await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
    await pg.route('https://fonts.**', r => r.abort());
    await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
    await pg.goto('file://' + path.join(root, 'index.html') + '?nolod&look=' + look + '#seed123gen4v10');
    await lib.ready(pg);
    await pg.waitForTimeout(3000);
    await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = 'creative'; });
    return pg;
  };
  const frames = (pg, n) => pg.evaluate(n => new Promise(res => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : res()); f(); }), n);
  const air = pg => pg.evaluate(() => {
    const A = BF.atmos;
    return { sunY: A.sunDir.y, len: A.sunDir.length(), sun: A.sunIntensity, hemi: A.hemiIntensity, day: A.dayness, wet: A.wetness, near: A.fogNear, far: A.fogFar,
      wind: A.wind.strength, fog: A.fogColor.toArray(), stars: A.dome.material.uniforms.uStars.value, cover: A.dome.material.uniforms.uCover.value,
      lightY: BF.real.lights.sun.position.y, lightI: BF.real.lights.sun.intensity };
  });

  // ---- the look on ----
  let pg = await open('real');
  const st = await pg.evaluate(() => ({ on: BF.real.on, dome: !!(BF.atmos.dome && BF.atmos.dome.parent), cloudsHidden: !BF.sky.cloudMesh.visible, sunHidden: !BF.sky.sunMesh.parent.parent.visible,
    dead: BF.real.modules.filter(m => m.dead).map(m => m.name) }));
  check(st.on, 'the look is on with ?look=real');
  check(st.dome, 'the realistic dome is in the scene');
  check(st.cloudsHidden && st.sunHidden, 'the pixel sky (dome, sun, moon, stars, slab clouds) is hidden');
  check(st.dead.length === 0, 'no module failed: ' + JSON.stringify(st.dead));

  await pg.evaluate(() => { BF.weather.set('clear', 9999); BF.weather.intensity = 0; BF.weather.thunder = 0; BF.sky.setTime(0.25); });
  await frames(pg, 5);
  const noon = await air(pg);
  check(Math.abs(noon.len - 1) < 1e-3 && noon.sunY > 0.8, 'noon: the light comes from high up (' + noon.sunY.toFixed(2) + ')');
  check(noon.sun > 1.4 && noon.hemi > 0.4 && noon.day > 0.95, 'noon: full sun ' + noon.sun.toFixed(2) + ', sky ' + noon.hemi.toFixed(2));
  check(noon.stars < 0.01, 'noon: no stars');
  check(noon.lightI > 1.4 && noon.lightY > 100, 'noon: core.js copied it into the sun light');
  check(noon.far > noon.near && noon.near > 0, 'fog distances ' + noon.near.toFixed(0) + ' .. ' + noon.far.toFixed(0));

  await pg.evaluate(() => BF.sky.setTime(0.75));
  await frames(pg, 5);
  const night = await air(pg);
  check(night.sunY > 0.8, 'midnight: the moon lights the scene from above (' + night.sunY.toFixed(2) + ')');
  check(night.sun > 0.05 && night.sun < 1 && night.hemi < noon.hemi * 0.6, 'midnight: moonlight ' + night.sun.toFixed(2) + ', sky ' + night.hemi.toFixed(2));
  check(night.stars > 0.9, 'midnight: stars out');
  check(night.fog[0] + night.fog[1] + night.fog[2] < 0.2, 'midnight: dark haze');

  await pg.evaluate(() => { BF.sky.setTime(0.5); });
  await frames(pg, 5);
  const set = await air(pg);
  check(set.sunY >= 0.059 && set.sun < 0.6, 'sunset: the light is low and weak, never from below (' + set.sunY.toFixed(2) + ', ' + set.sun.toFixed(2) + ')');

  await pg.evaluate(() => { BF.sky.setTime(0.25); BF.weather.set('thunder', 9999); BF.weather.intensity = 1; BF.weather.thunder = 1; });
  await frames(pg, 30);
  const rain = await air(pg);
  check(rain.sun < noon.sun * 0.3 && rain.far < noon.far, 'storm: the sun is hidden (' + rain.sun.toFixed(2) + ') and the haze closes in (' + rain.far.toFixed(0) + ' < ' + noon.far.toFixed(0) + ')');
  check(rain.wind > noon.wind, 'storm: more wind (' + rain.wind.toFixed(2) + ' > ' + noon.wind.toFixed(2) + ')');
  check(rain.cover > 0.95, 'storm: overcast');
  const splash = await pg.evaluate(() => !!BF.atmos.rainMap && BF.scene.children.some(o => o.isMesh && o.material.uniforms && o.material.uniforms.uIntensity && o.material.uniforms.uSize && o.visible));
  check(splash, 'storm: splashes drawn on the rain\'s height map');

  // a mob: lit material with the cell's light, normals on its geometry, a contact shadow
  await pg.evaluate(() => { BF.weather.set('clear', 9999); BF.weather.intensity = 0; BF.weather.thunder = 0; const p = BF.player.position; window.__pig = BF.mobs.spawn('pig', p.x + 2.5, p.y, p.z + 0.5); });
  await pg.waitForFunction(() => BF.mobView.viewOf(window.__pig), null, { timeout: 30000 });
  await frames(pg, 5);
  const mob = await pg.evaluate(() => {
    const v = BF.mobView.viewOf(window.__pig), mesh = v.meshes.body;
    return { std: !!v.mat.isMeshStandardMaterial, cell: v.mat.userData.cell ? v.mat.userData.cell.value.toArray() : null, nrm: !!mesh.geometry.attributes.normal,
      blob: !!(v.blob && v.blob.visible), col: v.mat.color.r };
  });
  check(mob.std && mob.nrm, 'a mob has the lit material and normals');
  check(mob.cell && mob.cell[0] > 0.9, 'a mob under the open sky gets full sky light (' + JSON.stringify(mob.cell) + ')');
  check(mob.blob, 'a mob has its contact shadow by day');
  check(mob.col > 0.3 && mob.col <= 1, 'the mob\'s colour is its albedo, not the light level (' + mob.col.toFixed(2) + ')');
  await pg.screenshot({ path: (process.argv[2] || '/tmp/real-atmos') + '.png' });
  await pg.close();

  // ---- the look off: 1.5's drawing ----
  pg = await open('blocks');
  const off = await pg.evaluate(() => ({ on: BF.real.on, dome: !!(BF.atmos && BF.atmos.dome), clouds: BF.sky.cloudMesh.visible, sun: BF.sky.sunMesh.parent.parent.visible,
    tone: BF.renderer.toneMapping === THREE.NoToneMapping }));
  check(!off.on && !off.dome, 'with ?look=blocks nothing of the realistic air exists');
  check(off.clouds && off.sun && off.tone, 'with the look off the pixel sky is drawn');
  await pg.evaluate(() => { const p = BF.player.position; window.__pig = BF.mobs.spawn('pig', p.x + 2.5, p.y, p.z + 0.5); });
  await pg.waitForFunction(() => BF.mobView.viewOf(window.__pig), null, { timeout: 30000 });
  const mob0 = await pg.evaluate(() => { const v = BF.mobView.viewOf(window.__pig); return { basic: !!v.mat.isMeshBasicMaterial, nrm: !!v.meshes.body.geometry.attributes.normal, blob: !!v.blob }; });
  check(mob0.basic && !mob0.nrm && !mob0.blob, 'with the look off a mob is drawn as in 1.5');
  await b.close();
  console.log(bad ? 'FAILED ' + bad : 'PASS');
  process.exit(bad ? 1 : 0);
})();

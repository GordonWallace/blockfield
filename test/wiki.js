// @ci integration suite=ui
// Blockfieldpedia (wiki/): loads the wiki over HTTP as run.sh serves it, then builds every page (home, indexes, every block and item,
// every profession and mob, every article) and checks that none fails to build, every [[wiki link]] names something that exists,
// every internal link leads to a page that builds, and the generated facts are there (recipes, trades, mining times, habitats).
// NODE_PATH=$(npm root -g) node test/wiki.js
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/plain' };
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const f = path.join(root, rel);
  if (!f.startsWith(root + path.sep)) { res.writeHead(404).end(); return; }
  fs.readFile(f, (err, data) => err ? res.writeHead(404).end() : res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }).end(data));
});
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'ok ' : 'FAIL ') + msg); if (!ok) fails++; };
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await b.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  pg.on('pageerror', e => { errors.push(e.message); console.log('PAGEERROR', e.stack || e.message); });
  pg.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  const t0 = Date.now();
  await pg.goto(`http://127.0.0.1:${port}/wiki/`);
  await pg.waitForSelector('#nav a', { timeout: 60000 });
  console.log(`wiki loaded in ${Date.now() - t0} ms`);
  const r = await pg.evaluate(async () => {
    const wait = () => new Promise(res => setTimeout(res, 0));
    const go = async h => {   // villager and mob pages fetch their behaviour section: wait until it is in (#beh gets data-done)
      location.hash = h; await wait(); await wait();
      for (let i = 0; i < 100 && document.querySelector('#beh:not([data-done])'); i++) await new Promise(res => setTimeout(res, 10));
      return document.getElementById('main');
    };
    const main = document.getElementById('main');
    const pages = new Set(['#/', '#/items', '#/villagers', '#/mobs']);
    for (const a of document.querySelectorAll('#nav a')) pages.add(a.getAttribute('href'));
    await go('#/items');
    for (const a of main.querySelectorAll('#grid a')) pages.add(a.getAttribute('href'));
    await go('#/villagers');
    for (const a of main.querySelectorAll('.tile')) pages.add(a.getAttribute('href'));
    await go('#/mobs');
    for (const a of main.querySelectorAll('td a')) pages.add(a.getAttribute('href'));
    const bad = [], broken = [], seen = new Set(), linked = new Set();
    const visit = async h => {
      if (seen.has(h)) return;
      seen.add(h);
      const m = await go(h);
      if (/Not in version|failed to build/.test(m.querySelector('h1') ? m.querySelector('h1').textContent + m.textContent.slice(0, 400) : m.textContent)) broken.push(h);
      for (const s of m.querySelectorAll('.bad')) bad.push(h + ': ' + s.textContent);
      for (const a of m.querySelectorAll('a[href^="#/"]')) linked.add(a.getAttribute('href'));
    };
    for (const h of pages) await visit(h);
    // every link seen on the way must lead somewhere
    for (const h of [...linked]) await visit(h);
    // some generated facts, spot-checked
    const text = async h => (await go(h)).innerText;
    const iron = await text('#/item/iron_ore'), farmer = await text('#/villager/farmer'), cow = await text('#/mob/cow'), chest = await text('#/item/chest');
    const pick = await text('#/tool/pickaxe'), forest = await text('#/biome/forest');
    const absent = await text('#/item/item_from_a_later_version');   // a page another version may have
    return { pick, forest, absent, n: seen.size, bad, broken, iron, farmer, cow, chest, articles: [...document.querySelectorAll('#nav a[href^="#/page/"]')].length };
  });
  console.log(`built ${r.n} pages, ${r.articles} articles`);
  check(r.articles >= 20, `articles listed (${r.articles})`);
  check(r.n > 500, `pages built (${r.n})`);
  check(!r.broken.length, `no page fails or is missing${r.broken.length ? ': ' + r.broken.slice(0, 20).join(', ') : ''}`);
  check(!r.bad.length, `every wiki link names something that exists${r.bad.length ? ': ' + r.bad.slice(0, 20).join('; ') : ''}`);
  check(/Stone pickaxe/.test(r.iron) && /Raw Iron/.test(r.iron) && /Iron Ingot/.test(r.iron), 'iron ore: mining table, drop and smelting');
  check(/Composter/.test(r.farmer) && /Novice/.test(r.farmer) && /16 Wheat for 1 Emerald/.test(r.farmer), 'farmer: jobsite and trade table');
  check(/Plains/.test(r.cow) && /Raw Beef/.test(r.cow), 'cow: habitat and drops');
  check(/Crafting/.test(r.chest) && /Furniture maker/i.test(r.chest), 'chest: recipe and the villager selling it');
  check(/Golden Pickaxe/.test(r.pick) && /1561 uses/.test(r.pick) && /Obsidian/.test(r.pick), 'pickaxe page: materials compared, durability, harvest levels');
  check(/Wild animals/i.test(r.forest) && /Borders/i.test(r.forest), 'forest biome page: animals and borders');
  check(/Not in version/.test(r.absent), 'a page this version lacks says so instead of building');
  check(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 5).join('; ') : ''}`);
  console.log(fails ? `FAILED wiki (${fails})` : 'PASS wiki');
  await b.close();
  server.close();
  process.exit(fails ? 1 : 0);
});

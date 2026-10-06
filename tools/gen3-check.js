// Re-runnable checks for the mile-high generator: node tools/gen3-check.js [identity|seams|all]
//  identity: gen 1 / gen 2 output must be byte-identical to the reference revision (REF env, default 2b0411d = start of the mile-high work)
//  seams:    gen 3 generateBand / generateRange / heightAt consistency (tools/gen3-seams.js)
const fs = require("fs"), vm = require("vm"), path = require("path"), crypto = require("crypto"), cp = require("child_process");
const ROOT = path.join(__dirname, "..");
// fresh global BF from a source-provider function (file name -> source text)
function env(srcOf) {
  delete global.BF;
  global.window = global; global.THREE = {}; global.document = {};
  const load = (f, src) => vm.runInThisContext(src, { filename: f });
  load("blocks.js", srcOf("blocks.js")); load("noise.js", srcOf("noise.js"));
  BF.CS = 16; BF.H = 192; BF.SEA = 48;
  load("rivers.js", srcOf("rivers.js")); load("worldgen.js", srcOf("worldgen.js"));
  return BF;
}
const cur = f => fs.readFileSync(path.join(ROOT, "js", f), "utf8");
const REF = process.env.REF || "2b0411d";
const ref = f => cp.execFileSync("git", ["show", REF + ":js/" + f], { cwd: ROOT, maxBuffer: 1 << 26 }).toString();
const md5 = a => crypto.createHash("md5").update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest("hex");
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; if (fails < 40) console.log("FAIL:", msg); } return c; };

function hashesLegacy(srcOf, gen, seed, scale, chunks) {
  const BF = env(srcOf);
  BF.noise = BF.makeNoise(seed); BF.worldgen.init(BF.noise, { gen, biomeScale: scale });
  return chunks.map(([cx, cz]) => { const v = new Uint16Array(16 * 16 * 192); BF.worldgen.generate(cx, cz, v); return md5(v); });
}
function identity() {
  const chunks = [[0, 0], [1, 0], [-1, -1], [5, 3], [-9, 12], [30, -22], [100, 40], [-250, 130], [400, 400], [-700, -50], [13, 77], [260, -330]];
  let n = 0;
  for (const gen of [1, 2]) for (const seed of [1337, 42, 7, 90210]) for (const scale of gen === 1 ? [1] : [1, 2]) {
    const a = hashesLegacy(ref, gen, seed, scale, chunks), b = hashesLegacy(cur, gen, seed, scale, chunks);
    for (let i = 0; i < a.length; i++) { n++; ok(a[i] === b[i], `gen ${gen} seed ${seed} scale ${scale} chunk ${chunks[i]}`); }
  }
  console.log("identity: compared", n, "chunks against", REF);
}
module.exports = { env, cur, md5, ok };
if (require.main === module) {
  const what = process.argv[2] || "all";
  if (what === "identity" || what === "all") identity();
  if (what === "seams" || what === "all") require("./gen3-seams.js").run(env, cur, ok, md5);
  console.log(fails ? "FAILED " + fails : "all checks passed");
  process.exit(fails ? 1 : 0);
}

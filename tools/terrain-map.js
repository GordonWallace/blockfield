// Top-down overview map of the terrain generator, rendered in node (no browser needed).
// Usage: node tools/terrain-map.js out.png seed biomeScale centreX centreZ spanBlocks pixels [gen]
//   e.g. node tools/terrain-map.js /tmp/map.png 1337 2 0 0 30000 700
// Colours are biomes, shaded by height (>100 tinted if EL=1), rivers are drawn thicker than they are when RV=<blocks> is set (e.g. RV=14).
const fs = require("fs"), vm = require("vm"), zlib = require("zlib"), path = require("path");
const R = path.join(__dirname, "..", "js") + path.sep;
global.window = global; global.THREE = {}; global.document = {};
const load = f => vm.runInThisContext(fs.readFileSync(R + f, "utf8"), { filename: f });
load("blocks.js"); load("noise.js");
BF.CS = 16; BF.H = 192; BF.SEA = 48;
load("rivers.js"); load("worldgen.js");
const [, , out, seed, scale, cx, cz, span, px, gen] = process.argv;
BF.noise = BF.makeNoise(+seed); BF.worldgen.init(BF.noise, { gen: +(gen || 2), biomeScale: +scale });
const w = BF.worldgen;
const N=+px, S=+span/N, x0=+cx-+span/2, z0=+cz-+span/2;
const col={0:[40,70,160],1:[230,215,150],2:[235,235,220],3:[130,130,130],4:[60,120,220],5:[130,190,80],6:[50,130,40],7:[200,120,200],8:[110,170,70],9:[30,80,30],10:[80,110,60],11:[90,90,50],12:[235,210,130],13:[200,110,60],14:[180,170,70],15:[100,170,50],16:[20,150,40],17:[40,110,80],18:[30,90,70],19:[235,240,250],20:[170,220,255],21:[160,200,200],22:[150,210,120],23:[250,170,200],24:[150,150,150],25:[220,230,240],26:[255,255,255],27:[170,170,170],28:[170,100,170]};
const buf=Buffer.alloc(N*(N*3+1)); let stats={};
for(let j=0;j<N;j++){buf[j*(N*3+1)]=0;for(let i=0;i<N;i++){
 const x=Math.floor(x0+i*S),z=Math.floor(z0+j*S); const h=w.heightAt(x,z), b=w.biomeAt(x,z); const wl=w.waterLevelAt(x,z);
 let c=col[b.id]||[255,0,255]; stats[b.id]=(stats[b.id]||0)+1;
 if(b.id===0){const d=Math.max(0,Math.min(1,(48-h)/30)); c=[40-d*25,80-d*40,170-d*70];}
 else if(b.id===4){c=[70,130,230];}
 else { const hE=w.heightAt(x+Math.max(1,S|0),z+Math.max(1,S|0)); const sh=Math.max(-0.35,Math.min(0.35,(h-hE)/(S*0.9+6)*0.5)); const k=0.7+0.45*Math.max(0,Math.min(1,(h-40)/150))+sh; c=c.map(v=>Math.max(0,Math.min(255,v*k))); if(process.env.EL){ if(h>100)c=[c[0]*0.6+100,c[1]*0.6+60,c[2]*0.6+40]; } }
 if(process.env.RV && b.id!==0){ const o2={}; if(BF.rivers.at(x,z,o2) && o2.sd<(+process.env.RV)) c=[30,90,255]; }
 const o=j*(N*3+1)+1+i*3; buf[o]=c[0];buf[o+1]=c[1];buf[o+2]=c[2];}}
function crc(b){let c,t=[];for(let n=0;n<256;n++){c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0}let r=0xffffffff;for(const x of b)r=t[(r^x)&255]^(r>>>8);return(r^0xffffffff)>>>0}
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(td));return Buffer.concat([l,td,c])}
const ih=Buffer.alloc(13);ih.writeUInt32BE(N,0);ih.writeUInt32BE(N,4);ih[8]=8;ih[9]=2;
fs.writeFileSync(out,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ih),chunk('IDAT',zlib.deflateSync(buf)),chunk('IEND',Buffer.alloc(0))]));
console.log(JSON.stringify(stats), BF.rivers._debug());

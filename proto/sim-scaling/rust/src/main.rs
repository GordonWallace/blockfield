// Rust port of the sim-scaling prototype (../kernel.js and ../sim.js), written to match the JS rules and arithmetic exactly so the
// end-of-run hash can be compared with the JS one. Same two-phase tick, same regions, same dynamic region scheduling over threads.
// Usage: simscale [threads=1] [size=1024] [spacing=64] [per=16] [ticks=2000] [far=0] [seed=1] [RS=64]
use std::cell::UnsafeCell;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
// A multiply-xor hasher for the A* maps (keys are small integers); std's default SipHash is built to resist hostile keys and is slow.
// Hashing never changes results: the maps are only looked up, never iterated.
#[derive(Default)] struct Fx(u64);
impl Hasher for Fx { fn finish(&self) -> u64 { self.0 } fn write(&mut self, b: &[u8]) { for &x in b { self.0 = (self.0.rotate_left(5) ^ x as u64).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95); } }
    fn write_i64(&mut self, i: i64) { self.0 = (self.0.rotate_left(5) ^ i as u64).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95); } }
type FxMap<K, V> = HashMap<K, V, BuildHasherDefault<Fx>>;
use std::sync::atomic::{AtomicI32, AtomicUsize, Ordering::*};
use std::sync::Barrier;
use std::time::Instant;

const AIR: u16 = 0; const STONE: u16 = 1; const DIRT: u16 = 2; const GRASS: u16 = 3; const LOG: u16 = 4; const COBBLE: u16 = 5;
const SAPLING: u16 = 6; const CROP0: u16 = 10; const CROP7: u16 = 17;
const I_COBBLE: usize = 0; const I_DIRT: usize = 1; const I_LOG: usize = 2; const I_WHEAT: usize = 3; const I_SAPLING: usize = 4; const NI: usize = 5;
const MINER: i32 = 0; const WOODCUTTER: i32 = 1; const FARMER: i32 = 2; const BUILDER: i32 = 3;
const M_IDLE: i32 = 0; const M_WALK: i32 = 1; const M_WORK: i32 = 2; const M_WAIT: i32 = 3; const M_REST: i32 = 4;
const A_NONE: i32 = 0; const A_MINE: i32 = 1; const A_PLACE: i32 = 2; const A_SELL: i32 = 3; const A_BUY: i32 = 4; const A_HARVEST: i32 = 5; const A_WAGE: i32 = 6;
const PMAX: usize = 48; const CELL: i32 = 16; const CAP: usize = 96; const DT: f64 = 0.05; const SPEED: f64 = 4.0; const IREC: usize = 8;

fn solid(b: u16) -> bool { b >= STONE && b <= COBBLE }
#[inline] fn imul(a: i32, b: i32) -> i32 { a.wrapping_mul(b) }
fn hash2(a: i32, b: i32, s: i32) -> u32 {
    let mut h = imul(a, 0x27d4eb2d) ^ imul(b, 0x165667b1) ^ imul(s, 0x9e3779b1u32 as i32);
    h = imul(h ^ ((h as u32) >> 15) as i32, 0x85ebca6bu32 as i32); h = imul(h ^ ((h as u32) >> 13) as i32, 0xc2b2ae35u32 as i32);
    (h ^ ((h as u32) >> 16) as i32) as u32
}
fn vnoise(x: f64, z: f64, s: i32) -> f64 {
    let xi = x.floor(); let zi = z.floor(); let fx = x - xi; let fz = z - zi;
    let u = fx * fx * (3.0 - 2.0 * fx); let v = fz * fz * (3.0 - 2.0 * fz);
    let (xi, zi) = (xi as i32, zi as i32);
    let a = hash2(xi, zi, s) as f64 / 4294967296.0; let b = hash2(xi + 1, zi, s) as f64 / 4294967296.0;
    let c = hash2(xi, zi + 1, s) as f64 / 4294967296.0; let d = hash2(xi + 1, zi + 1, s) as f64 / 4294967296.0;
    a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}
fn height(x: i32, z: i32) -> i32 { 24 + (10.0 * vnoise(x as f64 / 48.0, z as f64 / 48.0, 1) + 4.0 * vnoise(x as f64 / 16.0, z as f64 / 16.0, 2)).floor() as i32 }
fn js_round(x: f64) -> f64 { let r = x.floor(); if x - r >= 0.5 { r + 1.0 } else { r } }

// Shared array: plain loads and stores from any thread. Safe here for the same reason the JS SharedArrayBuffer version is:
// in each phase every slot has one writer and nobody reads a slot that is being written.
struct Sh<T: Copy>(Box<[UnsafeCell<T>]>);
unsafe impl<T: Copy> Sync for Sh<T> {}
impl<T: Copy> Sh<T> {
    fn new(n: usize, v: T) -> Self { Sh((0..n).map(|_| UnsafeCell::new(v)).collect()) }
    #[inline(always)] fn g(&self, i: usize) -> T { unsafe { *self.0.get_unchecked(i).get() } }
    #[inline(always)] fn s(&self, i: usize, v: T) { unsafe { *self.0.get_unchecked(i).get() = v } }
    fn len(&self) -> usize { self.0.len() }
}
fn atomics(n: usize) -> Vec<AtomicI32> { (0..n).map(|_| AtomicI32::new(0)).collect() }

#[derive(Clone, Copy)]
struct P { threads: usize, size: i32, h: i32, spacing: i32, per: usize, ticks: usize, far: f64, seed: i32, rs: i32, rn: i32, villages: usize, agents: usize, nvx: i32, capr: usize, capi: usize }

struct S {
    blocks: Sh<u16>, hm: Sh<u8>, pos_x: Sh<f64>, pos_z: Sh<f64>, pos_y: Sh<i32>,
    job: Sh<i32>, vil: Sh<i32>, mode: Sh<i32>, act: Sh<i32>, act_item: Sh<i32>, tx: Sh<i32>, ty: Sh<i32>, tz: Sh<i32>,
    timer: Sh<f64>, hunger: Sh<f64>, coins: Sh<i32>, inv: Sh<i32>, rng: Sh<u32>, path_len: Sh<i32>, path_idx: Sh<i32>, path: Sh<i32>,
    site: Sh<i32>, last_chop: Sh<i32>,
    res_done: Sh<i32>, res_ok: Sh<i32>, res_item: Sh<i32>, res_qty: Sh<i32>, res_coins: Sh<i32>, res_item2: Sh<i32>, res_qty2: Sh<i32>,
    vil_x: Sh<i32>, vil_z: Sh<i32>, chest_inv: Sh<i32>, chest_coins: Sh<i32>,
    grid_n: Vec<AtomicI32>, grid_ids: Sh<i32>,
    r_n: Sh<i32>, r_list: Sh<i32>, r_in_n: Vec<AtomicI32>, r_in: Sh<i32>, r_int_n: Vec<AtomicI32>, r_int: Sh<i32>,
}
impl S {
    fn new(p: &P) -> S {
        let n = p.agents; let v = p.villages; let r = (p.rn * p.rn) as usize; let cells = ((p.size / CELL) * (p.size / CELL)) as usize;
        S {
            blocks: Sh::new((p.size as usize) * (p.size as usize) * p.h as usize, 0), hm: Sh::new((p.size * p.size) as usize, 0),
            pos_x: Sh::new(2 * n, 0.0), pos_z: Sh::new(2 * n, 0.0), pos_y: Sh::new(2 * n, 0),
            job: Sh::new(n, 0), vil: Sh::new(n, 0), mode: Sh::new(n, 0), act: Sh::new(n, 0), act_item: Sh::new(n, 0),
            tx: Sh::new(n, 0), ty: Sh::new(n, 0), tz: Sh::new(n, 0), timer: Sh::new(n, 0.0), hunger: Sh::new(n, 0.0), coins: Sh::new(n, 0),
            inv: Sh::new(n * NI, 0), rng: Sh::new(n, 0), path_len: Sh::new(n, 0), path_idx: Sh::new(n, 0), path: Sh::new(n * PMAX * 2, 0),
            site: Sh::new(n * 4, 0), last_chop: Sh::new(n * 2, 0),
            res_done: Sh::new(n, 0), res_ok: Sh::new(n, 0), res_item: Sh::new(n, 0), res_qty: Sh::new(n, 0), res_coins: Sh::new(n, 0), res_item2: Sh::new(n, 0), res_qty2: Sh::new(n, 0),
            vil_x: Sh::new(v, 0), vil_z: Sh::new(v, 0), chest_inv: Sh::new(v * NI, 0), chest_coins: Sh::new(v, 0),
            grid_n: atomics(2 * cells), grid_ids: Sh::new(2 * cells * CAP, 0),
            r_n: Sh::new(r, 0), r_list: Sh::new(r * p.capr, 0), r_in_n: atomics(r), r_in: Sh::new(r * p.capr, 0), r_int_n: atomics(r), r_int: Sh::new(r * p.capi * IREC, 0),
        }
    }
}

#[derive(Default, Clone, Copy)]
struct Stats { astar: u64, nodes: u64, intents: u64, cross: u64, fail: u64, migr: u64, overflow: u64, scans: u64, busy_a: f64, busy_b: f64, wait: f64 }

struct C<'a> { p: P, s: &'a S, tick: usize, region: i32, heap_k: Vec<i64>, heap_f: Vec<f64>, from: FxMap<i64, i64>, gcost: FxMap<i64, f64>, st: Stats }

fn village_of(p: &P, gx: i32, gz: i32) -> (i32, i32) {
    let sp = p.spacing; let j = sp / 4;
    (gx * sp + sp / 2 + (hash2(gx, gz, 7) % j as u32) as i32 - j / 2, gz * sp + sp / 2 + (hash2(gx, gz, 8) % j as u32) as i32 - j / 2)
}
fn gen_column(p: &P, s: &S, x: i32, z: i32) {
    let h = height(x, z); let base = ((x * p.size + z) * p.h) as usize;
    for y in 0..p.h { s.blocks.s(base + y as usize, if y < h - 3 { STONE } else if y < h - 1 { DIRT } else if y < h { GRASS } else { AIR }); }
    let gx = x.div_euclid(p.spacing); let gz = z.div_euclid(p.spacing); let (vx, vz) = village_of(p, gx, gz);
    let d = (x - vx).abs().max((z - vz).abs());
    let mut top = h;
    if x - vx >= 4 && x - vx < 10 && z - vz >= -3 && z - vz < 3 { s.blocks.s(base + h as usize, CROP0 + (hash2(x, z, 3) & 7) as u16); top = h + 1; }
    else if d > 14 && hash2(x, z, 5) % 61 == 0 { for y in h..h + 4 { s.blocks.s(base + y as usize, LOG); } top = h + 4; }
    s.hm.s((x * p.size + z) as usize, top as u8);
}
#[inline] fn bidx(p: &P, x: i32, y: i32, z: i32) -> usize { ((x * p.size + z) * p.h + y) as usize }
#[inline] fn get_b(p: &P, s: &S, x: i32, y: i32, z: i32) -> u16 {
    if x < 0 || z < 0 || x >= p.size || z >= p.size || y < 0 { return STONE; }
    if y >= p.h { return AIR; }
    s.blocks.g(bidx(p, x, y, z))
}
#[inline] fn hm_at(p: &P, s: &S, x: i32, z: i32) -> i32 { s.hm.g((x * p.size + z) as usize) as i32 }
fn stand_at(p: &P, s: &S, x: i32, z: i32, y: i32) -> i32 {
    let mut dy = 1;
    while dy >= -3 {
        let ny = y + dy;
        if solid(get_b(p, s, x, ny - 1, z)) && !solid(get_b(p, s, x, ny, z)) && !solid(get_b(p, s, x, ny + 1, z)) {
            if dy > 0 && solid(get_b(p, s, x, y + 2, z)) { return -1; }
            if dy < 0 && solid(get_b(p, s, x, y + 1, z)) { dy -= 1; continue; }
            return ny;
        }
        dy -= 1;
    }
    -1
}
#[inline] fn region_of(p: &P, x: i32, z: i32) -> i32 { x.div_euclid(p.rs) * p.rn + z.div_euclid(p.rs) }
fn rnd(s: &S, i: usize) -> f64 { let mut x = s.rng.g(i); x ^= x << 13; x ^= x >> 17; x ^= x << 5; s.rng.s(i, x); x as f64 / 4294967296.0 }

impl<'a> C<'a> {
    fn cur(&self) -> usize { self.tick & 1 }
    fn astar(&mut self, i: usize, sx: i32, sy: i32, sz: i32, gx: i32, gz: i32, near: bool, max_nodes: usize) -> bool {
        let p = self.p; let s = self.s; let sz_ = p.size as i64;
        self.from.clear(); self.gcost.clear();
        let mut hn: usize = 0;
        let key = |x: i32, z: i32, y: i32| -> i64 { (x as i64 * sz_ + z as i64) * 64 + y as i64 };
        let k0 = key(sx, sz, sy);
        self.from.insert(k0, -1); self.gcost.insert(k0, 0.0);
        push(&mut self.heap_k, &mut self.heap_f, &mut hn, k0, ((sx - gx).abs() + (sz - gz).abs()) as f64);
        self.st.astar += 1;
        let mut n = 0;
        while hn > 0 && n < max_nodes {
            if hn > 8000 { break; }
            let k = pop(&mut self.heap_k, &mut self.heap_f, &mut hn);
            let y = (k & 63) as i32; let xz = (k - y as i64) / 64; let x = (xz / sz_) as i32; let z = (xz - x as i64 * sz_) as i32;
            let g = self.gcost[&k];
            self.st.nodes += 1;
            let dx0 = (x - gx).abs(); let dz0 = (z - gz).abs();
            if if near { dx0 <= 1 && dz0 <= 1 && (dx0 | dz0) != 0 } else { dx0 == 0 && dz0 == 0 } {
                let mut len = 0; let mut c = k;
                while c != k0 { len += 1; c = self.from[&c]; }
                let l = len.min(PMAX); let base = i * PMAX * 2; let mut c = k;
                let mut st = len;
                while st > 0 {
                    if st <= l { let cxz = c / 64; let cx = cxz / sz_; s.path.s(base + (st - 1) * 2, cx as i32); s.path.s(base + (st - 1) * 2 + 1, (cxz - cx * sz_) as i32); }
                    c = self.from[&c]; st -= 1;
                }
                s.path_len.s(i, l as i32); s.path_idx.s(i, 0);
                return true;
            }
            for d in 0..4 {
                let nx = x + if d == 0 { 1 } else if d == 1 { -1 } else { 0 }; let nz = z + if d == 2 { 1 } else if d == 3 { -1 } else { 0 };
                if nx < 0 || nz < 0 || nx >= p.size || nz >= p.size { continue; }
                let ny = stand_at(&p, s, nx, nz, y);
                if ny < 0 { continue; }
                let nk = key(nx, nz, ny); let ng = g + 1.0 + if ny != y { 0.5 } else { 0.0 };
                if let Some(&old) = self.gcost.get(&nk) { if old <= ng { continue; } }
                self.gcost.insert(nk, ng); self.from.insert(nk, k);
                push(&mut self.heap_k, &mut self.heap_f, &mut hn, nk, ng + ((nx - gx).abs() + (nz - gz).abs()) as f64);
            }
            n += 1;
        }
        false
    }
    fn intent(&mut self, typ: i32, i: usize, x: i32, y: i32, z: i32, item: i32, qty: i32) {
        let p = self.p; let s = self.s;
        let r = if typ == A_SELL || typ == A_BUY || typ == A_WAGE { region_of(&p, s.vil_x.g(x as usize), s.vil_z.g(x as usize)) } else { region_of(&p, x, z) };
        let n = s.r_int_n[r as usize].fetch_add(1, Relaxed) as usize;
        if n >= p.capi { panic!("region intent inbox full"); }
        let o = (r as usize * p.capi + n) * IREC;
        for (k, v) in [typ, r, i as i32, x, y, z, item, qty].iter().enumerate() { s.r_int.s(o + k, *v); }
        s.mode.s(i, M_WAIT); self.st.intents += 1;
        if r != self.region { self.st.cross += 1; }
    }
    fn decide(&mut self, i: usize) {
        let p = self.p; let s = self.s; let n = p.agents; let c = self.cur(); let v = s.vil.g(i) as usize;
        let x = s.pos_x.g(c * n + i).floor() as i32; let z = s.pos_z.g(c * n + i).floor() as i32; let y = s.pos_y.g(c * n + i);
        let ib = i * NI; let vx = s.vil_x.g(v); let vz = s.vil_z.g(v);
        s.act.s(i, A_NONE);
        if s.hunger.g(i) > 1.0 {
            if s.inv.g(ib + I_WHEAT) > 0 { s.inv.s(ib + I_WHEAT, s.inv.g(ib + I_WHEAT) - 1); s.hunger.s(i, 0.0); }
            else if s.coins.g(i) >= 4 && s.chest_inv.g(v * NI + I_WHEAT) >= 2 { return self.go_chest(i, x, y, z, A_BUY, I_WHEAT as i32, 2); }
        }
        match s.job.g(i) {
            MINER => {
                if s.inv.g(ib + I_COBBLE) >= 16 { return self.go_chest(i, x, y, z, A_SELL, I_COBBLE as i32, s.inv.g(ib + I_COBBLE)); }
                if s.inv.g(ib + I_DIRT) >= 8 { return self.go_chest(i, x, y, z, A_SELL, I_DIRT as i32, s.inv.g(ib + I_DIRT)); }
                let mut best: i64 = -1; let mut bx = 0; let mut bz = 0;
                for qx in vx - 10..=vx + 10 { for qz in vz + 8..=vz + 22 {
                    if qx < 0 || qz < 0 || qx >= p.size || qz >= p.size { continue; }
                    let t = hm_at(&p, s, qx, qz) - 1; let b = get_b(&p, s, qx, t, qz);
                    if b != STONE && b != DIRT && b != GRASS { continue; }
                    let score = t as i64 * 64 + (hash2(qx, qz, s.rng.g(i) as i32) & 63) as i64;
                    if score > best { best = score; bx = qx; bz = qz; }
                } }
                self.st.scans += 1;
                if best < 0 { return self.wander(i, x, y, z, vx, vz); }
                self.go_near(i, x, y, z, bx, bz, A_MINE, 0, 1.0, false)
            }
            WOODCUTTER => {
                if s.inv.g(ib + I_LOG) >= 12 { return self.go_chest(i, x, y, z, A_SELL, I_LOG as i32, s.inv.g(ib + I_LOG)); }
                if s.inv.g(ib + I_SAPLING) > 0 && s.last_chop.g(i * 2) >= 0 {
                    let lx = s.last_chop.g(i * 2); let lz = s.last_chop.g(i * 2 + 1); let t = hm_at(&p, s, lx, lz);
                    if get_b(&p, s, lx, t - 1, lz) == GRASS || get_b(&p, s, lx, t - 1, lz) == DIRT { s.act_item.s(i, I_SAPLING as i32); return self.go_near(i, x, y, z, lx, lz, A_PLACE, I_SAPLING as i32, 0.5, false); }
                    s.last_chop.s(i * 2, -1);
                }
                let mut bd = 1_000_000_000i64; let mut bx = -1; let mut bz = 0;
                for qx in vx - 22..=vx + 22 { for qz in vz - 22..=vz + 22 {
                    if qx < 0 || qz < 0 || qx >= p.size || qz >= p.size { continue; }
                    if get_b(&p, s, qx, hm_at(&p, s, qx, qz) - 1, qz) != LOG { continue; }
                    let d = ((qx - x).abs() + (qz - z).abs()) as i64 + (hash2(qx, qz, s.rng.g(i) as i32) & 7) as i64;
                    if d < bd { bd = d; bx = qx; bz = qz; }
                } }
                self.st.scans += 1;
                if bx < 0 { return self.wander(i, x, y, z, vx, vz); }
                self.go_near(i, x, y, z, bx, bz, A_MINE, 0, 1.5, false)
            }
            FARMER => {
                if s.inv.g(ib + I_WHEAT) >= 10 { return self.go_chest(i, x, y, z, A_SELL, I_WHEAT as i32, s.inv.g(ib + I_WHEAT) - 2); }
                let mut bd = 1_000_000_000i64; let mut bx = -1; let mut bz = 0;
                for qx in vx + 4..vx + 10 { for qz in vz - 3..vz + 3 {
                    if get_b(&p, s, qx, hm_at(&p, s, qx, qz) - 1, qz) != CROP7 { continue; }
                    let d = ((qx - x).abs() + (qz - z).abs()) as i64 + (hash2(qx, qz, s.rng.g(i) as i32) & 3) as i64;
                    if d < bd { bd = d; bx = qx; bz = qz; }
                } }
                if bx < 0 { return self.wander(i, x, y, z, vx + 7, vz); }
                self.go_near(i, x, y, z, bx, bz, A_HARVEST, 0, 0.5, false)
            }
            _ => {
                let mat = if s.inv.g(ib + I_COBBLE) > 0 { I_COBBLE as i32 } else if s.inv.g(ib + I_DIRT) > 0 { I_DIRT as i32 } else if s.inv.g(ib + I_LOG) > 0 { I_LOG as i32 } else { -1 };
                if mat < 0 {
                    let ci = v * NI;
                    let want = if s.chest_inv.g(ci + I_COBBLE) >= 8 { I_COBBLE as i32 } else if s.chest_inv.g(ci + I_DIRT) >= 8 { I_DIRT as i32 } else if s.chest_inv.g(ci + I_LOG) >= 8 { I_LOG as i32 } else { -1 };
                    if want < 0 || s.coins.g(i) < 8 { return self.wander(i, x, y, z, vx, vz); }
                    return self.go_chest(i, x, y, z, A_BUY, want, 8);
                }
                let sb = i * 4;
                if s.site.g(sb) < 0 { self.new_site(i); }
                for _ in 0..2 {
                    let sx = s.site.g(sb); let sz = s.site.g(sb + 1); let sy = s.site.g(sb + 2);
                    for h in 0..3 { for k in 0..8 {
                        let cx = sx + k;
                        if cx >= p.size || get_b(&p, s, cx, sy + h, sz) != AIR { continue; }
                        if h > 0 && !solid(get_b(&p, s, cx, sy + h - 1, sz)) { continue; }
                        s.tx.s(i, cx); s.ty.s(i, sy + h); s.tz.s(i, sz);
                        return self.go_near(i, x, y, z, cx, sz, A_PLACE, mat, 0.5, true);
                    } }
                    self.new_site(i);
                }
                self.wander(i, x, y, z, vx, vz)
            }
        }
    }
    fn new_site(&mut self, i: usize) {
        let p = self.p; let s = self.s; let v = s.vil.g(i) as usize; let sb = i * 4; let k = s.site.g(sb + 3) + 1; s.site.s(sb + 3, k);
        let sx = (p.size - 9).min(0.max(s.vil_x.g(v) - 24 + (hash2(i as i32, k, 11) % 40) as i32));
        let sz = (p.size - 1).min(0.max(s.vil_z.g(v) - 24 + (hash2(i as i32, k, 12) % 30) as i32));
        s.site.s(sb, sx); s.site.s(sb + 1, sz); s.site.s(sb + 2, hm_at(&p, s, sx, sz));
    }
    fn rest(&mut self, i: usize, t: f64) { self.s.mode.s(i, M_REST); self.s.timer.s(i, t); }
    fn go_chest(&mut self, i: usize, x: i32, y: i32, z: i32, act: i32, item: i32, qty: i32) {
        let s = self.s; let v = s.vil.g(i) as usize;
        s.act.s(i, act); s.act_item.s(i, item); s.tx.s(i, qty);
        if (x - s.vil_x.g(v)).abs() <= 1 && (z - s.vil_z.g(v)).abs() <= 1 { return self.intent(act, i, v as i32, 0, 0, item, qty); }
        if !self.astar(i, x, y, z, s.vil_x.g(v), s.vil_z.g(v), true, 1500) { self.st.fail += 1; return self.rest(i, 2.0); }
        s.mode.s(i, M_WALK); s.timer.s(i, 0.0);
    }
    fn go_near(&mut self, i: usize, x: i32, y: i32, z: i32, bx: i32, bz: i32, act: i32, item: i32, work: f64, keep_t: bool) {
        let p = self.p; let s = self.s;
        s.act.s(i, act); s.act_item.s(i, item); s.timer.s(i, work);
        if !keep_t { s.tx.s(i, bx); s.tz.s(i, bz); s.ty.s(i, hm_at(&p, s, bx, bz) - if act == A_PLACE { 0 } else { 1 }); }
        if (x - bx).abs() <= 1 && (z - bz).abs() <= 1 && (x != bx || z != bz) { s.path_len.s(i, 0); s.path_idx.s(i, 0); s.mode.s(i, M_WORK); return; }
        if !self.astar(i, x, y, z, bx, bz, true, 1500) { self.st.fail += 1; return self.rest(i, 2.0); }
        s.mode.s(i, M_WALK);
    }
    fn wander(&mut self, i: usize, x: i32, y: i32, z: i32, cx: i32, cz: i32) {
        let p = self.p; let s = self.s;
        let tx = (p.size - 1).min(0.max(cx + (rnd(s, i) * 13.0).floor() as i32 - 6)); let tz = (p.size - 1).min(0.max(cz + (rnd(s, i) * 13.0).floor() as i32 - 6));
        s.act.s(i, A_NONE);
        if !self.astar(i, x, y, z, tx, tz, false, 400) { let t = 1.0 + rnd(s, i) * 3.0; return self.rest(i, t); }
        s.mode.s(i, M_WALK);
    }
    fn arrive(&mut self, i: usize) {
        let s = self.s; let n = self.p.agents; let c = self.cur();
        let x = s.pos_x.g(c * n + i).floor() as i32; let z = s.pos_z.g(c * n + i).floor() as i32;
        let a = s.act.g(i);
        if a == A_NONE { let t = 0.5 + rnd(s, i) * 2.0; return self.rest(i, t); }
        if a == A_SELL || a == A_BUY { return self.intent(a, i, s.vil.g(i), 0, 0, s.act_item.g(i), s.tx.g(i)); }
        if (x - s.tx.g(i)).abs() > 1 || (z - s.tz.g(i)).abs() > 1 { s.mode.s(i, M_IDLE); return; }
        s.mode.s(i, M_WORK);
    }
    fn apply_result(&mut self, i: usize) {
        let s = self.s; let ib = i * NI;
        s.res_done.s(i, 0);
        if s.res_ok.g(i) == 0 { let t = 2.0 + rnd(s, i) * 2.0; return self.rest(i, t); }
        if s.res_qty.g(i) != 0 { let k = ib + s.res_item.g(i) as usize; s.inv.s(k, s.inv.g(k) + s.res_qty.g(i)); }
        if s.res_qty2.g(i) != 0 { let k = ib + s.res_item2.g(i) as usize; s.inv.s(k, s.inv.g(k) + s.res_qty2.g(i)); }
        s.coins.s(i, s.coins.g(i) + s.res_coins.g(i));
        if s.act.g(i) == A_PLACE && s.job.g(i) == BUILDER { s.act.s(i, A_WAGE); return self.intent(A_WAGE, i, s.vil.g(i), 0, 0, 0, 2); }
        if s.act.g(i) == A_MINE && s.job.g(i) == WOODCUTTER {
            if s.res_item2.g(i) == I_SAPLING as i32 && s.res_qty2.g(i) != 0 { s.last_chop.s(i * 2, s.tx.g(i)); s.last_chop.s(i * 2 + 1, s.tz.g(i)); }
            else if s.res_item.g(i) == I_LOG as i32 { s.ty.s(i, s.ty.g(i) - 1); s.timer.s(i, 1.5); s.mode.s(i, M_WORK); return; }
        }
        if s.act.g(i) == A_PLACE && s.act_item.g(i) == I_SAPLING as i32 { s.last_chop.s(i * 2, -1); }
        s.mode.s(i, M_IDLE);
    }
    fn sep_push(&self, i: usize, c: usize) -> (f64, f64) {
        let p = self.p; let s = self.s; let n = p.agents; let px = s.pos_x.g(c * n + i); let pz = s.pos_z.g(c * n + i);
        let gs = (p.size / CELL) as usize; let cell = (px / CELL as f64).floor() as usize * gs + (pz / CELL as f64).floor() as usize;
        let cnt = (s.grid_n[c * gs * gs + cell].load(Relaxed) as usize).min(CAP); let base = (c * gs * gs + cell) * CAP;
        let mut fx: f64 = 0.0; let mut fz: f64 = 0.0;
        for k in 0..cnt {
            let j = s.grid_ids.g(base + k) as usize;
            if j == i { continue; }
            let dx = px - s.pos_x.g(c * n + j); let dz = pz - s.pos_z.g(c * n + j); let d2 = dx * dx + dz * dz;
            if d2 > 0.36 || d2 < 1e-9 { continue; }
            let d = d2.sqrt(); let f = (0.6 - d) / d;
            fx += js_round(dx * f * 256.0); fz += js_round(dz * f * 256.0);
        }
        (fx / 256.0 * 0.1, fz / 256.0 * 0.1)
    }
    fn update_agent(&mut self, i: usize, dt: f64) {
        let p = self.p; let s = self.s; let n = p.agents; let c = self.cur(); let nx = 1 - c;
        if s.res_done.g(i) != 0 { self.apply_result(i); }
        let mut px = s.pos_x.g(c * n + i); let mut pz = s.pos_z.g(c * n + i); let mut py = s.pos_y.g(c * n + i);
        s.hunger.s(i, s.hunger.g(i) + dt / 300.0);
        let m = s.mode.g(i);
        if m == M_IDLE { self.decide(i); }
        else if m == M_REST { s.timer.s(i, s.timer.g(i) - dt); if s.timer.g(i) <= 0.0 { s.mode.s(i, M_IDLE); } }
        else if m == M_WORK {
            s.timer.s(i, s.timer.g(i) - dt);
            if s.timer.g(i) <= 0.0 {
                let a = s.act.g(i);
                if a == A_PLACE { self.intent(A_PLACE, i, s.tx.g(i), s.ty.g(i), s.tz.g(i), s.act_item.g(i), 1); }
                else { self.intent(a, i, s.tx.g(i), s.ty.g(i), s.tz.g(i), 0, 1); }
            }
        } else if m == M_WALK {
            let mut rem = SPEED * dt; let pb = i * PMAX * 2;
            while rem > 0.0 && s.path_idx.g(i) < s.path_len.g(i) {
                let k = s.path_idx.g(i) as usize; let cx = s.path.g(pb + k * 2); let cz = s.path.g(pb + k * 2 + 1);
                let dx = cx as f64 + 0.5 - px; let dz = cz as f64 + 0.5 - pz; let d = (dx * dx + dz * dz).sqrt();
                if d <= rem {
                    let ny = stand_at(&p, s, cx, cz, py);
                    if ny < 0 { s.mode.s(i, M_IDLE); break; }
                    px = cx as f64 + 0.5; pz = cz as f64 + 0.5; py = ny; rem -= d; s.path_idx.s(i, s.path_idx.g(i) + 1);
                } else { px += dx / d * rem; pz += dz / d * rem; rem = 0.0; }
            }
            if s.mode.g(i) == M_WALK && s.path_idx.g(i) >= s.path_len.g(i) { self.arrive(i); }
            let (fx, fz) = self.sep_push(i, c);
            let qx = px + fx; let qz = pz + fz;
            if qx.floor() == px.floor() && qz.floor() == pz.floor() { px = qx; pz = qz; }
        }
        s.pos_x.s(nx * n + i, px); s.pos_z.s(nx * n + i, pz); s.pos_y.s(nx * n + i, py);
    }
    fn set_b(&self, x: i32, y: i32, z: i32, b: u16) {
        let p = self.p; let s = self.s;
        s.blocks.s(bidx(&p, x, y, z), b);
        let hi = (x * p.size + z) as usize; let cur = s.hm.g(hi) as i32;
        if b != AIR && y + 1 > cur { s.hm.s(hi, (y + 1) as u8); }
        else if b == AIR && y + 1 == cur { let mut t = y; while t > 0 && s.blocks.g(bidx(&p, x, t - 1, z)) == AIR { t -= 1; } s.hm.s(hi, t as u8); }
    }
    fn resolve(&mut self, o: usize) {
        let p = self.p; let s = self.s; let q = |k: usize| s.r_int.g(o + k);
        let typ = q(0); let i = q(2) as usize; let x = q(3); let y = q(4); let z = q(5); let item = q(6); let qty = q(7);
        s.res_ok.s(i, 0); s.res_qty.s(i, 0); s.res_qty2.s(i, 0); s.res_coins.s(i, 0); s.res_item.s(i, 0); s.res_item2.s(i, 0); s.res_done.s(i, 1);
        const PRICE: [i32; 5] = [1, 1, 1, 2, 1];
        match typ {
            A_MINE | A_HARVEST => {
                let b = get_b(&p, s, x, y, z);
                if typ == A_HARVEST { if b == CROP7 { self.set_b(x, y, z, CROP0); s.res_item.s(i, I_WHEAT as i32); s.res_qty.s(i, 2); s.res_ok.s(i, 1); } }
                else if solid(b) && y == hm_at(&p, s, x, z) - 1 {
                    self.set_b(x, y, z, AIR);
                    s.res_item.s(i, if b == STONE || b == COBBLE { I_COBBLE } else if b == LOG { I_LOG } else { I_DIRT } as i32); s.res_qty.s(i, 1); s.res_ok.s(i, 1);
                    if b == LOG && get_b(&p, s, x, y - 1, z) != LOG { s.res_item2.s(i, I_SAPLING as i32); s.res_qty2.s(i, 1); }
                }
            }
            A_PLACE => {
                let ok = get_b(&p, s, x, y, z) == AIR && s.inv.g(i * NI + item as usize) >= 1
                    && !(item == I_SAPLING as i32 && get_b(&p, s, x, y - 1, z) != GRASS && get_b(&p, s, x, y - 1, z) != DIRT);
                if ok {
                    self.set_b(x, y, z, match item as usize { I_COBBLE => COBBLE, I_DIRT => DIRT, I_LOG => LOG, _ => SAPLING });
                    s.res_item.s(i, item); s.res_qty.s(i, -1); s.res_ok.s(i, 1);
                }
            }
            A_SELL => {
                let pay = qty * PRICE[item as usize]; let xv = x as usize;
                if s.inv.g(i * NI + item as usize) >= qty && s.chest_coins.g(xv) >= pay {
                    s.chest_coins.s(xv, s.chest_coins.g(xv) - pay); let k = xv * NI + item as usize; s.chest_inv.s(k, s.chest_inv.g(k) + qty);
                    s.res_item.s(i, item); s.res_qty.s(i, -qty); s.res_coins.s(i, pay); s.res_ok.s(i, 1);
                }
            }
            A_BUY => {
                let cost = qty * PRICE[item as usize]; let xv = x as usize; let k = xv * NI + item as usize;
                if s.chest_inv.g(k) >= qty && s.coins.g(i) >= cost {
                    s.chest_inv.s(k, s.chest_inv.g(k) - qty); s.chest_coins.s(xv, s.chest_coins.g(xv) + cost);
                    s.res_item.s(i, item); s.res_qty.s(i, qty); s.res_coins.s(i, -cost); s.res_ok.s(i, 1);
                }
            }
            A_WAGE => { let xv = x as usize; if s.chest_coins.g(xv) >= qty { s.chest_coins.s(xv, s.chest_coins.g(xv) - qty); s.res_coins.s(i, qty); s.res_ok.s(i, 1); } }
            _ => {}
        }
        if s.res_ok.g(i) == 0 { self.st.fail += 1; }
    }
    fn block_ticks(&self, r: i32) {
        let p = self.p; let s = self.s; let rx = (r / p.rn) * p.rs; let rz = (r % p.rn) * p.rs; let n = (p.rs * p.rs) >> 8;
        for k in 0..n {
            let h = hash2(r, self.tick as i32, k); let x = rx + (h & (p.rs as u32 - 1)) as i32; let z = rz + ((h >> 8) & (p.rs as u32 - 1)) as i32;
            let t = hm_at(&p, s, x, z) - 1; let b = get_b(&p, s, x, t, z);
            if b >= CROP0 && b < CROP7 { self.set_b(x, t, z, b + 1); }
            else if b == SAPLING && ((h >> 16) & 7) == 0 { let mut y = t; while y < t + 4 && y < p.h { if y == t || get_b(&p, s, x, y, z) == AIR { self.set_b(x, y, z, LOG); } y += 1; } }
        }
    }
}
fn push(hk: &mut Vec<i64>, hf: &mut Vec<f64>, hn: &mut usize, k: i64, f: f64) {
    let mut j = *hn; *hn += 1;
    while j > 0 { let p = (j - 1) >> 1; if hf[p] <= f { break; } hk[j] = hk[p]; hf[j] = hf[p]; j = p; }
    hk[j] = k; hf[j] = f;
}
fn pop(hk: &mut Vec<i64>, hf: &mut Vec<f64>, hn: &mut usize) -> i64 {
    let top = hk[0]; *hn -= 1; let k = hk[*hn]; let f = hf[*hn]; let n = *hn; let mut j = 0;
    loop { let mut c = 2 * j + 1; if c >= n { break; } if c + 1 < n && hf[c + 1] < hf[c] { c += 1; } if hf[c] >= f { break; } hk[j] = hk[c]; hf[j] = hf[c]; j = c; }
    hk[j] = k; hf[j] = f; top
}

fn file(p: &P, s: &S, i: usize, par: usize, st: &mut Stats) {
    let n = p.agents; let gs = (p.size / CELL) as usize;
    let cell = (s.pos_x.g(par * n + i) / CELL as f64).floor() as usize * gs + (s.pos_z.g(par * n + i) / CELL as f64).floor() as usize;
    let k = s.grid_n[par * gs * gs + cell].fetch_add(1, Relaxed) as usize;
    if k < CAP { s.grid_ids.s((par * gs * gs + cell) * CAP + k, i as i32); } else { st.overflow += 1; }
}

fn main() {
    let a: Vec<f64> = std::env::args().skip(1).map(|x| x.parse().unwrap()).collect();
    let arg = |k: usize, d: f64| *a.get(k).unwrap_or(&d);
    let size = arg(1, 1024.0) as i32; let spacing = arg(2, 64.0) as i32; let rs = arg(7, 64.0) as i32; let per = arg(3, 16.0) as usize;
    let villages = ((size / spacing) * (size / spacing)) as usize;
    let p = P { threads: arg(0, 1.0) as usize, size, h: 64, spacing, per, ticks: arg(4, 2000.0) as usize, far: arg(5, 0.0), seed: arg(6, 1.0) as i32,
        rs, rn: size / rs, villages, agents: villages * per, nvx: size / spacing, capr: 2048, capi: 1024 };
    let s = S::new(&p);
    let t0 = Instant::now();
    // villagers (as sim.js initAgents)
    let mut i = 0usize;
    for gx in 0..p.nvx { for gz in 0..p.nvx {
        let v = (gx * p.nvx + gz) as usize; let (vx, vz) = village_of(&p, gx, gz);
        s.vil_x.s(v, vx); s.vil_z.s(v, vz); s.chest_coins.s(v, 5000); s.chest_inv.s(v * NI + I_WHEAT, 32); s.chest_inv.s(v * NI + I_COBBLE, 16);
        for k in 0..p.per {
            let x = vx - 3 + (hash2(i as i32, 1, p.seed) % 7) as i32; let z = vz - 3 + (hash2(i as i32, 2, p.seed) % 7) as i32;
            s.pos_x.s(i, x as f64 + 0.5); s.pos_z.s(i, z as f64 + 0.5); s.pos_y.s(i, height(x, z));
            s.job.s(i, (k % 4) as i32); s.vil.s(i, v as i32); s.mode.s(i, M_IDLE); s.coins.s(i, 50); s.rng.s(i, hash2(i as i32, 99, p.seed) | 1);
            s.hunger.s(i, (hash2(i as i32, 3, p.seed) % 1000) as f64 / 1000.0); s.site.s(i * 4, -1); s.last_chop.s(i * 2, -1);
            i += 1;
        }
    } }
    let r_total = (p.rn * p.rn) as usize;
    let regions_xz = |r: usize| ((r as i32 / p.rn) * p.rs, (r as i32 % p.rn) * p.rs);
    // world generation, regions split over threads
    let next = AtomicUsize::new(0);
    std::thread::scope(|sc| { for _ in 0..p.threads { sc.spawn(|| loop {
        let r = next.fetch_add(1, Relaxed); if r >= r_total { break; }
        let (rx, rz) = regions_xz(r); for x in rx..rx + p.rs { for z in rz..rz + p.rs { gen_column(&p, &s, x, z); } }
    }); } });
    let mut st0 = Stats::default();
    for i in 0..p.agents { let r = region_of(&p, s.pos_x.g(i).floor() as i32, s.pos_z.g(i).floor() as i32) as usize; let k = s.r_n.g(r) as usize; s.r_list.s(r * p.capr + k, i as i32); s.r_n.s(r, (k + 1) as i32); file(&p, &s, i, 0, &mut st0); }
    let before = census(&p, &s);
    eprintln!("gen {} ms, {} villagers, {} threads", t0.elapsed().as_millis(), p.agents, p.threads);
    let ca = AtomicUsize::new(0); let cb = AtomicUsize::new(0); let bar = Barrier::new(p.threads);
    let gs = (p.size / CELL) as usize; let far2 = p.far * p.far; let mid = p.size as f64 / 2.0;
    let t1 = Instant::now();
    let stats: Vec<Stats> = std::thread::scope(|sc| {
        let hs: Vec<_> = (0..p.threads).map(|w| { let (s, ca, cb, bar) = (&s, &ca, &cb, &bar); sc.spawn(move || {
            let mut c = C { p, s, tick: 0, region: 0, heap_k: vec![0; 8192], heap_f: vec![0.0; 8192], from: FxMap::default(), gcost: FxMap::default(), st: Stats::default() };
            let mut picked: Vec<usize> = Vec::new();
            for t in 0..p.ticks {
                c.tick = t; let cu = t & 1; let nx = 1 - cu; let n = p.agents;
                let a0 = Instant::now();
                if w == 0 { cb.store(0, Relaxed); }
                loop {
                    let r = ca.fetch_add(1, Relaxed); if r >= r_total { break; }
                    c.region = r as i32; let l = r * p.capr;
                    let m = s.r_in_n[r].load(Relaxed) as usize; let mut rn = s.r_n.g(r) as usize;
                    for k in 0..m { s.r_list.s(l + rn, s.r_in.g(l + k)); rn += 1; }
                    s.r_n.s(r, rn as i32); s.r_in_n[r].store(0, Relaxed);
                    let (rx, rz) = regions_xz(r);
                    let mut x = rx; while x < rx + p.rs { let mut z = rz; while z < rz + p.rs { s.grid_n[nx * gs * gs + (x / CELL) as usize * gs + (z / CELL) as usize].store(0, Relaxed); z += CELL; } x += CELL; }
                    for k in 0..rn {
                        let i = s.r_list.g(l + k) as usize;
                        if far2 > 0.0 {
                            let dx = s.pos_x.g(cu * n + i) - mid; let dz = s.pos_z.g(cu * n + i) - mid;
                            if dx * dx + dz * dz > far2 {
                                if (t + i) & 3 != 0 { s.pos_x.s(nx * n + i, s.pos_x.g(cu * n + i)); s.pos_z.s(nx * n + i, s.pos_z.g(cu * n + i)); s.pos_y.s(nx * n + i, s.pos_y.g(cu * n + i)); continue; }
                                c.update_agent(i, DT * 4.0); continue;
                            }
                        }
                        c.update_agent(i, DT);
                    }
                }
                c.st.busy_a += a0.elapsed().as_secs_f64() * 1000.0;
                let wt = Instant::now(); bar.wait(); c.st.wait += wt.elapsed().as_secs_f64() * 1000.0;
                let b0 = Instant::now();
                if w == 0 { ca.store(0, Relaxed); }
                loop {
                    let r = cb.fetch_add(1, Relaxed); if r >= r_total { break; }
                    c.region = r as i32;
                    let m = s.r_int_n[r].load(Relaxed) as usize;
                    if m > 0 {
                        picked.clear(); for k in 0..m { picked.push((r * p.capi + k) * IREC); }
                        picked.sort_by_key(|&o| s.r_int.g(o + 2));
                        for &o in &picked { c.resolve(o); }
                        s.r_int_n[r].store(0, Relaxed);
                    }
                    c.block_ticks(r as i32);
                    let l = r * p.capr; let mut keep = 0usize;
                    for k in 0..s.r_n.g(r) as usize {
                        let i = s.r_list.g(l + k) as usize;
                        file(&p, s, i, nx, &mut c.st);
                        let r2 = region_of(&p, s.pos_x.g(nx * n + i).floor() as i32, s.pos_z.g(nx * n + i).floor() as i32) as usize;
                        if r2 == r { s.r_list.s(l + keep, i as i32); keep += 1; }
                        else { let q = s.r_in_n[r2].fetch_add(1, Relaxed) as usize; s.r_in.s(r2 * p.capr + q, i as i32); c.st.migr += 1; }
                    }
                    s.r_n.s(r, keep as i32);
                }
                c.st.busy_b += b0.elapsed().as_secs_f64() * 1000.0;
                let wt = Instant::now(); bar.wait(); c.st.wait += wt.elapsed().as_secs_f64() * 1000.0;
            }
            c.st
        }) }).collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let wall = t1.elapsed().as_secs_f64() * 1000.0;
    let after = census(&p, &s);
    let sum = |f: fn(&Stats) -> u64| stats.iter().map(f).sum::<u64>();
    println!("{{\"lang\":\"rust\",\"threads\":{},\"agents\":{},\"ticks\":{},\"far\":{},\"ms_per_tick\":{:.3},\"us_per_agent_tick\":{:.3},\"speed_x\":{:.1},\"busy_ms_per_tick\":{:?},\"wait_ms_per_tick\":{:?},\"astar\":{},\"astar_nodes\":{},\"intents\":{},\"cross_region_intents\":{},\"refused\":{},\"migrations\":{},\"grid_overflow\":{},\"conserved\":{{\"stone_cobble\":[{},{}],\"dirt\":[{},{}],\"coins\":[{},{}]}},\"hash\":\"{:x}\"}}",
        p.threads, p.agents, p.ticks, p.far, wall / p.ticks as f64, wall * 1000.0 / p.ticks as f64 / p.agents as f64, (p.ticks as f64 * DT) / (wall / 1000.0),
        stats.iter().map(|x| ((x.busy_a + x.busy_b) / p.ticks as f64 * 1000.0).round() / 1000.0).collect::<Vec<_>>(),
        stats.iter().map(|x| (x.wait / p.ticks as f64 * 1000.0).round() / 1000.0).collect::<Vec<_>>(),
        sum(|x| x.astar), sum(|x| x.nodes), sum(|x| x.intents), sum(|x| x.cross), sum(|x| x.fail), sum(|x| x.migr), sum(|x| x.overflow),
        before.0, after.0, before.1, after.1, before.2, after.2, state_hash(&p, &s));
}

fn census(p: &P, s: &S) -> (i64, i64, i64) {
    let (mut cob, mut dirt, mut coins) = (0i64, 0i64, 0i64);
    for k in 0..s.blocks.len() { let b = s.blocks.g(k); if b == STONE || b == COBBLE { cob += 1; } else if b == DIRT || b == GRASS { dirt += 1; } }
    for i in 0..p.agents { cob += s.inv.g(i * NI + I_COBBLE) as i64; dirt += s.inv.g(i * NI + I_DIRT) as i64; coins += s.coins.g(i) as i64; }
    for v in 0..p.villages { cob += s.chest_inv.g(v * NI + I_COBBLE) as i64; dirt += s.chest_inv.g(v * NI + I_DIRT) as i64; coins += s.chest_coins.g(v) as i64; }
    for i in 0..p.agents { if s.res_done.g(i) != 0 && s.res_ok.g(i) != 0 {
        coins += s.res_coins.g(i) as i64;
        if s.res_qty.g(i) != 0 { let q = s.res_qty.g(i) as i64; match s.res_item.g(i) as usize { I_COBBLE => cob += q, I_DIRT => dirt += q, _ => {} } }
    } }
    (cob, dirt, coins)
}
// Same mixing as sim.js stateHash (FNV-style over the same arrays in the same order; f64 positions as their two 32-bit words)
fn state_hash(p: &P, s: &S) -> u32 {
    let mut h: i32 = 0x811c9dc5u32 as i32;
    let mut mix = |v: i32| { h = imul(h ^ v, 0x01000193); };
    for k in 0..s.blocks.len() { mix(s.blocks.g(k) as i32); }
    for k in 0..s.hm.len() { mix(s.hm.g(k) as i32); }
    for k in 0..s.inv.len() { mix(s.inv.g(k)); }
    for k in 0..p.agents { mix(s.coins.g(k)); }
    for k in 0..s.chest_inv.len() { mix(s.chest_inv.g(k)); }
    for k in 0..p.villages { mix(s.chest_coins.g(k)); }
    for k in 0..p.agents { mix(s.mode.g(k)); }
    for k in 0..s.pos_x.len() { let b = s.pos_x.g(k).to_bits(); mix(b as u32 as i32); mix((b >> 32) as u32 as i32); }
    for k in 0..s.pos_z.len() { let b = s.pos_z.g(k).to_bits(); mix(b as u32 as i32); mix((b >> 32) as u32 as i32); }
    for k in 0..s.pos_y.len() { mix(s.pos_y.g(k)); }
    h as u32
}

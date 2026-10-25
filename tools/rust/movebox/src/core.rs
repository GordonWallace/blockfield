// world.moveBox (js/world.js) in Rust: per-axis box collision against a mirror of the chunks' block sections.
// The maths follows the JavaScript line by line (same f64 operations in the same order), so the results are bit-identical.
// A call returns OK, FALLBACK (the box touches a face edge's margin or a pane: JavaScript does the whole call) or MISSING (a chunk
// the mirror doesn't hold yet: JavaScript uploads it, or marks it absent, and calls again). Inputs are never changed before OK.

pub const OK: i32 = 0;
pub const FALLBACK: i32 = 1;
pub const MISSING: i32 = 2;

// io slots (f64)
pub const IO_N: usize = 40;
// in: 0 px 1 py 2 pz 3 vx 4 vy 5 vz 6 hw 7 h 8 dt 9 stepUp 10 swim 11 firm 12 high
// out: 0..2 pos, 3..5 vel, 16 onGround 17 hitX 18 hitZ 19 hitCeil 20 inWater 21 headInWater; MISSING: 24 cx 25 cz
// uploads: 30.. arguments

const SECN: usize = 4096;
const CS: i32 = 16;

enum Sec {
    Uni(u16),
    Arr(Box<[u16; SECN]>),
}

struct Chunk {
    lo: i32,
    y0: i32,
    y1: i32,
    absent: bool,
    secs: Vec<Sec>,
}

// a small open-addressing map from (cx, cz) to a chunk slot
struct Table {
    keys: Vec<i64>,
    vals: Vec<u32>,
    used: usize,
}
const EMPTY: i64 = i64::MIN;
const TOMB: i64 = i64::MIN + 1;
#[inline]
fn kkey(cx: i32, cz: i32) -> i64 {
    ((cx as i64) << 32) | (cz as u32 as i64)
}
#[inline]
fn khash(k: i64) -> usize {
    let mut h = (k as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    h ^= h >> 29;
    h as usize
}
impl Table {
    fn new() -> Table {
        Table { keys: vec![EMPTY; 1024], vals: vec![0; 1024], used: 0 }
    }
    fn get(&self, k: i64) -> Option<u32> {
        let m = self.keys.len() - 1;
        let mut i = khash(k) & m;
        loop {
            let x = self.keys[i];
            if x == k {
                return Some(self.vals[i]);
            }
            if x == EMPTY {
                return None;
            }
            i = (i + 1) & m;
        }
    }
    fn put(&mut self, k: i64, v: u32) {
        if (self.used + 1) * 2 > self.keys.len() {
            let n2 = self.keys.len() * 2;
            let old_k = std::mem::replace(&mut self.keys, vec![EMPTY; n2]);
            let old_v = std::mem::replace(&mut self.vals, vec![0; n2]);
            self.used = 0;
            for (i, &x) in old_k.iter().enumerate() {
                if x != EMPTY && x != TOMB {
                    self.put(x, old_v[i]);
                }
            }
        }
        let m = self.keys.len() - 1;
        let mut i = khash(k) & m;
        loop {
            let x = self.keys[i];
            if x == k {
                self.vals[i] = v;
                return;
            }
            if x == EMPTY || x == TOMB {
                self.keys[i] = k;
                self.vals[i] = v;
                self.used += 1;
                return;
            }
            i = (i + 1) & m;
        }
    }
    fn del(&mut self, k: i64) -> Option<u32> {
        let m = self.keys.len() - 1;
        let mut i = khash(k) & m;
        loop {
            let x = self.keys[i];
            if x == k {
                self.keys[i] = TOMB;
                return Some(self.vals[i]);
            }
            if x == EMPTY {
                return None;
            }
            i = (i + 1) & m;
        }
    }
    fn clear(&mut self) {
        for k in self.keys.iter_mut() {
            *k = EMPTY;
        }
        self.used = 0;
    }
}

pub struct World {
    pub io: [f64; IO_N],
    pub stage: Box<[u16; SECN]>,
    // block tables
    pub solid: Vec<u8>,
    pub tall: Vec<u8>,
    pub render: Vec<u8>,
    pub dynbox: Vec<u8>,
    pub nullbox: Vec<u8>,
    pub box_off: Vec<u32>,
    pub boxes: Vec<f64>,
    pub min_y: i32,
    pub h: i32,
    pub pn: i32,
    pub pw: i32,
    pub stone: u16,
    pub bedrock: u16,
    chunks: Vec<Chunk>,
    free: Vec<u32>,
    table: Table,
    last_k: i64,
    last_v: Option<u32>,
    pub calls: u64,
}

struct Hit {
    x0: f64,
    y0: f64,
    z0: f64,
    x1: f64,
    y1: f64,
    z1: f64,
    inside: bool,
}

// a chunk the mirror doesn't hold: abort the call
struct Miss(i32, i32);
// the box needs what only JavaScript has (margin cells, a pane's dynamic boxes)
enum Stop {
    Miss(Miss),
    Fallback,
}
type R<T> = Result<T, Stop>;

#[inline]
fn floor_div(a: i32, b: i32) -> i32 {
    let q = a / b;
    if (a % b != 0) && ((a < 0) != (b < 0)) {
        q - 1
    } else {
        q
    }
}

#[inline]
fn jmin(a: f64, b: f64) -> f64 {
    // Math.min for non-NaN values (-0 below +0)
    if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}
#[inline]
fn jmax(a: f64, b: f64) -> f64 {
    if a > b || (a == b && b.is_sign_negative()) {
        a
    } else {
        b
    }
}

impl World {
    pub fn new() -> World {
        World {
            io: [0.0; IO_N],
            stage: Box::new([0; SECN]),
            solid: vec![],
            tall: vec![],
            render: vec![],
            dynbox: vec![],
            nullbox: vec![],
            box_off: vec![0],
            boxes: vec![],
            min_y: -64,
            h: 3072,
            pn: 0,
            pw: 0,
            stone: 0,
            bedrock: 0,
            chunks: vec![],
            free: vec![],
            table: Table::new(),
            last_k: EMPTY,
            last_v: None,
            calls: 0,
        }
    }
    pub fn tables(&mut self, n: usize, nboxes: usize) {
        self.solid = vec![0; n];
        self.tall = vec![0; n];
        self.render = vec![0; n];
        self.dynbox = vec![0; n];
        self.nullbox = vec![0; n];
        self.box_off = vec![0; n + 1];
        self.boxes = vec![0.0; nboxes * 6];
    }

    // ---- the mirror
    fn forget_last(&mut self) {
        self.last_k = EMPTY;
        self.last_v = None;
    }
    pub fn chunk_put(&mut self, cx: i32, cz: i32, lo: i32, hi: i32, absent: bool) -> u32 {
        self.chunk_drop(cx, cz);
        let n = if absent { 0 } else { (hi - lo).max(0) as usize };
        let mut secs = Vec::with_capacity(n);
        for _ in 0..n {
            secs.push(Sec::Uni(0));
        }
        let c = Chunk { lo, y0: lo * 16, y1: hi * 16, absent, secs };
        let slot = if let Some(s) = self.free.pop() {
            self.chunks[s as usize] = c;
            s
        } else {
            self.chunks.push(c);
            (self.chunks.len() - 1) as u32
        };
        self.table.put(kkey(cx, cz), slot);
        self.forget_last();
        slot
    }
    pub fn chunk_drop(&mut self, cx: i32, cz: i32) {
        if let Some(s) = self.table.del(kkey(cx, cz)) {
            self.chunks[s as usize] = Chunk { lo: 0, y0: 0, y1: 0, absent: true, secs: vec![] };
            self.free.push(s);
        }
        self.forget_last();
    }
    pub fn drop_absent(&mut self) {
        let mut gone = vec![];
        for (i, &k) in self.table.keys.iter().enumerate() {
            if k != EMPTY && k != TOMB && self.chunks[self.table.vals[i] as usize].absent {
                gone.push(k);
            }
        }
        for k in gone {
            self.chunk_drop((k >> 32) as i32, k as i32);
        }
    }
    pub fn clear(&mut self) {
        self.table.clear();
        self.chunks.clear();
        self.free.clear();
        self.forget_last();
    }
    pub fn sec_uniform(&mut self, slot: u32, i: usize, id: u16) {
        self.chunks[slot as usize].secs[i] = Sec::Uni(id);
    }
    pub fn sec_from(&mut self, slot: u32, i: usize, data: &[u16]) {
        let mut b = Box::new([0u16; SECN]);
        b.copy_from_slice(&data[..SECN]);
        self.chunks[slot as usize].secs[i] = Sec::Arr(b);
    }
    pub fn sec_from_stage(&mut self, slot: u32, i: usize) {
        let b = self.stage.clone();
        self.chunks[slot as usize].secs[i] = Sec::Arr(b);
    }
    // one cell written (world.js secSet): si is the section index from the chunk's lo
    pub fn cell_set(&mut self, cx: i32, cz: i32, si: i32, li: usize, id: u16) {
        if let Some(s) = self.table.get(kkey(cx, cz)) {
            let c = &mut self.chunks[s as usize];
            if c.absent || si < 0 || si as usize >= c.secs.len() {
                return;
            }
            let sec = &mut c.secs[si as usize];
            match sec {
                Sec::Uni(u) => {
                    if *u == id {
                        return;
                    }
                    let mut b = Box::new([*u; SECN]);
                    b[li] = id;
                    *sec = Sec::Arr(b);
                }
                Sec::Arr(a) => a[li] = id,
            }
        }
    }
    pub fn chunk_count(&self) -> usize {
        self.table.used
    }
    pub fn mirror_bytes(&self) -> usize {
        let mut b = 0;
        for c in &self.chunks {
            for s in &c.secs {
                if let Sec::Arr(_) = s {
                    b += SECN * 2;
                }
            }
        }
        b
    }

    #[inline]
    fn chunk(&mut self, cx: i32, cz: i32) -> Result<u32, Miss> {
        let k = kkey(cx, cz);
        if k == self.last_k {
            if let Some(v) = self.last_v {
                return Ok(v);
            }
        }
        match self.table.get(k) {
            Some(v) => {
                self.last_k = k;
                self.last_v = Some(v);
                Ok(v)
            }
            None => Err(Miss(cx, cz)),
        }
    }
    // the canonical face square, or FALLBACK (a margin address: JavaScript's res() turns it)
    #[inline]
    fn in_face(&self, x: i32, z: i32) -> bool {
        let f = floor_div(x, self.pw);
        let u = x - self.pw * f - self.pn;
        let v = z - self.pn;
        f >= 0 && f < 6 && u >= 0 && u < self.pn && v >= 0 && v < self.pn
    }
    #[inline]
    fn cblock(&self, slot: u32, lx: i32, y: i32, lz: i32) -> u16 {
        let c = &self.chunks[slot as usize];
        if y < c.y0 {
            return if y < self.min_y { self.bedrock } else { self.stone };
        }
        if y >= c.y1 {
            return 0;
        }
        match &c.secs[((y >> 4) - c.lo) as usize] {
            Sec::Uni(u) => *u,
            Sec::Arr(a) => a[(((y & 15) << 8) | (lz << 4) | lx) as usize],
        }
    }
    // world.getBlock with integer coordinates
    #[inline]
    fn get_block_i(&mut self, x: i32, y: i32, z: i32) -> R<u16> {
        if y < self.min_y {
            return Ok(self.bedrock);
        }
        if y >= self.h {
            return Ok(0);
        }
        if !self.in_face(x, z) {
            return Err(Stop::Fallback);
        }
        let cx = floor_div(x, CS);
        let cz = floor_div(z, CS);
        let s = self.chunk(cx, cz).map_err(Stop::Miss)?;
        if self.chunks[s as usize].absent {
            return Ok(0);
        }
        Ok(self.cblock(s, x - cx * CS, y, z - cz * CS))
    }
    // world.getBlock with float coordinates (the bounds check comes before the floor, as in JavaScript)
    #[inline]
    fn get_block_f(&mut self, x: f64, y: f64, z: f64) -> R<u16> {
        if y < self.min_y as f64 {
            return Ok(self.bedrock);
        }
        if y >= self.h as f64 {
            return Ok(0);
        }
        self.get_block_i(x.floor() as i32, y.floor() as i32, z.floor() as i32)
    }
    // world.isSolid (integer coordinates), which also gives the block id it read
    #[inline]
    fn solid_i(&mut self, x: i32, y: i32, z: i32, high: bool) -> R<bool> {
        if y < self.min_y {
            return Ok(true);
        }
        if y >= self.h {
            return Ok(false);
        }
        if !self.in_face(x, z) {
            return Err(Stop::Fallback);
        }
        let cx = floor_div(x, CS);
        let cz = floor_div(z, CS);
        let s = self.chunk(cx, cz).map_err(Stop::Miss)?;
        if self.chunks[s as usize].absent {
            return Ok(!high);
        }
        let id = self.cblock(s, x - cx * CS, y, z - cz * CS);
        Ok(self.solid[id as usize] == 1)
    }

    // boxHit (js/world.js). axis: 0 none, 1 x, 2 y, 3 z
    fn box_hit(&mut self, px: f64, py: f64, pz: f64, hw: f64, h: f64, axis: u8, prev: f64, firm: bool, high: bool, hit_out: &mut Hit) -> R<bool> {
        hit_out.inside = false;
        let x0 = (px - hw).floor() as i32;
        let x1 = (px + hw - 1e-6).floor() as i32;
        let y0 = py.floor() as i32;
        let y1 = (py + h - 1e-6).floor() as i32;
        let z0 = (pz - hw).floor() as i32;
        let z1 = (pz + hw - 1e-6).floor() as i32;
        let mut hit = false;
        let mut y = y0 - 1;
        while y <= y1 {
            let mut z = z0;
            while z <= z1 {
                let mut x = x0;
                while x <= x1 {
                    let (cx_, cy_, cz_) = (x, y, z);
                    x += 1;
                    if cy_ < y0 {
                        let t = self.get_block_i(cx_, cy_, cz_)? as usize;
                        if self.tall[t] == 0 {
                            continue;
                        }
                    }
                    if !self.solid_i(cx_, cy_, cz_, high)? {
                        continue;
                    }
                    let bid = self.get_block_i(cx_, cy_, cz_)? as usize;
                    if self.dynbox[bid] != 0 {
                        return Err(Stop::Fallback);
                    }
                    let (xf, yf, zf) = (cx_ as f64, cy_ as f64, cz_ as f64);
                    let (b0, b1, nb) = if self.nullbox[bid] != 0 {
                        (0usize, 0usize, true)
                    } else {
                        (self.box_off[bid] as usize, self.box_off[bid + 1] as usize, false)
                    };
                    let count = if nb { 1 } else { b1 - b0 };
                    for bi in 0..count {
                        let mut ax = xf;
                        let mut ay = yf;
                        let mut az = zf;
                        let mut bx = xf + 1.0;
                        let mut by = yf + 1.0;
                        let mut bz = zf + 1.0;
                        if !nb {
                            let cb = &self.boxes[(b0 + bi) * 6..(b0 + bi) * 6 + 6];
                            ax += cb[0];
                            ay += cb[1];
                            az += cb[2];
                            bx = xf + cb[3];
                            by = yf + cb[4];
                            bz = zf + cb[5];
                            if ax >= px + hw || bx <= px - hw || ay >= py + h || by <= py || az >= pz + hw || bz <= pz - hw {
                                continue;
                            }
                        }
                        let over = match axis {
                            1 => ax < prev + hw && bx > prev - hw,
                            3 => az < prev + hw && bz > prev - hw,
                            2 => ay < prev + h && by > prev,
                            _ => false,
                        };
                        if over {
                            let qx = if axis == 1 { prev } else { px };
                            let qy = if axis == 2 { prev } else { py };
                            let qz = if axis == 3 { prev } else { pz };
                            let ox = jmin(bx, qx + hw) - jmax(ax, qx - hw);
                            let oy = jmin(by, qy + h) - jmax(ay, qy);
                            let oz = jmin(bz, qz + hw) - jmax(az, qz - hw);
                            let o = if axis == 1 { ox } else if axis == 2 { oy } else { oz };
                            let mv = (if axis == 1 { px } else if axis == 2 { py } else { pz }) - prev;
                            let mid = if axis == 1 {
                                (ax + bx) / 2.0 - prev
                            } else if axis == 2 {
                                (ay + by) / 2.0 - (prev + h / 2.0)
                            } else {
                                (az + bz) / 2.0 - prev
                            };
                            if !firm || o > jmin(jmin(ox, oy), oz) || mv * mid <= 0.0 {
                                continue;
                            }
                            hit_out.inside = true;
                        }
                        if !hit {
                            hit_out.x0 = ax;
                            hit_out.y0 = ay;
                            hit_out.z0 = az;
                            hit_out.x1 = bx;
                            hit_out.y1 = by;
                            hit_out.z1 = bz;
                            hit = true;
                            continue;
                        }
                        hit_out.x0 = jmin(hit_out.x0, ax);
                        hit_out.y0 = jmin(hit_out.y0, ay);
                        hit_out.z0 = jmin(hit_out.z0, az);
                        hit_out.x1 = jmax(hit_out.x1, bx);
                        hit_out.y1 = jmax(hit_out.y1, by);
                        hit_out.z1 = jmax(hit_out.z1, bz);
                    }
                }
                z += 1;
            }
            y += 1;
        }
        Ok(hit)
    }

    pub fn move_box(&mut self) -> i32 {
        self.calls += 1;
        match self.move_box_r() {
            Ok(()) => OK,
            Err(Stop::Fallback) => FALLBACK,
            Err(Stop::Miss(Miss(cx, cz))) => {
                self.io[24] = cx as f64;
                self.io[25] = cz as f64;
                MISSING
            }
        }
    }

    fn move_box_r(&mut self) -> R<()> {
        let io = self.io;
        let mut pos = [io[0], io[1], io[2]];
        let mut vel = [io[3], io[4], io[5]];
        let (hw, h, dt) = (io[6], io[7], io[8]);
        let step_up = io[9];
        let swim = io[10] != 0.0;
        let firm = io[11] != 0.0;
        let high = io[12] != 0.0;
        let mut on_ground = false;
        let mut hit_x = false;
        let mut hit_z = false;
        let mut hit_ceil = false;
        let mut top = 0.0f64;
        let mut hb = Hit { x0: 0.0, y0: 0.0, z0: 0.0, x1: 0.0, y1: 0.0, z1: 0.0, inside: false };

        // moveAxis: axis 0 x, 1 y, 2 z (box_hit's codes are +1)
        macro_rules! move_axis {
            ($ax:expr, $d:expr) => {{
                let d: f64 = $d;
                let ax: usize = $ax;
                let n = jmax(1.0, (d.abs() / 0.45).ceil());
                let step = d / n;
                let mut i = 0.0;
                let mut out = false;
                while i < n {
                    i += 1.0;
                    let prev = pos[ax];
                    pos[ax] += step;
                    if self.box_hit(pos[0], pos[1], pos[2], hw, h, (ax + 1) as u8, prev, firm, high, &mut hb)? {
                        if hb.inside {
                            pos[ax] = prev;
                            if ax == 1 && step < 0.0 {
                                on_ground = true;
                            }
                            top = hb.y1;
                            out = true;
                            break;
                        }
                        if ax == 1 {
                            if step < 0.0 {
                                pos[1] = hb.y1;
                                on_ground = true;
                            } else {
                                pos[1] = hb.y0 - h - 1e-4;
                                hit_ceil = true;
                            }
                        } else {
                            let (lo, hi) = if ax == 0 { (hb.x0, hb.x1) } else { (hb.z0, hb.z1) };
                            pos[ax] = if step > 0.0 { lo - hw - 1e-4 } else { hi + hw + 1e-4 };
                        }
                        top = hb.y1;
                        out = true;
                        break;
                    }
                }
                out
            }};
        }
        let mut hb2 = Hit { x0: 0.0, y0: 0.0, z0: 0.0, x1: 0.0, y1: 0.0, z1: 0.0, inside: false };

        if move_axis!(1, vel[1] * dt) {
            vel[1] = 0.0;
        }
        let was_ground = on_ground || (vel[1] <= 0.0 && self.box_hit(pos[0], pos[1] - 0.05, pos[2], hw, 0.05, 0, 0.0, firm, high, &mut hb2)?);
        for &ax in &[0usize, 2usize] {
            let d = vel[ax] * dt;
            if d == 0.0 || d.is_nan() {
                continue;
            }
            let save = pos;
            if move_axis!(ax, d) {
                if step_up != 0.0 && (was_ground || swim) {
                    let mut lift = save;
                    lift[1] = if top > save[1] { top } else { (save[1] + 1e-3).floor() + 1.0 };
                    if lift[1] - save[1] <= step_up && !self.box_hit(lift[0], lift[1], lift[2], hw, h, 0, 0.0, firm, high, &mut hb2)? {
                        lift[ax] += d;
                        if !self.box_hit(lift[0], lift[1], lift[2], hw, h, 0, 0.0, firm, high, &mut hb2)? {
                            pos = lift;
                            continue;
                        }
                    }
                }
                vel[ax] = 0.0;
                if ax == 0 {
                    hit_x = true;
                } else {
                    hit_z = true;
                }
            }
        }
        if !on_ground && vel[1] <= 0.0 && self.box_hit(pos[0], pos[1] - 0.02, pos[2], hw, 0.02, 0, 0.0, firm, high, &mut hb2)? {
            on_ground = true;
        }
        let w1 = self.get_block_f(pos[0], pos[1] + 0.4, pos[2])?;
        let w2 = self.get_block_f(pos[0], pos[1] + h - 0.15, pos[2])?;
        let in_water = self.render[w1 as usize] == 3;
        let head_in_water = self.render[w2 as usize] == 3;
        let b = |v: bool| if v { 1.0 } else { 0.0 };
        self.io[0] = pos[0];
        self.io[1] = pos[1];
        self.io[2] = pos[2];
        self.io[3] = vel[0];
        self.io[4] = vel[1];
        self.io[5] = vel[2];
        self.io[16] = b(on_ground);
        self.io[17] = b(hit_x);
        self.io[18] = b(hit_z);
        self.io[19] = b(hit_ceil);
        self.io[20] = b(in_water);
        self.io[21] = b(head_in_water);
        Ok(())
    }
}

// Shared-memory proof of concept, Rust side (prototype only): the same model as poc.js, bit for bit (see there).
// Modes (sharedpoc <mode> <N> <threads> <K> <ticks> [W=64]):
//   single   one thread
//   threads  persistent threads sharing cur / nxt / snap in one allocation, a std Barrier per tick (two on snapshot ticks)
use std::sync::Barrier;
use std::time::Instant;

const GROUP: usize = 20;
const SNAP_EVERY: u32 = 20;

#[inline(always)]
fn mix(a: u32, b: u32) -> u32 {
    let mut a = a ^ b;
    a = a.wrapping_mul(0x85eb_ca6b);
    a ^= a >> 13;
    a = a.wrapping_mul(0xc2b2_ae35);
    a ^= a >> 16;
    a
}
fn init(n: usize, w: usize) -> Vec<u32> { (0..n * w).map(|i| mix(i as u32, 0x9e37_79b9)).collect() }
fn checksum(s: &[u32]) -> u32 { s.iter().fold(0, |h, &x| mix(h, x)) }

// One object's tick; cur, snap read through raw pointers (other threads only write rows this object never reads this tick).
#[inline(always)]
unsafe fn step(i: usize, t: u32, cur: *const u32, nxt: *mut u32, snap: *const u32, n: usize, w: usize, k: u32) {
    let base = i - i % GROUP;
    let m = (w - 1) as u32;
    let row = i * w;
    let mut h = mix(i as u32, t.wrapping_mul(0x9e37_79b9));
    for j in 0..GROUP as u32 { h = mix(h, *cur.add((base + j as usize) * w + ((t.wrapping_add(j)) & m) as usize)); }
    for q in 0..2u32 { let o = h as usize % n; h = mix(h, *snap.add(o * w + ((q + t) & m) as usize)); }
    for r in 0..k { h = mix(h, (*cur.add(row + (r & m) as usize)).wrapping_add(r)); }
    for kk in 0..w { *nxt.add(row + kk) = mix(*cur.add(row + kk), h.wrapping_add(kk as u32)); }
}
fn range(n: usize, threads: usize, t: usize) -> (usize, usize) {
    let g = n / GROUP;
    (g * t / threads * GROUP, g * (t + 1) / threads * GROUP)
}
#[derive(Clone, Copy)]
struct P(*mut u32);
unsafe impl Send for P {}
unsafe impl Sync for P {}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let mode = a[1].as_str();
    let n: usize = a[2].parse().unwrap();
    let threads: usize = a[3].parse().unwrap();
    let k: u32 = a[4].parse().unwrap();
    let ticks: u32 = a[5].parse().unwrap();
    let w: usize = a.get(6).map(|s| s.parse().unwrap()).unwrap_or(64);
    assert!(n % GROUP == 0 && w.is_power_of_two());
    let mut b0 = init(n, w);
    let mut b1 = vec![0u32; n * w];
    let mut snap = b0.clone();
    let t0 = Instant::now();
    match mode {
        "single" => {
            for t in 0..ticks {
                let (cur, nxt) = if t & 1 == 0 { (&b0, &mut b1) } else { (&b1, &mut b0) };
                let (cp, np) = (cur.as_ptr(), nxt.as_mut_ptr());
                for i in 0..n { unsafe { step(i, t, cp, np, snap.as_ptr(), n, w, k) } }
                if (t + 1) % SNAP_EVERY == 0 { snap.copy_from_slice(if t & 1 == 0 { &b1 } else { &b0 }); }
            }
        }
        "threads" => {
            let bar = Barrier::new(threads);
            let (p0, p1, ps) = (P(b0.as_mut_ptr()), P(b1.as_mut_ptr()), P(snap.as_mut_ptr()));
            std::thread::scope(|s| {
                for th in 0..threads {
                    let bar = &bar;
                    s.spawn(move || {
                        let (lo, hi) = range(n, threads, th);
                        let (p0, p1, ps) = (p0, p1, ps);
                        for t in 0..ticks {
                            let (cur, nxt) = if t & 1 == 0 { (p0.0, p1.0) } else { (p1.0, p0.0) };
                            for i in lo..hi { unsafe { step(i, t, cur, nxt, ps.0, n, w, k) } }
                            bar.wait();
                            if (t + 1) % SNAP_EVERY == 0 {
                                unsafe { std::ptr::copy_nonoverlapping(nxt.add(lo * w), ps.0.add(lo * w), (hi - lo) * w) };
                                bar.wait();
                            }
                        }
                    });
                }
            });
        }
        _ => panic!("mode: single or threads"),
    }
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    let fin = if ticks & 1 == 0 { &b0 } else { &b1 };
    println!("{{\"lang\":\"rust\",\"mode\":\"{}\",\"N\":{},\"threads\":{},\"K\":{},\"W\":{},\"ticks\":{},\"msTick\":{:.3},\"usObj\":{:.3},\"checksum\":{}}}",
        mode, n, threads, k, w, ticks, ms / ticks as f64, ms * 1000.0 / ticks as f64 / n as f64, checksum(fin));
}

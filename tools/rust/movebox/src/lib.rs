// r15-50: world.moveBox in Rust. The core (core.rs) is shared; this file is the two thin bindings:
//  - wasm32: plain exported functions over the module's linear memory (no wasm-bindgen). JavaScript writes the io slots and the
//    staging section straight into memory (mb_io / mb_stage pointers) and calls mb_move.
//  - native: a Node N-API addon declared by hand (no napi crates). The same calls, with the io slots in a Float64Array that
//    JavaScript hands over once (mb_init) and section data passed as Uint16Arrays.
mod core;
use crate::core::World;

static mut W: Option<World> = None;
#[allow(static_mut_refs)]
fn w() -> &'static mut World {
    unsafe {
        if W.is_none() {
            W = Some(World::new());
        }
        W.as_mut().unwrap()
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::w;
    #[no_mangle]
    pub extern "C" fn mb_io() -> *mut f64 {
        w().io.as_mut_ptr()
    }
    #[no_mangle]
    pub extern "C" fn mb_stage() -> *mut u16 {
        w().stage.as_mut_ptr()
    }
    #[no_mangle]
    pub extern "C" fn mb_tables(n: u32, nboxes: u32) {
        w().tables(n as usize, nboxes as usize)
    }
    // 0 solid, 1 tall, 2 render, 3 dynamic boxes, 4 null box (u8); 5 box offsets (u32); 6 boxes (f64, 6 per box)
    #[no_mangle]
    pub extern "C" fn mb_table(which: u32) -> u32 {
        let x = w();
        (match which {
            0 => x.solid.as_mut_ptr() as usize,
            1 => x.tall.as_mut_ptr() as usize,
            2 => x.render.as_mut_ptr() as usize,
            3 => x.dynbox.as_mut_ptr() as usize,
            4 => x.nullbox.as_mut_ptr() as usize,
            5 => x.box_off.as_mut_ptr() as usize,
            _ => x.boxes.as_mut_ptr() as usize,
        }) as u32
    }
    #[no_mangle]
    pub extern "C" fn mb_consts(min_y: i32, h: i32, pn: i32, pw: i32, stone: u32, bedrock: u32) {
        let x = w();
        x.min_y = min_y; x.h = h; x.pn = pn; x.pw = pw; x.stone = stone as u16; x.bedrock = bedrock as u16;
    }
    #[no_mangle]
    pub extern "C" fn mb_chunk_put(cx: i32, cz: i32, lo: i32, hi: i32, absent: u32) -> u32 {
        w().chunk_put(cx, cz, lo, hi, absent != 0)
    }
    #[no_mangle]
    pub extern "C" fn mb_sec_uni(slot: u32, i: u32, id: u32) {
        w().sec_uniform(slot, i as usize, id as u16)
    }
    #[no_mangle]
    pub extern "C" fn mb_sec_stage(slot: u32, i: u32) {
        w().sec_from_stage(slot, i as usize)
    }
    #[no_mangle]
    pub extern "C" fn mb_cell(cx: i32, cz: i32, si: i32, li: u32, id: u32) {
        w().cell_set(cx, cz, si, li as usize, id as u16)
    }
    #[no_mangle]
    pub extern "C" fn mb_drop(cx: i32, cz: i32) {
        w().chunk_drop(cx, cz)
    }
    #[no_mangle]
    pub extern "C" fn mb_drop_absent() {
        w().drop_absent()
    }
    #[no_mangle]
    pub extern "C" fn mb_clear() {
        w().clear()
    }
    #[no_mangle]
    pub extern "C" fn mb_move() -> i32 {
        w().move_box()
    }
    #[no_mangle]
    pub extern "C" fn mb_count() -> u32 {
        w().chunk_count() as u32
    }
    #[no_mangle]
    pub extern "C" fn mb_bytes() -> u32 {
        w().mirror_bytes() as u32
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod napi {
    use super::w;
    use std::ffi::c_void;
    use std::os::raw::c_char;
    type Env = *mut c_void;
    type Val = *mut c_void;
    type Info = *mut c_void;
    type Cb = unsafe extern "C" fn(Env, Info) -> Val;
    extern "C" {
        fn napi_create_function(env: Env, name: *const c_char, len: usize, cb: Cb, data: *mut c_void, out: *mut Val) -> i32;
        fn napi_set_named_property(env: Env, obj: Val, name: *const c_char, v: Val) -> i32;
        fn napi_get_cb_info(env: Env, info: Info, argc: *mut usize, argv: *mut Val, this: *mut Val, data: *mut *mut c_void) -> i32;
        fn napi_get_value_double(env: Env, v: Val, out: *mut f64) -> i32;
        fn napi_create_double(env: Env, v: f64, out: *mut Val) -> i32;
        fn napi_get_typedarray_info(env: Env, v: Val, ty: *mut i32, len: *mut usize, data: *mut *mut c_void, ab: *mut Val, off: *mut usize) -> i32;
        fn napi_create_reference(env: Env, v: Val, count: u32, out: *mut *mut c_void) -> i32;
    }
    static mut IO: *mut f64 = std::ptr::null_mut();

    unsafe fn args<const N: usize>(env: Env, info: Info) -> [Val; N] {
        let mut argv = [std::ptr::null_mut(); N];
        let mut argc = N;
        napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut());
        argv
    }
    unsafe fn num(env: Env, v: Val) -> f64 {
        let mut d = 0.0;
        napi_get_value_double(env, v, &mut d);
        d
    }
    unsafe fn ret(env: Env, d: f64) -> Val {
        let mut v = std::ptr::null_mut();
        napi_create_double(env, d, &mut v);
        v
    }
    unsafe fn tarr(env: Env, v: Val) -> (*mut c_void, usize) {
        let (mut ty, mut len, mut data, mut ab, mut off) = (0, 0usize, std::ptr::null_mut(), std::ptr::null_mut(), 0usize);
        napi_get_typedarray_info(env, v, &mut ty, &mut len, &mut data, &mut ab, &mut off);
        (data, len)
    }

    // mb_init(io Float64Array(40)): kept referenced, its data used for every call
    unsafe extern "C" fn init(env: Env, info: Info) -> Val {
        let a = args::<1>(env, info);
        let mut r = std::ptr::null_mut();
        napi_create_reference(env, a[0], 1, &mut r);
        IO = tarr(env, a[0]).0 as *mut f64;
        ret(env, 0.0)
    }
    // mb_tables(solid, tall, render, dyn, null (Uint8Array), off (Uint32Array), boxes (Float64Array))
    unsafe extern "C" fn tables(env: Env, info: Info) -> Val {
        let a = args::<7>(env, info);
        let (p0, n) = tarr(env, a[0]);
        let (_, nb6) = tarr(env, a[6]);
        let x = w();
        x.tables(n, nb6 / 6);
        let cp8 = |v: Val, dst: &mut Vec<u8>| {
            let (p, l) = tarr(env, v);
            dst.copy_from_slice(std::slice::from_raw_parts(p as *const u8, l));
        };
        let _ = p0;
        cp8(a[0], &mut x.solid);
        cp8(a[1], &mut x.tall);
        cp8(a[2], &mut x.render);
        cp8(a[3], &mut x.dynbox);
        cp8(a[4], &mut x.nullbox);
        let (p, l) = tarr(env, a[5]);
        x.box_off.copy_from_slice(std::slice::from_raw_parts(p as *const u32, l));
        let (p, l) = tarr(env, a[6]);
        x.boxes.copy_from_slice(std::slice::from_raw_parts(p as *const f64, l));
        ret(env, 0.0)
    }
    unsafe extern "C" fn consts(env: Env, info: Info) -> Val {
        let a = args::<6>(env, info);
        let x = w();
        x.min_y = num(env, a[0]) as i32; x.h = num(env, a[1]) as i32; x.pn = num(env, a[2]) as i32; x.pw = num(env, a[3]) as i32;
        x.stone = num(env, a[4]) as u16; x.bedrock = num(env, a[5]) as u16;
        ret(env, 0.0)
    }
    unsafe extern "C" fn chunk_put(env: Env, info: Info) -> Val {
        let a = args::<5>(env, info);
        let s = w().chunk_put(num(env, a[0]) as i32, num(env, a[1]) as i32, num(env, a[2]) as i32, num(env, a[3]) as i32, num(env, a[4]) != 0.0);
        ret(env, s as f64)
    }
    unsafe extern "C" fn sec_uni(env: Env, info: Info) -> Val {
        let a = args::<3>(env, info);
        w().sec_uniform(num(env, a[0]) as u32, num(env, a[1]) as usize, num(env, a[2]) as u16);
        ret(env, 0.0)
    }
    // mb_sec(slot, i, Uint16Array(4096))
    unsafe extern "C" fn sec_arr(env: Env, info: Info) -> Val {
        let a = args::<3>(env, info);
        let (p, l) = tarr(env, a[2]);
        w().sec_from(num(env, a[0]) as u32, num(env, a[1]) as usize, std::slice::from_raw_parts(p as *const u16, l));
        ret(env, 0.0)
    }
    unsafe extern "C" fn cell(env: Env, info: Info) -> Val {
        let a = args::<5>(env, info);
        w().cell_set(num(env, a[0]) as i32, num(env, a[1]) as i32, num(env, a[2]) as i32, num(env, a[3]) as usize, num(env, a[4]) as u16);
        ret(env, 0.0)
    }
    unsafe extern "C" fn drop_(env: Env, info: Info) -> Val {
        let a = args::<2>(env, info);
        w().chunk_drop(num(env, a[0]) as i32, num(env, a[1]) as i32);
        ret(env, 0.0)
    }
    unsafe extern "C" fn drop_absent(env: Env, _info: Info) -> Val {
        w().drop_absent();
        ret(env, 0.0)
    }
    unsafe extern "C" fn clear(env: Env, _info: Info) -> Val {
        w().clear();
        ret(env, 0.0)
    }
    unsafe extern "C" fn mv(env: Env, _info: Info) -> Val {
        let x = w();
        std::ptr::copy_nonoverlapping(IO, x.io.as_mut_ptr(), 13);
        let r = x.move_box();
        std::ptr::copy_nonoverlapping(x.io.as_ptr(), IO, crate::core::IO_N);
        ret(env, r as f64)
    }
    unsafe extern "C" fn count(env: Env, _info: Info) -> Val {
        ret(env, w().chunk_count() as f64)
    }
    unsafe extern "C" fn bytes(env: Env, _info: Info) -> Val {
        ret(env, w().mirror_bytes() as f64)
    }

    #[no_mangle]
    pub unsafe extern "C" fn napi_register_module_v1(env: Env, exports: Val) -> Val {
        let fns: [(&[u8], Cb); 13] = [
            (b"mb_init\0", init), (b"mb_tables\0", tables), (b"mb_consts\0", consts), (b"mb_chunk_put\0", chunk_put),
            (b"mb_sec_uni\0", sec_uni), (b"mb_sec\0", sec_arr), (b"mb_cell\0", cell), (b"mb_drop\0", drop_),
            (b"mb_drop_absent\0", drop_absent), (b"mb_clear\0", clear), (b"mb_move\0", mv), (b"mb_count\0", count), (b"mb_bytes\0", bytes),
        ];
        for (name, f) in fns.iter() {
            let mut v = std::ptr::null_mut();
            napi_create_function(env, name.as_ptr() as *const c_char, usize::MAX, *f, std::ptr::null_mut(), &mut v);
            napi_set_named_property(env, exports, name.as_ptr() as *const c_char, v);
        }
        exports
    }
}

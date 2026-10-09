//! C ABI over oozextract for WebAssembly: the host allocates input and output
//! buffers in linear memory and calls `decompress`.
use std::alloc::{alloc, dealloc, Layout};

#[no_mangle]
pub extern "C" fn buffer_alloc(len: usize) -> *mut u8 {
    if len == 0 { return std::ptr::null_mut(); }
    match Layout::from_size_align(len, 8) { Ok(layout) => unsafe { alloc(layout) }, Err(_) => std::ptr::null_mut() }
}

#[no_mangle]
pub extern "C" fn buffer_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 { return; }
    if let Ok(layout) = Layout::from_size_align(len, 8) { unsafe { dealloc(ptr, layout) } }
}

/// Decompresses `src_len` bytes at `src` into exactly `dst_len` bytes at `dst`.
/// Returns the decoded byte count, or -1 on a malformed stream.
#[no_mangle]
pub extern "C" fn decompress(src: *const u8, src_len: usize, dst: *mut u8, dst_len: usize) -> isize {
    if src.is_null() || dst.is_null() { return -1; }
    let input = unsafe { std::slice::from_raw_parts(src, src_len) };
    let output = unsafe { std::slice::from_raw_parts_mut(dst, dst_len) };
    match oozextract::Extractor::new().read_from_slice(input, output) {
        Ok(n) => n as isize,
        Err(_) => -1,
    }
}

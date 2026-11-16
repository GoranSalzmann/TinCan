// SPDX-License-Identifier: AGPL-3.0-or-later
//! DeepFilterNet3 for the voice pipeline's AudioWorklet (docs/09-audio-pipeline.md §3, tier A).
//!
//! The module exports plain functions and imports nothing, so there is no generated JavaScript glue to keep in step
//! with the binary: the worklet (`apps/web/src/core/voice/deepfilter/worklet.ts`) instantiates it with an empty import
//! object and talks to it through linear memory.
//!
//! Protocol: `dfn_alloc` a buffer, copy the model archive (`DeepFilterNet3_onnx.tar.gz`) in, `dfn_create`, `dfn_free`
//! the buffer. Then for every hop: write `dfn_hop_size` samples at `dfn_input`, call `dfn_process`, read the same
//! number at `dfn_output`. The pointers stay valid for the life of the state, but memory growth replaces the
//! `ArrayBuffer`, so the caller re-creates its views when `memory.buffer` changes.

use std::ptr::null_mut;

// The `deep_filter` package names its library `df`.
use df::tract::{DfParams, DfTract, RuntimeParams};
use ndarray::{ArrayView2, ArrayViewMut2};

pub struct State {
    model: DfTract,
    input: Vec<f32>,
    output: Vec<f32>,
}

/// A buffer of `len` bytes in linear memory, for the model archive. Null when `len` is zero.
#[no_mangle]
pub extern "C" fn dfn_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return null_mut();
    }
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Frees a buffer from `dfn_alloc`.
///
/// # Safety
/// `ptr` and `len` must come from one `dfn_alloc` call, and the buffer must not be freed twice.
#[no_mangle]
pub unsafe extern "C" fn dfn_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(Vec::from_raw_parts(ptr, 0, len));
    }
}

/// Loads the model for one 48 kHz channel. `atten_lim_db` caps the attenuation (100 or more: no cap).
/// Returns null when the archive is not a DeepFilterNet model.
///
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn dfn_create(ptr: *const u8, len: usize, atten_lim_db: f32) -> *mut State {
    if ptr.is_null() {
        return null_mut();
    }
    let bytes = std::slice::from_raw_parts(ptr, len);
    let Ok(params) = DfParams::from_bytes(bytes) else {
        return null_mut();
    };
    let runtime = RuntimeParams::default_with_ch(1).with_atten_lim(atten_lim_db);
    let Ok(model) = DfTract::new(params, &runtime) else {
        return null_mut();
    };
    let hop = model.hop_size;
    Box::into_raw(Box::new(State {
        model,
        input: vec![0.; hop],
        output: vec![0.; hop],
    }))
}

/// Samples per hop (480 for DeepFilterNet3: 10 ms at 48 kHz).
///
/// # Safety
/// `st` must come from `dfn_create` and not be destroyed.
#[no_mangle]
pub unsafe extern "C" fn dfn_hop_size(st: *const State) -> usize {
    (*st).model.hop_size
}

/// The model's own delay in samples: the STFT overlap plus its lookahead frames.
///
/// # Safety
/// `st` must come from `dfn_create` and not be destroyed.
#[no_mangle]
pub unsafe extern "C" fn dfn_delay_samples(st: *const State) -> usize {
    let m = &(*st).model;
    m.fft_size - m.hop_size + m.lookahead * m.hop_size
}

/// Where the caller writes one hop of input.
///
/// # Safety
/// `st` must come from `dfn_create` and not be destroyed.
#[no_mangle]
pub unsafe extern "C" fn dfn_input(st: *mut State) -> *mut f32 {
    (*st).input.as_mut_ptr()
}

/// Where the caller reads one hop of output after `dfn_process`.
///
/// # Safety
/// `st` must come from `dfn_create` and not be destroyed.
#[no_mangle]
pub unsafe extern "C" fn dfn_output(st: *const State) -> *const f32 {
    (*st).output.as_ptr()
}

/// Denoises the hop at `dfn_input` into `dfn_output`. Returns the frame's local SNR in dB, or NaN when processing failed
/// (the output is then a copy of the input, so the call goes on unprocessed rather than silent).
///
/// # Safety
/// `st` must come from `dfn_create` and not be destroyed.
#[no_mangle]
pub unsafe extern "C" fn dfn_process(st: *mut State) -> f32 {
    let s = &mut *st;
    let hop = s.model.hop_size;
    let (Ok(noisy), Ok(enh)) = (
        ArrayView2::from_shape((1, hop), &s.input[..]),
        ArrayViewMut2::from_shape((1, hop), &mut s.output[..]),
    ) else {
        return f32::NAN;
    };
    match s.model.process(noisy, enh) {
        Ok(lsnr) => lsnr,
        Err(_) => {
            s.output.copy_from_slice(&s.input);
            f32::NAN
        }
    }
}

/// Changes the attenuation cap in dB (100 or more: no cap).
///
/// # Safety
/// `st` must come from `dfn_create` and not be destroyed.
#[no_mangle]
pub unsafe extern "C" fn dfn_set_atten_lim(st: *mut State, db: f32) {
    (*st).model.set_atten_lim(db);
}

/// Frees the state.
///
/// # Safety
/// `st` must come from `dfn_create` and not be destroyed twice.
#[no_mangle]
pub unsafe extern "C" fn dfn_destroy(st: *mut State) {
    if !st.is_null() {
        drop(Box::from_raw(st));
    }
}

/// tract asks getrandom for seeds (hash maps, random ONNX operators that DeepFilterNet does not use). Nothing here is
/// secret, and an import-free module has no entropy source, so it gets a fixed xorshift stream.
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod entropy {
    use std::sync::atomic::{AtomicU64, Ordering};

    static STATE: AtomicU64 = AtomicU64::new(0x9E37_79B9_7F4A_7C15);

    fn fill(buf: &mut [u8]) -> Result<(), getrandom::Error> {
        for b in buf {
            let mut x = STATE.load(Ordering::Relaxed);
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            STATE.store(x, Ordering::Relaxed);
            *b = x as u8;
        }
        Ok(())
    }
    getrandom::register_custom_getrandom!(fill);
}

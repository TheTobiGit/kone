//! The launcher's floor: a loom of accent threads drifting sideways.
//!
//! Every thread runs edge to edge. Its height is a sum of slow travelling
//! waves, scaled by a window that pinches all threads together at the sides
//! and lets them part in the middle, so the bundle breathes like cloth in a
//! draught. Neighbouring threads share the same waves a little out of phase,
//! which keeps them parallel instead of tangling. Nothing loops or orbits:
//! the waves only travel left to right.

use std::f32::consts::{PI, TAU};

use gpui_kit::*;
use kone_theme::{Rgba, hsla};

const THREADS: usize = 30;
/// Vertices per thread; at 1280px wide that is a joint every ~21px, enough
/// for the gentlest of these waves to stay smooth.
const SEGMENTS: usize = 60;

pub struct Look {
    pub color: Rgba,
    /// Peak opacity of the middle thread; the outer ones fade from it.
    pub alpha: f32,
}

/// Paints the threads into `b` at time `t` seconds.
pub fn paint(b: Bounds<Pixels>, t: f32, look: &Look, window: &mut Window) {
    let (x0, y0) = (f32::from(b.origin.x), f32::from(b.origin.y));
    let (w, h) = (f32::from(b.size.width), f32::from(b.size.height));
    if w < 1. || h < 1. {
        return;
    }
    let mid = y0 + h * 0.62;
    let spread = h * 0.3;

    for i in 0..THREADS {
        // -1 at the top thread, +1 at the bottom one.
        let lane = i as f32 / (THREADS - 1) as f32 * 2. - 1.;
        let phase = i as f32 * 0.21;
        let mut path = PathBuilder::stroke(px(1.));
        for s in 0..=SEGMENTS {
            let u = s as f32 / SEGMENTS as f32;
            // Zero at both edges, one in the middle: the pinch.
            let open = (PI * u).sin().max(0.).powf(1.6);
            let wave = (TAU * (u * 1.3 - t * 0.035) + phase).sin() * 0.55
                + (TAU * (u * 2.7 - t * 0.021) - phase * 1.7).sin() * 0.3
                + (TAU * (u * 0.6 - t * 0.012) + lane * 1.1).sin() * 0.45;
            let y = mid + open * (lane * spread + wave * h * 0.13);
            let p = point(px(x0 + u * w), px(y));
            if s == 0 { path.move_to(p) } else { path.line_to(p) }
        }
        // Threads thin out toward the edges of the bundle.
        let a = look.alpha * (1. - lane.abs().powi(2) * 0.75);
        if let Ok(path) = path.build() {
            window.paint_path(path, hsla(look.color.alpha(a)));
        }
    }
}

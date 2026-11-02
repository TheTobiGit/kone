//! The launcher's floor: a strip of tiny scribbled stick people along the
//! bottom edge, each busy with a small chore of its own.
//!
//! Everything is seeded by the figure's slot, so the crowd is the same on
//! every frame and only grows or shrinks with the window's width. Strokes
//! wobble by a fixed per-stroke offset to look hand drawn; time only drives
//! the poses (a walk cycle, a wave, a hop), so a frame is a few dozen short
//! paths and no allocation beyond the paths themselves.

use std::f32::consts::{PI, TAU};

use gpui_kit::*;
use kone_theme::{Rgba, hsla};

/// Strip height the canvas should be given.
pub const STRIP: f32 = 40.;
/// Average room each figure gets along the bottom edge.
const SLOT: f32 = 26.;
/// Feet touch the panel's bottom edge; this only keeps the stroke's
/// lower half from being clipped away.
const FLOOR: f32 = 0.7;
/// Keeps the end figures clear of the panel's rounded corners.
const INSET: f32 = 18.;

pub struct Look {
    pub color: Rgba,
    pub alpha: f32,
}

#[derive(Clone, Copy)]
enum Chore {
    Walk,
    Wave,
    Sit,
    Hop,
    Carry,
    Stretch,
    Juggle,
    Read,
    Kick,
    Kite,
}

const CHORES: [Chore; 10] = [
    Chore::Walk,
    Chore::Wave,
    Chore::Sit,
    Chore::Hop,
    Chore::Carry,
    Chore::Stretch,
    Chore::Juggle,
    Chore::Read,
    Chore::Kick,
    Chore::Kite,
];

/// Small integer hash, so the crowd is stable without a RNG.
fn hash(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^ (x >> 16)
}

fn unit(seed: u32) -> f32 {
    (hash(seed) & 0xffff) as f32 / 65535.
}

type P = (f32, f32);

struct Pen<'a> {
    window: &'a mut Window,
    color: Hsla,
    seed: u32,
    stroke: u32,
}

impl Pen<'_> {
    /// A polyline whose joints are nudged by a fixed seeded wobble.
    fn line(&mut self, pts: &[P]) {
        self.stroke += 1;
        let mut path = PathBuilder::stroke(px(1.3));
        let mut first = true;
        for (k, w) in pts.windows(2).enumerate() {
            let ((ax, ay), (bx, by)) = (w[0], w[1]);
            // Each segment gets a midpoint bowed sideways a touch.
            let s = self.seed ^ (self.stroke << 8) ^ k as u32;
            let bow = (unit(s) - 0.5) * 1.1;
            let (dx, dy) = (bx - ax, by - ay);
            let len = (dx * dx + dy * dy).sqrt().max(0.001);
            let mid = ((ax + bx) * 0.5 - dy / len * bow, (ay + by) * 0.5 + dx / len * bow);
            if first {
                path.move_to(point(px(ax), px(ay)));
                first = false;
            }
            path.line_to(point(px(mid.0), px(mid.1)));
            path.line_to(point(px(bx), px(by)));
        }
        if let Ok(p) = path.build() {
            self.window.paint_path(p, self.color);
        }
    }

    /// A slightly lumpy loop that does not quite close, like a pen circle.
    fn ring(&mut self, (cx, cy): P, r: f32) {
        self.stroke += 1;
        let start = unit(self.seed ^ (self.stroke << 8)) * TAU;
        let mut path = PathBuilder::stroke(px(1.25));
        for k in 0..=9 {
            let a = start + k as f32 / 9. * (TAU + 0.35);
            let rr = r * (1. + (unit(self.seed ^ (self.stroke << 8) ^ (k + 1)) - 0.5) * 0.22);
            let p = point(px(cx + a.cos() * rr), px(cy + a.sin() * rr));
            if k == 0 { path.move_to(p) } else { path.line_to(p) }
        }
        if let Ok(p) = path.build() {
            self.window.paint_path(p, self.color);
        }
    }
}

/// Arm or leg from a joint, by angle from straight down and a bend.
fn limb((x, y): P, len: f32, ang: f32, bend: f32) -> [P; 3] {
    let h = len * 0.5;
    let k = (x + ang.sin() * h, y + ang.cos() * h);
    let a2 = ang + bend;
    [(x, y), k, (k.0 + a2.sin() * h, k.1 + a2.cos() * h)]
}

/// Paints the crowd into `b` (the bottom strip) at time `t` seconds.
pub fn paint(b: Bounds<Pixels>, t: f32, look: &Look, window: &mut Window) {
    let (x0, y0) = (f32::from(b.origin.x), f32::from(b.origin.y));
    let (w, h) = (f32::from(b.size.width), f32::from(b.size.height));
    if w < SLOT || h < 1. {
        return;
    }
    let ground = y0 + h - FLOOR;
    let span = w - INSET * 2.;
    if span < SLOT {
        return;
    }
    let count = (span / SLOT).floor() as usize;
    let gap = span / count as f32;
    let mut pen = Pen { window, color: hsla(look.color.alpha(look.alpha)), seed: 0, stroke: 0 };

    let mut prev = usize::MAX;
    for i in 0..count {
        let seed = hash(i as u32 + 1);
        // Neighbours never share a chore.
        let mut c = seed as usize % CHORES.len();
        if c == prev {
            c = (c + 1 + (seed >> 8) as usize % (CHORES.len() - 1)) % CHORES.len();
        }
        prev = c;
        let scale = 0.85 + unit(seed ^ 3) * 0.3;
        // Uneven spacing so it reads as a crowd, not a row.
        let jitter = (unit(seed ^ 5) - 0.5) * gap * 0.5;
        let x = x0 + INSET + (i as f32 + 0.5) * gap + jitter;
        let speed = 0.8 + unit(seed ^ 7) * 0.5;
        let face = if seed & 1 == 0 { 1. } else { -1. };
        pen.seed = seed;
        pen.stroke = 0;
        figure(&mut pen, CHORES[c], x, ground, scale, face, t * speed + unit(seed ^ 9) * 10.);
    }
}

fn figure(pen: &mut Pen, chore: Chore, x: f32, g: f32, s: f32, f: f32, t: f32) {
    let leg = 9. * s;
    let body = 8. * s;
    let arm = 7. * s;
    let r = 3. * s;
    let swing = (t * TAU * 0.9).sin();

    // Defaults: standing, arms hanging.
    let mut hip = (x, g - leg);
    let mut lean = 0.;
    let mut legs = [(0.12, 0.), (-0.12, 0.)];
    let arms;

    match chore {
        Chore::Walk => {
            // Paces back and forth a few pixels, turning at each end.
            let p = (t * 0.25).sin();
            let dir = if (t * 0.25).cos() >= 0. { 1. } else { -1. };
            hip.0 += p * 9. * s;
            hip.1 -= swing.abs() * 0.6;
            legs = [(swing * 0.7 * dir, -0.35 * dir), (-swing * 0.7 * dir, -0.35 * dir)];
            arms = [(-swing * 0.5 * dir, 0.3 * dir), (swing * 0.5 * dir, 0.3 * dir)];
        }
        Chore::Wave => {
            let wv = (t * TAU * 1.4).sin();
            arms = [(0.3 * -f, 0.), (PI * 0.8 * f, 0.5 * f + wv * 0.5 * f)];
        }
        Chore::Sit => {
            // On a little crate, legs dangling and kicking.
            let crate_h = 5. * s;
            pen.line(&[(x - 4. * s, g), (x - 4. * s, g - crate_h), (x + 4. * s, g - crate_h), (x + 4. * s, g)]);
            hip = (x, g - crate_h);
            let k = swing * 0.25;
            legs = [(PI * 0.5 * f, -PI * 0.5 * f + k), (PI * 0.5 * f, -PI * 0.45 * f - k)];
            arms = [(0.4 * f, 0.4 * f), (0.2 * f, 0.5 * f)];
        }
        Chore::Hop => {
            let up = (t * TAU * 0.8).sin().max(0.);
            hip.1 -= up * 5. * s;
            let tuck = up * 0.6;
            legs = [(0.25 + tuck, -tuck * 2.), (-0.25 - tuck, tuck * 2.)];
            arms = [(PI * 0.75 + up * 0.2, 0.), (-PI * 0.75 - up * 0.2, 0.)];
        }
        Chore::Carry => {
            // A box held overhead, bobbing with each step.
            let bob = swing.abs() * 0.7;
            hip.1 -= bob;
            legs = [(swing * 0.35, -0.2), (-swing * 0.35, -0.2)];
            arms = [(PI * 0.88, 0.25), (-PI * 0.88, -0.25)];
            let top = hip.1 - body - arm - 1.;
            pen.line(&[
                (x - 4.5 * s, top),
                (x + 4.5 * s, top),
                (x + 4.5 * s, top - 5. * s),
                (x - 4.5 * s, top - 5. * s),
                (x - 4.5 * s, top),
            ]);
        }
        Chore::Stretch => {
            let e = ((t * TAU * 0.35).sin() + 1.) * 0.5;
            lean = (e - 0.5) * 0.35;
            arms = [(PI * (0.6 + 0.35 * e), 0.), (-PI * (0.6 + 0.35 * e), 0.)];
            legs = [(0.3, 0.), (-0.3, 0.)];
        }
        Chore::Juggle => {
            arms = [(0.9 + swing * 0.25, 1.2), (-0.9 + swing * 0.25, -1.2)];
            let head_y = hip.1 - body - r * 2.;
            for k in 0..3 {
                let a = t * TAU * 0.7 + k as f32 * TAU / 3.;
                let bx = x + a.cos() * 5. * s;
                let by = head_y - 3. * s - a.sin().abs() * 5. * s;
                pen.ring((bx, by), 0.9);
            }
        }
        Chore::Read => {
            // Sitting cross-legged on the ground with an open book.
            hip = (x, g - 1.);
            legs = [(PI * 0.5, -PI * 0.8), (-PI * 0.5, PI * 0.8)];
            let turn = ((t * 0.3).fract() < 0.1) as u8 as f32;
            arms = [(PI * 0.55 * f, 0.6 * f), (PI * 0.4 * f, 0.9 * f)];
            let bx = x + f * 5.5 * s;
            let by = hip.1 - body * 0.5;
            pen.line(&[(bx - 2.5 * s, by - 1.5 - turn), (bx, by), (bx + 2.5 * s, by - 1.5 + turn)]);
        }
        Chore::Kick => {
            // Kicking a ball that rolls out and back.
            let k = (t * TAU * 0.5).sin();
            let kick = k.max(0.);
            legs = [(0.1, 0.), (f * (0.2 + kick * 1.1), -f * kick * 0.3)];
            arms = [(-0.6 * f, 0.), (0.4 * f, 0.)];
            lean = -f * kick * 0.12;
            let ball = x + f * (7. + (k * 0.5 + 0.5) * 6.) * s;
            pen.ring((ball, g - 1.8), 1.8);
        }
        Chore::Kite => {
            arms = [(PI * 0.7 * f, 0.3 * f), (0.4 * -f, 0.)];
            let hand = (x + f * 5. * s, hip.1 - body - 3. * s);
            let kx = x + f * (14. + (t * 0.9).sin() * 2.) * s;
            let ky = g - 24. * s + (t * 1.3).cos() * 1.5;
            pen.line(&[hand, ((hand.0 + kx) * 0.5, (hand.1 + ky) * 0.5 + 2.), (kx, ky)]);
            pen.line(&[(kx, ky - 2.5), (kx + 2., ky), (kx, ky + 2.5), (kx - 2., ky), (kx, ky - 2.5)]);
        }
    }

    let neck = (hip.0 + lean.sin() * body, hip.1 - lean.cos() * body);
    let head = (neck.0 + lean.sin() * r, neck.1 - r - 0.3);
    pen.ring(head, r);
    pen.line(&[hip, neck]);
    for (a, bd) in legs {
        pen.line(&limb(hip, leg, a, bd));
    }
    let shoulder = (hip.0 + lean.sin() * body * 0.85, hip.1 - lean.cos() * body * 0.85);
    for (a, bd) in arms {
        pen.line(&limb(shoulder, arm, a, bd));
    }
}

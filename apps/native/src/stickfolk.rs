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
pub const STRIP: f32 = 64.;
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

/// Letter height of the scribbled word, about twice a figure.
const LH: f32 = 40.;
/// How far (px) above the strip a cursor still counts as hovering it.
const REACH: f32 = 24.;
/// Seconds for the crowd to wake up when hovered, and to settle after.
const RISE: f32 = 0.25;
const FALL: f32 = 0.9;

/// Where the cursor is over the crowd, shared between the shell's mouse
/// handler and the paint pass (which records the strip's bounds).
#[derive(Default)]
pub struct Hover {
    pub strip: std::rc::Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
    cursor: Option<f32>,
    last_x: f32,
    since: Option<std::time::Instant>,
}

impl Hover {
    /// Follows the cursor; returns whether a frame is needed.
    pub fn track(&mut self, pos: Point<Pixels>, busy: bool) -> bool {
        let inside = !busy
            && self.strip.get().is_some_and(|b| {
                let (x, y) = (f32::from(pos.x), f32::from(pos.y));
                let (bx, by) = (f32::from(b.origin.x), f32::from(b.origin.y));
                x >= bx && x <= bx + f32::from(b.size.width) && y >= by - REACH && y <= by + f32::from(b.size.height)
            });
        let x = f32::from(pos.x);
        match (inside, self.cursor) {
            (true, None) => {
                self.since = Some(std::time::Instant::now());
                self.cursor = Some(x);
                self.last_x = x;
                true
            }
            // Moving within the strip waits for the next ticker frame.
            (true, Some(_)) => {
                self.cursor = Some(x);
                self.last_x = x;
                false
            }
            (false, Some(_)) => {
                self.cursor = None;
                self.since = Some(std::time::Instant::now());
                true
            }
            (false, None) => false,
        }
    }

    /// 0 when calm, 1 when fully stirred.
    pub fn energy(&self) -> f32 {
        let Some(since) = self.since else { return 0. };
        let s = since.elapsed().as_secs_f32();
        if self.cursor.is_some() { (s / RISE).min(1.) } else { (1. - s / FALL).max(0.) }
    }

    /// Whether the crowd is mid-reaction and wants smooth frames.
    pub fn active(&self) -> bool {
        self.cursor.is_some() || self.energy() > 0.
    }

    pub fn snapshot(&self) -> Stir {
        Stir { x: self.last_x, energy: self.energy() }
    }
}

/// A frame's view of the hover: cursor x (window coords) and strength.
#[derive(Clone, Copy, Default)]
pub struct Stir {
    pub x: f32,
    pub energy: f32,
}

impl Stir {
    /// Closeness to the cursor, fading over ~150px.
    fn near(&self, x: f32) -> f32 {
        let d = (x - self.x) / 190.;
        self.energy * (-d * d).exp()
    }
    /// A ripple of hops running outward from the cursor.
    fn hop(&self, x: f32, t: f32) -> f32 {
        if self.energy <= 0. {
            return 0.;
        }
        let d = (x - self.x).abs();
        self.energy * (t * 9. - d / 22.).sin().max(0.) * (-d / 420.).exp()
    }
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
    // Parts in the word.
    Perch,
    Hang,
    Push,
    Balance,
    Slide,
    Paint,
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
    width: f32,
}

impl Pen<'_> {
    /// A polyline whose joints are nudged by a fixed seeded wobble.
    fn line(&mut self, pts: &[P]) {
        self.stroke += 1;
        let mut path = PathBuilder::stroke(px(self.width));
        let mut first = true;
        for (k, w) in pts.windows(2).enumerate() {
            let ((ax, ay), (bx, by)) = (w[0], w[1]);
            // Each segment gets a midpoint bowed sideways a touch.
            let s = self.seed ^ (self.stroke << 8) ^ k as u32;
            let bow = (unit(s) - 0.5) * (1.1 + (self.width - 1.3) * 1.2);
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
    fn ring(&mut self, c: P, r: f32) {
        self.oval(c, r, r, 0., 9);
    }

    /// An oval loop; `spin` turns where the pen starts and stops, so a
    /// rolling letter shows its gap going round.
    fn oval(&mut self, (cx, cy): P, rx: f32, ry: f32, spin: f32, n: u32) {
        self.stroke += 1;
        let r = 1.;
        let start = unit(self.seed ^ (self.stroke << 8)) * TAU + spin;
        let mut path = PathBuilder::stroke(px(self.width - 0.05));
        for k in 0..=n {
            let a = start + k as f32 / n as f32 * (TAU + 0.35);
            let rr = r * (1. + (unit(self.seed ^ (self.stroke << 8) ^ (k + 1)) - 0.5) * 0.12);
            let p = point(px(cx + a.cos() * rr * rx), px(cy + a.sin() * rr * ry));
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

/// Paints the crowd into `b` (the bottom strip) at time `t` seconds, with
/// the word "KONE" in the middle and its own little crew.
pub fn paint(b: Bounds<Pixels>, t: f32, stir: Stir, look: &Look, window: &mut Window) {
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
    let mut pen = Pen { window, color: hsla(look.color.alpha(look.alpha)), seed: 0, stroke: 0, width: 1.3 };

    // The word sits in the middle when there is room for it and a crowd.
    let word = WORD_W + 80. < span;
    let wl = x0 + (w - WORD_W) * 0.5;
    let keep_out = (wl - 22., wl + WORD_W + 24.);

    let mut prev = usize::MAX;
    for i in 0..count {
        let seed = hash(i as u32 + 1);
        let jitter = (unit(seed ^ 5) - 0.5) * gap * 0.5;
        let x = x0 + INSET + (i as f32 + 0.5) * gap + jitter;
        if word && x > keep_out.0 && x < keep_out.1 {
            continue;
        }
        // Neighbours never share a chore.
        let mut c = seed as usize % CHORES.len();
        if c == prev {
            c = (c + 1 + (seed >> 8) as usize % (CHORES.len() - 1)) % CHORES.len();
        }
        prev = c;
        let scale = 0.85 + unit(seed ^ 3) * 0.3;
        let speed = 0.8 + unit(seed ^ 7) * 0.5;
        let face = if seed & 1 == 0 { 1. } else { -1. };
        // Shy of the cursor: step a little away from it, then hop and cheer.
        let near = stir.near(x);
        let away = if x >= stir.x { 1. } else { -1. };
        let x = x + away * near * 7.;
        pen.seed = seed;
        pen.stroke = 0;
        let react = React { cheer: near, hop: stir.hop(x, t) };
        figure(&mut pen, CHORES[c], x, ground, scale, face, t * speed + unit(seed ^ 9) * 10., react);
    }
    if word {
        letters(&mut pen, wl, ground, t, stir);
    }
}

/// Letter widths and spacing of "KONE".
const KW: f32 = 24.;
const ORX: f32 = 17.;
const NW: f32 = 23.;
const EW: f32 = 21.;
const LGAP: f32 = 10.;
/// Room between K and O for the pusher, and between N and E for the hanger.
const PGAP: f32 = 20.;
const WORD_W: f32 = KW + ORX * 2. + NW + EW + LGAP + PGAP * 2.;

#[derive(Clone, Copy, Default)]
struct React {
    cheer: f32,
    hop: f32,
}

/// Straight stroke cut into `n` pieces so a long letter stroke wobbles.
fn seg(a: P, b: P, n: usize, out: &mut Vec<P>) {
    for k in 0..=n {
        if k == 0 && !out.is_empty() {
            continue;
        }
        let f = k as f32 / n as f32;
        out.push((a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f));
    }
}

fn stroke(pen: &mut Pen, pts: &[P]) {
    let mut out = Vec::with_capacity(pts.len() * 3);
    for w in pts.windows(2) {
        seg(w[0], w[1], 3, &mut out);
    }
    pen.line(&out);
}

/// Each letter's bounce and tilt under the cursor.
fn jolt(stir: Stir, cx: f32, t: f32, k: f32) -> (f32, f32) {
    let near = stir.near(cx);
    let hop = stir.hop(cx, t);
    ((t * 11. + k).sin() * near * 2.2, -hop * 6. - near * 2.)
}

fn letters(pen: &mut Pen, wl: f32, g: f32, t: f32, stir: Stir) {
    let top = g - LH;
    let crew = |pen: &mut Pen, k: u32| {
        pen.seed = hash(0xbeef + k);
        pen.stroke = 0;
        pen.width = 1.3;
    };
    let ink = |pen: &mut Pen, k: u32| {
        pen.seed = hash(0xc0de + k);
        pen.stroke = 0;
        pen.width = 2.1;
    };

    // K: someone perched on top of the stem.
    let kx = wl;
    let (dx, dy) = jolt(stir, kx + KW * 0.5, t, 0.);
    let (kx, kt, kg) = (kx + dx, top + dy, g);
    ink(pen, 1);
    stroke(pen, &[(kx, kg), (kx, kt)]);
    stroke(pen, &[(kx + KW, kt), (kx + 2., kt + LH * 0.55), (kx + KW + 1., kg)]);
    let r = React { cheer: stir.near(kx), hop: 0. };
    crew(pen, 1);
    figure(pen, Chore::Perch, kx, kt - 0.5, 1., 1., t, r);

    // O: rolled back and forth like a wheel, with a pusher and a log-roller.
    let ox = kx - dx + KW + PGAP + ORX;
    let roll = (t * 0.7).sin() * 5.;
    let (dx, dy) = jolt(stir, ox, t, 1.3);
    let oc = (ox + roll + dx, g - LH * 0.5 + dy.min(0.) - 0.3);
    ink(pen, 2);
    pen.oval(oc, ORX, LH * 0.5, roll / ORX, 14);
    let r = React { cheer: stir.near(ox), hop: 0. };
    crew(pen, 3);
    figure(pen, Chore::Push, oc.0 - ORX - 6., g, 1., 1., t, r);
    crew(pen, 4);
    // Feet on the top of the O, stepping against its roll.
    figure(pen, Chore::Balance, oc.0, oc.1 - LH * 0.5 - 0.6, 0.95, 1., -roll, r);

    // N: a slide down the diagonal.
    let nx = ox + ORX + LGAP;
    let (dx, dy) = jolt(stir, nx + NW * 0.5, t, 2.1);
    let (nx, nt, ng) = (nx + dx, top + dy, g);
    ink(pen, 3);
    stroke(pen, &[(nx, ng), (nx, nt), (nx + NW, ng + dy.min(0.)), (nx + NW, nt)]);
    let r = React { cheer: stir.near(nx), hop: 0. };
    crew(pen, 5);
    let p = (t * 0.32).fract();
    figure(pen, Chore::Slide, nx + NW * p, nt + (LH + (-dy).min(LH)) * p - 1., 0.95, 1., p, r);
    // And someone hanging off its top right corner.
    crew(pen, 2);
    figure(pen, Chore::Hang, nx + NW + 1., nt, 1., 1., t * 1.1, r);

    // E: a painter still finishing the middle bar.
    let ex = nx - dx + NW + PGAP;
    let (dx, dy) = jolt(stir, ex + EW * 0.5, t, 3.4);
    let (ex, et, eg) = (ex + dx, top + dy, g);
    ink(pen, 4);
    stroke(pen, &[(ex + EW, et), (ex, et), (ex, eg), (ex + EW + 1., eg)]);
    // The bar grows as it is painted, then the painter touches it up again.
    let done = 0.6 + ((t * 0.45).sin() * 0.5 + 0.5) * 0.25;
    let bar_end = ex + EW * done;
    stroke(pen, &[(ex, et + LH * 0.5), (bar_end, et + LH * 0.5 + 0.5)]);
    let r = React { cheer: stir.near(ex), hop: 0. };
    crew(pen, 6);
    figure(pen, Chore::Paint, ex + EW + 9., eg, 1., -1., t, r);
}

#[allow(clippy::too_many_arguments)]
fn figure(pen: &mut Pen, chore: Chore, x: f32, g: f32, s: f32, f: f32, t: f32, react: React) {
    let leg = 9. * s;
    let body = 8. * s;
    let arm = 7. * s;
    let r = 3. * s;
    let swing = (t * TAU * 0.9).sin();

    // Defaults: standing, arms hanging.
    let mut hip = (x, g - leg);
    let mut lean = 0.;
    let mut legs = [(0.12, 0.), (-0.12, 0.)];
    let mut arms;

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
        Chore::Perch => {
            // On top of a letter, legs dangling over its edge.
            hip = (x + 2. * s, g);
            let k = swing * 0.3;
            legs = [(PI * 0.5 + k, -PI * 0.5), (PI * 0.45 - k, -PI * 0.45)];
            arms = [(-0.5, 0.3), (0.6, 0.2)];
        }
        Chore::Hang => {
            // Hands on (x, g), swinging under it.
            let sway = swing * 0.12;
            let shoulder_y = g + arm * 0.95;
            // Hangs a little off to the right so it is clear of the letter.
            hip = (x + 4. - sway * 8., shoulder_y + body * 0.85);
            lean = sway;
            legs = [(sway * 2. + 0.1, 0.25), (sway * 2. - 0.1, 0.4)];
            arms = [(PI + 0.55, 0.1), (PI + 0.35, 0.)];
        }
        Chore::Push => {
            lean = 0.45 * f;
            legs = [(swing * 0.5 - 0.25 * f, -0.3), (-swing * 0.5 - 0.25 * f, -0.3)];
            arms = [(PI * 0.5 * f, 0.15), (PI * 0.42 * f, 0.25)];
        }
        Chore::Balance => {
            // `t` here is the roll; feet patter against it, arms out.
            let step = (t * 1.3).sin();
            hip.0 -= t * 0.25;
            legs = [(step * 0.5, -0.2), (-step * 0.5, -0.2)];
            arms = [(PI * 0.5 + step * 0.25, -0.3), (-PI * 0.5 + step * 0.25, 0.3)];
            lean = step * 0.12;
        }
        Chore::Slide => {
            // Seated on the N's diagonal, arms up: whee.
            hip = (x, g);
            lean = -0.25;
            legs = [(0.55, 0.), (0.7, -0.1)];
            arms = [(PI * 0.85, 0.2), (-PI * 0.85, -0.2)];
        }
        Chore::Paint => {
            // Brush arm scrubbing at the bar end on its left.
            let scrub = (t * TAU * 1.6).sin() * 0.18;
            lean = 0.1 * f;
            arms = [(PI * 0.62 * f + scrub, -0.3 * f), (0.3 * -f, 0.)];
            let sh = (hip.0 + lean.sin() * body * 0.85, hip.1 - lean.cos() * body * 0.85);
            let tip = limb(sh, arm, PI * 0.62 * f + scrub, -0.3 * f)[2];
            pen.line(&[tip, (tip.0 + f * 3., tip.1 - 1.5)]);
        }
    }

    // The cursor: the ripple lifts people off their feet and the nearest
    // throw their arms up and wave.
    if react.hop > 0. && !matches!(chore, Chore::Hang | Chore::Slide | Chore::Balance | Chore::Perch) {
        hip.1 -= react.hop * 8. * s;
    }
    if react.cheer > 0.25 && !matches!(chore, Chore::Hang) {
        let wv = (t * TAU * 2.).sin() * 0.35;
        arms = [(PI * 0.82 + wv, 0.2), (-PI * 0.82 + wv, -0.2)];
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

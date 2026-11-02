//! The launcher's floor: a strip of tiny scribbled stick people along the
//! bottom edge, each busy with a small chore of its own.
//!
//! Everything is seeded by the figure's slot, so the crowd is the same on
//! every frame and only grows or shrinks with the window's width. Strokes
//! wobble by a fixed per-stroke offset to look hand drawn; time only drives
//! the poses (a walk cycle, a wave, a hop), so a frame is a few dozen short
//! paths and no allocation beyond the paths themselves.

use std::{
    cell::Cell,
    f32::consts::{PI, TAU},
    rc::Rc,
    time::Instant,
};

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
const RISE: f32 = 0.28;
const FALL: f32 = 0.95;
/// Duration of a click shockwave ripple across the strip.
const PULSE_DUR: f32 = 1.35;
/// Duration of a kicked ball rolling and bouncing along the floor.
const BALL_DUR: f32 = 2.6;
/// Duration of a clicked letter tipping over and being heaved back upright.
const TIP_DUR: f32 = 2.2;

/// Hermite smoothstep on `0..=1`.
fn smooth(u: f32) -> f32 {
    let u = u.clamp(0., 1.);
    u * u * (3. - 2. * u)
}

/// Cubic ease-out on `0..=1`: brisk launch, gentle stop.
fn ease_out(u: f32) -> f32 {
    let u = u.clamp(0., 1.);
    1. - (1. - u).powi(3)
}

/// Smooth back-and-forth patrol wave: returns `(pos in -1..=1, dir in -1..=1)`
/// so walkers travel at an even pace, pause briefly at each end, and turn
/// smoothly instead of snapping their knees in a single frame.
fn patrol(t: f32) -> (f32, f32) {
    let s = (t * 0.22).sin();
    let c = (t * 0.22).cos();
    // Soften the turnaround and blend facing direction across the pause.
    let pos = s * (1. - 0.18 * s * s);
    let dir = (c * 3.2).clamp(-1., 1.);
    (pos, dir)
}

/// Where the cursor is over the crowd, shared between the shell's mouse
/// handlers and the paint pass (which records the strip's bounds).
pub struct Hover {
    pub strip: Rc<Cell<Option<Bounds<Pixels>>>>,
    cursor: Option<f32>,
    raw_x: f32,
    smooth_x: Cell<f32>,
    vx: Cell<f32>,
    last_step: Cell<Option<Instant>>,
    from_energy: f32,
    since: Option<Instant>,
    pulse: Option<(f32, Instant)>,
    ball: Option<(f32, f32, Instant)>,
    tipped: [Option<Instant>; 4],
}

impl Default for Hover {
    fn default() -> Self {
        Self {
            strip: Rc::new(Cell::new(None)),
            cursor: None,
            raw_x: 0.,
            smooth_x: Cell::new(0.),
            vx: Cell::new(0.),
            last_step: Cell::new(None),
            from_energy: 0.,
            since: None,
            pulse: None,
            ball: None,
            tipped: [None; 4],
        }
    }
}

impl Hover {
    fn inside_strip(&self, pos: Point<Pixels>) -> bool {
        self.strip.get().is_some_and(|b| {
            let (x, y) = (f32::from(pos.x), f32::from(pos.y));
            let (bx, by) = (f32::from(b.origin.x), f32::from(b.origin.y));
            x >= bx && x <= bx + f32::from(b.size.width) && y >= by - REACH && y <= by + f32::from(b.size.height)
        })
    }

    /// Follows the cursor; returns whether an immediate frame is needed.
    pub fn track(&mut self, pos: Point<Pixels>, busy: bool) -> bool {
        if busy {
            return self.release();
        }
        let inside = self.inside_strip(pos);
        let x = f32::from(pos.x);
        let now = Instant::now();
        match (inside, self.cursor) {
            (true, None) => {
                let current = self.energy_at(now);
                self.from_energy = current;
                self.since = Some(now);
                self.cursor = Some(x);
                if current <= 0.01 {
                    self.smooth_x.set(x);
                    self.vx.set(0.);
                }
                self.raw_x = x;
                self.last_step.set(Some(now));
                true
            }
            // Moving within the strip updates the target; large sweeps wake a frame.
            (true, Some(prev)) => {
                self.cursor = Some(x);
                self.raw_x = x;
                (x - prev).abs() > 18.
            }
            (false, Some(_)) => {
                self.from_energy = self.energy_at(now);
                self.cursor = None;
                self.since = Some(now);
                true
            }
            (false, None) => false,
        }
    }

    /// Settles the crowd when a modal opens over the page.
    pub fn release(&mut self) -> bool {
        if self.cursor.is_some() {
            let now = Instant::now();
            self.from_energy = self.energy_at(now);
            self.cursor = None;
            self.since = Some(now);
            return true;
        }
        false
    }

    /// Handles a left click inside the strip: tips a letter in "KONE" if one
    /// was clicked, or kicks a ball across the floor for the crowd to chase.
    pub fn press(&mut self, pos: Point<Pixels>, busy: bool) -> bool {
        if busy || !self.inside_strip(pos) {
            return false;
        }
        let Some(b) = self.strip.get() else { return false };
        let now = Instant::now();
        let x = f32::from(pos.x);
        let x0 = f32::from(b.origin.x);
        let w = f32::from(b.size.width);
        let span = w - INSET * 2.;

        self.from_energy = self.energy_at(now).max(0.65);
        self.cursor = Some(x);
        self.raw_x = x;
        self.smooth_x.set(x);
        self.since = Some(now);
        self.pulse = Some((x, now));

        if WORD_W + 80. < span {
            let wl = x0 + (w - WORD_W) * 0.5;
            if let Some(idx) = hit_letter(wl, x) {
                self.tipped[idx] = Some(now);
                return true;
            }
        }

        // Outside the word: boot a ball across the strip. If the cursor was
        // sweeping sideways, kick in that direction; otherwise kick toward the middle.
        let vx = self.vx.get();
        let dir = if vx.abs() > 35. {
            vx.signum()
        } else if x < x0 + w * 0.5 {
            1.
        } else {
            -1.
        };
        self.ball = Some((x, dir, now));
        true
    }

    fn energy_at(&self, now: Instant) -> f32 {
        let Some(since) = self.since else { return 0. };
        let s = now.saturating_duration_since(since).as_secs_f32();
        if self.cursor.is_some() {
            let u = smooth((s / RISE).min(1.));
            self.from_energy + (1. - self.from_energy) * u
        } else {
            let u = smooth((s / FALL).min(1.));
            self.from_energy * (1. - u)
        }
    }

    /// Whether the crowd is mid-reaction and wants smooth frames.
    pub fn active(&self) -> bool {
        let now = Instant::now();
        self.cursor.is_some()
            || self.energy_at(now) > 0.001
            || self.pulse.is_some_and(|(_, t)| now.saturating_duration_since(t).as_secs_f32() < PULSE_DUR)
            || self.ball.is_some_and(|(_, _, t)| now.saturating_duration_since(t).as_secs_f32() < BALL_DUR)
            || self.tipped.iter().flatten().any(|t| now.saturating_duration_since(*t).as_secs_f32() < TIP_DUR)
    }

    pub fn snapshot(&self) -> Stir {
        let now = Instant::now();
        let dt = self
            .last_step
            .get()
            .map_or(0.04, |prev| now.saturating_duration_since(prev).as_secs_f32().clamp(0.001, 0.25));
        self.last_step.set(Some(now));

        let prev_x = self.smooth_x.get();
        let alpha = 1. - (-dt * 15.).exp();
        let sx = prev_x + (self.raw_x - prev_x) * alpha;
        self.smooth_x.set(sx);

        let inst_v = (sx - prev_x) / dt;
        let vx = (self.vx.get() * (1. - alpha) + inst_v * alpha).clamp(-450., 450.);
        self.vx.set(vx);

        let pulse = self.pulse.and_then(|(px, t)| {
            let age = now.saturating_duration_since(t).as_secs_f32();
            (age < PULSE_DUR).then_some((px, age))
        });
        let ball = self.ball.and_then(|(bx, dir, t)| {
            let age = now.saturating_duration_since(t).as_secs_f32();
            (age < BALL_DUR).then_some((bx, dir, age))
        });
        let mut tipped = [-1.; 4];
        for (i, slot) in self.tipped.iter().enumerate() {
            if let Some(t) = slot {
                let age = now.saturating_duration_since(*t).as_secs_f32();
                if age < TIP_DUR {
                    tipped[i] = age;
                }
            }
        }

        Stir { x: sx, energy: self.energy_at(now), vx, pulse, ball, tipped }
    }
}

/// A frame's view of the interaction state: smoothed cursor x, hover strength,
/// cursor breeze velocity, and any active click animations.
#[derive(Clone, Copy, Default)]
pub struct Stir {
    pub x: f32,
    pub energy: f32,
    pub vx: f32,
    pub pulse: Option<(f32, f32)>,
    pub ball: Option<(f32, f32, f32)>,
    pub tipped: [f32; 4],
}

impl Stir {
    /// Closeness to the cursor, fading over ~160px.
    fn near(&self, x: f32) -> f32 {
        let d = (x - self.x) / 185.;
        self.energy * (-d * d).exp()
    }

    /// Directional gaze toward the cursor (`-1..=1`), weighted by closeness.
    fn gaze(&self, x: f32) -> f32 {
        let near = self.near(x);
        if near <= 0.01 {
            return 0.;
        }
        ((self.x - x) / 36.).clamp(-1., 1.) * near
    }

    /// A ripple of hops running outward from the cursor, plus any click shockwave.
    fn hop(&self, x: f32, t: f32) -> f32 {
        let mut h = 0.;
        if self.energy > 0. {
            let d = (x - self.x).abs();
            let wave = (t * 8.5 - d / 24.).sin().max(0.);
            h = self.energy * wave * wave * (-d / 420.).exp();
        }
        if let Some((px, age)) = self.pulse {
            let d = (x - px).abs();
            let front = age * 260.;
            let band = ((d - front) / 42.).powi(2);
            let fade = (1. - age / PULSE_DUR).max(0.);
            h = h.max((-band).exp() * fade * 1.15);
        }
        h
    }

    /// Current ball coordinates `(bx, by, spin, fade)` if a ball is in play.
    fn ball_state(&self, left_lim: f32, right_lim: f32, g: f32) -> Option<(f32, f32, f32, f32)> {
        let (x0, dir, age) = self.ball?;
        if !(0. ..BALL_DUR).contains(&age) {
            return None;
        }
        let u = (age / BALL_DUR).clamp(0., 1.);
        let travel = ease_out(u) * 220. * dir;
        let span = (right_lim - left_lim).max(1.);
        // Reflect cleanly off the strip's inset edges if kicked near a corner.
        let mut bx = x0 + travel;
        if bx < left_lim {
            bx = left_lim + (left_lim - bx).min(span);
        } else if bx > right_lim {
            bx = right_lim - (bx - right_lim).min(span);
        }
        let damp = (1. - u).powi(2);
        let bounce = (age * TAU * 2.1).sin().abs() * 13. * damp;
        let by = g - 2.1 - bounce;
        let spin = ease_out(u) * 14. * dir;
        Some((bx, by, spin, 1. - u * 0.6))
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
    let ball = stir.ball_state(x0 + INSET, x0 + w - INSET, ground);

    let mut prev = usize::MAX;
    for i in 0..count {
        let seed = hash(i as u32 + 1);
        let jitter = (unit(seed ^ 5) - 0.5) * gap * 0.5;
        let base_x = x0 + INSET + (i as f32 + 0.5) * gap + jitter;
        if word && base_x > keep_out.0 && base_x < keep_out.1 {
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
        let mut face = if seed & 1 == 0 { 1. } else { -1. };
        // Shy directly under the cursor, curious just outside it.
        let near = stir.near(base_x);
        let gaze = stir.gaze(base_x);
        let away = if base_x >= stir.x { 1. } else { -1. };
        let mut x = base_x + away * near * 6.5;

        // When the cursor is nearby, figures turn to face it.
        if near > 0.22 {
            face = -away;
        }

        // If a clicked ball is rolling past, nearby figures turn, chase, and boot it.
        let mut chase_kick = 0.;
        if let Some((bx, _, _, fade)) = ball {
            let db = bx - x;
            let dist = db.abs();
            if dist < 95. {
                let pull = (1. - dist / 95.).powi(2) * fade;
                face = if db >= 0. { 1. } else { -1. };
                x += db.clamp(-24., 24.) * 0.38 * pull;
                if dist < 18. {
                    chase_kick = (1. - dist / 18.) * fade;
                }
            }
        }

        // Keep displaced figures out of the central word and inside the strip.
        if word && x > keep_out.0 && x < keep_out.1 {
            x = if base_x <= keep_out.0 { keep_out.0 } else { keep_out.1 };
        }
        x = x.clamp(x0 + INSET, x0 + w - INSET);

        pen.seed = seed;
        pen.stroke = 0;
        let react = React {
            cheer: (near + chase_kick * 0.6).min(1.),
            hop: stir.hop(x, t),
            gaze,
            breeze: (stir.vx / 260.).clamp(-1., 1.) * near,
            kick: chase_kick,
        };
        figure(&mut pen, CHORES[c], x, ground, scale, face, t * speed + unit(seed ^ 9) * 10., react);
    }

    if let Some((bx, by, spin, _)) = ball {
        pen.seed = hash(0xba11);
        pen.stroke = 0;
        pen.width = 1.45;
        pen.oval((bx, by), 2.3, 2.3, spin, 9);
        pen.width = 1.3;
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

/// Returns which letter `0..4` ("K", "O", "N", "E") sits under `x`, if any.
fn hit_letter(wl: f32, x: f32) -> Option<usize> {
    if !(wl - 10. ..=wl + WORD_W + 12.).contains(&x) {
        return None;
    }
    let kx = wl + KW * 0.5;
    let ox = wl + KW + PGAP + ORX;
    let nx = ox + ORX + LGAP + NW * 0.5;
    let ex = ox + ORX + LGAP + NW + PGAP + EW * 0.5;
    let centres = [kx, ox, nx, ex];
    centres
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| (x - **a).abs().total_cmp(&(x - **b).abs()))
        .map(|(i, _)| i)
}

/// Tilt angle (radians), vertical pop, rescue progress (`0..=1`), and celebration
/// when a letter has been clicked and is being heaved back upright by its crew.
fn letter_tip(age: f32) -> (f32, f32, Option<f32>, f32) {
    if !(0. ..TIP_DUR).contains(&age) {
        return (0., 0., None, 0.);
    }
    let max_tilt = 0.46;
    if age < 0.32 {
        // Tip over onto its side with a small pop.
        let u = age / 0.32;
        let tilt = ease_out(u) * max_tilt;
        let pop = -(u * PI).sin() * 3.2;
        (tilt, pop, Some(0.), 0.)
    } else if age < 1.65 {
        // Crew leans in and heaves the letter back up in rhythmic pushes.
        let u = (age - 0.32) / 1.33;
        let heave = (smooth(u) + (u * TAU * 3.).sin() * 0.045 * (1. - u)).clamp(0., 1.);
        let tilt = max_tilt * (1. - heave);
        (tilt, 0., Some(u), 0.)
    } else {
        // Upright again: a brief damped wobble and a cheer from the crew.
        let u = (age - 1.65) / (TIP_DUR - 1.65);
        let wobble = -0.065 * (1. - u) * (u * TAU * 2.2).sin();
        (wobble, 0., None, 1. - u)
    }
}

/// Rotates a point on a letter around its bottom-right pivot `(px, g)`, keeping
/// all strokes on or above the floor `g`.
fn tip_pt((x, y): P, px: f32, g: f32, tilt: f32, lift: f32) -> P {
    if tilt == 0. && lift == 0. {
        return (x, y);
    }
    let (dx, dy) = (x - px, y - g);
    let (s, c) = tilt.sin_cos();
    (px + dx * c - dy * s, (g + dx * s + dy * c + lift).min(g))
}

#[derive(Clone, Copy, Default)]
struct React {
    cheer: f32,
    hop: f32,
    gaze: f32,
    breeze: f32,
    kick: f32,
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

    // K: someone perched on top of the stem; if tipped, they hop down to right it.
    let kx0 = wl;
    let (dx, dy) = jolt(stir, kx0 + KW * 0.5, t, 0.);
    let (tilt, lift, rescue, glee) = letter_tip(stir.tipped[0]);
    let (kx, kt, kg) = (kx0 + dx, top + dy, g);
    let kp = |p: P| tip_pt(p, kx + KW, kg, tilt, lift);
    ink(pen, 1);
    stroke(pen, &[kp((kx, kg)), kp((kx, kt))]);
    stroke(pen, &[kp((kx + KW, kt)), kp((kx + 2., kt + LH * 0.55)), kp((kx + KW + 1., kg))]);
    let r = React {
        cheer: (stir.near(kx0) + glee).min(1.),
        hop: glee * 0.7,
        gaze: stir.gaze(kx0),
        ..Default::default()
    };
    crew(pen, 1);
    if rescue.is_some() {
        let foot = kp((kx + KW, kt)).0 + 5.;
        figure(pen, Chore::Push, foot, g, 1., -1., t * 1.6, r);
    } else {
        let perch = kp((kx, kt));
        figure(pen, Chore::Perch, perch.0, perch.1 - 0.5, 1., 1., t, r);
    }

    // O: rolled back and forth like a wheel, with a pusher and a log-roller.
    // Clicking O sends it bowling further with both crew members hustling.
    let ox = kx0 + KW + PGAP + ORX;
    let o_age = stir.tipped[1];
    let extra_roll = if (0. ..TIP_DUR).contains(&o_age) {
        let u = o_age / TIP_DUR;
        (o_age * TAU * 1.15).sin() * (1. - u) * 11.
    } else {
        0.
    };
    let roll = (t * 0.7).sin() * 5. + extra_roll;
    let (dx, dy) = jolt(stir, ox, t, 1.3);
    let oc = (ox + roll + dx, g - LH * 0.5 + dy.min(0.) - 0.3);
    ink(pen, 2);
    pen.oval(oc, ORX, LH * 0.5, roll / ORX, 14);
    let r = React {
        cheer: stir.near(ox),
        hop: 0.,
        gaze: stir.gaze(ox),
        ..Default::default()
    };
    let hustle = if extra_roll != 0. { 1.8 } else { 1. };
    crew(pen, 3);
    figure(pen, Chore::Push, oc.0 - ORX - 6., g, 1., 1., t * hustle, r);
    crew(pen, 4);
    // Feet on the top of the O, stepping against its roll.
    figure(pen, Chore::Balance, oc.0, oc.1 - LH * 0.5 - 0.6, 0.95, 1., -roll * 1.2, r);

    // N: a slide down the diagonal (and scramble back up the stem), plus a hanger.
    let nx0 = ox + ORX + LGAP;
    let (dx, dy) = jolt(stir, nx0 + NW * 0.5, t, 2.1);
    let (tilt, lift, rescue, glee) = letter_tip(stir.tipped[2]);
    let (nx, nt, ng) = (nx0 + dx, top + dy, g);
    let np = |p: P| tip_pt(p, nx + NW, ng, tilt, lift);
    ink(pen, 3);
    stroke(pen, &[np((nx, ng)), np((nx, nt)), np((nx + NW, ng + dy.min(0.))), np((nx + NW, nt))]);
    let r = React {
        cheer: (stir.near(nx0) + glee).min(1.),
        hop: glee * 0.7,
        gaze: stir.gaze(nx0),
        ..Default::default()
    };
    if rescue.is_some() {
        let edge = np((nx + NW, nt)).0;
        crew(pen, 5);
        figure(pen, Chore::Push, edge + 4., g, 0.95, -1., t * 1.6, r);
        crew(pen, 2);
        figure(pen, Chore::Push, edge + 11., g, 1., -1., t * 1.5 + 0.5, r);
    } else {
        crew(pen, 5);
        let cyc = (t * 0.26).fract();
        if cyc < 0.68 {
            // Smoothly accelerating slide down the diagonal.
            let u = smooth(cyc / 0.68);
            let spt = np((nx + NW * u, nt + (LH + (-dy).min(LH)) * u - 1.));
            figure(pen, Chore::Slide, spt.0, spt.1, 0.95, 1., u, r);
        } else {
            // Hop off at the bottom and trot back to the left stem to climb up.
            let u = smooth((cyc - 0.68) / 0.32);
            let climb_x = nx + NW * (1. - u);
            let climb_y = ng - (u * PI).sin() * 6.;
            figure(pen, Chore::Walk, climb_x, climb_y, 0.95, -1., t * 1.5, r);
        }
        // And someone hanging off its top right corner.
        let hpt = np((nx + NW + 1., nt));
        crew(pen, 2);
        figure(pen, Chore::Hang, hpt.0, hpt.1, 1., 1., t * 1.1, r);
    }

    // E: a painter still finishing the middle bar (or propping E back up if tipped).
    let ex0 = nx0 + NW + PGAP;
    let (dx, dy) = jolt(stir, ex0 + EW * 0.5, t, 3.4);
    let (tilt, lift, rescue, glee) = letter_tip(stir.tipped[3]);
    let (ex, et, eg) = (ex0 + dx, top + dy, g);
    let ep = |p: P| tip_pt(p, ex + EW, eg, tilt, lift);
    ink(pen, 4);
    stroke(pen, &[ep((ex + EW, et)), ep((ex, et)), ep((ex, eg)), ep((ex + EW + 1., eg))]);
    // The bar grows as it is painted, then the painter touches it up again.
    let done = 0.6 + ((t * 0.45).sin() * 0.5 + 0.5) * 0.25;
    let bar_end = ex + EW * done;
    stroke(pen, &[ep((ex, et + LH * 0.5)), ep((bar_end, et + LH * 0.5 + 0.5))]);
    let r = React {
        cheer: (stir.near(ex0) + glee).min(1.),
        hop: glee * 0.7,
        gaze: stir.gaze(ex0),
        ..Default::default()
    };
    crew(pen, 6);
    if rescue.is_some() {
        let edge = ep((ex + EW, et)).0;
        figure(pen, Chore::Push, edge + 5., eg, 1., -1., t * 1.6, r);
    } else {
        figure(pen, Chore::Paint, ex + EW + 9., eg, 1., -1., t, r);
    }
}

#[allow(clippy::too_many_arguments)]
fn figure(pen: &mut Pen, chore: Chore, x: f32, g: f32, s: f32, f: f32, t: f32, react: React) {
    let leg = 9. * s;
    let body = 8. * s;
    let arm = 7. * s;
    let r = 3. * s;
    let phase = t * TAU * 0.9;
    let swing = phase.sin();
    let cos_p = phase.cos();

    // Defaults: standing, arms hanging.
    let mut hip = (x, g - leg);
    let mut lean = react.gaze * 0.1;
    let mut legs = [(0.12, 0.), (-0.12, 0.)];
    let mut arms;

    match chore {
        Chore::Walk => {
            // Strolls along a patrol span, pausing briefly and turning smoothly at each end.
            let (p, dir) = patrol(t);
            let pace = dir.abs();
            hip.0 += p * 14. * s + react.gaze * 3.5 * s;
            hip.1 -= (phase * 2.).cos().abs() * 0.65 * pace;
            lean += 0.08 * dir;
            // Knee bends backward relative to travel direction as the foot lifts.
            let l_lift = cos_p.max(0.) * pace;
            let r_lift = (-cos_p).max(0.) * pace;
            legs = [
                (swing * 0.68 * dir, -0.45 * dir * (0.25 + l_lift)),
                (-swing * 0.68 * dir, -0.45 * dir * (0.25 + r_lift)),
            ];
            arms = [
                (-swing * 0.52 * dir, 0.32 * dir * pace),
                (swing * 0.52 * dir, 0.32 * dir * pace),
            ];
        }
        Chore::Wave => {
            let wv = (t * TAU * 1.4).sin();
            lean += wv * 0.05 * f;
            arms = [(0.3 * -f, 0.), (PI * 0.8 * f, 0.5 * f + wv * 0.5 * f)];
        }
        Chore::Sit => {
            // On a little crate, legs dangling and kicking.
            let crate_h = 5. * s;
            pen.line(&[(x - 4. * s, g), (x - 4. * s, g - crate_h), (x + 4. * s, g - crate_h), (x + 4. * s, g)]);
            hip = (x, g - crate_h);
            let k = swing * 0.28;
            legs = [(PI * 0.5 * f, -PI * 0.5 * f + k), (PI * 0.5 * f, -PI * 0.45 * f - k)];
            arms = [(0.4 * f, 0.4 * f), (0.2 * f, 0.5 * f)];
        }
        Chore::Hop => {
            // Parabolic airtime with a quick squat on landing.
            let cyc = (t * 0.85).fract();
            let (up, squat) = if cyc < 0.62 {
                let u = cyc / 0.62;
                (4. * u * (1. - u), 0.)
            } else {
                let u = (cyc - 0.62) / 0.38;
                (0., (u * PI).sin() * 0.35)
            };
            hip.1 -= (up * 5.8 - squat * 1.8) * s;
            let tuck = up * 0.55 + squat * 0.4;
            legs = [(0.22 + tuck, -tuck * 1.9), (-0.22 - tuck, tuck * 1.9)];
            arms = [(PI * (0.72 + up * 0.22), 0.), (-PI * (0.72 + up * 0.22), 0.)];
        }
        Chore::Carry => {
            // A box held overhead, strolling and bobbing with each step.
            let (p, dir) = patrol(t * 0.75);
            let pace = dir.abs();
            let bob = (phase * 2.).cos().abs() * 0.65 * pace;
            hip.0 += p * 6. * s;
            hip.1 -= bob;
            legs = [
                (swing * 0.38 * dir, -0.25 * dir * pace),
                (-swing * 0.38 * dir, -0.25 * dir * pace),
            ];
            arms = [(PI * 0.88, 0.25), (-PI * 0.88, -0.25)];
            let top = hip.1 - body - arm - 1.;
            let bx = hip.0;
            pen.line(&[
                (bx - 4.5 * s, top),
                (bx + 4.5 * s, top),
                (bx + 4.5 * s, top - 5. * s),
                (bx - 4.5 * s, top - 5. * s),
                (bx - 4.5 * s, top),
            ]);
        }
        Chore::Stretch => {
            let e = smooth(((t * TAU * 0.35).sin() + 1.) * 0.5);
            lean += (e - 0.5) * 0.35;
            arms = [(PI * (0.6 + 0.35 * e), 0.), (-PI * (0.6 + 0.35 * e), 0.)];
            legs = [(0.3, 0.), (-0.3, 0.)];
        }
        Chore::Juggle => {
            arms = [(0.9 + swing * 0.25, 1.2), (-0.9 + swing * 0.25, -1.2)];
            let head_y = hip.1 - body - r * 2.;
            for k in 0..3 {
                let a = t * TAU * 0.7 + k as f32 * TAU / 3.;
                let bx = x + a.cos() * 5. * s + react.breeze * 2.5;
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
            // Kicking a ball that rolls out with eased speed and rolls back.
            let cyc = (t * 0.5).fract();
            let strike = if cyc < 0.25 {
                let u = cyc / 0.25;
                (u * PI).sin()
            } else {
                0.
            };
            let out = if cyc < 0.5 { ease_out(cyc * 2.) } else { 1. - smooth((cyc - 0.5) * 2.) };
            legs = [(0.1, 0.), (f * (0.15 + strike * 1.15), -f * strike * 0.35)];
            arms = [(-0.6 * f, 0.), (0.4 * f, 0.)];
            lean -= f * strike * 0.14;
            let ball = x + f * (6.5 + out * 7.5) * s;
            let lift = (out * PI).sin() * 1.2 * strike;
            pen.ring((ball, g - 1.8 - lift), 1.8);
        }
        Chore::Kite => {
            arms = [(PI * 0.7 * f, 0.3 * f), (0.4 * -f, 0.)];
            let hand = (x + f * 5. * s, hip.1 - body - 3. * s);
            let kx = x + f * (14. + (t * 0.9).sin() * 2.) * s + react.breeze * 6.;
            let ky = g - 24. * s + (t * 1.3).cos() * 1.5 - react.breeze.abs() * 2.;
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
            legs = [(swing * 0.5 - 0.25 * f, -0.3 * f), (-swing * 0.5 - 0.25 * f, -0.3 * f)];
            arms = [(PI * 0.5 * f, 0.15 * f), (PI * 0.42 * f, 0.25 * f)];
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

    // If a kicked ball rolls right past, give it a playful boot.
    if react.kick > 0.05 && !matches!(chore, Chore::Hang | Chore::Slide | Chore::Balance | Chore::Perch) {
        legs[1] = (f * (0.25 + react.kick * 1.05), -f * react.kick * 0.3);
        lean -= f * react.kick * 0.12;
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
    // Figures shift their head slightly toward the cursor when it hovers nearby.
    let head = (
        neck.0 + lean.sin() * r + react.gaze * 1.05 * s,
        neck.1 - r - 0.3 - react.cheer * 0.35 * s,
    );
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

#[cfg(test)]
mod tests {
    use super::*;
    use core::prelude::v1::test;

    fn test_bounds() -> Bounds<Pixels> {
        Bounds {
            origin: point(px(0.), px(700.)),
            size: size(px(1200.), px(STRIP)),
        }
    }

    #[test]
    fn easing_and_patrol_stay_bounded_and_continuous() {
        assert_eq!(smooth(0.), 0.);
        assert_eq!(smooth(1.), 1.);
        assert!((smooth(0.5) - 0.5).abs() < 1e-6);
        assert_eq!(ease_out(0.), 0.);
        assert_eq!(ease_out(1.), 1.);
        assert!(ease_out(0.5) > 0.8);

        for k in 0..100 {
            let (p, dir) = patrol(k as f32 * 0.15);
            assert!((-1. ..=1.).contains(&p));
            assert!((-1. ..=1.).contains(&dir));
        }
    }

    #[test]
    fn hover_tracks_cursor_and_releases_when_busy() {
        let mut h = Hover::default();
        h.strip.set(Some(test_bounds()));

        // Entering the strip wakes the crowd.
        assert!(h.track(point(px(300.), px(720.)), false));
        assert!(h.active());
        let s1 = h.snapshot();
        assert!((s1.x - 300.).abs() < 1.);

        // Moving while busy releases hover instead of tracking.
        assert!(h.track(point(px(340.), px(720.)), true));
        assert!(h.cursor.is_none());
    }

    #[test]
    fn clicking_letter_tips_it_and_clicking_strip_boots_ball() {
        let mut h = Hover::default();
        h.strip.set(Some(test_bounds()));

        // Word sits centered around x = 600; clicking near K tips letter 0.
        let wl = (1200. - WORD_W) * 0.5;
        assert!(h.press(point(px(wl + 8.), px(720.)), false));
        let snap = h.snapshot();
        assert!(snap.tipped[0] >= 0.);
        let (tilt, _, rescue, _) = letter_tip(0.2);
        assert!(tilt > 0.1);
        assert!(rescue.is_some());

        // Clicking out in the open crowd kicks a ball.
        assert!(h.press(point(px(140.), px(720.)), false));
        let snap2 = h.snapshot();
        assert!(snap2.ball.is_some());
        let (bx, by, _, _) = snap2.ball_state(INSET, 1200. - INSET, 763.).unwrap();
        assert!((INSET..=1200. - INSET).contains(&bx));
        assert!(by <= 763.);
    }
}

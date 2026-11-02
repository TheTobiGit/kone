//! A row's lean toward the cursor: inside a small halo around it, the row
//! follows a ninth of the cursor's distance from its centre; outside the
//! halo it glides back to rest.

use std::{
    cell::Cell,
    rc::Rc,
    time::{Duration, Instant},
};

use gpui_kit::*;

/// `cubic-bezier(0.22, 1, 0.36, 1)`: a quick start that glides to rest.
pub fn glide(t: f32) -> f32 {
    let (x1, y1, x2, y2) = (0.22f32, 1f32, 0.36f32, 1f32);
    let bez =
        |a: f32, b: f32, s: f32| 3. * a * s * (1. - s).powi(2) + 3. * b * s * s * (1. - s) + s.powi(3);
    let (mut lo, mut hi) = (0f32, 1f32);
    for _ in 0..24 {
        let mid = (lo + hi) / 2.;
        if bez(x1, x2, mid) < t {
            lo = mid
        } else {
            hi = mid
        }
    }
    bez(y1, y2, (lo + hi) / 2.)
}

/// How far outside a row the cursor starts to pull it, and how weakly: the
/// row moves a ninth of the cursor's distance from its centre.
pub const PADDING: f32 = 12.;
pub const STRENGTH: f32 = 9.;
pub const PULL_IN: Duration = Duration::from_millis(350);
pub const LET_GO: Duration = Duration::from_millis(600);

/// One row's lean toward the cursor, eased like a CSS transform transition:
/// a new target restarts the glide from wherever the row is now.
#[derive(Default)]
pub struct Magnet {
    pub bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    from: (f32, f32),
    to: (f32, f32),
    since: Option<Instant>,
    active: bool,
}

impl Magnet {
    /// The probe to hang inside the row's unmoved wrapper: wherever it paints,
    /// that is the box the pull is measured from.
    pub fn probe(&self) -> Rc<Cell<Option<Bounds<Pixels>>>> {
        self.bounds.clone()
    }

    fn duration(&self) -> Duration {
        if self.active { PULL_IN } else { LET_GO }
    }

    fn progress(&self) -> f32 {
        self.since
            .map_or(1., |t| (t.elapsed().as_secs_f32() / self.duration().as_secs_f32()).min(1.))
    }

    pub fn offset(&self) -> (f32, f32) {
        let e = glide(self.progress());
        (self.from.0 + (self.to.0 - self.from.0) * e, self.from.1 + (self.to.1 - self.from.1) * e)
    }

    /// Returns whether the pull target moved, i.e. whether a repaint is due.
    pub fn track(&mut self, cursor: Point<Pixels>) -> bool {
        let Some(b) = self.bounds.get() else { return false };
        let (w, h) = (f32::from(b.size.width), f32::from(b.size.height));
        let (cx, cy) = (f32::from(b.origin.x) + w / 2., f32::from(b.origin.y) + h / 2.);
        let (dx, dy) = (f32::from(cursor.x) - cx, f32::from(cursor.y) - cy);
        let near = dx.abs() < w / 2. + PADDING && dy.abs() < h / 2. + PADDING;
        let to = if near { (dx / STRENGTH, dy / STRENGTH) } else { (0., 0.) };
        if to != self.to {
            self.from = self.offset();
            self.to = to;
            self.active = near;
            self.since = Some(Instant::now());
            return true;
        }
        false
    }

    /// Glide back to rest, as when the pointer leaves the pull zone.
    pub fn release(&mut self) -> bool {
        if self.to != (0., 0.) {
            self.from = self.offset();
            self.to = (0., 0.);
            self.active = false;
            self.since = Some(Instant::now());
            return true;
        }
        false
    }

    pub fn settling(&self) -> bool {
        self.progress() < 1.
    }
}

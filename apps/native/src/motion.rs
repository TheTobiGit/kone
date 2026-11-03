//! Shared modal and hover motion curves.
use std::time::Duration;
use gpui_ce_motion::{Bezier, Easing, MotionValue, Transition};

pub(crate) const ENTER: Duration = Duration::from_millis(420);
pub(crate) const EXIT: Duration = Duration::from_millis(240);
/// How far below its resting place the card starts, then rises from.
pub(crate) const CARD_RISE: f32 = 12.;
/// The card rises on Electron's `modal-card-in` curve: a small overshoot, so
/// it lands a touch past its slot before settling.
pub(crate) fn card_enter_tween() -> Transition {
    Transition::Tween(ENTER, Easing::Bezier(Bezier::new(0.34, 1.3, 0.64, 1.).expect("valid curve")))
}

/// Opacity is opaque at 45% of the card's arrival, so it never reads as a
/// ghost sliding into place.
pub(crate) fn card_fade_tween() -> Transition {
    Transition::Tween(
        ENTER.mul_f32(0.45),
        Easing::Bezier(Bezier::new(0.34, 1.3, 0.64, 1.).expect("valid curve")),
    )
}

pub(crate) fn scrim_enter_tween() -> Transition {
    Transition::Tween(
        Duration::from_millis(240),
        Easing::Bezier(Bezier::new(0.22, 1., 0.36, 1.).expect("valid curve")),
    )
}

/// CSS `ease` over 180ms: the picker's hover wash, glyphs, and actions.
pub(crate) fn hover_tween() -> Transition {
    Transition::Tween(
        Duration::from_millis(180),
        Easing::Bezier(Bezier::new(0.25, 0.1, 0.25, 1.).expect("valid curve")),
    )
}

/// Eases a hover amount toward its target. A change restarts from wherever it
/// is, the way a CSS transition does. Returns the amount and whether it is
/// still moving.
pub(crate) fn sample_hover(
    value: &mut MotionValue,
    hovering: &mut bool,
    active: bool,
    now: Duration,
) -> (f32, bool) {
    if *hovering != active {
        *hovering = active;
        value.animate(if active { 1. } else { 0. }, hover_tween(), now);
    }
    let sample = value.sample(now, false);
    (sample.value() as f32, sample.is_animating())
}

/// Solves a CSS-style cubic bezier for one axis and returns the eased value.
pub(crate) fn bezier(x1: f32, y1: f32, x2: f32, y2: f32, t: f32) -> f32 {
    let curve = |a: f32, b: f32, s: f32| {
        3. * a * s * (1. - s).powi(2) + 3. * b * s * s * (1. - s) + s.powi(3)
    };
    let (mut lo, mut hi) = (0f32, 1f32);
    for _ in 0..24 {
        let mid = (lo + hi) / 2.;
        if curve(x1, x2, mid) < t {
            lo = mid
        } else {
            hi = mid
        }
    }
    curve(y1, y2, (lo + hi) / 2.)
}


//! Shared easing and the populated home wordmark motion.

use std::sync::OnceLock;

/// Frames per second the glyph animations are sampled at.
pub(crate) const FPS: f32 = 120.0;
/// Glyphs are drawn on a 28-unit grid with the 24-unit artwork centred in it, so
/// strokes that overshoot the 24 box mid-animation (SVG `overflow="visible"`)
/// are not clipped.
pub(crate) const PAD: f32 = 2.0;
pub(crate) const VIEW: f32 = 24.0 + PAD * 2.0;
/// CSS `cubic-bezier(x1, y1, x2, y2)` at `x`.
pub(crate) fn bezier([x1, y1, x2, y2]: [f32; 4], x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    let sample = |a: f32, b: f32, t: f32| {
        let u = 1.0 - t;
        3.0 * u * u * t * a + 3.0 * u * t * t * b + t * t * t
    };
    let (mut lo, mut hi, mut t) = (0.0f32, 1.0f32, x);
    for _ in 0..8 {
        let u = 1.0 - t;
        let slope = 3.0 * u * u * x1 + 6.0 * u * t * (x2 - x1) + 3.0 * t * t * (1.0 - x2);
        if slope.abs() < 1e-6 {
            break;
        }
        t = (t - (sample(x1, x2, t) - x) / slope).clamp(0.0, 1.0);
    }
    for _ in 0..40 {
        let v = sample(x1, x2, t);
        if (v - x).abs() < 1e-6 {
            break;
        }
        if v < x {
            lo = t;
        } else {
            hi = t;
        }
        t = (lo + hi) / 2.0;
    }
    sample(y1, y2, t)
}

pub(crate) const WORD_SETS: [[&str; 4]; 5] = [
    ["kompiled.", "kompatible.", "konkurrent.", "konekted."],
    ["kached.", "kohesive.", "konfigured.", "konektiv."],
    ["krafted.", "kollaborative.", "kontinuous.", "konektable."],
    ["klustered.", "komposable.", "konsistent.", "konektor."],
    ["kompact.", "kompressed.", "konverged.", "konexus."],
];
pub(crate) const BRAND: &str = "kone.";
pub(crate) const WORD_COUNT: usize = 25;

/// Word `i` of the rotation, how many leading letters are accent-coloured, and
/// how long it shows (ms) before the next.
pub(crate) fn word(i: usize) -> (&'static str, usize, f32) {
    let (set, slot) = (i / 5 % 5, i % 5);
    if slot == 4 {
        (BRAND, BRAND.len(), 4.6)
    } else {
        (WORD_SETS[set][slot], slot + 1, 2.2)
    }
}

pub(crate) const STAGGER: f32 = 0.03;

/// motion's spring (stiffness 300, damping 25, mass 1) from `from` to `to`.
pub(crate) fn spring(t: f32, from: f32, to: f32) -> f32 {
    if t <= 0.0 {
        return from;
    }
    let w0 = 300.0f32.sqrt();
    let zeta = 25.0 / (2.0 * w0);
    let wd = w0 * (1.0 - zeta * zeta).sqrt();
    let delta = to - from;
    let envelope = (-zeta * w0 * t).exp();
    to - envelope * ((zeta * w0 * delta) / wd * (wd * t).sin() + delta * (wd * t).cos())
}

/// When motion calls a spring from `from` to `to` finished: its rest speed and
/// rest delta, granular for small ranges such as opacity.
fn settle(from: f32, to: f32) -> f32 {
    let (speed, delta) = if (to - from).abs() < 5.0 {
        (0.01, 0.005)
    } else {
        (2.0, 0.5)
    };
    let mut t = 0.0f32;
    while t < 5.0 {
        t += 1.0 / 60.0;
        let now = spring(t, from, to);
        let v = (now - spring(t - 0.005, from, to)) / 0.005;
        if v.abs() <= speed && (to - now).abs() <= delta {
            return t;
        }
    }
    t
}

/// Seconds a letter's enter (y 100% → 0, opacity 0 → 1) and exit (y 0 → −120%,
/// opacity 1 → 0) springs take to finish.
pub(crate) fn letter_settle() -> (f32, f32) {
    static SETTLE: OnceLock<(f32, f32)> = OnceLock::new();
    *SETTLE.get_or_init(|| {
        (
            settle(100.0, 0.0).max(settle(0.0, 1.0)),
            settle(0.0, -120.0).max(settle(1.0, 0.0)),
        )
    })
}

/// A letter `t` seconds into its own (already staggered) enter or exit:
/// its offset as a fraction of its height, and its opacity.
#[allow(dead_code)]
pub(crate) fn letter(t: f32, entering: bool) -> (f32, f32) {
    if entering {
        (spring(t, 1.0, 0.0), spring(t, 0.0, 1.0).clamp(0.0, 1.0))
    } else {
        (spring(t, 0.0, -1.2), spring(t, 1.0, 0.0).clamp(0.0, 1.0))
    }
}

/// Seconds the exit of an `n`-letter word holds `AnimatePresence mode="wait"`.
pub(crate) fn exit_span(n: usize) -> f32 {
    n.saturating_sub(1) as f32 * STAGGER + letter_settle().1
}

/// Seconds until an `n`-letter word's entrance has settled.
pub(crate) fn enter_span(n: usize) -> f32 {
    n.saturating_sub(1) as f32 * STAGGER + letter_settle().0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bezier_matches_css_endpoints_and_midpoint() {
        assert_eq!(bezier([0.42, 0.0, 0.58, 1.0], 0.0), 0.0);
        assert_eq!(bezier([0.42, 0.0, 0.58, 1.0], 1.0), 1.0);
        assert!((bezier([0.42, 0.0, 0.58, 1.0], 0.5) - 0.5).abs() < 1e-4);
        // ease-out (0.22, 1, 0.36, 1) is well past halfway at a quarter.
        assert!(bezier([0.22, 1.0, 0.36, 1.0], 0.25) > 0.6);
    }

    #[test]
    fn wordmark_rotation_matches_electron_sets() {
        assert_eq!(word(0), ("kompiled.", 1, 2.2));
        assert_eq!(word(3), ("konekted.", 4, 2.2));
        assert_eq!(word(4), ("kone.", 5, 4.6));
        assert_eq!(word(5), ("kached.", 1, 2.2));
        assert_eq!(word(24), ("kone.", 5, 4.6));
        let (enter, exit) = letter_settle();
        assert!(
            (0.3..1.2).contains(&enter) && (0.3..1.2).contains(&exit),
            "{enter} {exit}"
        );
        assert_eq!(letter(0.0, true), (1.0, 0.0));
        assert_eq!(letter(0.0, false), (0.0, 1.0));
    }
}

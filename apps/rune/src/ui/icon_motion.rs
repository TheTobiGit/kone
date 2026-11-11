//! Hover gestures for the home screens' animated icons.
//!
//! Electron's `components/icons/animated/*.vue` are motion-v components: on
//! `mouseenter` they run a short keyframe track over the glyph's `<g>` (or over
//! a few of its paths) and settle back at rest. Rune's declarative motion has no
//! keyframe tracks, so — like the start screen's action glyphs in
//! `start_motion.rs` — every frame is sampled once into an `Icon` and the app
//! steps them from its poll clock. Every number below is copied from the Vue
//! source.
//!
//! The sampled glyphs share the start glyphs' padded grid (24-unit artwork
//! centred in a 28-unit box) so a rotation that pushes a path past its 24-unit
//! box is not clipped; [`GLYPH`] is the size multiplier that keeps the artwork
//! at its authored point size.

use super::start_motion::{FPS, PAD, VIEW, bezier};
use rune::Icon;
use std::sync::OnceLock;

/// Draw size for a sampled gesture icon authored at `size` points.
pub(crate) const GLYPH: f32 = VIEW / 24.0;

/// The five hover gestures, plus the pinned pin (a heavier stroke).
pub(crate) const PIN: usize = 0;
pub(crate) const PINNED: usize = 1;
pub(crate) const FINDER: usize = 2;
pub(crate) const CANCEL: usize = 3;
const KINDS: usize = 4;

/// Seconds each gesture runs, from its longest `transition.duration`.
const LEN: [f32; KINDS] = [0.5, 0.5, 0.58, 1.06];

/// CSS `cubic-bezier` shared by the icon sources.
const EASE: [f32; 4] = [0.23, 1.0, 0.32, 1.0];
const SNAP: [f32; 4] = [0.77, 0.0, 0.175, 1.0];
const LINEAR: [f32; 4] = [0.0, 0.0, 1.0, 1.0];

/// A motion keyframe track: one value per keyframe at `times` (fractions of the
/// run), each segment eased by its own curve.
struct Table {
    values: Vec<f32>,
    times: Vec<f32>,
    eases: Vec<[f32; 4]>,
}

impl Table {
    /// Motion's default: keyframes evenly spaced over the run.
    fn even(values: &[f32], ease: [f32; 4]) -> Table {
        let n = values.len();
        let times = (0..n).map(|i| i as f32 / (n.max(2) - 1) as f32).collect();
        Table {
            values: values.to_vec(),
            times,
            eases: vec![ease; n.saturating_sub(1)],
        }
    }

    fn timed(values: &[f32], times: &[f32], eases: &[[f32; 4]]) -> Table {
        Table {
            values: values.to_vec(),
            times: times.to_vec(),
            eases: eases.to_vec(),
        }
    }

    fn at(&self, p: f32) -> f32 {
        if p <= self.times[0] {
            return self.values[0];
        }
        for i in 0..self.values.len() - 1 {
            if p < self.times[i + 1] {
                let span = self.times[i + 1] - self.times[i];
                let local = if span <= 0.0 {
                    1.0
                } else {
                    (p - self.times[i]) / span
                };
                let a = self.values[i];
                return a + (self.values[i + 1] - a) * bezier(self.eases[i], local);
            }
        }
        self.values[self.values.len() - 1]
    }
}

/// Where `t` seconds sits in a sub-animation that starts at `start` and runs `dur`.
fn local(t: f32, start: f32, dur: f32) -> f32 {
    ((t - start) / dur).clamp(0.0, 1.0)
}

/// An affine matrix `[a, b, c, d, e, f]`, as SVG `matrix(...)`.
type M = [f32; 6];

fn mul(a: M, b: M) -> M {
    [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ]
}

/// `translate(tx, ty) rotate(deg) scale(sx, sy)` about `origin`, in user units.
fn about(origin: [f32; 2], deg: f32, sx: f32, sy: f32, tx: f32, ty: f32) -> M {
    let (sin, cos) = deg.to_radians().sin_cos();
    let spin: M = [cos * sx, sin * sx, -sin * sy, cos * sy, 0.0, 0.0];
    let [ox, oy] = origin;
    mul(
        [1.0, 0.0, 0.0, 1.0, ox + tx, oy + ty],
        mul(spin, [1.0, 0.0, 0.0, 1.0, -ox, -oy]),
    )
}

fn path(d: &str, stroke: f32, m: M, opacity: f32) -> String {
    // The glyph grid pads the 24-unit artwork by `PAD` on every side.
    let m = mul([1.0, 0.0, 0.0, 1.0, PAD, PAD], m);
    let alpha = if opacity >= 1.0 {
        String::new()
    } else {
        format!(r#" stroke-opacity="{opacity:.3}""#)
    };
    format!(
        r#"<path d="{d}" fill="none" stroke="currentColor" stroke-width="{stroke:.1}" stroke-linecap="round" stroke-linejoin="round"{alpha} transform="matrix({:.6} {:.6} {:.6} {:.6} {:.4} {:.4})"/>"#,
        m[0], m[1], m[2], m[3], m[4], m[5]
    )
}

/// A straight line's visible window under SVG `pathLength`/`pathOffset`:
/// `[offset, offset + length]` of the normalized path, clamped.
fn trim_line(from: [f32; 2], to: [f32; 2], offset: f32, length: f32) -> Option<String> {
    let (a, b) = (offset.clamp(0.0, 1.0), (offset + length).clamp(0.0, 1.0));
    if b - a <= 1e-4 {
        return None;
    }
    let at = |u: f32| {
        [
            from[0] + (to[0] - from[0]) * u,
            from[1] + (to[1] - from[1]) * u,
        ]
    };
    let (p, q) = (at(a), at(b));
    Some(format!("M{:.4} {:.4}L{:.4} {:.4}", p[0], p[1], q[0], q[1]))
}

const PIN_HEAD: &str = "M13.2585 18.8714C9.51516 18.0215 5.97844 14.4848 5.12853 10.7415C4.99399 10.1489 4.92672 9.85266 5.12161 9.37197C5.3165 8.89129 5.55457 8.74255 6.03071 8.44509C7.10705 7.77265 8.27254 7.55888 9.48209 7.66586C11.1793 7.81598 12.0279 7.89104 12.4512 7.67048C12.8746 7.44991 13.1622 6.93417 13.7376 5.90269L14.4664 4.59604C14.9465 3.73528 15.1866 3.3049 15.7513 3.10202C16.316 2.89913 16.6558 3.02199 17.3355 3.26771C18.9249 3.84236 20.1576 5.07505 20.7323 6.66449C20.978 7.34417 21.1009 7.68401 20.898 8.2487C20.6951 8.8134 20.2647 9.05346 19.4039 9.53358L18.0672 10.2792C17.0376 10.8534 16.5229 11.1406 16.3024 11.568C16.0819 11.9955 16.162 12.8256 16.3221 14.4859C16.4399 15.7068 16.2369 16.88 15.5555 17.9697C15.2577 18.4458 15.1088 18.6839 14.6283 18.8786C14.1477 19.0733 13.8513 19.006 13.2585 18.8714Z";

/// `Pin.vue`: the pin wobbles in its socket about the 24-unit centre.
fn pin(t: f32, stroke: f32) -> String {
    let x = Table::even(&[0.0, -0.8, 0.3, 0.0], EASE);
    let y = Table::even(&[0.0, 0.8, -0.3, 0.0], EASE);
    let r = Table::even(&[0.0, -2.0, 0.8, 0.0], EASE);
    let p = local(t, 0.0, 0.5);
    let m = about([12.0, 12.0], r.at(p), 1.0, 1.0, x.at(p), y.at(p));
    path("M3 21L8 16", stroke, m, 1.0) + &path(PIN_HEAD, stroke, m, 1.0)
}

/// `AppleFinder.vue`: the face tilts while the eyes squint and the smile flexes.
fn finder(t: f32) -> String {
    let r = Table::even(&[0.0, -6.0, 2.0, 0.0], EASE);
    let eye = Table::even(&[1.0, 0.25, 1.0], EASE);
    let smile = Table::even(&[1.0, 1.22, 0.96, 1.0], EASE);
    let face = about([12.0, 12.0], r.at(local(t, 0.0, 0.58)), 1.0, 1.0, 0.0, 0.0);
    let squint = eye.at(local(t, 0.12, 0.32));
    let grin = smile.at(local(t, 0.08, 0.5));
    let eyes_l = mul(face, about([7.0, 9.0], 0.0, 1.0, squint, 0.0, 0.0));
    let eyes_r = mul(face, about([17.0, 9.0], 0.0, 1.0, squint, 0.0, 0.0));
    let mouth = mul(face, about([12.0, 16.5], 0.0, 1.0, grin, 0.0, 0.0));
    let rect = "M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z";
    let nose = "M12.9896 2.5C12.1238 3.78525 10.5163 7.71349 10.0737 11.5798C9.98097 12.3899 9.9346 12.795 10.1905 13.1176C10.2151 13.1486 10.2474 13.1843 10.2757 13.212C10.5708 13.5 11.0149 13.5 11.9031 13.5C12.3889 13.5 12.6317 13.5 12.7766 13.6314C12.7923 13.6457 12.8051 13.6588 12.819 13.6748C12.9468 13.8225 12.9383 14.072 12.9212 14.5709C12.8685 16.1156 12.9401 19.0524 14 21.5";
    path(rect, 1.7, face, 1.0)
        + &path(nose, 1.7, face, 1.0)
        + &path("M7 8V10", 1.7, eyes_l, 1.0)
        + &path("M17 8V10", 1.7, eyes_r, 1.0)
        + &path("M7 16.5C10.5 18.5 13.5 18.5 17 16.5", 1.7, mouth, 1.0)
}

/// `Cancel01.vue`: both strikes erase and redraw with a lift-off flourish, and
/// the whole glyph takes one shared settle when the second lands.
fn cancel(t: f32) -> String {
    let first_times = &[0.0, 0.05, 0.22, 0.25, 0.34, 0.38, 0.58, 1.0][..];
    let second_times = &[0.0, 0.1, 0.27, 0.3, 0.64, 0.7, 0.9, 1.0][..];
    let eases = &[LINEAR, SNAP, LINEAR, LINEAR, LINEAR, SNAP, LINEAR][..];
    let impact = Table::timed(
        &[0.0, 0.0, -0.35, 0.0],
        &[0.0, 0.78, 0.9, 1.0],
        &[LINEAR, EASE, EASE],
    );
    let rot = Table::timed(
        &[0.0, 0.0, 0.8, 0.0],
        &[0.0, 0.78, 0.9, 1.0],
        &[LINEAR, EASE, EASE],
    );
    let scale = Table::timed(
        &[1.0, 1.0, 1.08, 1.0],
        &[0.0, 0.78, 0.9, 1.0],
        &[LINEAR, EASE, EASE],
    );
    let p = local(t, 0.0, 1.04);
    let s = scale.at(p);
    let m = about([12.0, 12.0], rot.at(p), s, s, 0.0, impact.at(p));
    let strike = |from: [f32; 2], to: [f32; 2], times: &[f32]| {
        let length = Table::timed(&[1.0, 1.0, 0.12, 0.0, 0.0, 0.12, 1.0, 1.0], times, eases);
        let offset = Table::timed(&[0.0, 0.0, 0.88, 1.0, 0.0, 0.0, 0.0, 0.0], times, eases);
        let visible = Table::timed(&[1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0], times, eases);
        let q = local(t, 0.0, 0.9);
        if visible.at(q) < 0.5 {
            return String::new();
        }
        trim_line(from, to, offset.at(q), length.at(q))
            .map_or(String::new(), |d| path(&d, 2.0, m, 1.0))
    };
    // The lift-off ticks draw in while fading in, then fade out.
    let flourish = |from: [f32; 2], to: [f32; 2], dur: f32, times: &[f32]| {
        let q = local(t, 0.0, dur);
        let opacity = Table::timed(&[0.0, 0.0, 1.0, 0.0], times, &[LINEAR, EASE, EASE]).at(q);
        let length = Table::timed(&[0.0, 0.0, 1.0, 1.0], times, &[LINEAR, EASE, EASE]).at(q);
        if opacity <= 0.01 || length <= 0.01 {
            return String::new();
        }
        trim_line(from, to, 0.0, length).map_or(String::new(), |d| path(&d, 2.0, m, opacity))
    };
    strike([18.0, 6.0], [6.00081, 17.9992], first_times)
        + &strike([6.0, 6.00085], [17.9992, 18.0], second_times)
        + &flourish(
            [6.00081, 17.9992],
            [5.1, 18.9],
            0.76,
            &[0.0, 0.69, 0.84, 1.0],
        )
        + &flourish(
            [17.9992, 18.0],
            [18.9, 18.9008],
            1.06,
            &[0.0, 0.77, 0.88, 1.0],
        )
}

fn body(kind: usize, t: f32) -> String {
    match kind {
        PIN => pin(t, 1.8),
        PINNED => pin(t, 2.4),
        FINDER => finder(t),
        CANCEL => cancel(t),
        _ => unreachable!(),
    }
}

/// Seconds gesture `kind` runs for.
#[allow(dead_code)]
pub(crate) fn len(kind: usize) -> f32 {
    LEN[kind]
}

/// Every frame of gesture `kind`; the last is rest.
pub(crate) fn frames(kind: usize) -> &'static [&'static Icon] {
    static TABLES: [OnceLock<Vec<&'static Icon>>; KINDS] = [
        OnceLock::new(),
        OnceLock::new(),
        OnceLock::new(),
        OnceLock::new(),
    ];
    TABLES[kind].get_or_init(|| {
        let duration = LEN[kind];
        let count = (duration * FPS).ceil() as usize + 1;
        (0..count)
            .map(|i| {
                let t = (i as f32 / FPS).min(duration);
                let name: &'static str = Box::leak(format!("gesture-{kind}-{i}").into_boxed_str());
                let body: &'static str = Box::leak(body(kind, t).into_boxed_str());
                &*Box::leak(Box::new(Icon {
                    name,
                    view: VIEW,
                    body,
                }))
            })
            .collect()
    })
}

/// Gesture `kind` `elapsed` seconds in, or at rest.
pub(crate) fn gesture(kind: usize, elapsed: Option<f32>) -> &'static Icon {
    let table = frames(kind);
    let index = elapsed.map_or(table.len() - 1, |e| {
        ((e.max(0.0) * FPS) as usize).min(table.len() - 1)
    });
    table[index]
}

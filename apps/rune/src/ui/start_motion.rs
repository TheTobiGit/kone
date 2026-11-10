//! Frame-exact ports of the start screen's motion-v animations.
//!
//! Electron morphs SVG path data and applies CSS transforms (one of them a
//! `perspective()` tilt) to the start-action glyphs, and springs the wordmark's
//! letters in and out. Rune's declarative motion can't express path morphs, so
//! the glyphs are sampled once into per-frame icons and the app steps them from
//! its poll clock; the wordmark letters are placed per frame from the same
//! spring motion-v integrates. Every number below is copied from the Electron
//! source (`components/icons/animated/*.vue`, `components/ui/rotating-text`).

use rune::Icon;
use std::sync::OnceLock;

/// Frames per second the glyph animations are sampled at.
pub(crate) const FPS: f32 = 120.0;
/// Glyphs are drawn on a 28-unit grid with the 24-unit artwork centred in it, so
/// strokes that overshoot the 24 box mid-animation (SVG `overflow="visible"`)
/// are not clipped.
const PAD: f32 = 2.0;
pub(crate) const VIEW: f32 = 24.0 + PAD * 2.0;
/// Electron's glyphs are 18 px on the 24 grid; this is the same scale on 28.
pub(crate) const GLYPH: f32 = 18.0 * VIEW / 24.0;

/// Seconds each action glyph's gesture runs: plus, folder, github.
pub(crate) const DURATIONS: [f32; 3] = [0.55, 0.84, 0.72];

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

const EASE_IN_OUT: [f32; 4] = [0.42, 0.0, 0.58, 1.0];
const ICON_EASE: [f32; 4] = [0.77, 0.0, 0.175, 1.0];

/// A motion keyframe track: `values` at `times` (0..1 of the run), each segment
/// eased by `ease`, as motion does for one easing over several keyframes.
fn track(values: &[f32], times: &[f32], ease: [f32; 4], p: f32) -> f32 {
    if p <= 0.0 {
        return values[0];
    }
    for i in 0..values.len() - 1 {
        if p < times[i + 1] {
            let local = (p - times[i]) / (times[i + 1] - times[i]);
            return values[i] + (values[i + 1] - values[i]) * bezier(ease, local);
        }
    }
    values[values.len() - 1]
}

/// Path data as commands and their numbers.
#[derive(Clone)]
struct Path(Vec<(char, Vec<f32>)>);

impl Path {
    fn parse(d: &str) -> Path {
        let mut out: Vec<(char, Vec<f32>)> = Vec::new();
        let mut num = String::new();
        let flush = |num: &mut String, out: &mut Vec<(char, Vec<f32>)>| {
            if !num.is_empty() {
                out.last_mut()
                    .expect("path starts with a command")
                    .1
                    .push(num.parse().expect("number"));
                num.clear();
            }
        };
        for ch in d.chars() {
            if ch.is_ascii_alphabetic() {
                flush(&mut num, &mut out);
                out.push((ch, Vec::new()));
            } else if ch == ' ' || ch == ',' {
                flush(&mut num, &mut out);
            } else if ch == '-' && !num.is_empty() {
                flush(&mut num, &mut out);
                num.push(ch);
            } else {
                num.push(ch);
            }
        }
        flush(&mut num, &mut out);
        Path(out)
    }

    /// motion's string interpolation: every number of matching paths tweens.
    fn morph(frames: &[Path], times: &[f32], ease: [f32; 4], p: f32) -> Path {
        let mut out = frames[0].clone();
        for (c, (_, nums)) in out.0.iter_mut().enumerate() {
            for (n, value) in nums.iter_mut().enumerate() {
                let values: Vec<f32> = frames.iter().map(|f| f.0[c].1[n]).collect();
                *value = track(&values, times, ease, p);
            }
        }
        out
    }

    /// Absolute points as M/L/C/Z segments (only absolute commands appear in
    /// Electron's glyphs).
    fn segments(&self) -> Vec<(char, Vec<[f32; 2]>)> {
        let mut out = Vec::new();
        let mut at = [0.0f32; 2];
        for (cmd, nums) in &self.0 {
            match cmd {
                'M' | 'L' => {
                    for pair in nums.chunks(2) {
                        at = [pair[0], pair[1]];
                        out.push((*cmd, vec![at]));
                    }
                }
                'H' => {
                    for x in nums {
                        at = [*x, at[1]];
                        out.push(('L', vec![at]));
                    }
                }
                'V' => {
                    for y in nums {
                        at = [at[0], *y];
                        out.push(('L', vec![at]));
                    }
                }
                'C' => {
                    for six in nums.chunks(6) {
                        let pts = vec![[six[0], six[1]], [six[2], six[3]], [six[4], six[5]]];
                        at = pts[2];
                        out.push(('C', pts));
                    }
                }
                'Z' | 'z' => out.push(('Z', Vec::new())),
                other => panic!("unsupported path command {other}"),
            }
        }
        out
    }

    /// The geometry's bounding box (SVG `fill-box`): [x0, y0, x1, y1].
    fn bbox(&self) -> [f32; 4] {
        let mut b = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
        let mut add = |p: [f32; 2]| {
            b[0] = b[0].min(p[0]);
            b[1] = b[1].min(p[1]);
            b[2] = b[2].max(p[0]);
            b[3] = b[3].max(p[1]);
        };
        let mut at = [0.0f32; 2];
        for (cmd, pts) in self.segments() {
            match cmd {
                'C' => {
                    for i in 0..=64 {
                        let t = i as f32 / 64.0;
                        let u = 1.0 - t;
                        let w = [u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t];
                        add([
                            w[0] * at[0] + w[1] * pts[0][0] + w[2] * pts[1][0] + w[3] * pts[2][0],
                            w[0] * at[1] + w[1] * pts[0][1] + w[2] * pts[1][1] + w[3] * pts[2][1],
                        ]);
                    }
                    at = pts[2];
                }
                'Z' => {}
                _ => {
                    at = pts[0];
                    add(at);
                }
            }
        }
        b
    }

    /// The path with every curve replaced by a polyline that stays within
    /// `tolerance` of it, keeping M/L/Z only.
    fn flattened(&self, tolerance: f32) -> Path {
        let mut out: Vec<(char, Vec<f32>)> = Vec::new();
        let mut at = [0.0f32; 2];
        for (cmd, pts) in self.segments() {
            match cmd {
                'C' => {
                    let len = dist(at, pts[0]) + dist(pts[0], pts[1]) + dist(pts[1], pts[2]);
                    let steps = ((len / tolerance).sqrt() * 0.5).ceil().clamp(1.0, 512.0) as usize;
                    for i in 1..=steps {
                        let t = i as f32 / steps as f32;
                        let u = 1.0 - t;
                        let w = [u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t];
                        out.push((
                            'L',
                            vec![
                                w[0] * at[0]
                                    + w[1] * pts[0][0]
                                    + w[2] * pts[1][0]
                                    + w[3] * pts[2][0],
                                w[0] * at[1]
                                    + w[1] * pts[0][1]
                                    + w[2] * pts[1][1]
                                    + w[3] * pts[2][1],
                            ],
                        ));
                    }
                    at = pts[2];
                }
                'Z' => out.push(('Z', Vec::new())),
                _ => {
                    at = pts[0];
                    out.push((cmd, vec![at[0], at[1]]));
                }
            }
        }
        Path(out)
    }

    /// Path data with every point sent through `map`.
    fn mapped(&self, map: impl Fn([f32; 2]) -> [f32; 2]) -> String {
        let mut d = String::new();
        for (cmd, pts) in self.segments() {
            d.push(cmd);
            let mut first = true;
            for p in pts {
                let [x, y] = map(p);
                if !first {
                    d.push(' ');
                }
                first = false;
                d.push_str(&format!("{x:.4} {y:.4}"));
            }
        }
        d
    }
}

const ROUND: &str = r#" stroke-linecap="round" stroke-linejoin="round""#;

fn stroke(d: &str, round: bool, transform: Option<[f32; 6]>) -> String {
    let transform = transform.map_or(String::new(), |[a, b, c, dd, e, f]| {
        format!(r#" transform="matrix({a:.6} {b:.6} {c:.6} {dd:.6} {e:.4} {f:.4})""#)
    });
    format!(
        r#"<path d="{d}" fill="none" stroke="currentColor" stroke-width="1.7"{}{transform}/>"#,
        if round { ROUND } else { "" }
    )
}

fn pad(p: [f32; 2]) -> [f32; 2] {
    [p[0] + PAD, p[1] + PAD]
}

fn dist(a: [f32; 2], b: [f32; 2]) -> f32 {
    ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt()
}

/// `PlusSign.vue`: two strokes that overshoot long, pinch short and settle.
fn plus(t: f32) -> String {
    let times = [0.0, 0.32, 0.68, 1.0];
    let stem = ["M12 4V20", "M12 2.6V21.4", "M12 4.6V19.4", "M12 4V20"].map(Path::parse);
    let arm = ["M20 12H4", "M21.4 12H2.6", "M19.4 12H4.6", "M20 12H4"].map(Path::parse);
    let stem = Path::morph(&stem, &times, EASE_IN_OUT, t / 0.5);
    let arm = Path::morph(&arm, &times, EASE_IN_OUT, (t - 0.05) / 0.5);
    stroke(&stem.mapped(pad), true, None) + &stroke(&arm.mapped(pad), true, None)
}

const FOLDER_BACK: &str = "M2.5 20V8.87695C2.5 7.58945 2.5 6.9457 2.78533 6.47048C2.9541 6.18939 3.18939 5.9541 3.47048 5.78533C3.9457 5.5 4.59449 5.5 5.89206 5.5C6.52339 5.5 6.83906 5.5 7.12612 5.58819C7.31759 5.64702 7.49914 5.73428 7.66469 5.84705C7.91289 6.01611 8.10859 6.26074 8.5 6.75C8.89141 7.23926 9.08711 7.48389 9.33531 7.65295C9.50086 7.76572 9.68241 7.85298 9.87388 7.91181C10.1609 8 10.4742 8 11.1008 8H15C16.4045 8 17.1067 8 17.6111 8.33706C17.8295 8.48298 18.017 8.67048 18.1629 8.88886C18.5 9.39331 18.5 10.0955 18.5 11.5";
const FOLDER_FLAP: &str = "M4.42028 14.0144L3.63368 16.0144C2.65618 18.4998 2.16743 19.7425 2.7524 20.6213C3.33737 21.5 4.65337 21.5 7.28537 21.5H15.1903C16.4249 21.5 17.0422 21.5 17.5295 21.1795C18.0169 20.859 18.2702 20.2865 18.7769 19.1415L19.6618 17.1415C20.7866 14.5992 21.349 13.3281 20.7679 12.4141C20.1868 11.5 18.8163 11.5 16.0752 11.5H8.07196C6.78232 11.5 6.1375 11.5 5.63811 11.8439C5.13872 12.1877 4.89924 12.7966 4.42028 14.0144Z";
const FOLDER_PAPER: &str = "M11.5 4.51456C12.4151 3.28409 13.6662 2.55594 15.5125 2.50161C16.1155 2.48386 16.7152 2.61395 17.2682 2.85544C18.5748 3.42601 19.4185 4.15644 20 5.5L21.5 3";

/// `perspective(70px)`, the flap's distance from the viewer in user units.
const EYE_DISTANCE: f32 = 70.0;

/// CSS `transform-box: fill-box` gives the flap two different reference points:
/// `transform-origin` (`originX: 0.5`, `originY: 1`) is the bottom centre it
/// turns and squashes about, while `perspective()` looks at whatever
/// `perspective-origin` names — left at its default `50% 50%`, the fill-box
/// centre, not the origin. Baking the tilt with the hinge as the vanishing
/// point lifts the flap by 0.4 units at its peak.
struct Flap {
    hinge: [f32; 2],
    eye: [f32; 2],
}

impl Flap {
    fn new(b: [f32; 4]) -> Flap {
        let cx = (b[0] + b[2]) / 2.0;
        Flap {
            hinge: [cx, b[3]],
            eye: [cx, (b[1] + b[3]) / 2.0],
        }
    }

    /// `translateY(ty) rotateX(tilt) scaleY(squash)` about the hinge, seen
    /// through `perspective(70px)` at the eye.
    fn project(&self, [x, y]: [f32; 2], ty: f32, tilt: f32, squash: f32) -> [f32; 2] {
        let (sin, cos) = tilt.sin_cos();
        let dy = y - self.hinge[1];
        let w = 1.0 - squash * sin * dy / EYE_DISTANCE;
        let at = [x, self.hinge[1] + ty + squash * cos * dy];
        [
            self.eye[0] + (at[0] - self.eye[0]) / w,
            self.eye[1] + (at[1] - self.eye[1]) / w,
        ]
    }
}

/// `FolderOpen.vue`: the front flap hinges toward the viewer under
/// `perspective(70px)` while the back and the paper lift.
fn folder(t: f32) -> String {
    let p = t / 0.84;
    let times = [0.0, 0.14, 0.34, 0.5, 0.66, 0.86, 1.0];
    let at = |values: [f32; 7]| track(&values, &times, ICON_EASE, p);
    let back = at([0.0, -0.2, -0.55, -0.7, -0.55, -0.2, 0.0]);
    let paper = at([0.0, -0.25, -0.9, -1.35, -0.9, -0.25, 0.0]);
    let flap_y = at([0.0, 0.25, 0.9, 1.25, 0.9, 0.25, 0.0]);
    let tilt = at([0.0, -10.0, -28.0, -36.0, -28.0, -10.0, 0.0]).to_radians();
    let squash = at([1.0, 0.99, 0.94, 0.9, 0.94, 0.99, 1.0]);
    let flap = Path::parse(FOLDER_FLAP);
    let flap = Flap::new(flap.bbox());
    // A projection isn't affine, so the curves are flattened before their
    // points are mapped: mapping control points would draw another cubic.
    let flap = Path::parse(FOLDER_FLAP)
        .flattened(0.001)
        .mapped(|q| pad(flap.project(q, flap_y, tilt, squash)));
    stroke(
        &Path::parse(FOLDER_BACK).mapped(|[x, y]| pad([x, y + back])),
        true,
        None,
    ) + &stroke(&flap, false, None)
        + &stroke(
            &Path::parse(FOLDER_PAPER).mapped(|[x, y]| pad([x, y + paper])),
            true,
            None,
        )
}

const TAIL: [&str; 5] = [
    "M10 20.5675C8.28572 21.1462 6.71429 21.1462 5.35715 20.5556C4.00001 19.965 2.85715 18.7838 2 17",
    "M10 20.5675C8.18 21.24 6.48 21.04 4.86 19.94C3.05 18.7 1.08 16.05 0.36 13.6",
    "M10 20.5675C8.2 21.18 6.34 20.72 4.68 19.26C2.82 17.62 0.48 14.65 0.82 12.55",
    "M10 20.5675C8.3 21.42 6.58 21.72 5.02 21.28C3.42 20.83 1.58 19.52 0.62 18.35",
    "M10 20.5675C8.28 21.08 6.68 21.02 5.32 20.46C3.95 19.9 2.7 18.5 1.88 16.72",
];
const GITHUB_BODY: &str = "M10 22V18.7579C10 18.1596 10.1839 17.6396 10.4804 17.1699C10.6838 16.8476 10.5445 16.3904 10.1771 16.2894C7.13394 15.4528 5 14.1077 5 9.64606C5 8.48611 5.38005 7.39556 6.04811 6.4464C6.21437 6.21018 6.29749 6.09208 6.31748 5.9851C6.33746 5.87813 6.30272 5.73852 6.23322 5.45932C5.95038 4.32292 5.96871 3.11619 6.39322 2.02823C6.39322 2.02823 7.27042 1.74242 9.26698 2.98969C9.72282 3.27447 9.95075 3.41686 10.1515 3.44871C10.3522 3.48056 10.6206 3.41384 11.1573 3.28041C11.8913 3.09795 12.6476 3 13.5 3C14.3524 3 15.1087 3.09795 15.8427 3.28041C16.3794 3.41384 16.6478 3.48056 16.8485 3.44871C17.0493 3.41686 17.2772 3.27447 17.733 2.98969C19.7296 1.74242 20.6068 2.02823 20.6068 2.02823C21.0313 3.11619 21.0496 4.32292 20.7668 5.45932C20.6973 5.73852 20.6625 5.87813 20.6825 5.9851C20.7025 6.09207 20.7856 6.21019 20.9519 6.4464C21.6199 7.39556 22 8.48611 22 9.64606C22 14.1077 19.8661 15.4528 16.8229 16.2894C16.4555 16.3904 16.3162 16.8476 16.5196 17.1699C16.8161 17.6396 17 18.1596 17 18.7579V22";

/// `Github.vue`: the cat crouches, sweeps its tail, stretches and settles.
/// motion gives the group `transform-box: fill-box` and a 50% 50% origin, so
/// it turns about the centre of its current (tail-swept) bounds.
fn github(t: f32) -> String {
    let p = t / 0.72;
    let tail_times = [0.0, 0.22, 0.42, 0.64, 0.82, 1.0];
    let frames = [TAIL[0], TAIL[1], TAIL[2], TAIL[3], TAIL[4], TAIL[0]].map(Path::parse);
    let tail = Path::morph(&frames, &tail_times, ICON_EASE, p);
    let body = Path::parse(GITHUB_BODY);
    let times = [0.0, 0.18, 0.42, 0.64, 0.82, 1.0];
    let at = |values: [f32; 6]| track(&values, &times, ICON_EASE, p);
    let ty = at([0.0, 0.9, -1.2, 0.4, -0.15, 0.0]);
    let turn = at([0.0, 0.0, -2.0, 0.75, -0.2, 0.0]).to_radians();
    let sx = at([1.0, 1.04, 0.97, 1.02, 0.995, 1.0]);
    let sy = at([1.0, 0.9, 1.08, 0.97, 1.01, 1.0]);
    let (a, b) = (tail.bbox(), body.bbox());
    let origin = [
        (a[0].min(b[0]) + a[2].max(b[2])) / 2.0,
        (a[1].min(b[1]) + a[3].max(b[3])) / 2.0,
    ];
    let (sin, cos) = turn.sin_cos();
    let m = [cos * sx, sin * sx, -sin * sy, cos * sy];
    let e = origin[0] - (m[0] * origin[0] + m[2] * origin[1]) + PAD;
    let f = origin[1] + ty - (m[1] * origin[0] + m[3] * origin[1]) + PAD;
    let matrix = Some([m[0], m[1], m[2], m[3], e, f]);
    stroke(&tail.mapped(|p| p), true, matrix) + &stroke(&body.mapped(|p| p), true, matrix)
}

/// Every frame of glyph `kind` (0 plus, 1 folder, 2 github); the last is rest.
pub(crate) fn frames(kind: usize) -> &'static [&'static Icon] {
    static TABLES: [OnceLock<Vec<&'static Icon>>; 3] =
        [OnceLock::new(), OnceLock::new(), OnceLock::new()];
    TABLES[kind].get_or_init(|| {
        let duration = DURATIONS[kind];
        let count = (duration * FPS).ceil() as usize + 1;
        (0..count)
            .map(|i| {
                let t = (i as f32 / FPS).min(duration);
                let body = match kind {
                    0 => plus(t),
                    1 => folder(t),
                    _ => github(t),
                };
                let name: &'static str =
                    Box::leak(format!("start-glyph-{kind}-{i}").into_boxed_str());
                let body: &'static str = Box::leak(body.into_boxed_str());
                &*Box::leak(Box::new(Icon {
                    name,
                    view: VIEW,
                    body,
                }))
            })
            .collect()
    })
}

/// Glyph `kind` `elapsed` seconds into its gesture, or at rest.
pub(crate) fn glyph(kind: usize, elapsed: Option<f32>) -> &'static Icon {
    let table = frames(kind);
    let index = elapsed.map_or(table.len() - 1, |e| {
        ((e.max(0.0) * FPS) as usize).min(table.len() - 1)
    });
    table[index]
}

// --- Rotating wordmark (`HomeRotatingWordmark.vue` + `RotatingText.vue`) ---

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
        assert_eq!(bezier(EASE_IN_OUT, 0.0), 0.0);
        assert_eq!(bezier(EASE_IN_OUT, 1.0), 1.0);
        assert!((bezier(EASE_IN_OUT, 0.5) - 0.5).abs() < 1e-4);
        // ease-out (0.22, 1, 0.36, 1) is well past halfway at a quarter.
        assert!(bezier([0.22, 1.0, 0.36, 1.0], 0.25) > 0.6);
    }

    #[test]
    fn glyph_frames_start_and_end_at_rest() {
        for (kind, duration) in DURATIONS.iter().enumerate() {
            let table = frames(kind);
            assert_eq!(table.len(), (duration * FPS).ceil() as usize + 1);
            assert_eq!(table[0].body, table[table.len() - 1].body, "glyph {kind}");
            assert_ne!(
                table[0].body,
                table[table.len() / 2].body,
                "glyph {kind} moves"
            );
        }
    }

    #[test]
    fn plus_stem_overshoots_at_its_peak() {
        // At 0.32 of 0.5 s the stem reaches M12 2.6V21.4.
        let body = plus(0.16);
        assert!(body.contains("14.0000 4.6000L14.0000 23.4000"), "{body}");
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

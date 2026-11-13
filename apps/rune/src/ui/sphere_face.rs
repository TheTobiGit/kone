use rune::{Color, El, Image, ImageCache, SurfaceFit, el};
use std::collections::HashMap;
use std::f32::consts::TAU;
use std::fmt::Write as _;
use std::sync::{Arc, Mutex, OnceLock};

pub const YAW_MAX: f32 = 16.0;
pub const PITCH_MAX: f32 = 13.0;
/// Held slightly above the equator with the pointer centred: attentive, not vacant.
pub const PITCH_REST: f32 = 10.0;

/// Full pointer attention within this many body radii; released by `AIM_FAR`.
pub const AIM_NEAR: f32 = 4.0;
pub const AIM_FAR: f32 = 11.0;

const EYE_SPLIT: f32 = 15.46;
const EYE_W: f32 = 0.186;
const EYE_H: f32 = 0.412;
const REST_YAW: f32 = 28.49;
const REST_PITCH: f32 = 28.62;
const REST_ROLL: f32 = -13.0;
const BLINK_DUR: f64 = 0.18;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Aim {
    /// Pointer horizontal offset from the face centre, -1 to 1 (right positive).
    pub nx: f32,
    /// Pointer vertical offset from the face centre, -1 to 1 (screen-down positive).
    pub ny: f32,
    /// Blend factor in [0, 1]: 0 = resting pose, 1 = full pointer aim.
    pub mix: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RenderedEye {
    pub a: f32,
    pub b: f32,
    pub c: f32,
    pub d: f32,
    pub tx: f32,
    pub ty: f32,
    pub alpha: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FaceFrame {
    pub cx: f32,
    pub cy: f32,
    pub rx: f32,
    pub ry: f32,
    pub hw: f32,
    pub hh: f32,
    pub corner: f32,
    pub eyes: Vec<RenderedEye>,
}

#[derive(Clone, Copy, Debug)]
struct Liveliness {
    d_yaw: f32,
    d_pitch: f32,
    d_roll: f32,
    lid: f32,
    drift_x: f32,
    drift_y: f32,
    breath: f32,
}

#[derive(Clone, Copy)]
struct EyePose {
    x: f32,
    y: f32,
    a: f32,
    b: f32,
    c: f32,
    d: f32,
    depth: f32,
}

fn r2(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}

fn loop_noise(t: f64, period: f64, seed: f32) -> f32 {
    let p = (t / period) as f32 * TAU;
    0.55 * (p + seed).sin()
        + 0.3 * (2.0 * p + seed * 1.7 + 1.1).sin()
        + 0.15 * (3.0 * p + seed * 2.3 + 2.4).sin()
}

fn blinks() -> &'static Vec<f64> {
    static TABLE: OnceLock<Vec<f64>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut a: u32 = 0x5eed;
        let mut next = || -> f64 {
            a = a.wrapping_add(0x6d2b_79f5);
            let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
            t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
            ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
        };
        let mut out = Vec::new();
        let mut t = 1.4_f64;
        while t < 900.0 {
            out.push(t);
            t += 1.9 + next() * 2.7;
            if next() < 0.18 {
                out.push(t);
                t += 0.24;
            }
        }
        out
    })
}

fn blink_lid(t: f64) -> f32 {
    let mod_t = t.rem_euclid(900.0);
    for &start in blinks() {
        if mod_t < start {
            break;
        }
        let k = (mod_t - start) / BLINK_DUR;
        if (0.0..=1.0).contains(&k) {
            return if k < 0.45 {
                (1.0 - k / 0.45) as f32
            } else {
                ((k - 0.45) / 0.55) as f32
            };
        }
    }
    1.0
}

fn liveliness(t: f64) -> Liveliness {
    Liveliness {
        d_yaw: loop_noise(t, 11.3, 0.4) * 5.5 + loop_noise(t, 3.7, 2.1) * 1.6,
        d_pitch: loop_noise(t, 9.1, 1.3) * 4.2 + loop_noise(t, 4.3, 0.7) * 1.3,
        d_roll: loop_noise(t, 13.7, 3.2) * 2.2,
        lid: blink_lid(t),
        drift_x: loop_noise(t, 7.9, 1.9) * 0.006,
        drift_y: loop_noise(t, 5.3, 0.3) * 0.007,
        breath: 1.0 + (((t / 3.4) as f32) * TAU).sin() * 0.005,
    }
}

fn spin(u: [f32; 3], v: [f32; 3], angle: f32) -> ([f32; 3], [f32; 3]) {
    let c = angle.cos();
    let s = angle.sin();
    (
        [
            u[0] * c + v[0] * s,
            u[1] * c + v[1] * s,
            u[2] * c + v[2] * s,
        ],
        [
            v[0] * c - u[0] * s,
            v[1] * c - u[1] * s,
            v[2] * c - u[2] * s,
        ],
    )
}

fn eye_poses(yaw_deg: f32, pitch_deg: f32, roll_deg: f32, scale: f32) -> [EyePose; 2] {
    let f = [0.0_f32, 0.0, 1.0];
    let right = [1.0_f32, 0.0, 0.0];
    let down = [0.0_f32, 1.0, 0.0];

    let (f, right) = spin(f, right, yaw_deg.to_radians());
    let (down, f) = spin(down, f, pitch_deg.to_radians());
    let (right, down) = spin(right, down, roll_deg.to_radians());

    let build = |side: f32| {
        let (ef, er) = spin(f, right, (EYE_SPLIT * side).to_radians());
        EyePose {
            x: ef[0] * scale,
            y: ef[1] * scale,
            a: er[0],
            b: er[1],
            c: down[0],
            d: down[1],
            depth: ef[2],
        }
    };
    [build(-1.0), build(1.0)]
}

/// Convert pointer offset `(dx_px, dy_px)` from the orb centre into an `Aim`.
pub fn aim_from_offset(dx_px: f32, dy_px: f32, size: f32) -> Option<Aim> {
    let r = (size * 0.5).max(1.0);
    let dx = dx_px / r;
    let dy = dy_px / r;
    let dist = dx.hypot(dy);
    let mix = 1.0 - ((dist - AIM_NEAR) / (AIM_FAR - AIM_NEAR)).clamp(0.0, 1.0);
    if mix <= 0.0 {
        return None;
    }
    let k = dist.max(1.0);
    Some(Aim {
        nx: dx / k,
        ny: dy / k,
        mix,
    })
}

/// Sample one sphere-projected resting orb frame at time `t` seconds.
pub fn sample_face(t: f64, size: f32, aim: Option<Aim>) -> FaceFrame {
    let r = size * 0.5;
    let life = liveliness(t);
    let mix = aim.map_or(0.0, |a| a.mix.clamp(0.0, 1.0));
    let target_yaw = aim.map_or(0.0, |a| a.nx * YAW_MAX);
    let target_pitch = aim.map_or(0.0, |a| PITCH_REST - a.ny * PITCH_MAX);

    let yaw = REST_YAW + (target_yaw - REST_YAW) * mix + life.d_yaw;
    let pitch = REST_PITCH + (target_pitch - REST_PITCH) * mix + life.d_pitch;
    let roll = REST_ROLL + life.d_roll;

    let cx = r + life.drift_x * r;
    let cy = r + life.drift_y * r;
    let k = 0.06 + 0.94 * life.lid.clamp(0.0, 1.0);

    let w = EYE_W * r;
    let h = EYE_H * r;
    let hw = w.max(0.01) * 0.5;
    let hh = h.max(0.01) * 0.5;
    let corner = hw.min(hh);

    let mut eyes = Vec::with_capacity(2);
    for pose in eye_poses(yaw, pitch, roll, r) {
        if pose.depth <= 0.02 {
            continue;
        }
        eyes.push(RenderedEye {
            a: r2(pose.a),
            b: r2(pose.b * k),
            c: r2(pose.c),
            d: r2(pose.d * k),
            tx: r2(cx + pose.x),
            ty: r2(cy + pose.y),
            alpha: r2((pose.depth / 0.12).clamp(0.0, 1.0)),
        });
    }

    FaceFrame {
        cx: r2(cx),
        cy: r2(cy),
        rx: r2(r),
        ry: r2(r * life.breath),
        hw: r2(hw),
        hh: r2(hh),
        corner: r2(corner),
        eyes,
    }
}

fn color_hex(c: Color) -> String {
    let q = |x: f32| (rune::color::srgb_encode(x.clamp(0.0, 1.0)) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", q(c.r), q(c.g), q(c.b))
}

fn build_svg(frame: &FaceFrame, size: f32, ink: Color) -> String {
    let fill = color_hex(ink);
    let mut svg = String::with_capacity(640);
    let _ = write!(
        svg,
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}"><defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="{size}" height="{size}"><path d="M{} {}A{} {} 0 0 1 {} {}A{} {} 0 0 1 {} {}Z" fill="#fff"/>"##,
        r2(frame.cx - frame.rx),
        frame.cy,
        frame.rx,
        frame.ry,
        r2(frame.cx + frame.rx),
        frame.cy,
        frame.rx,
        frame.ry,
        r2(frame.cx - frame.rx),
        frame.cy,
    );
    let cap_d = format!(
        "M{} {}A{} {} 0 0 1 0 {}L0 {}A{} {} 0 0 1 {} {}L{} {}A{} {} 0 0 1 0 {}L0 {}A{} {} 0 0 1 {} {}Z",
        r2(-frame.hw),
        r2(-frame.hh + frame.corner),
        frame.corner,
        frame.corner,
        r2(-frame.hh),
        r2(-frame.hh),
        frame.corner,
        frame.corner,
        frame.hw,
        r2(-frame.hh + frame.corner),
        frame.hw,
        r2(frame.hh - frame.corner),
        frame.corner,
        frame.corner,
        frame.hh,
        frame.hh,
        frame.corner,
        frame.corner,
        r2(-frame.hw),
        r2(frame.hh - frame.corner),
    );
    for eye in &frame.eyes {
        let _ = write!(
            svg,
            r##"<path d="{cap_d}" transform="matrix({},{},{},{},{},{})" opacity="{}" fill="#000"/>"##,
            eye.a, eye.b, eye.c, eye.d, eye.tx, eye.ty, eye.alpha,
        );
    }
    let _ = write!(
        svg,
        r##"</mask></defs><g mask="url(#m)"><rect x="0" y="0" width="{size}" height="{size}" fill="{fill}"/></g></svg>"##
    );
    svg
}

#[derive(Hash, Eq, PartialEq, Clone)]
struct OrbCacheKey {
    size_q: u32,
    ink_rgb: u32,
    frame_svg: String,
}

fn orb_image(frame: &FaceFrame, size: f32, ink: Color) -> Image {
    static IMAGES: OnceLock<ImageCache> = OnceLock::new();
    static BY_KEY: OnceLock<Mutex<HashMap<OrbCacheKey, Image>>> = OnceLock::new();
    let svg = build_svg(frame, size, ink);
    let key = OrbCacheKey {
        size_q: (size * 10.0).round() as u32,
        ink_rgb: ((ink.r * 255.0).round() as u32) << 16
            | ((ink.g * 255.0).round() as u32) << 8
            | ((ink.b * 255.0).round() as u32),
        frame_svg: svg,
    };
    let map = BY_KEY.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().expect("orb cache lock");
    if let Some(existing) = guard.get(&key) {
        return existing.clone();
    }
    if guard.len() > 64 {
        guard.clear();
    }
    let cache = IMAGES.get_or_init(|| ImageCache::new(Arc::new(|| {})));
    let img = cache.svg(Arc::<[u8]>::from(key.frame_svg.as_bytes()), size, 2.0);
    let _ = img.wait();
    guard.insert(key, img.clone());
    img
}

/// Draw the `size`×`size` SphereFace with transparent eye cutouts in `ink`.
pub fn sphere_face(clock: f64, size: f32, aim: Option<Aim>, ink: Color) -> El {
    let frame = sample_face(clock, size, aim);
    let image = orb_image(&frame, size, ink);
    el().w(size)
        .h(size)
        .pixels_fit(image.pixels(), SurfaceFit::Fill)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rest_frame_at_mount_clock_projects_both_open_eyes() {
        let frame = sample_face(0.9, 55.0, None);
        assert_eq!(frame.eyes.len(), 2);
        // Right/upper quadrant gaze from REST_GAZE { yaw: 28.49, pitch: 28.62, roll: -13 }.
        assert!((frame.eyes[0].tx - 34.0).abs() < 2.0);
        assert!((frame.eyes[0].ty - 16.5).abs() < 2.0);
        assert!((frame.eyes[1].tx - 45.3).abs() < 2.0);
        assert!((frame.eyes[1].ty - 13.5).abs() < 2.0);
    }

    #[test]
    fn centered_pointer_aim_pulls_eyes_toward_center() {
        let aim = aim_from_offset(0.0, 0.0, 55.0).expect("centered pointer yields aim");
        let frame = sample_face(0.9, 55.0, Some(aim));
        assert_eq!(frame.eyes.len(), 2);
        assert!((frame.eyes[0].tx - 21.3).abs() < 2.0);
        assert!((frame.eyes[0].ty - 25.0).abs() < 2.0);
        assert!((frame.eyes[1].tx - 35.5).abs() < 2.0);
        assert!((frame.eyes[1].ty - 21.5).abs() < 2.0);
    }

    #[test]
    fn blink_window_squashes_eye_vertical_scale() {
        let first_blink = blinks()[0] + 0.45 * BLINK_DUR;
        let frame = sample_face(first_blink, 55.0, None);
        assert_eq!(frame.eyes.len(), 2);
        assert!(frame.eyes[0].d.abs() < 0.12);
    }

    #[test]
    fn sphere_face_builds_valid_masked_svg_element() {
        let frame = sample_face(0.9, 55.0, None);
        let svg = build_svg(&frame, 55.0, Color::BLACK);
        assert!(svg.contains("<mask id=\"m\""));
        assert!(svg.contains("fill=\"#000000\""));
    }
}

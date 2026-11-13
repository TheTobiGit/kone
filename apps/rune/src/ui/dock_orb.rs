//! Electron's point-cloud `work` logo, including the Rocket01Icon settled mark.
use rune::{Color, El, el};

#[path = "dock_orb_points.rs"]
mod points;

/// The mark at the exact logo endpoint of Electron's work/morph cycle.
pub(super) fn working_mark(size: f32, dark: bool) -> El {
    working(size, 7.4, dark)
}

/// `time` is elapsed animation time in seconds, matching `frameLogoWork`.
pub(super) fn working(size: f32, time: f32, dark: bool) -> El {
    let local = time.rem_euclid(9.3);
    let into = local - 5.5;
    let ease = |x: f32| {
        let s = x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
        let e = if x <= 0.0 {
            0.0
        } else if x >= 1.0 {
            1.0
        } else if x < 0.5 {
            2.0_f32.powf(20.0 * x - 10.0) / 2.0
        } else {
            (2.0 - 2.0_f32.powf(-20.0 * x + 10.0)) / 2.0
        };
        s + (e - s) * 0.3
    };
    let m = if local < 5.5 {
        0.0
    } else if into < 1.9 {
        ease(into / 1.9)
    } else {
        ease(1.0 - (into - 1.9) / 1.9)
    };
    let c = 1.0 - m;
    let prog = if local < 5.5 {
        local / 5.5
    } else if into < 1.9 {
        1.0
    } else {
        (1.0 - (into - 1.9) / 1.9).clamp(0.0, 1.0)
    };
    let (sy, cy) = (0.4 + 0.3 * (time * 0.26).sin() * c).sin_cos();
    let (st, ct) = (0.4 * c).sin_cos();
    let scale = size * 0.41;
    let rs = (size / 300.0).powf(0.36);
    let n = points::POINTS.len() as f32;
    let mut dots = Vec::with_capacity(points::POINTS.len());
    for (i, &[lx, ly, lz, edge]) in points::POINTS.iter().enumerate() {
        let seat = points::SEATS[i] as f32;
        let u = seat / n * std::f32::consts::TAU * 2.0 + time * 0.35;
        let v = seat / n * std::f32::consts::TAU * 3.0;
        let rad = 0.68 + 0.28 * v.cos();
        let x = lx + (rad * u.cos() - lx) * c;
        let y = ly + (rad * u.sin() - ly) * c;
        let z = lz + (0.28 * v.sin() - lz) * c;
        let x1 = x * cy + z * sy;
        let z1 = -x * sy + z * cy;
        let y2 = y * ct - z1 * st;
        let z2 = y * st + z1 * ct;
        let zx = ((z2 + 1.0) / 2.0).clamp(0.0, 1.0);
        let dist = seat - prog * n;
        let head_w = (n * 0.015).max(1.0);
        let feather = (n * 0.04).max(1.0);
        let bright = (-dist * dist / (head_w * head_w)).exp();
        let laid = if dist > 0.0 {
            (-dist * dist / (feather * feather)).exp()
        } else {
            1.0
        };
        let presence = m + c * laid;
        let r = ((0.75 + 1.2 * zx + 0.55 * bright * c) * presence * rs).max(0.75);
        let white = 0.6 - 0.5 * zx - 0.16 * (1.0 - (edge * m + c)) - 0.3 * bright * c;
        dots.push((
            z2,
            size / 2.0 + x1 * scale,
            size / 2.0 - y2 * scale,
            r,
            tint(white, dark, presence),
        ));
    }
    dots.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut mark = el().w(size).h(size);
    for (_, x, y, r, color) in dots {
        mark = mark.child(
            el().w(r * 2.0)
                .h(r * 2.0)
                .absolute(x - r, y - r)
                .radius(r)
                .fill(color),
        );
    }
    mark
}

fn tint(white: f32, dark: bool, alpha: f32) -> Color {
    let raw = [113.0_f32, 113.0, 122.0];
    let lum = (0.2126 * raw[0] + 0.7152 * raw[1] + 0.0722 * raw[2]) / 255.0;
    let depth = 1.0 - white.clamp(0.0, 1.0);
    let channel = |v: f32| {
        let v = if dark && lum < 0.5 {
            (v + (255.0 - v) * (0.5 - lum) / (1.0 - lum)).round()
        } else {
            v
        };
        let col = if dark {
            (v + (255.0 - v) * 0.28 * (depth - 0.5).max(0.0) * 2.0) * (0.72 + 0.28 * depth)
        } else {
            255.0 - (255.0 - v * 0.82) * (0.5 + 0.5 * depth)
        };
        rune::color::srgb_decode(col.round().clamp(0.0, 255.0) / 255.0)
    };
    Color {
        r: channel(raw[0]),
        g: channel(raw[1]),
        b: channel(raw[2]),
        a: alpha.max(0.5),
    }
}

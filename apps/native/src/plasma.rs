//! The warm glow rising from the floor of the empty launcher.
//!
//! GPUI takes no custom shaders, so the field is evaluated on the CPU at half
//! resolution and shown as an image. It drifts slowly enough (0.55× speed)
//! that a dozen frames a second reads as continuous.

use std::{sync::Arc, time::{Duration, Instant}};

use gpui_kit::*;
use image::{Frame, RgbaImage};
use kone_theme::{Rgba, Theme};

const SPEED: f32 = 0.55;
const TURBULENCE: f32 = 0.85;
const GRAIN: f32 = 0.4;
const SPARKLE: f32 = 0.35;
const VIGNETTE: f32 = 1.0;
/// Device pixels per field sample.
const STEP: f32 = 2.0;
const FRAME: Duration = Duration::from_millis(83);

#[derive(Clone, Copy)]
struct Params {
    dark: bool,
    opacity: f32,
    ground: [f32; 3],
    ramp: [[f32; 3]; 3],
}

fn mod289(x: f32) -> f32 { x - (x / 289.).floor() * 289. }
fn permute(x: f32) -> f32 { mod289((x * 34. + 1.) * x) }
fn fract(x: f32) -> f32 { x - x.floor() }
fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0., 1.);
    t * t * (3. - 2. * t)
}
fn mix(a: f32, b: f32, t: f32) -> f32 { a + (b - a) * t }
fn mix3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] { [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)] }

/// 2D simplex noise, the same formulation the web shader uses.
fn snoise(vx: f32, vy: f32) -> f32 {
    const C: [f32; 4] = [0.211_324_87, 0.366_025_4, -0.577_350_26, 0.024_390_243];
    let s = (vx + vy) * C[1];
    let (ix, iy) = ((vx + s).floor(), (vy + s).floor());
    let t = (ix + iy) * C[0];
    let (x0, y0) = (vx - ix + t, vy - iy + t);
    let (i1x, i1y) = if x0 > y0 { (1., 0.) } else { (0., 1.) };
    let (x1, y1) = (x0 + C[0] - i1x, y0 + C[0] - i1y);
    let (x2, y2) = (x0 + C[2], y0 + C[2]);
    let (ix, iy) = (mod289(ix), mod289(iy));
    let p = [
        permute(permute(iy) + ix),
        permute(permute(iy + i1y) + ix + i1x),
        permute(permute(iy + 1.) + ix + 1.),
    ];
    let d = [x0 * x0 + y0 * y0, x1 * x1 + y1 * y1, x2 * x2 + y2 * y2];
    let pts = [(x0, y0), (x1, y1), (x2, y2)];
    let mut total = 0.;
    for k in 0..3 {
        let mut m = (0.5 - d[k]).max(0.);
        m *= m;
        m *= m;
        let x = 2. * fract(p[k] * C[3]) - 1.;
        let h = x.abs() - 0.5;
        let a0 = x - (x + 0.5).floor();
        m *= 1.792_842_9 - 0.853_734_7 * (a0 * a0 + h * h);
        total += m * (a0 * pts[k].0 + h * pts[k].1);
    }
    130. * total
}

fn fbm(mut x: f32, mut y: f32) -> f32 {
    let (s, c) = 0.45f32.sin_cos();
    let (mut total, mut amp, mut freq) = (0., 0.5, 1.);
    let step = mix(1.85, 2.35, TURBULENCE.clamp(0., 2.) * 0.5);
    for _ in 0..5 {
        total += snoise(x * freq, y * freq) * amp;
        // GLSL's mat2(c, s, -s, c) * p, column-major.
        (x, y) = (c * x - s * y, s * x + c * y);
        freq *= step;
        amp *= 0.5;
    }
    total
}

/// One sample, in straight RGBA. `fx, fy` are device pixels with y up.
fn shade(fx: f32, fy: f32, w: f32, h: f32, time: f32, p: &Params) -> [f32; 4] {
    let aspect = w / h.max(1.);
    let (px_, py_) = ((fx / w - 0.5) * aspect, fy / h - 0.5);
    let t = time * 0.15 * SPEED;
    let flow = (fbm(px_ + t * 0.2, py_ + t * 0.1), fbm(px_ - t * 0.1, py_ + t * 0.3));
    let n = fbm(px_ * 2. + flow.0 * 1.45, py_ * 2. + flow.1 * 1.45);
    let ridges = (1. - (snoise(px_ * 4. + n, py_ * 4. + n) * 2.).abs()).powi(3);
    let [a, b, cc] = p.ramp;
    let mut col = mix3(a, b, smoothstep(-0.5, 0.5, n));
    col = mix3(col, cc, smoothstep(0.25, 1., n * 0.52 + ridges * 0.48));
    let sparkle = snoise(fx * 0.2 + t * 2., fy * 0.2 + t * 2.).max(0.).powi(18) * 0.5 * SPARKLE;
    let sc = if p.dark { [0.8, 0.9, 1.0] } else { [0.56, 0.58, 0.72] };
    for i in 0..3 {
        col[i] += sc[i] * sparkle;
    }
    let len = (px_ * px_ + py_ * py_).sqrt();
    if p.dark {
        let vig = 1. - smoothstep(0.5, 1.55, len);
        col = mix3(col, col.map(|v| v * vig), VIGNETTE);
    } else {
        let vig = 1. - smoothstep(0.4, 1.45, len);
        col = mix3([1.; 3], col, vig);
    }
    let grain = (fract(((fx + t * 50.) * 12.9898 + (fy + t * 50.) * 78.233).sin() * 43_758.547) - 0.5) * 0.06 * GRAIN;
    // The web canvas composites premultiplied, so its colour lands at full
    // strength and only the ground behind is scaled by the opacity.
    let under = 1. - p.opacity;
    [col[0] + grain + p.ground[0] * under, col[1] + grain + p.ground[1] * under, col[2] + grain + p.ground[2] * under, 1.]
}

/// Renders a `w × h` device-pixel field, faded in from the top to full at
/// 55% of its height, as BGRA for GPUI.
fn render(w: u32, h: u32, time: f32, p: Params) -> Arc<RenderImage> {
    let (sw, sh) = (((w as f32) / STEP).ceil().max(1.) as u32, ((h as f32) / STEP).ceil().max(1.) as u32);
    let mut img = RgbaImage::new(sw, sh);
    let rows: Vec<(u32, &mut [u8])> = img.chunks_mut((sw * 4) as usize).enumerate().map(|(i, r)| (i as u32, r)).collect();
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    let per = rows.len().div_ceil(threads);
    let mut rows = rows;
    std::thread::scope(|s| {
        while !rows.is_empty() {
            let chunk: Vec<_> = rows.drain(..per.min(rows.len())).collect();
            s.spawn(move || {
                for (y, row) in chunk {
                    let from_top = y as f32 / sh as f32;
                    let mask = (from_top / 0.55).min(1.);
                    let fy = (sh - 1 - y) as f32 * STEP;
                    for x in 0..sw {
                        let c = shade(x as f32 * STEP, fy, w as f32, h as f32, time, &p);
                        let o = (x * 4) as usize;
                        let to8 = |v: f32| (v.clamp(0., 1.) * 255.).round() as u8;
                        row[o] = to8(c[2]);
                        row[o + 1] = to8(c[1]);
                        row[o + 2] = to8(c[0]);
                        row[o + 3] = to8(c[3] * mask);
                    }
                }
            });
        }
    });
    let image = RenderImage::new(smallvec::smallvec![Frame::new(img)]);
    Arc::new(image)
}

fn rgb(c: Rgba) -> [f32; 3] { [c.r, c.g, c.b] }

pub struct Plasma {
    image: Option<Arc<RenderImage>>,
    size: (u32, u32, f32),
    started: Instant,
    _ticker: Task<()>,
}

impl Plasma {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let ticker = cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(FRAME).await;
            let Ok(job) = this.update(cx, |p, cx| {
                let t = Theme::get(cx);
                // Near-black lets the ridge veins burn bright, so the layer
                // sits back by half in dark to settle into the ground.
                let params = Params { dark: t.is_dark(), opacity: if t.is_dark() { 0.5 } else { 1. }, ground: rgb(t.colors.ground), ramp: t.colors.plasma.map(rgb) };
                (p.size, p.started.elapsed().as_secs_f32(), params)
            }) else { return };
            let ((w, h, _), time, params) = job;
            if w == 0 {
                continue;
            }
            let image = cx.background_executor().spawn(async move { render(w, h, time, params) }).await;
            if this
                .update(cx, |p, cx| {
                    if let Some(old) = p.image.replace(image) {
                        cx.drop_image(old, None);
                    }
                    cx.notify();
                })
                .is_err()
            {
                return;
            }
        });
        Plasma { image: None, size: (0, 0, 1.), started: Instant::now(), _ticker: ticker }
    }
}

impl Render for Plasma {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let scale = window.scale_factor();
        let entity = cx.entity();
        div()
            .size_full()
            .child(
                canvas(move |b, _, cx| {
                    let size = ((f32::from(b.size.width) * scale) as u32, (f32::from(b.size.height) * scale) as u32, scale);
                    entity.update(cx, |p, _| p.size = size);
                }, |_, _, _, _| {})
                .absolute()
                .size_full(),
            )
            .children(self.image.clone().map(|i| img(i).size_full().object_fit(ObjectFit::Fill)))
    }
}

//! The empty launcher: three ways to begin, centred, over a warm floor glow.

use std::{cell::Cell, rc::Rc, time::{Duration, Instant}};

use gpui_kit::prelude::*;
use gpui_kit::*;
use kone_theme::{Theme, hsla};

use crate::plasma::Plasma;

pub const SANS: &str = "Geist";

/// `cubic-bezier(0.22, 1, 0.36, 1)`: a quick start that glides to rest.
fn glide(t: f32) -> f32 {
    let (x1, y1, x2, y2) = (0.22f32, 1f32, 0.36f32, 1f32);
    let bez = |a: f32, b: f32, s: f32| 3. * a * s * (1. - s).powi(2) + 3. * b * s * s * (1. - s) + s.powi(3);
    let (mut lo, mut hi) = (0f32, 1f32);
    for _ in 0..24 {
        let mid = (lo + hi) / 2.;
        if bez(x1, x2, mid) < t { lo = mid } else { hi = mid }
    }
    bez(y1, y2, (lo + hi) / 2.)
}

/// How far outside a row the cursor starts to pull it, and how weakly: the
/// row moves a ninth of the cursor's distance from its centre.
const MAGNET_PADDING: f32 = 12.;
const MAGNET_STRENGTH: f32 = 9.;
const PULL_IN: Duration = Duration::from_millis(350);
const LET_GO: Duration = Duration::from_millis(600);

/// One row's lean toward the cursor, eased like a CSS transform transition:
/// a new target restarts the glide from wherever the row is now.
#[derive(Default)]
struct Magnet {
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    from: (f32, f32),
    to: (f32, f32),
    since: Option<Instant>,
    active: bool,
}

impl Magnet {
    fn duration(&self) -> Duration {
        if self.active { PULL_IN } else { LET_GO }
    }

    fn progress(&self) -> f32 {
        self.since.map_or(1., |t| (t.elapsed().as_secs_f32() / self.duration().as_secs_f32()).min(1.))
    }

    fn offset(&self) -> (f32, f32) {
        let e = glide(self.progress());
        (self.from.0 + (self.to.0 - self.from.0) * e, self.from.1 + (self.to.1 - self.from.1) * e)
    }

    fn track(&mut self, cursor: Point<Pixels>) {
        let Some(b) = self.bounds.get() else { return };
        let (w, h) = (f32::from(b.size.width), f32::from(b.size.height));
        let (cx, cy) = (f32::from(b.origin.x) + w / 2., f32::from(b.origin.y) + h / 2.);
        let (dx, dy) = (f32::from(cursor.x) - cx, f32::from(cursor.y) - cy);
        let near = dx.abs() < w / 2. + MAGNET_PADDING && dy.abs() < h / 2. + MAGNET_PADDING;
        let to = if near { (dx / MAGNET_STRENGTH, dy / MAGNET_STRENGTH) } else { (0., 0.) };
        if to != self.to {
            self.from = self.offset();
            self.to = to;
            self.active = near;
            self.since = Some(Instant::now());
        }
    }

    fn settling(&self) -> bool {
        self.progress() < 1.
    }
}

pub struct Shell {
    plasma: Entity<Plasma>,
    magnets: [Magnet; 3],
}

impl Shell {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Shell { plasma: cx.new(Plasma::new), magnets: Default::default() }
    }
}

fn open_folder(cx: &mut App) {
    let picked = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some("Open".into()) });
    cx.background_executor()
        .spawn(async move {
            if let Ok(Ok(Some(paths))) = picked.await {
                eprintln!("open: {}", paths[0].display());
            }
        })
        .detach();
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = Theme::get(cx).colors.clone();
        let vh = f32::from(window.viewport_size().height);
        let glow_h = (vh * 0.42).clamp(220., 380.);

        if self.magnets.iter().any(Magnet::settling) {
            window.request_animation_frame();
        }
        let offsets: Vec<(f32, f32)> = self.magnets.iter().map(Magnet::offset).collect();
        let slots: Vec<_> = self.magnets.iter().map(|m| m.bounds.clone()).collect();
        let row = |i: usize, id: &'static str, icon: &'static str, label: &'static str| {
            let slot = slots[i].clone();
            let (x, y) = offsets[i];
            // The pull is measured from where the row rests, so the probe sits
            // on the unmoved wrapper and only the inner row travels.
            div().relative().child(canvas(move |b, _, _| slot.set(Some(b)), |_, _, _, _| {}).absolute().size_full()).child(
            div()
                .id(id)
                .relative()
                .left(px(x))
                .top(px(y))
                .when(id == "open", |r| r.on_click(|_, _, cx| open_folder(cx)))
                .flex()
                .items_center()
                .gap(px(14.))
                .rounded(px(14.))
                .py(px(11.))
                .pr(px(12.))
                .pl(px(6.))
                .cursor_pointer()
                .hover(|s| s.bg(hsla(c.hover)))
                .child(div().w(px(22.)).flex().flex_shrink_0().justify_center().child(svg().path(icon).size(px(18.)).text_color(hsla(c.ink))))
                .child(
                    div()
                        .text_size(px(14.))
                        .line_height(px(14.))
                        .font_weight(FontWeight::NORMAL)
                        .text_color(hsla(c.ink))
                        .whitespace_nowrap()
                        .child(label),
                ))
        };

        div()
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .bg(hsla(c.ground))
            .font_family(SANS)
            .px(px(64.))
            .pt(px(52.))
            .on_mouse_move(cx.listener(|this, e: &MouseMoveEvent, _, cx| {
                for m in &mut this.magnets {
                    m.track(e.position);
                }
                cx.notify();
            }))
            // The band above the content moves the window, as a titlebar would.
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .h(px(52.))
                    .on_mouse_down(MouseButton::Left, |e, window, _| {
                        if e.click_count == 2 {
                            window.zoom_window();
                        } else {
                            window.start_window_move();
                        }
                    }),
            )
            .child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .h(px(glow_h))
                    .child(self.plasma.clone())
                    .with_animation("glow-in", Animation::new(Duration::from_millis(1600)).with_easing(|t| {
                        // 0.2s of rest, then 1.4s ease-out.
                        let t = ((t * 1.6 - 0.2) / 1.4).clamp(0., 1.);
                        1. - (1. - t).powi(2)
                    }), |el, d| el.opacity(d)),
            )
            .child(
                div().relative().flex().justify_end().child(
                    div()
                        .id("settings")
                        .size(px(36.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(11.))
                        .cursor_pointer()
                        .text_color(hsla(c.muted))
                        .hover(|s| s.bg(hsla(c.hover)).text_color(hsla(c.ink)))
                        .child(svg().path("icons/settings.svg").size(px(16.)).text_color(hsla(c.muted))),
                ),
            )
            .child(
                div().relative().flex().flex_1().flex_col().items_center().justify_center().child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(row(0, "create", "icons/plus.svg", "Create a new project"))
                        .child(row(1, "open", "icons/folder-open.svg", "Open from local folder"))
                        .child(row(2, "clone", "icons/github.svg", "Clone from GitHub"))
                        .with_animation("actions-in", Animation::new(Duration::from_millis(500)).with_easing(glide), |el, d| {
                            el.opacity(d).mt(px(8. * (1. - d) * 2.))
                        }),
                ),
            )
    }
}

//! The empty launcher: three ways to begin, centred, over a warm floor glow.

use std::time::Duration;

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

pub struct Shell {
    plasma: Entity<Plasma>,
}

impl Shell {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Shell { plasma: cx.new(Plasma::new) }
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

        let row = |id: &'static str, icon: &'static str, label: &'static str| {
            div()
                .id(id)
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
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(hsla(c.ink))
                        .whitespace_nowrap()
                        .child(label),
                )
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
                        .child(row("create", "icons/plus.svg", "Create a new project"))
                        .child(row("open", "icons/folder-open.svg", "Open from local folder").on_click(|_, _, cx| open_folder(cx)))
                        .child(row("clone", "icons/github.svg", "Clone from GitHub"))
                        .with_animation("actions-in", Animation::new(Duration::from_millis(500)).with_easing(glide), |el, d| {
                            el.opacity(d).mt(px(8. * (1. - d) * 2.))
                        }),
                ),
            )
    }
}

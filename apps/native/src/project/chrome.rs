//! Overview's three anchors share a fixed top line, independent of content width.
use super::*;
use kone_theme::Palette;

impl ProjectView {
    pub(super) fn render_chrome(
        &mut self,
        c: &Palette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let ink = hsla(c.ink);
        let muted = hsla(c.muted);
        let offset = if cx.reduce_motion() {
            (0., 0.)
        } else {
            self.chrome_back.offset()
        };
        let probe = self.chrome_back.probe();
        let back_active = self.chrome_back_hover
            || (self.focus_visible
                && self.focus.is_focused(window)
                && self.selected.as_deref() == Some("back"));
        let (hover, active) = crate::motion::sample_hover(
            &mut self.chrome_back_value,
            &mut self.chrome_back_target,
            back_active,
            self.started.elapsed(),
        );
        if active && !cx.reduce_motion() {
            window.request_animation_frame();
        }
        let hover = if cx.reduce_motion() {
            f32::from(back_active)
        } else {
            hover
        };
        let back_tone = hsla(c.ink.mix(hover, c.muted));
        if !cx.reduce_motion() && self.chrome_back.settling() {
            window.request_animation_frame();
        }
        let reduced = cx.reduce_motion();
        div()
            .relative()
            .h(px(48.))
            .flex_shrink_0()
            .when(self.detail.is_none(), |d| {
                d.child(
                    div()
                        .id("project-back")
                        .absolute()
                        .left(px(32.))
                        .top(px(20.))
                        .size(px(18.))
                        .cursor_pointer()
                        .text_color(back_tone)
                        .on_hover(cx.listener(|this, over: &bool, _, cx| {
                            this.chrome_back_hover = *over;
                            cx.notify();
                        }))
                        .on_click(cx.listener(|_, _, _, cx| cx.emit(Back)))
                        .child(
                            canvas(
                                move |bounds, _, _| {
                                    probe.set(Some(bounds));
                                },
                                |_, _, _, _| {},
                            )
                            .absolute()
                            .inset_0(),
                        )
                        .child(
                            svg()
                                .path("icons/project-back.svg")
                                .size(px(18.))
                                .text_color(back_tone)
                                .relative()
                                .left(px(offset.0))
                                .top(px(offset.1)),
                        )
                        .with_animation(
                            "project-back-enter",
                            Animation::new(Duration::from_millis(300)),
                            move |el, t| {
                                let t = if reduced { 1. } else { crate::magnet::glide(t) };
                                el.left(px(32. - 6. * (1. - t))).opacity(t)
                            },
                        ),
                )
                .child(
                    div()
                        .absolute()
                        .left(relative(0.5))
                        .ml(px(-168.))
                        .top(px(20.))
                        .flex()
                        .children(
                            ["Overview", "Space", "Files", "Git"]
                                .into_iter()
                                .enumerate()
                                .map(|(i, label)| {
                                    div()
                                        .id(SharedString::from(format!("project-tab-{i}")))
                                        .relative()
                                        .w(px(84.))
                                        .h(px(33.4))
                                        .line_height(px(19.4))
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .text_size(px(12.5))
                                        .text_color(if i == 0 { ink } else { muted })
                                        .when(i == 0, |d| {
                                            d.child(
                                                div()
                                                    .absolute()
                                                    .left_0()
                                                    .right_0()
                                                    .top(px(3.))
                                                    .bottom(px(3.))
                                                    .rounded_full()
                                                    .bg(hsla(c.ink.mix(0.067, c.ground))),
                                            )
                                        })
                                        .cursor_default()
                                        .child(div().relative().child(label))
                                }),
                        )
                        .with_animation(
                            "project-nav-enter",
                            Animation::new(Duration::from_millis(420)),
                            move |el, t| {
                                let t = if reduced { 1. } else { crate::magnet::glide(t) };
                                el.top(px(20. - 8. * (1. - t))).opacity(t)
                            },
                        ),
                )
                .when(!self.identity.trim().is_empty(), |d| {
                    d.child(
                        div()
                            .id("project-avatar")
                            .absolute()
                            .right(px(32.))
                            .top(px(20.))
                            .size(px(30.))
                            .rounded_full()
                            .bg(ink)
                            .text_color(hsla(c.ground))
                            .text_size(px(13.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(
                                self.identity
                                    .chars()
                                    .next()
                                    .unwrap_or('Y')
                                    .to_uppercase()
                                    .to_string(),
                            )
                            .with_animation(
                                "project-avatar-enter",
                                Animation::new(Duration::from_millis(350)),
                                move |el, t| {
                                    let t = if reduced { 1. } else { crate::magnet::glide(t) };
                                    el.top(px(20. - 6. * (1. - t))).opacity(t)
                                },
                            ),
                    )
                })
            })
            .into_any_element()
    }
}

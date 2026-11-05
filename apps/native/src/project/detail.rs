use super::*;
use kone_theme::Palette;
impl ProjectView {
    pub(super) fn render_detail(&mut self, c: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let Some(detail) = self.detail.as_ref() else {
            return div().into_any_element();
        };
        let path = detail
            .data
            .as_ref()
            .and_then(|d| d.diff.as_ref())
            .map(|d| d.path.clone())
            .unwrap_or_else(|| detail.entry.change.path.clone());
        let source = detail.source;
        let wrap = detail.wrap;
        let mut body = div()
            .flex()
            .flex_col()
            .min_w_full()
            .py(px(16.))
            .font_family(crate::style::MONO)
            .text_size(px(12.))
            .line_height(px(20.))
            .text_color(hsla(c.ink));
        if let Some(error) = &detail.error {
            body = body.child(
                div()
                    .px(px(24.))
                    .text_color(hsla(c.danger))
                    .child(error.clone()),
            );
        } else if let Some(data) = &detail.data {
            let note = if data.limited || data.content.as_ref().is_some_and(|c| c.truncated) {
                Some("This file is too large to preview.")
            } else if data.content.as_ref().is_some_and(|c| c.binary)
                || data.diff.as_ref().is_some_and(|d| d.binary)
            {
                Some("Binary file")
            } else {
                None
            };
            if let Some(note) = note {
                body = body.child(div().px(px(24.)).text_color(hsla(c.muted)).child(note));
            } else if source {
                if let Some(text) = data.content.as_ref().and_then(|c| c.text.as_ref()) {
                    if text.is_empty() {
                        body = body.child(
                            div()
                                .px(px(24.))
                                .text_color(hsla(c.muted))
                                .child("Empty file"),
                        );
                    }
                    for (i, line) in text.lines().enumerate() {
                        body = body.child(code_line(i as u32 + 1, None, "", line, wrap, c));
                    }
                } else {
                    body = body.child(
                        div()
                            .px(px(24.))
                            .text_color(hsla(c.muted))
                            .child("File content unavailable"),
                    );
                }
            } else if let Some(diff) = &data.diff {
                if diff.hunks.is_empty() {
                    body = body.child(
                        div()
                            .px(px(24.))
                            .text_color(hsla(c.muted))
                            .child("No text changes"),
                    );
                }
                for hunk in &diff.hunks {
                    body = body.child(
                        div()
                            .px(px(24.))
                            .py(px(5.))
                            .bg(hsla(c.hover))
                            .text_color(hsla(c.muted))
                            .child(format!(
                                "@@ −{} +{} @@ {}",
                                hunk.old_start, hunk.new_start, hunk.header
                            )),
                    );
                    for line in &hunk.lines {
                        body = body.child(code_line(
                            line.old_no.unwrap_or(0),
                            line.new_no,
                            &line.kind,
                            &line.text,
                            wrap,
                            c,
                        ));
                    }
                }
            } else {
                body = body.child(
                    div()
                        .px(px(24.))
                        .text_color(hsla(c.muted))
                        .child("Preview unavailable"),
                );
            }
        } else {
            body = body.child(
                div()
                    .px(px(24.))
                    .text_color(hsla(c.muted))
                    .child("Loading…"),
            );
        }
        crate::style::modal_backdrop()
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .id("detail-dismiss")
                    .absolute()
                    .inset_0()
                    .bg(hsla(c.ground.alpha(0.7)))
                    .on_click(cx.listener(|this, _, window, cx| this.dismiss(window, cx))),
            )
            .child(
                div()
                    .id("file-detail-panel")
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .relative()
                    .w(relative(0.9))
                    .h(relative(0.86))
                    .rounded(px(14.))
                    .border_1()
                    .border_color(hsla(c.line))
                    .bg(hsla(c.ground))
                    .overflow_hidden()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .h(px(56.))
                            .flex_shrink_0()
                            .px(px(24.))
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(16.))
                            .border_b_1()
                            .border_color(hsla(c.line_soft))
                            .text_size(px(13.))
                            .text_color(hsla(c.ink))
                            .child(div().min_w(px(0.)).truncate().child(path))
                            .child(
                                div()
                                    .flex()
                                    .gap(px(16.))
                                    .flex_shrink_0()
                                    .child(
                                        div()
                                            .id("detail-mode")
                                            .rounded(px(4.))
                                            .when(self.detail_control == 0, |d| d.bg(hsla(c.hover)))
                                            .cursor_pointer()
                                            .text_color(hsla(c.ink_soft))
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.detail_control = 0;
                                                if let Some(d) = &mut this.detail {
                                                    d.source = !d.source;
                                                    d.scroll.set_offset(point(px(0.), px(0.)));
                                                }
                                                cx.notify();
                                            }))
                                            .child(if source { "Diff" } else { "Source" }),
                                    )
                                    .child(
                                        div()
                                            .id("detail-wrap")
                                            .rounded(px(4.))
                                            .when(self.detail_control == 1, |d| d.bg(hsla(c.hover)))
                                            .cursor_pointer()
                                            .text_color(hsla(if wrap { c.ink } else { c.muted }))
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.detail_control = 1;
                                                if let Some(d) = &mut this.detail {
                                                    d.wrap = !d.wrap;
                                                }
                                                cx.notify();
                                            }))
                                            .child("Wrap"),
                                    )
                                    .child(
                                        div()
                                            .id("detail-close")
                                            .rounded(px(4.))
                                            .when(self.detail_control == 2, |d| d.bg(hsla(c.hover)))
                                            .cursor_pointer()
                                            .px(px(6.))
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.dismiss(window, cx)
                                            }))
                                            .child("×"),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .id("detail-body")
                            .track_scroll(&detail.scroll)
                            .flex_1()
                            .min_h(px(0.))
                            .overflow_scroll()
                            .child(body),
                    ),
            )
            .into_any_element()
    }
}
fn code_line(old: u32, new: Option<u32>, kind: &str, text: &str, wrap: bool, c: &Palette) -> Div {
    let bg = match kind {
        "add" => c.diff_add.mix(0.08, c.ground),
        "del" => c.diff_del.mix(0.08, c.ground),
        _ => c.ground,
    };
    let ink = match kind {
        "add" => c.diff_add,
        "del" => c.diff_del,
        _ => c.ink_soft,
    };
    div()
        .flex()
        .min_w_full()
        .bg(hsla(bg))
        .px(px(16.))
        .gap(px(12.))
        .child(
            div()
                .w(px(38.))
                .flex_shrink_0()
                .text_color(hsla(c.muted))
                .child(if old == 0 {
                    String::new()
                } else {
                    old.to_string()
                }),
        )
        .child(
            div()
                .w(px(38.))
                .flex_shrink_0()
                .text_color(hsla(c.muted))
                .child(new.map(|n| n.to_string()).unwrap_or_default()),
        )
        .child(
            div()
                .w(px(12.))
                .flex_shrink_0()
                .text_color(hsla(ink))
                .child(match kind {
                    "add" => "+",
                    "del" => "−",
                    _ => " ",
                }),
        )
        .child(
            div()
                .when(!wrap, |d| d.whitespace_nowrap())
                .when(wrap, |d| d.flex_1().min_w(px(0.)))
                .text_color(hsla(c.ink_soft))
                .child(if text.is_empty() {
                    " ".to_string()
                } else {
                    text.to_string()
                }),
        )
}

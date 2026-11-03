//! File cards and the overflow bundle.
use super::*;
impl ProjectView {
    pub(super) fn render_card(
        &self,
        entry: &FileEntry,
        c: &Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = entry.key();
        let is_selected = self.selected.as_deref() == Some(&key);
        let path_str = &entry.change.path;
        let is_deleted = entry.change.status.eq_ignore_ascii_case("deleted")
            || (entry.change.removed > 0
                && entry.change.added == 0
                && entry.change.status.contains("del"));
        let is_new = entry.change.status.eq_ignore_ascii_case("untracked")
            || entry.change.status.eq_ignore_ascii_case("added");
        let added = entry.change.added;
        let removed = entry.change.removed;
        let is_empty = is_new && added == 0 && removed == 0;

        let path = std::path::Path::new(path_str);
        let filename = path
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| path_str.clone());
        let parent = path
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .filter(|p| !p.is_empty());

        let marks = marks_for_card(&filename, added, removed, is_deleted);

        let entry_clone = entry.clone();
        let hover_key = key.clone();
        let lift = self.card_lifts.get(&key).copied().unwrap_or(0.);

        div()
            .id(SharedString::from(format!("card-{key}")))
            .child(self.track_bounds(key.clone()))
            .relative()
            .w(px(CARD_W))
            .h(px(CARD_H))
            .p(px(15.))
            .rounded(px(12.))
            .cursor_pointer()
            .flex()
            .flex_col()
            .justify_between()
            .bg(hsla(if is_deleted {
                c.raised_high.mix(0.45, c.ground)
            } else {
                c.raised_high
            }))
            .when(is_selected, |d| d.border_2().border_color(hsla(c.accent)))
            .when(!is_selected && is_deleted, |d| {
                d.border_1().border_color(hsla(c.diff_del))
            })
            .when(!is_selected && !is_deleted, |d| {
                d.border_1().border_color(hsla(c.line_soft))
            })
            // Hover card lift without continuous frames
            .top(px(-6. * lift))
            .on_hover(cx.listener(move |this, over: &bool, _, cx| {
                let next = if *over {
                    Some(hover_key.clone())
                } else if this.hovered.as_ref() == Some(&hover_key) {
                    None
                } else {
                    return;
                };
                if this.hovered != next {
                    this.hovered = next;
                    cx.notify();
                }
            }))
            .on_click(cx.listener(move |this, _, window, cx| {
                this.open_file(entry_clone.clone(), window, cx);
            }))
            // Top: Icon and marks sketch
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(14.))
                    .child(
                        div().size(px(18.)).child(
                            div()
                                .w(px(13.))
                                .h(px(16.))
                                .rounded(px(2.))
                                .border_1()
                                .border_color(hsla(c.muted))
                                .pt(px(5.))
                                .px(px(2.))
                                .flex()
                                .flex_col()
                                .gap(px(2.))
                                .children((0..2).map(|_| div().h(px(1.)).bg(hsla(c.muted)))),
                        ),
                    )
                    .child(if is_empty {
                        div().w(px(44.)).h(px(1.5)).bg(hsla(c.line_soft))
                    } else {
                        let mut marks_col = div().flex().flex_col().gap(px(4.5));
                        for (w, tone) in marks {
                            let mark_color = match tone {
                                CardTone::Context => c.muted,
                                CardTone::Add => c.diff_add,
                                CardTone::Del => c.diff_del,
                            };
                            marks_col = marks_col.child(
                                div()
                                    .w(px(w))
                                    .h(px(3.5))
                                    .rounded(px(2.))
                                    .bg(hsla(mark_color)),
                            );
                        }
                        marks_col
                    }),
            )
            // Bottom: Name/Path and footer diff
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .when_some(parent, |d, p| {
                                d.child(
                                    div()
                                        .truncate()
                                        .font_family(crate::style::MONO)
                                        .text_size(px(9.5))
                                        .text_color(hsla(c.faint))
                                        .child(p),
                                )
                            })
                            .child(
                                div()
                                    .truncate()
                                    .font_family(crate::style::MONO)
                                    .text_size(px(11.))
                                    .text_color(hsla(if is_deleted { c.muted } else { c.ink }))
                                    .child(filename),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(if is_empty {
                                div()
                                    .font_family(crate::style::MONO)
                                    .text_size(px(10.5))
                                    .text_color(hsla(c.faint))
                                    .child("empty")
                            } else {
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(7.))
                                    .font_family(crate::style::MONO)
                                    .text_size(px(10.5))
                                    .when(added > 0, |d| {
                                        d.child(
                                            div()
                                                .text_color(hsla(c.diff_add))
                                                .child(format!("+{added}")),
                                        )
                                    })
                                    .when(removed > 0, |d| {
                                        d.child(
                                            div()
                                                .text_color(hsla(c.diff_del))
                                                .child(format!("−{removed}")),
                                        )
                                    })
                            })
                            .when(is_new && !is_empty, |d| {
                                d.child(
                                    div()
                                        .font_family(crate::style::MONO)
                                        .text_size(px(10.))
                                        .text_color(hsla(c.muted))
                                        .child("new"),
                                )
                            })
                            .when(is_deleted, |d| {
                                d.child(
                                    div()
                                        .font_family(crate::style::MONO)
                                        .text_size(px(10.))
                                        .text_color(hsla(c.diff_del))
                                        .child("del"),
                                )
                            }),
                    ),
            )
            .into_any_element()
    }
    pub(super) fn render_bundle_card(
        &self,
        overflow_count: usize,
        c: &Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        div()
            .id(SharedString::from(format!("bundle-{overflow_count}")))
            .child(self.track_bounds("peek".into()))
            .when(self.selected.as_deref() == Some("peek"), |d| {
                d.border_2().border_color(hsla(c.focus))
            })
            .relative()
            .w(px(CARD_W))
            .h(px(CARD_H))
            .rounded(px(12.))
            .cursor_pointer()
            .border_1()
            .border_color(hsla(c.line_soft))
            .bg(hsla(c.raised_high))
            .hover(|s| s.top(px(-6.)))
            .on_click(cx.listener(|this, _, window, cx| {
                this.open_peek(window, cx);
            }))
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            // Splayed mini cards
            .child(
                div()
                    .relative()
                    .w(px(110.))
                    .h(px(100.))
                    // Mini card 1
                    .child(
                        div()
                            .absolute()
                            .left(px(8.))
                            .top(px(10.))
                            .w(px(64.))
                            .h(px(80.))
                            .rounded(px(8.))
                            .bg(hsla(c.raised))
                            .border_1()
                            .border_color(hsla(c.line_soft)),
                    )
                    // Mini card 2
                    .child(
                        div()
                            .absolute()
                            .left(px(24.))
                            .top(px(6.))
                            .w(px(64.))
                            .h(px(80.))
                            .rounded(px(8.))
                            .bg(hsla(c.raised))
                            .border_1()
                            .border_color(hsla(c.line_soft)),
                    )
                    // Mini card 3 (front)
                    .child(
                        div()
                            .absolute()
                            .left(px(38.))
                            .top(px(12.))
                            .w(px(64.))
                            .h(px(80.))
                            .rounded(px(8.))
                            .bg(hsla(c.raised_high))
                            .border_1()
                            .border_color(hsla(c.line_soft))
                            .p(px(8.))
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .child(
                                div()
                                    .w(px(32.))
                                    .h(px(3.))
                                    .rounded(px(1.5))
                                    .bg(hsla(c.diff_add)),
                            )
                            .child(
                                div()
                                    .w(px(22.))
                                    .h(px(3.))
                                    .rounded(px(1.5))
                                    .bg(hsla(c.diff_del)),
                            )
                            .child(
                                div()
                                    .w(px(28.))
                                    .h(px(3.))
                                    .rounded(px(1.5))
                                    .bg(hsla(c.faint)),
                            ),
                    ),
            )
            // +N pill overlapping bottom
            .child(
                div()
                    .absolute()
                    .bottom(px(16.))
                    .h(px(22.))
                    .px(px(10.))
                    .rounded(px(11.))
                    .bg(hsla(c.ink))
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .child(
                        div()
                            .font_family(crate::style::MONO)
                            .text_size(px(11.))
                            .text_color(hsla(c.ground))
                            .child(format!("+{overflow_count}")),
                    ),
            )
            .into_any_element()
    }
}

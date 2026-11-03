//! Distinct clean and non-repository presentations.
use super::*;
impl ProjectView {
    pub(super) fn render_empty_state(
        &self,
        c: &Palette,
        repo: bool,
        branch: Option<&str>,
    ) -> AnyElement {
        let clean_text = if repo {
            "Working tree clean"
        } else {
            "Not a git repository"
        };
        let sync_text = if repo { "UP TO DATE" } else { "NOT TRACKED" };
        let stage_label = if repo {
            "No changes"
        } else {
            "Not tracked yet"
        };

        div()
            .flex()
            .flex_col()
            .gap(px(14.))
            .w_full()
            // Header row
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .w_full()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .text_size(px(12.5))
                            .text_color(hsla(c.ink_soft))
                            .when(repo, |d| {
                                d.child(
                                    svg()
                                        .path("icons/git-branch.svg")
                                        .size(px(14.))
                                        .flex_shrink_0()
                                        .text_color(hsla(c.diff_add)),
                                )
                            })
                            .child(clean_text),
                    )
                    .child(
                        div()
                            .font_family(crate::style::MONO)
                            .text_size(px(11.))
                            .text_color(hsla(c.muted))
                            .child(sync_text),
                    ),
            )
            // Centred stage
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap(px(20.))
                    .min_h(px(236.))
                    .p(px(28.))
                    // Three-sheet folder glyph
                    .child(
                        div()
                            .relative()
                            .w(px(180.))
                            .h(px(118.))
                            // Left sheet
                            .child(
                                div()
                                    .absolute()
                                    .left(px(26.))
                                    .top(px(22.))
                                    .w(px(76.))
                                    .h(px(92.))
                                    .rounded(px(12.))
                                    .border_1()
                                    .border_color(hsla(c.line_soft))
                                    .bg(hsla(c.raised))
                                    .child(
                                        div()
                                            .size(px(15.))
                                            .m(px(12.))
                                            .rounded(px(4.))
                                            .bg(hsla(c.faint.alpha(0.32))),
                                    ),
                            )
                            // Right sheet
                            .child(
                                div()
                                    .absolute()
                                    .left(px(78.))
                                    .top(px(22.))
                                    .w(px(76.))
                                    .h(px(92.))
                                    .rounded(px(12.))
                                    .border_1()
                                    .border_color(hsla(c.line_soft))
                                    .bg(hsla(c.raised))
                                    .flex()
                                    .justify_end()
                                    .child(
                                        div()
                                            .size(px(15.))
                                            .m(px(12.))
                                            .rounded(px(4.))
                                            .bg(hsla(c.faint.alpha(0.32))),
                                    ),
                            )
                            // Front sheet
                            .child(
                                div()
                                    .absolute()
                                    .left(px(52.))
                                    .top(px(16.))
                                    .w(px(76.))
                                    .h(px(92.))
                                    .rounded(px(12.))
                                    .border_1()
                                    .border_color(hsla(c.line_soft))
                                    .bg(hsla(c.raised_high))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(
                                        div()
                                            .w(px(14.))
                                            .h(px(6.))
                                            .rounded(px(3.))
                                            .bg(hsla(c.faint.alpha(0.29))),
                                    ),
                            )
                            // Green check circle on repo clean
                            .when(repo, |d| {
                                d.child(
                                    div()
                                        .absolute()
                                        .left(px(74.))
                                        .top(px(0.))
                                        .size(px(32.))
                                        .rounded_full()
                                        .bg(hsla(c.diff_add))
                                        .border_2()
                                        .border_color(hsla(c.ground))
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .child(
                                            div()
                                                .text_color(hsla(c.ground))
                                                .text_size(px(14.))
                                                .child("✓"),
                                        ),
                                )
                            }),
                    )
                    .child(
                        div()
                            .text_size(px(13.5))
                            .text_color(hsla(c.ink_soft))
                            .child(stage_label),
                    )
                    .when_some(branch, |d, b| {
                        d.child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .px(px(11.))
                                .py(px(5.))
                                .rounded(px(8.))
                                .bg(hsla(c.band))
                                .child(
                                    svg()
                                        .path("icons/git-branch.svg")
                                        .size(px(12.))
                                        .flex_shrink_0()
                                        .text_color(hsla(c.muted)),
                                )
                                .child(
                                    div()
                                        .font_family(crate::style::MONO)
                                        .text_size(px(11.))
                                        .text_color(hsla(c.muted))
                                        .child(b.to_string()),
                                ),
                        )
                    }),
            )
            .into_any_element()
    }
}

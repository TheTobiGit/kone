//! The Switch branch picker: piece 1, the card at rest. Lists the project's
//! branches the way Electron's BranchPickerModal does (checkout mode). Rows are
//! inert for now. Electron's weights (title 600, rows 500) are drawn one step
//! lighter because GPUI renders Inter heavier than Chromium. Cancel, the scrim and Escape close it.
use super::ProjectView;
use crate::git_service::{picker_options, GitBranch};
use crate::shell::SANS;
use crate::style::{paint_header_band, BAND_ARC, HEADER_H};
use gpui_kit::prelude::*;
use gpui_kit::*;
use kone_theme::{hsla, Palette};
use std::sync::{atomic::AtomicBool, Arc};

#[derive(Default)]
pub(super) struct BranchPicker {
    /// None while loading.
    pub(super) branches: Option<Result<Vec<GitBranch>, String>>,
}

impl ProjectView {
    pub(super) fn open_branch_picker(&mut self, cx: &mut Context<Self>) {
        if self.branch_picker.is_some() {
            return;
        }
        self.branch_picker = Some(BranchPicker::default());
        let git = self.git.clone();
        let path = self.path.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        let task = cx.background_spawn(async move {
            git.branches(std::path::Path::new(&path), &cancel).map(picker_options)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await.map_err(|_| "Couldn’t load branches".to_string());
            let _ = this.update(cx, |this, cx| {
                if let Some(picker) = &mut this.branch_picker {
                    picker.branches = Some(result);
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn close_branch_picker(&mut self, cx: &mut Context<Self>) {
        if self.branch_picker.take().is_some() {
            cx.notify();
        }
    }

    pub(super) fn render_branch_picker(&self, c: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let Some(picker) = &self.branch_picker else {
            return div().into_any_element();
        };
        let band = c.band;
        let header = div()
            .relative()
            .h(px(HEADER_H))
            .mb(px(12.))
            .flex_shrink_0()
            .child(
                canvas(|_, _, _| (), move |bounds, _, window, _| {
                    paint_header_band(bounds, hsla(band), window)
                })
                .absolute()
                .left_0()
                .right_0()
                .top_0()
                .h(px(HEADER_H + BAND_ARC)),
            )
            .child(
                div()
                    .relative()
                    .h_full()
                    .px(px(16.))
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(16.))
                    .child(
                        div()
                            .text_size(px(14.))
                            .font_weight(FontWeight::MEDIUM)
                            .line_height(px(17.5))
                            .whitespace_nowrap()
                            .text_color(hsla(c.ink))
                            .child("Switch branch"),
                    )
                    .child(
                        div()
                            .id("branch-picker-cancel")
                            .cursor_pointer()
                            .text_size(px(13.))
                            .font_weight(FontWeight::NORMAL)
                            .whitespace_nowrap()
                            .text_color(hsla(c.muted))
                            .on_click(cx.listener(|this, _, _, cx| this.close_branch_picker(cx)))
                            .child("Cancel"),
                    ),
            );

        let note = |text: String| {
            div()
                .px(px(12.))
                .py(px(10.))
                .text_size(px(13.))
                .text_color(hsla(c.muted))
                .child(text)
                .into_any_element()
        };
        let rows: Vec<AnyElement> = match &picker.branches {
            None => vec![note("Loading…".into())],
            Some(Err(e)) => vec![note(e.clone())],
            Some(Ok(list)) if list.is_empty() => vec![note("No other branches".into())],
            Some(Ok(list)) => list
                .iter()
                .enumerate()
                .map(|(i, b)| branch_row(i, b, c))
                .collect(),
        };

        let card = div()
            .id("branch-picker-card")
            .max_w(px(448.))
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(px(18.))
            .bg(hsla(c.panel))
            .border_1()
            .border_color(hsla(c.ink.alpha(0.08)))
            .font_family(SANS)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(header)
            .child(
                div()
                    .px(px(12.))
                    .pb(px(12.))
                    .child(div().flex().flex_col().items_start().gap(px(2.)).py(px(4.)).children(rows)),
            );

        div()
            .id("branch-picker-scrim")
            .absolute()
            .inset_0()
            .flex()
            .items_end()
            .justify_start()
            .p(px(40.))
            .bg(hsla(c.ground.alpha(0.62)))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| this.close_branch_picker(cx)),
            )
            .child(card)
            .into_any_element()
    }
}

fn branch_row(index: usize, b: &GitBranch, c: &Palette) -> AnyElement {
    let tag = if b.current {
        Some("current")
    } else if b.remote {
        Some("remote")
    } else {
        None
    };
    div()
        .id(("branch-row", index))
        .flex()
        .items_center()
        .gap(px(8.))
        .max_w_full()
        .rounded(px(10.))
        .px(px(12.))
        .py(px(10.))
        .cursor_default()
        .child(
            div()
                .min_w(px(0.))
                .truncate()
                .text_size(px(14.))
                .font_weight(FontWeight::NORMAL)
                .line_height(px(18.2))
                .text_color(hsla(c.ink))
                .child(b.name.clone()),
        )
        .when_some(tag, |d, tag| {
            d.child(
                div()
                    .flex_none()
                    .text_size(px(12.))
                    .font_weight(FontWeight::NORMAL)
                    .text_color(hsla(c.muted))
                    .child(tag),
            )
        })
        .into_any_element()
}

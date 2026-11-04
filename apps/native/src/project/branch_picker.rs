//! The Switch branch picker with search and keyboard highlighting. Lists the project's
//! branches the way Electron's BranchPickerModal does (checkout mode). Rows are
//! inert for now. Electron's weights (title 600, rows 500) are drawn one step
//! lighter because GPUI renders Inter heavier than Chromium. Cancel, the scrim and Escape close it.
use super::ProjectView;
use crate::git_service::{GitBranch, picker_options};
use crate::magnet::Magnet;
use crate::motion::sample_hover;
use crate::shell::SANS;
use crate::style::{BAND_ARC, HEADER_H, input_style, paint_header_band};
use gpui_ce_motion::MotionValue;
use gpui_kit::base::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::*;
use gpui_kit::*;
use kone_theme::{Palette, Theme, hsla};
use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, atomic::AtomicBool};
use std::time::Duration;

#[derive(Default)]
pub(super) struct BranchPicker {
    /// None while loading.
    pub(super) branches: Option<Result<Vec<GitBranch>, String>>,
    pub(super) hovered: Option<usize>,
    input: Option<Entity<InputState>>,
    _input_sub: Option<Subscription>,
    query: String,
    keyboard_highlight: bool,
    pub(super) row_motion: HashMap<String, MotionValue>,
    pub(super) row_hovering: HashMap<String, bool>,
    pub(super) magnets: HashMap<String, Magnet>,
}

impl BranchPicker {
    fn reset_query(&mut self, query: String) {
        self.query = query;
        self.hovered = None;
        self.keyboard_highlight = false;
        // Hidden rows must not retain hover animations or magnet probes.
        self.row_motion.clear();
        self.row_hovering.clear();
        self.magnets.clear();
    }
}

struct RowVisual {
    hover: f32,
    offset: (f32, f32),
    probe: Option<Rc<Cell<Option<Bounds<Pixels>>>>>,
    hoverable: bool,
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
            git.branches(std::path::Path::new(&path), &cancel)
                .map(picker_options)
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

    pub(super) fn close_branch_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.branch_picker.take().is_some() {
            self.focus.focus(window, cx);
            cx.notify();
        }
    }

    /// Capture picker navigation; leave text editing to InputState.
    pub(super) fn branch_picker_key(
        &mut self,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(picker) = &mut self.branch_picker else {
            return;
        };
        match key {
            "escape" if !picker.query.is_empty() => {
                if let Some(input) = picker.input.clone() {
                    input.update(cx, |state, cx| state.set_value("", window, cx));
                }
                picker.reset_query(String::new());
                cx.notify();
            }
            "escape" => self.close_branch_picker(window, cx),
            "up" | "down" => {
                let selectable: Vec<_> = picker
                    .branches
                    .as_ref()
                    .and_then(|result| result.as_ref().ok())
                    .map(|branches| {
                        filter_branches(branches, &picker.query)
                            .into_iter()
                            .enumerate()
                            .filter_map(|(i, branch)| (!branch.current).then_some(i))
                            .collect()
                    })
                    .unwrap_or_default();
                let at = selectable.iter().position(|i| Some(*i) == picker.hovered);
                picker.hovered = if selectable.is_empty() {
                    None
                } else {
                    let next = match (at, key) {
                        (Some(i), "up") => i.saturating_sub(1),
                        (Some(i), _) => (i + 1).min(selectable.len() - 1),
                        (None, "up") => selectable.len() - 1,
                        (None, _) => 0,
                    };
                    Some(selectable[next])
                };
                picker.keyboard_highlight = true;
                cx.notify();
            }
            _ => {}
        }
    }

    fn prepare_branch_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self
            .branch_picker
            .as_ref()
            .is_some_and(|p| p.input.is_none())
        {
            return;
        }
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Search branches"));
        let sub = cx.subscribe_in(&input, window, |this, input, event: &InputEvent, _, cx| {
            if let Some(picker) = &mut this.branch_picker {
                if matches!(event, InputEvent::Change) {
                    picker.reset_query(input.read(cx).value().to_string());
                }
                cx.notify();
            }
        });
        let first = input.clone();
        window.defer(cx, move |window, cx| {
            first.read(cx).focus_handle(cx).focus(window, cx)
        });
        if let Some(picker) = &mut self.branch_picker {
            picker.input = Some(input);
            picker._input_sub = Some(sub);
        }
    }

    pub(super) fn render_branch_picker(
        &mut self,
        c: &Palette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.prepare_branch_search(window, cx);
        let now = self.started.elapsed();
        let Some(picker) = &mut self.branch_picker else {
            return div().into_any_element();
        };
        let mut animating = false;
        let band = c.band;
        let header = div()
            .relative()
            .h(px(HEADER_H))
            .mb(px(12.))
            .flex_shrink_0()
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, _| paint_header_band(bounds, hsla(band), window),
                )
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
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.close_branch_picker(window, cx)
                            }))
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
            Some(Ok(list)) if list.is_empty() && picker.query.trim().is_empty() => {
                vec![note("No other branches".into())]
            }
            Some(Ok(list)) => {
                let branches = filter_branches(list, &picker.query);
                if branches.is_empty() {
                    vec![note("No branches match".into())]
                } else {
                    let hovered_idx = picker.hovered;
                    branches
                        .iter()
                        .enumerate()
                        .map(|(i, b)| {
                            if b.current {
                                let visual = RowVisual {
                                    hover: 0.,
                                    offset: (0., 0.),
                                    probe: None,
                                    hoverable: false,
                                };
                                branch_row(i, b, c, visual, cx)
                            } else {
                                let is_hovered = hovered_idx == Some(i);
                                let motion = picker
                                    .row_motion
                                    .entry(b.name.clone())
                                    .or_insert_with(|| MotionValue::new(0.));
                                let hovering =
                                    picker.row_hovering.entry(b.name.clone()).or_insert(false);
                                let (hover, hover_anim) =
                                    sample_hover(motion, hovering, is_hovered, now);
                                animating |= hover_anim;

                                let magnet = picker.magnets.entry(b.name.clone()).or_default();
                                let offset = magnet.offset();
                                let probe = magnet.probe();

                                let visual = RowVisual {
                                    hover,
                                    offset,
                                    probe: Some(probe),
                                    hoverable: true,
                                };
                                branch_row(i, b, c, visual, cx)
                            }
                        })
                        .collect()
                }
            }
        };

        if picker.magnets.values().any(Magnet::settling) {
            animating = true;
        }

        if animating {
            window.request_animation_frame();
        }

        let input = picker.input.as_ref().expect("branch search prepared");
        let focused = input.read(cx).focus_handle(cx).is_focused(window);
        input.update(cx, |state, _| {
            state.set_editor_style(input_style(c, focused))
        });
        let search = div()
            .mx(px(12.))
            .mb(px(6.))
            .h(px(32.))
            .px(px(11.))
            .flex()
            .items_center()
            .rounded(px(9.))
            .border_1()
            .border_color(hsla(if focused {
                c.ink.alpha(0.22)
            } else {
                c.line_soft
            }))
            .bg(hsla(c.band.alpha(0.5)))
            .font_family(SANS)
            .text_size(px(13.))
            .child(div().flex_1().min_w(px(0.)).child(Input::new(input)));

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
            .child(search)
            .child(
                div().px(px(12.)).pb(px(12.)).child(
                    div()
                        .flex()
                        .flex_col()
                        .items_start()
                        .gap(px(2.))
                        .py(px(4.))
                        .children(rows),
                ),
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
                cx.listener(|this, _, window, cx| this.close_branch_picker(window, cx)),
            )
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| {
                let Some(picker) = &mut this.branch_picker else {
                    return;
                };
                let mut moved = false;
                for magnet in picker.magnets.values_mut() {
                    moved |= magnet.track(event.position);
                }
                if moved {
                    cx.notify();
                }
            }))
            .child(card)
            .into_any_element()
    }
}

fn branch_row(
    index: usize,
    b: &GitBranch,
    c: &Palette,
    visual: RowVisual,
    cx: &mut Context<ProjectView>,
) -> AnyElement {
    let tag = if b.current {
        Some("current")
    } else if b.remote {
        Some("remote")
    } else {
        None
    };
    let (x, y) = visual.offset;
    let mut row = div()
        .id(("branch-row", index))
        .relative()
        .left(px(x))
        .top(px(y))
        .flex()
        .items_center()
        .gap(px(8.))
        .max_w_full()
        .rounded(px(10.))
        .px(px(12.))
        .py(px(10.))
        .tooltip(branch_tip(b.name.clone()))
        .tooltip_show_delay(Duration::from_millis(500))
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
        });

    if visual.hoverable {
        row = row
            .cursor_pointer()
            .when(visual.hover > 0.001, |d| {
                d.bg(hsla(c.hover.alpha(c.hover.a * visual.hover)))
            })
            .on_mouse_move(cx.listener(move |this, _, _, cx| {
                if let Some(picker) = &mut this.branch_picker
                    && (picker.keyboard_highlight || picker.hovered != Some(index))
                {
                    picker.keyboard_highlight = false;
                    picker.hovered = Some(index);
                    cx.notify();
                }
            }))
            .on_hover(cx.listener(move |this, over: &bool, _, cx| {
                let Some(picker) = &mut this.branch_picker else {
                    return;
                };
                if *over {
                    picker.keyboard_highlight = false;
                    picker.hovered = Some(index);
                } else if !picker.keyboard_highlight && picker.hovered == Some(index) {
                    picker.hovered = None;
                }
                cx.notify();
            }));
    } else {
        row = row.cursor_default();
    }

    let mut wrapper = div().relative().max_w_full();
    if let Some(probe) = visual.probe {
        wrapper = wrapper.child(
            canvas(move |b, _, _| probe.set(Some(b)), |_, _, _, _| {})
                .absolute()
                .size_full(),
        );
    }
    wrapper.child(row).into_any_element()
}

struct BranchTip(SharedString);

impl Render for BranchTip {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::get(cx);
        let c = &theme.colors;
        let (background, foreground, border) = if theme.is_dark() {
            (c.sunken, c.ink, c.muted)
        } else {
            (c.ink, c.raised_high, c.line)
        };
        div().pl(px(11.)).pt(px(14.)).child(
            div()
                .font_family(SANS)
                .px(px(4.))
                .py(px(3.))
                .bg(hsla(background))
                .border_1()
                .border_color(hsla(border))
                .text_size(px(13.5))
                .line_height(px(16.))
                .font_weight(FontWeight::NORMAL)
                .text_color(hsla(foreground))
                .whitespace_nowrap()
                .child(self.0.clone()),
        )
    }
}

fn branch_tip(
    text: impl Into<SharedString>,
) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let text = text.into();
    move |_, cx| cx.new(|_| BranchTip(text.clone())).into()
}

/// Preserve picker order and metadata, including current, only on a name match.
fn filter_branches(branches: &[GitBranch], query: &str) -> Vec<GitBranch> {
    let query = query.trim().to_lowercase();
    branches
        .iter()
        .filter(|branch| branch.name.to_lowercase().contains(&query))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{filter_branches, GitBranch};
    fn branches() -> Vec<GitBranch> {
        [
            ("main", true),
            ("feature/login", false),
            ("fix/header-spacing", false),
        ]
        .into_iter()
        .map(|(name, current)| GitBranch {
            name: name.into(),
            current,
            remote: false,
            upstream: None,
        })
        .collect()
    }
    #[test]
    fn empty_query_preserves_all_branches_and_order() {
        assert_eq!(filter_branches(&branches(), ""), branches());
    }
    #[test]
    fn search_is_case_insensitive() {
        assert_eq!(
            filter_branches(&branches(), "FEATURE"),
            vec![branches()[1].clone()]
        );
    }
    #[test]
    fn search_matches_substring_in_middle() {
        assert_eq!(
            filter_branches(&branches(), "header"),
            vec![branches()[2].clone()]
        );
    }
    #[test]
    fn current_branch_is_hidden_unless_it_matches() {
        assert!(!filter_branches(&branches(), "fe").iter().any(|b| b.current));
        assert_eq!(
            filter_branches(&branches(), "mai"),
            vec![branches()[0].clone()]
        );
    }
    #[test]
    fn no_match_returns_empty() {
        assert!(filter_branches(&branches(), "zzz").is_empty());
    }
    #[test]
    fn query_is_trimmed() {
        assert_eq!(
            filter_branches(&branches(), "  login \t"),
            vec![branches()[1].clone()]
        );
        assert_eq!(filter_branches(&branches(), " \t"), branches());
    }
}

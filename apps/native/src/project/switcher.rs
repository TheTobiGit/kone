//! Greeting-owned project navigation; Shell remains the owner of project opening.
use super::*;
use kone_theme::Palette;
use std::{cell::Cell, rc::Rc};

#[derive(Default)]
pub(super) struct Switcher {
    pub open: bool,
    pub suspended: bool,
    error: Option<String>,
    pub(super) rows: Vec<crate::projects::RecentProject>,
    pub(super) tiles: std::collections::HashMap<String, crate::recents::Tile>,
    selected: usize,
    generation: u64,
    pub(super) closing: bool,
    exit_started: Option<std::time::Instant>,
    exit_task: Option<Task<()>>,
    pub(super) pending_cycle: Vec<bool>,
    pub(super) cycle_motion: std::collections::HashMap<String, cycle::CycleCell>,
    hover: Option<usize>,
    hover_motion: std::collections::HashMap<usize, (gpui_ce_motion::MotionValue, bool)>,
    trigger_hover: bool,
    trigger_motion: Option<(gpui_ce_motion::MotionValue, bool)>,
    pub(super) greeting_keys: std::collections::HashSet<String>,
    pub(super) greeting_delays: std::collections::HashMap<String, f32>,

    scroll: ScrollHandle,
    pub cycle: Option<(Vec<crate::projects::RecentProject>, usize)>,
    pub greeting_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    pub root_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
}

fn ordered(
    list: Vec<crate::projects::RecentProject>,
    current: &str,
    pins: bool,
) -> Vec<crate::projects::RecentProject> {
    let mut rows: Vec<_> = list.into_iter().filter(|p| p.path != current).collect();
    if pins {
        rows = crate::projects::sorted(rows);
    } else {
        rows.sort_by_key(|p| std::cmp::Reverse(p.last_opened_at));
    }
    rows
}

fn preserved_selection(
    old: &[crate::projects::RecentProject],
    selected: usize,
    rows: &[crate::projects::RecentProject],
) -> usize {
    if selected == 0 {
        return 0;
    }
    if let Some(project) = old.get(selected - 1) {
        rows.iter()
            .position(|p| p.path == project.path)
            .map_or(0, |i| i + 1)
    } else {
        rows.len() + (selected - old.len()).min(3)
    }
}
fn same_tile(a: &crate::recents::Tile, b: &crate::recents::Tile) -> bool {
    use crate::recents::Tile;
    use kone_rpc::Branch;
    match (a, b) {
        (Tile::Missing, Tile::Missing) | (Tile::Plain, Tile::Plain) => true,
        (Tile::Repo(a, partial_a), Tile::Repo(b, partial_b)) => {
            let branch_equal = match (&a.branch, &b.branch) {
                (Branch::Named(a), Branch::Named(b))
                | (Branch::Detached(a), Branch::Detached(b)) => a == b,
                (Branch::Unknown, Branch::Unknown) => true,
                _ => false,
            };
            partial_a == partial_b
                && branch_equal
                && a.repo == b.repo
                && a.added == b.added
                && a.removed == b.removed
                && a.files.len() == b.files.len()
                && a.files.iter().zip(&b.files).all(|(a, b)| {
                    a.name == b.name
                        && a.change == b.change
                        && a.added == b.added
                        && a.removed == b.removed
                })
        }
        _ => false,
    }
}

fn shadow(c: &Palette, y: f32, blur: f32, spread: f32, opacity: f32) -> BoxShadow {
    let mut shade = hsla(c.sunken);
    shade.l = 0.;
    shade.a = opacity;
    BoxShadow {
        color: shade,
        offset: point(px(0.), px(y)),
        blur_radius: px(blur),
        spread_radius: px(spread),
        inset: false,
    }
}

impl ProjectView {
    pub(super) fn load_switch_projects(&mut self, cx: &mut Context<Self>) {
        if self.switcher.closing || self.switcher.suspended {
            return;
        }
        self.switcher.generation += 1;
        let generation = self.switcher.generation;
        let path = self.path.clone();
        let task =
            cx.background_spawn(async move { ordered(crate::projects::recents(), &path, true) });
        self._switcher_load = Some(cx.spawn(async move |this, cx| {
            let rows = task.await;
            let paths = rows.iter().map(|p| p.path.clone()).collect::<Vec<_>>();
            let published = this
                .update(cx, |this, cx| {
                    if this.switcher.generation != generation {
                        return false;
                    }
                    if this.switcher.rows != rows {
                        this.switcher.selected =
                            preserved_selection(&this.switcher.rows, this.switcher.selected, &rows);
                        this.switcher.rows = rows;
                        this.switcher.hover = None;
                        this.switcher.hover_motion.clear();
                        cx.notify();
                    }
                    for backward in std::mem::take(&mut this.switcher.pending_cycle) {
                        this.advance_cycle(backward, cx);
                    }
                    true
                })
                .unwrap_or(false);
            if !published {
                return;
            }
            let tiles = cx
                .background_spawn(async move { crate::recents::read_tiles(&paths) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.switcher.generation != generation {
                    return;
                }
                let unchanged = tiles.len() == this.switcher.tiles.len()
                    && tiles.iter().all(|(path, tile)| {
                        this.switcher
                            .tiles
                            .get(path)
                            .is_some_and(|old| same_tile(old, tile))
                    });
                if !unchanged {
                    this.switcher.tiles = tiles;
                    cx.notify();
                }
            });
        }));
    }
    pub(super) fn toggle_switcher(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.switcher.open {
            self.close_switcher(window, cx);
            return;
        }
        self.switcher.open = true;
        self.switcher.closing = false;
        self.switcher.exit_started = None;
        self.switcher.exit_task = None;
        self.switcher.error = None;
        self.switcher.selected = 0;
        self.selected = Some("switch-project".into());
        self.focus.focus(window, cx);
        if self.switcher.open {
            self.load_switch_projects(cx);
        }
        cx.notify();
    }
    pub(super) fn close_switcher(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.finish_switcher(None, window, cx);
    }
    fn finish_switcher(
        &mut self,
        action: Option<ProjectAction>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.switcher.closing || self.switcher.suspended {
            return;
        }
        self.switcher.closing = true;
        self.switcher.generation += 1;
        self.switcher.exit_started = Some(std::time::Instant::now());
        let delay = if cx.reduce_motion() {
            Duration::ZERO
        } else {
            crate::motion::EXIT
        };
        self.switcher.exit_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(delay).await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.switcher.open = false;
                this.switcher.closing = false;
                this.switcher.exit_started = None;
                this.selected = Some("switch-project".into());
                this.focus.focus(window, cx);
                if let Some(action) = action {
                    cx.emit(action);
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    pub(crate) fn resume_switcher(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.switcher.suspended = false;
        self.focus.focus(window, cx);
        cx.notify();
    }
    pub(crate) fn switch_failed(
        &mut self,
        message: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.switcher.error = Some(message);
        self.switcher.open = true;
        self.resume_switcher(window, cx);
    }
    fn activate_switcher(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.switcher.closing || self.switcher.suspended {
            return;
        }
        if index == 0 {
            self.close_switcher(window, cx);
            return;
        }
        let action = if let Some(row) = self.switcher.rows.get(index - 1) {
            ProjectAction::Open(row.path.clone().into())
        } else {
            match index - self.switcher.rows.len() - 1 {
                0 => ProjectAction::Create,
                1 => ProjectAction::OpenFolder,
                _ => ProjectAction::Clone,
            }
        };
        if matches!(action, ProjectAction::Open(_)) {
            self.finish_switcher(Some(action), window, cx);
            return;
        }
        self.switcher.error = None;
        self.switcher.suspended = true;
        cx.emit(action);
        cx.notify();
    }
    pub(super) fn switcher_key(
        &mut self,
        key: &str,
        shift: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.switcher.closing {
            cx.stop_propagation();
            return;
        }
        let count = self.switcher.rows.len() + 4;
        match key {
            "escape" => self.close_switcher(window, cx),
            "enter" | "space" => self.activate_switcher(self.switcher.selected, window, cx),
            "tab" | "down" | "right" | "up" | "left" | "home" | "end" => {
                self.switcher.selected = match key {
                    "home" => 0,
                    "end" => count - 1,
                    "up" | "left" => (self.switcher.selected + count - 1) % count,
                    "tab" if shift => (self.switcher.selected + count - 1) % count,
                    _ => (self.switcher.selected + 1) % count,
                };
                if self.switcher.selected > 0 && self.switcher.selected <= self.switcher.rows.len()
                {
                    self.switcher
                        .scroll
                        .scroll_to_item(self.switcher.selected - 1);
                }
                cx.notify();
            }
            _ => {}
        }
        cx.stop_propagation();
    }
    pub(super) fn project_trigger(
        &mut self,
        c: &Palette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let state = self
            .switcher
            .trigger_motion
            .get_or_insert_with(|| (gpui_ce_motion::MotionValue::new(0.), false));
        let (hover, moving) = crate::motion::sample_hover(
            &mut state.0,
            &mut state.1,
            self.switcher.trigger_hover,
            self.started.elapsed(),
        );
        if moving && !cx.reduce_motion() {
            window.request_animation_frame();
        }
        let hover = if cx.reduce_motion() {
            f32::from(self.switcher.trigger_hover)
        } else {
            hover
        };
        div().child(
            div()
                .id("greeting-project-trigger")
                .role(Role::Button)
                .aria_label(format!("Switch project: {}", self.name))
                .aria_expanded(self.switcher.open)
                .relative()
                .flex()
                .items_center()
                .gap(px(6.))
                .rounded(px(9.))
                .px(px(5.))
                .mx(px(-4.))
                .py(px(1.))
                .my(px(-1.))
                .cursor_pointer()
                .text_size(px(30.))
                .text_color(hsla(c.ink))
                .whitespace_nowrap()
                .bg(hsla(c.ink.alpha(0.06 * hover)))
                .on_hover(cx.listener(|this, over: &bool, _, cx| {
                    this.switcher.trigger_hover = *over;
                    cx.notify();
                }))
                .on_click(cx.listener(|this, _, window, cx| this.toggle_switcher(window, cx)))
                .when(
                    self.focus_visible
                        && self.focus.is_focused(window)
                        && self.selected.as_deref() == Some("switch-project"),
                    |d| d.child(crate::recents::ring(9., 2., c.ink.alpha(0.26))),
                )
                .child(self.name.clone())
                .child(
                    svg()
                        .path("icons/arrow-down.svg")
                        .size(px(15.))
                        .text_color(hsla(c.ink.mix(hover, c.ink_soft)))
                        .relative()
                        .top(px(hover)),
                ),
        )
    }
    fn switch_row(
        &self,
        index: usize,
        icon: &'static str,
        content: (String, Option<String>),
        hover: f32,
        c: &Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (label, branch) = content;
        let action = index > self.switcher.rows.len();
        div()
            .id(SharedString::from(format!("switch-row-{index}")))
            .role(Role::Button)
            .aria_label(label.clone())
            .when(
                self.switcher.selected == index && !self.switcher.suspended,
                |d| d.aria_active_descendant(),
            )
            .flex()
            .items_center()
            .gap(px(if action { 8.8 } else { 7.2 }))
            .px(px(8.8))
            .py(px(6.72))
            .rounded(px(9.))
            .cursor_pointer()
            .text_color(hsla(c.ink))
            .bg(hsla(c.ink.alpha(0.04 * hover)))
            .on_hover(cx.listener(move |this, over: &bool, _, cx| {
                // Moving straight onto a sibling fires this row's exit after the
                // sibling's enter; only clear hover if it still points at us.
                match over {
                    true => this.switcher.hover = Some(index),
                    false => {
                        if this.switcher.hover == Some(index) {
                            this.switcher.hover = None;
                        }
                    }
                }
                cx.notify();
            }))
            .when(self.focus_visible && self.switcher.selected == index, |d| {
                d.bg(hsla(c.hover))
            })
            .on_click(
                cx.listener(move |this, _, window, cx| this.activate_switcher(index, window, cx)),
            )
            .child(
                div()
                    .size(px(16.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        svg()
                            .path(icon)
                            .size(px(if action { 16. } else { 15. }))
                            .flex_shrink_0()
                            .text_color(hsla(
                                (if action { c.ink } else { c.ink_soft })
                                    .mix(hover, if action { c.ink_soft } else { c.muted }),
                            )),
                    ),
            )
            .child(
                div()
                    .min_w(px(0.))
                    .text_size(px(if action { 12.5 } else { 13. }))
                    .font_weight(FontWeight::NORMAL)
                    .line_height(px(if action { 19.375 } else { 20.15 }))
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .child(label),
            )
            .when_some(branch, |d, b| {
                d.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(2.5))
                        .max_w(px(90.))
                        .flex_shrink_0()
                        .whitespace_nowrap()
                        .overflow_hidden()
                        .font_family(crate::style::MONO)
                        .text_size(px(10.))
                        .text_color(hsla(c.muted))
                        .child(
                            svg()
                                .path("icons/git-branch.svg")
                                .size(px(11.))
                                .flex_shrink_0()
                                .text_color(hsla(c.muted)),
                        )
                        .child(div().truncate().child(b)),
                )
            })
            .when(action, |d| {
                d.child(div().flex_1()).child(
                    svg()
                        .path("icons/arrow-up.svg")
                        .with_transformation(Transformation::rotate(radians(
                            std::f32::consts::FRAC_PI_2,
                        )))
                        .size(px(13.))
                        .text_color(hsla(c.muted))
                        .relative()
                        .left(px(-3. * (1. - hover)))
                        .opacity(hover),
                )
            })
            .into_any_element()
    }
    pub(super) fn render_switcher(
        &mut self,
        c: &Palette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut hovers = Vec::new();
        for index in 0..self.switcher.rows.len() + 4 {
            let state = self
                .switcher
                .hover_motion
                .entry(index)
                .or_insert_with(|| (gpui_ce_motion::MotionValue::new(0.), false));
            let active = self.switcher.hover == Some(index);
            let (value, moving) = crate::motion::sample_hover(
                &mut state.0,
                &mut state.1,
                active,
                self.started.elapsed(),
            );
            if moving && !cx.reduce_motion() {
                window.request_animation_frame();
            }
            hovers.push(if cx.reduce_motion() {
                f32::from(active)
            } else {
                value
            });
        }
        let greeting = self.switcher.greeting_bounds.get().unwrap_or_default();
        let root = self.switcher.root_bounds.get().unwrap_or_default();
        let x = (greeting.left() - root.left())
            .as_f32()
            .clamp(0., (window.viewport_size().width.as_f32() - 312.).max(0.));
        let y = (greeting.bottom() - root.top()).as_f32() + 8.;
        let card = || {
            div()
                .rounded(px(18.))
                .border_1()
                .border_color(hsla(c.line_soft))
                .shadow(vec![shadow(c, 1., 2., 0., 0.05)])
                .bg(hsla(c.raised))
                .p(px(4.))
                .flex()
                .flex_col()
        };
        let mut list = div()
            .id("switch-project-list")
            .track_scroll(&self.switcher.scroll)
            .max_h(px(window.viewport_size().height.as_f32() * 0.35))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(2.));
        for (i, row) in self.switcher.rows.iter().enumerate() {
            let branch = match self.switcher.tiles.get(&row.path) {
                Some(crate::recents::Tile::Repo(summary, _)) => match &summary.branch {
                    kone_rpc::Branch::Named(b) => Some(b.clone()),
                    kone_rpc::Branch::Detached(b) => Some(b.chars().take(7).collect()),
                    kone_rpc::Branch::Unknown => None,
                },
                _ => None,
            };
            list = list.child(self.switch_row(
                i + 1,
                "icons/folder.svg",
                (row.name.clone(), branch),
                hovers[i + 1],
                c,
                cx,
            ));
        }
        let mut actions = card();
        for (i, (icon, label)) in [
            ("icons/plus.svg", "Create a new project"),
            ("icons/folder-open.svg", "Open from local folder"),
            ("icons/github.svg", "Clone from GitHub"),
        ]
        .into_iter()
        .enumerate()
        {
            actions = actions.child(self.switch_row(
                self.switcher.rows.len() + i + 1,
                icon,
                (label.into(), None),
                hovers[self.switcher.rows.len() + i + 1],
                c,
                cx,
            ));
        }
        let panel = div()
            .id("project-switcher")
            .role(Role::Dialog)
            .aria_label("Switch project")
            .absolute()
            .left(px(x))
            .top(px(y))
            .w(px(300.))
            .rounded(px(20.))
            .bg(hsla(c.band))
            .border_1()
            .border_color(hsla(c.line_soft))
            .shadow(vec![shadow(c, 10., 28., -12., 0.16)])
            .overflow_hidden()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child({
                let band = hsla(c.band);
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, _| {
                        crate::style::paint_header_band_height(bounds, band, 35., window)
                    },
                )
                .absolute()
                .left_0()
                .top_0()
                .w_full()
                .h(px(49.))
            })
            .child(
                div()
                    .relative()
                    .h(px(35.))
                    .px(px(12.))
                    .flex()
                    .items_center()
                    .justify_between()
                    .text_size(px(12.5))
                    .text_color(hsla(c.ink_soft))
                    .child("Switch project")
                    .child(
                        div()
                            .id("switch-cancel")
                            .role(Role::Button)
                            .aria_label("Cancel")
                            .when(
                                self.switcher.selected == 0 && !self.switcher.suspended,
                                |d| d.aria_active_descendant(),
                            )
                            .cursor_pointer()
                            .text_size(px(13.))
                            .text_color(hsla(c.muted))
                            .text_color(hsla(c.muted.alpha(1. - 0.3 * hovers[0])))
                            .on_hover(cx.listener(|this, over: &bool, _, cx| {
                                match over {
                                    true => this.switcher.hover = Some(0),
                                    false => {
                                        if this.switcher.hover == Some(0) {
                                            this.switcher.hover = None;
                                        }
                                    }
                                }
                                cx.notify();
                            }))
                            .when(self.focus_visible && self.switcher.selected == 0, |d| {
                                d.text_color(hsla(c.ink))
                            })
                            .on_click(
                                cx.listener(|this, _, window, cx| this.close_switcher(window, cx)),
                            )
                            .child("Cancel"),
                    ),
            )
            .child(
                div()
                    .px(px(1.))
                    .pb(px(1.))
                    .flex()
                    .flex_col()
                    .gap(px(5.))
                    .when(!self.switcher.rows.is_empty(), |d| {
                        d.child(card().child(list))
                    })
                    .child(actions),
            );
        let panel = panel.when_some(self.switcher.error.clone(), |d, message| {
            d.child(
                div()
                    .px(px(12.))
                    .py(px(8.))
                    .text_size(px(12.))
                    .text_color(hsla(c.danger))
                    .child(message),
            )
        });
        let panel = if let Some(started) = self.switcher.exit_started {
            let t = if cx.reduce_motion() {
                1.
            } else {
                (started.elapsed().as_secs_f32() / 0.24).min(1.)
            };
            if t < 1. {
                window.request_animation_frame();
            }
            let t = crate::motion::bezier(0.4, 0., 1., 1., t);
            panel.mt(px(-10. * t)).opacity(1. - t).into_any_element()
        } else if cx.reduce_motion() {
            panel.into_any_element()
        } else {
            panel
                .with_animation(
                    "project-switcher-in",
                    Animation::new(Duration::from_millis(420)),
                    |el, d| {
                        let t = crate::motion::bezier(0.34, 1.3, 0.64, 1., d);
                        el.mt(px(-10. * (1. - t))).opacity(
                            crate::motion::bezier(0.34, 1.3, 0.64, 1., (d / 0.45).min(1.))
                                .clamp(0., 1.),
                        )
                    },
                )
                .into_any_element()
        };
        crate::style::modal_backdrop()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.close_switcher(window, cx);
                    cx.stop_propagation();
                }),
            )
            .child(panel)
            .into_any_element()
    }
    pub(super) fn step_cycle(&mut self, backward: bool, cx: &mut Context<Self>) {
        if self.switcher.cycle.is_none() {
            if !self.switcher.rows.is_empty() {
                // The held gesture uses a stable snapshot immediately. Refresh for
                // the next gesture without delaying a quick Ctrl+Tab/release.
                self.load_switch_projects(cx);
                self.advance_cycle(backward, cx);
                return;
            }
            let pending = !self.switcher.pending_cycle.is_empty();
            self.switcher.pending_cycle.push(backward);
            if !pending {
                self.load_switch_projects(cx);
            }
            return;
        }
        self.advance_cycle(backward, cx);
    }
    pub(super) fn advance_cycle(&mut self, backward: bool, cx: &mut Context<Self>) {
        if self.switcher.cycle.is_none() {
            let mut rows = ordered(self.switcher.rows.clone(), &self.path, false);
            if rows.is_empty() {
                return;
            }
            self.switcher.cycle_motion.clear();
            rows.insert(
                0,
                crate::projects::RecentProject {
                    path: self.path.clone(),
                    name: self.name.clone(),
                    last_opened_at: 0,
                    pinned: None,
                },
            );
            self.switcher.cycle = Some((rows, 0));
            self.switcher.open = false;
        }
        if let Some((rows, index)) = &mut self.switcher.cycle {
            *index = (*index + if backward { rows.len() - 1 } else { 1 }) % rows.len();
        }
        cx.notify();
    }
    pub(super) fn commit_cycle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.switcher.pending_cycle.clear();
        if let Some((rows, index)) = self.switcher.cycle.take() {
            if window.is_window_active() && rows[index].path != self.path {
                cx.emit(ProjectAction::Open(rows[index].path.clone().into()));
            }
            cx.notify();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ordered;
    use crate::projects::RecentProject;
    #[test]
    fn refresh_retains_path_or_action_and_removed_path_falls_back_to_cancel() {
        let row = |path: &str| RecentProject {
            path: path.into(),
            name: path.into(),
            last_opened_at: 0,
            pinned: None,
        };
        let old = vec![row("a"), row("b")];
        let reordered = vec![row("b"), row("c"), row("a")];
        assert_eq!(super::preserved_selection(&old, 1, &reordered), 3);
        assert_eq!(super::preserved_selection(&old, 2, &reordered), 1);
        assert_eq!(super::preserved_selection(&old, 1, &[row("b")]), 0);
        for action in 1..=3 {
            assert_eq!(
                super::preserved_selection(&old, old.len() + action, &reordered),
                reordered.len() + action
            );
            assert_eq!(
                super::preserved_selection(&old, old.len() + action, &[]),
                action
            );
        }
        assert_eq!(super::preserved_selection(&old, 0, &reordered), 0);
    }
    #[test]
    fn dropdown_uses_pins_but_cycle_uses_mru_and_both_exclude_current() {
        let row = |path: &str, time, pinned| RecentProject {
            path: path.into(),
            name: path.into(),
            last_opened_at: time,
            pinned: Some(pinned),
        };
        let rows = vec![
            row("current", 4, true),
            row("old-pin", 1, true),
            row("recent", 3, false),
            row("older", 2, false),
        ];
        assert_eq!(
            ordered(rows.clone(), "current", true)
                .iter()
                .map(|p| p.path.as_str())
                .collect::<Vec<_>>(),
            ["old-pin", "recent", "older"]
        );
        assert_eq!(
            ordered(rows, "current", false)
                .iter()
                .map(|p| p.path.as_str())
                .collect::<Vec<_>>(),
            ["recent", "older", "old-pin"]
        );
    }
}

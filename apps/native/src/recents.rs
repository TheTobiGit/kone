//! The recents home: the launcher once you've opened projects (Electron's
//! `HomeRecent.vue`). A grid of project folders, pinned first then newest,
//! each with its branch and uncommitted ± read off the UI thread, plus the
//! three start actions in the last cell.

use std::{collections::HashMap, path::Path, time::Duration};

use gpui_ce_motion::{MotionValue, Spring, Transition};

use gpui_kit::prelude::*;
use gpui_kit::*;
use kone_rpc::{Branch, RepoSummary};
use kone_theme::{hsla, Palette};

use crate::projects::RecentProject;
use crate::shell::Shell;

/// What a tile knows about its folder.
#[derive(Clone, Debug)]
pub enum Tile {
    /// The folder is gone (moved, deleted, or an unplugged drive).
    Missing,
    /// A folder that isn't inside a git repo.
    Plain,
    Repo(RepoSummary),
}

/// Reads every row's folder state. Blocking: call it off the UI thread.
pub fn read_tiles(paths: &[String]) -> HashMap<String, Tile> {
    paths
        .iter()
        .map(|p| {
            let path = Path::new(p);
            let tile = if !path.is_dir() {
                Tile::Missing
            } else {
                // A folder inside a repo belongs to it, as in the project view.
                match path.ancestors().find_map(crate::folder_picker::repo_summary) {
                    Some(s) => Tile::Repo(s),
                    None => Tile::Plain,
                }
            };
            (p.clone(), tile)
        })
        .collect()
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Sort {
    #[default]
    Recent,
    Name,
}

/// The rows the grid shows: a case-insensitive name filter, and for the name
/// sort pins still lead (alphabetical within each group). `list` arrives in
/// recents order (pins first, then newest).
pub fn shown(list: &[RecentProject], query: &str, sort: Sort) -> Vec<RecentProject> {
    let q = query.trim().to_lowercase();
    let mut rows: Vec<RecentProject> =
        list.iter().filter(|p| q.is_empty() || p.name.to_lowercase().contains(&q)).cloned().collect();
    if sort == Sort::Name {
        rows.sort_by(|a, b| {
            let (pa, pb) = (a.pinned == Some(true), b.pinned == Some(true));
            pb.cmp(&pa).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
    }
    rows
}

/// Columns in the grid; the start actions take the cell after the last tile.
pub const COLS: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    Left,
    Right,
    Up,
    Down,
}

/// The cell an arrow key lands on in a `COLS`-wide grid of `cells` cells
/// (the tiles plus the start actions). Edges hold; Down into a short last row
/// lands on its last cell, as a grid does when a column has no cell below.
pub fn grid_step(cur: usize, cells: usize, dir: Dir) -> usize {
    if cells == 0 {
        return 0;
    }
    let cur = cur.min(cells - 1);
    match dir {
        Dir::Left => cur.saturating_sub(1),
        Dir::Right => (cur + 1).min(cells - 1),
        Dir::Up => cur.checked_sub(COLS).unwrap_or(cur),
        Dir::Down if cur + COLS < cells => cur + COLS,
        Dir::Down if cur / COLS < (cells - 1) / COLS => cells - 1,
        Dir::Down => cur,
    }
}

/// Focus stops in a cell: a tile has its folder then pin, reveal and remove;
/// the start-actions cell has its three rows.
pub fn slots(cell: usize, tiles: usize) -> usize {
    if cell < tiles {
        4
    } else {
        3
    }
}

/// Tab order through every stop in the grid, wrapping at both ends.
pub fn tab_step((cell, slot): (usize, usize), tiles: usize, forward: bool) -> (usize, usize) {
    let cells = tiles + 1;
    let cell = cell.min(cells - 1);
    let slot = slot.min(slots(cell, tiles) - 1);
    if forward {
        if slot + 1 < slots(cell, tiles) {
            (cell, slot + 1)
        } else {
            ((cell + 1) % cells, 0)
        }
    } else if slot > 0 {
        (cell, slot - 1)
    } else {
        let prev = (cell + cells - 1) % cells;
        (prev, slots(prev, tiles) - 1)
    }
}

/// Where the grid's scroll should sit so `row` is fully in view, given the
/// current scroll `cur` (px down from the top) and the visible height `view`.
/// Rows start `GRID_TOP` down the scroller and are `TILE_H + GAP_Y` apart.
pub fn reveal_scroll(cur: f32, row: usize, view: f32) -> f32 {
    // Room for the hover lift above and the focus ring below.
    const MARGIN: f32 = 12.;
    let top = GRID_TOP + row as f32 * (TILE_H + GAP_Y) - MARGIN;
    let bottom = top + TILE_H + 2. * MARGIN;
    if top < cur {
        top.max(0.)
    } else if bottom > cur + view {
        bottom - view
    } else {
        cur
    }
}

/// The grid's top inside the scroller: the section's top padding plus the grid's.
pub const GRID_TOP: f32 = 72. + 8.;

/// Electron's folder lift: `{ type: 'spring', stiffness: 420, damping: 38, mass: 0.85 }`.
fn lift_spring() -> Transition {
    Transition::Spring(Spring::new(420., 38., 0.85).expect("valid spring"))
}

/// Electron's side actions: `{ type: 'spring', stiffness: 500, damping: 30 }` (mass 1).
fn side_spring() -> Transition {
    Transition::Spring(Spring::new(500., 30., 1.).expect("valid spring"))
}

/// One tile's hover springs. Values run 0 (rest) to 1 (active); they only
/// ask for frames while they are still moving.
pub struct TileMotion {
    lift: MotionValue,
    side: MotionValue,
    active: bool,
}

impl Default for TileMotion {
    fn default() -> Self {
        TileMotion { lift: MotionValue::new(0.), side: MotionValue::new(0.), active: false }
    }
}

impl TileMotion {
    /// Retargets on a change of state, then reads both springs:
    /// `(lift, side, still_moving)`.
    pub fn sample(&mut self, active: bool, now: Duration) -> (f32, f32, bool) {
        if self.active != active {
            self.active = active;
            let to = if active { 1. } else { 0. };
            self.lift.animate(to, lift_spring(), now);
            self.side.animate(to, side_spring(), now);
        }
        let lift = self.lift.sample(now, false);
        let side = self.side.sample(now, false);
        (lift.value() as f32, side.value() as f32, lift.is_animating() || side.is_animating())
    }
}

/// A hover tip: the native app's stand-in for Electron's `title` attribute.
pub struct Tip(pub SharedString);

impl Render for Tip {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = &kone_theme::Theme::get(cx).colors;
        div()
            .font_family(crate::shell::SANS)
            .px(px(8.))
            .py(px(4.))
            .rounded(px(7.))
            .bg(hsla(c.raised_high))
            .border_1()
            .border_color(hsla(c.line_soft))
            .shadow(vec![BoxShadow {
                color: black().opacity(0.12),
                offset: point(px(0.), px(2.)),
                blur_radius: px(8.),
                spread_radius: px(0.),
                inset: false,
            }])
            .text_size(px(12.))
            .text_color(hsla(c.ink))
            .whitespace_nowrap()
            .child(self.0.clone())
    }
}

/// A builder for `.tooltip(..)` showing `text`.
pub fn tip(text: impl Into<SharedString>) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let text = text.into();
    move |_, cx| cx.new(|_| Tip(text.clone())).into()
}

/// Electron's wording; the native app says what Linux calls it.
pub const REVEAL_TIP: &str = if cfg!(target_os = "macos") { "Reveal in Finder" } else { "Reveal in file manager" };

/// A keyboard focus ring hugging an element, `inset` px outside it.
pub fn ring(radius: f32, inset: f32, color: kone_theme::Rgba) -> Div {
    div()
        .absolute()
        .top(px(-inset))
        .left(px(-inset))
        .right(px(-inset))
        .bottom(px(-inset))
        .rounded(px(radius + inset))
        .border_2()
        .border_color(hsla(color))
}

/// Tile geometry from `ProjectFolder.vue`.
pub const TILE_W: f32 = 200.;
pub const TILE_H: f32 = 116.;
const POCKET_H: f32 = 92.;
/// Room on the right for the side actions.
const ACTIONS_W: f32 = 36.;
pub const CELL_W: f32 = TILE_W + ACTIONS_W;
pub const GAP_X: f32 = 56.;
pub const GAP_Y: f32 = 24.;
pub const GRID_W: f32 = CELL_W * 3. + GAP_X * 2.;

impl Shell {
    /// One tile, and whether its hover springs still need frames.
    /// `focus` is the keyboard stop inside this tile, if it has one.
    pub(crate) fn tile(
        &mut self,
        project: &RecentProject,
        busy: bool,
        focus: Option<usize>,
        now: Duration,
        c: &Palette,
        cx: &mut Context<Self>,
    ) -> (AnyElement, bool) {
        let key = project.path.clone();
        // Electron's isActive: pointer over it or keyboard focus inside it.
        let active = !busy && (self.hovered.as_deref() == Some(key.as_str()) || focus.is_some());
        let (lift_t, side_t, moving) = self.tile_motion.entry(key.clone()).or_default().sample(active, now);
        let pinned = project.pinned == Some(true);
        let tile = self.tiles.get(&key);
        let missing = matches!(tile, Some(Tile::Missing));
        let lift = -6. * lift_t;
        let side_t = side_t.clamp(0., 1.);

        let mut meta = div().flex().items_center().gap(px(10.)).h(px(13.)).font_family(crate::folder_picker::MONO).text_size(px(11.5));
        match tile {
            Some(Tile::Missing) => {
                meta = meta.child(div().text_color(hsla(c.muted)).child("Folder not found"));
            }
            Some(Tile::Repo(s)) => {
                let branch = match &s.branch {
                    Branch::Named(n) => Some(n.clone()),
                    Branch::Detached(sha) => Some(sha.clone()),
                    Branch::Unknown => None,
                };
                if let Some(b) = branch {
                    meta = meta.child(
                        div().flex().items_center().gap(px(5.)).min_w(px(0.)).text_color(hsla(c.muted))
                            .child(svg().path("icons/git-branch.svg").size(px(12.)).flex_shrink_0().text_color(hsla(c.muted)))
                            .child(div().min_w(px(0.)).max_w(px(100.)).truncate().child(b)),
                    );
                }
                if s.added > 0 || s.removed > 0 {
                    let mut diff = div().flex().gap(px(5.)).flex_shrink_0();
                    if s.added > 0 {
                        diff = diff.child(div().text_color(hsla(c.diff_add)).child(format!("+{}", s.added)));
                    }
                    if s.removed > 0 {
                        diff = diff.child(div().text_color(hsla(c.diff_del)).child(format!("−{}", s.removed)));
                    }
                    meta = meta.child(diff);
                }
            }
            _ => {}
        }

        let pocket_bg = c.raised;
        let sheet_bg = c.raised_high;
        let folder = div()
            .id(SharedString::from(format!("tile:{key}")))
            .relative()
            .w(px(TILE_W))
            .h(px(TILE_H))
            .top(px(lift))
            .when(missing, |d| d.opacity(0.55))
            .when(!busy, |d| {
                let path = key.clone();
                d.cursor_pointer().on_click(cx.listener(move |this, _, window, cx| {
                    this.open_project(std::path::PathBuf::from(&path), window, cx)
                }))
            })
            // The back sheet peeking above the pocket.
            .child(div().absolute().left(px(16.)).top(px(6.)).w(px(168.)).h(px(44.)).rounded(px(15.)).bg(hsla(sheet_bg)).border_1().border_color(hsla(c.line_soft)))
            .child(
                div()
                    .absolute()
                    .left_0()
                    .bottom_0()
                    .w(px(TILE_W))
                    .h(px(POCKET_H))
                    .rounded(px(22.))
                    .bg(hsla(pocket_bg))
                    .border_1()
                    .border_color(hsla(if active { c.line } else { c.line_soft }))
                    .shadow(vec![BoxShadow {
                        color: black().opacity(0.06 + 0.06 * lift_t.clamp(0., 1.)),
                        offset: point(px(0.), px(4.)),
                        blur_radius: px(10.),
                        spread_radius: px(0.),
                        inset: false,
                    }])
                    .flex()
                    .flex_col()
                    .justify_end()
                    .gap(px(7.))
                    .px(px(18.))
                    .pb(px(15.))
                    .child(
                        div()
                            .flex()
                            .items_end()
                            .gap(px(9.))
                            .min_w(px(0.))
                            .when(tile.is_none() || matches!(tile, Some(Tile::Repo(_))), |d| {
                                d.child(svg().path("icons/gh-mark.svg").size(px(15.)).flex_shrink_0().text_color(hsla(c.ink_soft)))
                            })
                            .child(
                                div()
                                    .id(SharedString::from(format!("name:{key}")))
                                    .tooltip(tip(project.name.clone()))
                                    .min_w(px(0.))
                                    .truncate()
                                    .text_size(px(17.))
                                    .line_height(px(17.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(hsla(c.ink))
                                    .child(project.name.clone()),
                            ),
                    )
                    .child(meta),
            )
            // Electron rings the pocket, not the whole button, on keyboard focus.
            .when(focus == Some(0), |d| {
                d.child(ring(22., 3., c.ink.alpha(0.26)).left(px(-3.)).top(px(TILE_H - POCKET_H - 3.)))
            });

        let side = |id: &str, icon: &'static str, label: &'static str, on: bool, ringed: bool, cx: &mut Context<Self>, act: fn(&mut Shell, String, &mut Window, &mut Context<Shell>)| {
            let path = key.clone();
            div()
                .id(SharedString::from(format!("{id}:{key}")))
                .relative()
                .size(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(7.))
                .cursor_pointer()
                .hover(|s| s.bg(hsla(c.hover)))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                // Like Electron's pointer-events: none, a column on its way out
                // takes no clicks and shows no tips.
                .when(active, |d| {
                    d.on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        act(this, path.clone(), window, cx)
                    }))
                    .tooltip(tip(label))
                })
                .when(ringed, |d| d.child(ring(7., 2., c.ink.alpha(0.34))))
                .child(svg().path(icon).size(px(14.)).text_color(hsla(if on { c.ink } else { c.muted })))
        };
        let actions = div()
            .absolute()
            .top(px(-6. * side_t))
            .bottom(px(6. * side_t))
            // Slides in 4px from the right as it fades up.
            .left(px(TILE_W + 12. + 4. * (1. - side_t)))
            .flex()
            .flex_col()
            .justify_center()
            .gap(px(6.))
            .opacity(side_t)
            .when(side_t < 0.01, |d| d.invisible())
            .child(side("pin", "icons/pin.svg", if pinned { "Unpin" } else { "Pin to top" }, pinned, focus == Some(1), cx, |this, p, _, cx| this.toggle_pin(p, cx)))
            .child(side("reveal", "icons/finder.svg", REVEAL_TIP, false, focus == Some(2), cx, |this, p, _, cx| this.reveal(p, cx)))
            .child(side("forget", "icons/cancel.svg", "Remove", false, focus == Some(3), cx, |this, p, _, cx| this.forget(p, cx)));

        let hover_key = key.clone();
        let el = div()
            .id(SharedString::from(format!("cell:{key}")))
            .relative()
            .w(px(CELL_W))
            .pr(px(ACTIONS_W))
            .on_hover(cx.listener(move |this, over: &bool, _, cx| {
                let next = if *over { Some(hover_key.clone()) } else if this.hovered.as_deref() == Some(hover_key.as_str()) { None } else { return };
                if this.hovered != next {
                    this.hovered = next;
                    cx.notify();
                }
            }))
            .child(folder)
            .child(actions)
            .into_any_element();
        (el, moving)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::prelude::v1::test;

    fn p(name: &str, at: u64, pinned: bool) -> RecentProject {
        RecentProject { path: format!("/x/{name}"), name: name.into(), last_opened_at: at, pinned: pinned.then_some(true) }
    }

    #[test]
    fn name_sort_keeps_pins_first_and_filter_ignores_case() {
        let list = vec![p("zed", 3, true), p("Beta", 2, false), p("alpha", 1, false), p("Ape", 0, true)];
        let names = |v: Vec<RecentProject>| v.into_iter().map(|p| p.name).collect::<Vec<_>>();
        assert_eq!(names(shown(&list, "", Sort::Recent)), ["zed", "Beta", "alpha", "Ape"]);
        assert_eq!(names(shown(&list, "", Sort::Name)), ["Ape", "zed", "alpha", "Beta"]);
        assert_eq!(names(shown(&list, " A", Sort::Recent)), ["Beta", "alpha", "Ape"]);
    }

    #[test]
    fn a_missing_folder_reads_as_missing() {
        let gone = std::env::temp_dir().join(format!("kone-recents-gone-{}", std::process::id()));
        let tiles = read_tiles(&[gone.to_string_lossy().into_owned()]);
        assert!(matches!(tiles.values().next(), Some(Tile::Missing)));
    }

    #[test]
    fn arrows_walk_a_three_column_grid() {
        // 5 tiles + start actions = 6 cells, two full rows.
        assert_eq!(grid_step(0, 6, Dir::Left), 0);
        assert_eq!(grid_step(0, 6, Dir::Right), 1);
        assert_eq!(grid_step(2, 6, Dir::Right), 3);
        assert_eq!(grid_step(5, 6, Dir::Right), 5);
        assert_eq!(grid_step(1, 6, Dir::Down), 4);
        assert_eq!(grid_step(4, 6, Dir::Down), 4);
        assert_eq!(grid_step(4, 6, Dir::Up), 1);
        assert_eq!(grid_step(1, 6, Dir::Up), 1);
        // 4 cells: Down from the top right lands on the short last row's end.
        assert_eq!(grid_step(2, 4, Dir::Down), 3);
        assert_eq!(grid_step(0, 4, Dir::Down), 3);
        // Only the start actions, and an out-of-range cursor clamps.
        assert_eq!(grid_step(0, 1, Dir::Down), 0);
        assert_eq!(grid_step(9, 4, Dir::Left), 2);
        assert_eq!(grid_step(0, 0, Dir::Right), 0);
    }

    #[test]
    fn tab_visits_every_stop_and_wraps() {
        let mut at = (0, 0);
        let mut seen = vec![at];
        for _ in 0..(2 * 4 + 3) {
            at = tab_step(at, 2, true);
            seen.push(at);
        }
        assert_eq!(seen[..5], [(0, 0), (0, 1), (0, 2), (0, 3), (1, 0)]);
        assert_eq!(seen[8..], [(2, 0), (2, 1), (2, 2), (0, 0)]);
        assert_eq!(tab_step((0, 0), 2, false), (2, 2));
        assert_eq!(tab_step((1, 0), 2, false), (0, 3));
        assert_eq!(tab_step((0, 0), 0, true), (0, 1));
        assert_eq!(tab_step((0, 2), 0, true), (0, 0));
    }

    #[test]
    fn hover_springs_settle_at_rest_and_lifted() {
        let mut m = TileMotion::default();
        let (l, s, moving) = m.sample(false, Duration::ZERO);
        assert_eq!((l, s, moving), (0., 0., false));
        let (_, _, moving) = m.sample(true, Duration::from_millis(1));
        assert!(moving);
        let (l, s, moving) = m.sample(true, Duration::from_millis(60));
        assert!(l > 0. && l < 1.0 && s > 0., "{l} {s}");
        assert!(moving);
        let (l, s, moving) = m.sample(true, Duration::from_secs(2));
        assert!((l - 1.).abs() < 1e-3 && (s - 1.).abs() < 1e-3 && !moving);
        m.sample(false, Duration::from_secs(2));
        let (l, _, moving) = m.sample(false, Duration::from_secs(4));
        assert!(l.abs() < 1e-3 && !moving);
    }

    #[test]
    fn reveal_scrolls_only_as_far_as_needed() {
        // Row 0 in view at the top: no change.
        assert_eq!(reveal_scroll(0., 0, 500.), 0.);
        // Row 4 sits at 80 + 560 = 640..756; with margins 628..768.
        assert_eq!(reveal_scroll(0., 4, 500.), 268.);
        // Back up to row 1 (220 - 12 = 208) from further down.
        assert_eq!(reveal_scroll(400., 1, 500.), 208.);
        // Row 0 from below goes to its top (68), never past the start.
        assert_eq!(reveal_scroll(300., 0, 500.), 68.);
    }
}

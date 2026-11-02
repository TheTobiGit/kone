//! The recents home: the launcher once you've opened projects (Electron's
//! `HomeRecent.vue`). A grid of project folders, pinned first then newest,
//! each with its branch and uncommitted ± read off the UI thread, plus the
//! three start actions in the last cell.

use std::{collections::HashMap, path::Path};

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

/// Tile geometry from `ProjectFolder.vue`.
pub const TILE_W: f32 = 200.;
const TILE_H: f32 = 116.;
const POCKET_H: f32 = 92.;
/// Room on the right for the side actions.
const ACTIONS_W: f32 = 36.;
pub const CELL_W: f32 = TILE_W + ACTIONS_W;
pub const GAP_X: f32 = 56.;
pub const GAP_Y: f32 = 24.;
pub const GRID_W: f32 = CELL_W * 3. + GAP_X * 2.;

impl Shell {
    pub(crate) fn tile(&self, project: &RecentProject, busy: bool, c: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let key = project.path.clone();
        let active = !busy && self.hovered.as_deref() == Some(key.as_str());
        let pinned = project.pinned == Some(true);
        let tile = self.tiles.get(&key);
        let missing = matches!(tile, Some(Tile::Missing));
        let lift = if active { -6. } else { 0. };

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
                        color: black().opacity(if active { 0.12 } else { 0.06 }),
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
                            .when(matches!(tile, Some(Tile::Repo(_))), |d| {
                                d.child(svg().path("icons/gh-mark.svg").size(px(15.)).flex_shrink_0().text_color(hsla(c.ink_soft)))
                            })
                            .child(
                                div()
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
            );

        let side = |id: &str, icon: &'static str, _tip: &'static str, on: bool, cx: &mut Context<Self>, act: fn(&mut Shell, String, &mut Window, &mut Context<Shell>)| {
            let path = key.clone();
            div()
                .id(SharedString::from(format!("{id}:{key}")))
                .size(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(7.))
                .cursor_pointer()
                .hover(|s| s.bg(hsla(c.hover)))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    this.hovered = None;
                    act(this, path.clone(), window, cx)
                }))
                .child(svg().path(icon).size(px(14.)).text_color(hsla(if on { c.ink } else { c.muted })))
        };
        let actions = div()
            .absolute()
            .right_0()
            .top(px(lift))
            .bottom(px(-lift))
            .flex()
            .flex_col()
            .justify_center()
            .gap(px(6.))
            .when(!active, |d| d.invisible())
            .child(side("pin", "icons/pin.svg", if pinned { "Unpin" } else { "Pin to top" }, pinned, cx, |this, p, _, cx| this.toggle_pin(p, cx)))
            .child(side("reveal", "icons/finder.svg", "Reveal in file manager", false, cx, |this, p, _, cx| this.reveal(p, cx)))
            .child(side("forget", "icons/cancel.svg", "Remove from recents", false, cx, |this, p, _, cx| this.forget(p, cx)));

        let hover_key = key.clone();
        div()
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
            .into_any_element()
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
}

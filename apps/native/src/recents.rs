//! The recents home: the launcher once you've opened projects (Electron's
//! `HomeRecent.vue`). A grid of project folders, pinned first then newest,
//! each with its branch and uncommitted ± read off the UI thread, plus the
//! three start actions in the last cell.

use std::{collections::HashMap, path::Path, time::Duration};

use gpui_ce_motion::{MotionValue, Spring, Transition};

use gpui_kit::prelude::*;
use gpui_kit::*;
use kone_rpc::{Branch, ChangedFile, FileChange, RepoSummary};

mod git;
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
    /// The flag marks totals from a truncated status read.
    Repo(RepoSummary, bool),
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
                match path.ancestors().find_map(git::summary) {
                    Some((s, partial)) => Tile::Repo(s, partial),
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
        // A view shorter than a row shows the row's top.
        (bottom - view).min(top).max(0.)
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
    papers: [MotionValue; 3],
}

impl Default for TileMotion {
    fn default() -> Self {
        TileMotion { lift: MotionValue::new(0.), side: MotionValue::new(0.), active: false, papers: std::array::from_fn(|_| MotionValue::new(0.)) }
    }
}

impl TileMotion {
    fn papers(&mut self, now: Duration) -> ([f32; 3], bool) {
        let mut moving = false;
        let values = std::array::from_fn(|i| {
            let sample = self.papers[i].sample(now, false);
            moving |= sample.is_animating();
            sample.value() as f32
        });
        (values, moving)
    }

    /// Retargets on a change of state, then reads both springs:
    /// `(lift, side, still_moving)`.
    pub fn sample(&mut self, active: bool, now: Duration) -> (f32, f32, bool) {
        if self.active != active {
            self.active = active;
            let to = if active { 1. } else { 0. };
            self.lift.animate(to, lift_spring(), now);
            self.side.animate(to, side_spring(), now);
            for (i, paper) in self.papers.iter_mut().enumerate() {
                paper.animate_delayed(to, Transition::Spring(Spring::new(340., 15., 0.7).expect("valid spring")),
                    if active { Duration::from_secs_f64(i as f64 * 0.04) } else { Duration::ZERO }, now);
            }
        }
        let lift = self.lift.sample(now, false);
        let side = self.side.sample(now, false);
        // On the way out the column is invisible below 0.01; its undershoot
        // ringing past zero isn't worth frames.
        let side_moving = side.is_animating() && (active || side.value() >= 0.01);
        (lift.value() as f32, side.value() as f32, lift.is_animating() || side_moving)
    }
}

/// A hover tip: the native app's stand-in for Electron's `title` attribute.
pub struct Tip(pub SharedString);

impl Render for Tip {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = kone_theme::Theme::get(cx);
        let c = &theme.colors;
        // Chromium's plain light title box, expressed in the active palette.
        let (background, foreground, border) = if theme.is_dark() {
            (c.ink, c.ground, c.muted)
        } else {
            (c.raised_high, c.ink, c.line)
        };
        div()
            .font_family(".SystemUIFont")
            .px(px(4.))
            .py(px(2.))
            .bg(hsla(background))
            .border_1()
            .border_color(hsla(border))
            .text_size(px(12.))
            .font_weight(FontWeight::NORMAL)
            .text_color(hsla(foreground))
            .whitespace_nowrap()
            .child(self.0.clone())
    }
}

/// GPUI anchors these below-right of the pointer and flips at window edges.
pub fn tip(text: impl Into<SharedString>) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let text = text.into();
    move |_, cx| cx.new(|_| Tip(text.clone())).into()
}

/// Electron's wording; the native app says what Linux calls it.
pub const REVEAL_TIP: &str = if cfg!(target_os = "macos") { "Reveal in Finder" } else { "Reveal in file manager" };

/// A keyboard focus ring hugging an element, `inset` px outside it.
/// Like CSS `outline-offset`, the 2px stroke starts `inset` px out.
pub fn ring(radius: f32, inset: f32, color: kone_theme::Rgba) -> Div {
    let out = inset + 2.;
    div()
        .absolute()
        .top(px(-out))
        .left(px(-out))
        .right(px(-out))
        .bottom(px(-out))
        .rounded(px(radius + out))
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

/// One entry clock belongs to the mounted grid, never to a search/sort result.
/// Keep grid cells fixed while the folder dimensions follow the entry scale.
pub struct EntryMotion {
    value: MotionValue,
}

impl EntryMotion {
    pub fn new(index: usize, now: Duration) -> Self {
        let mut value = MotionValue::new(0.);
        value.animate_delayed(
            1.,
            Transition::Spring(Spring::new(340., 13., 0.85).expect("valid spring")),
            Duration::from_secs_f64(index as f64 * 0.06),
            now,
        );
        Self { value }
    }

    pub fn sample(&mut self, now: Duration) -> (f32, bool) {
        let sample = self.value.sample(now, false);
        (sample.value() as f32, sample.is_animating())
    }
}

pub(crate) fn entry_scale(progress: f32) -> f32 {
    0.97 + 0.03 * progress
}

fn ease_out_expo(t: f64) -> f64 {
    if t >= 1. { 1. } else { 1. - 2_f64.powf(-10. * t.max(0.)) }
}

/// CountUp's default `separator: ','` grouping.
pub fn group(n: u32) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

#[derive(Default)]
pub struct CountMotion {
    from: f64,
    target: u32,
    started: Duration,
}

impl CountMotion {
    fn value(&self, now: Duration) -> (f64, bool) {
        let t = (now.saturating_sub(self.started).as_secs_f64() / 1.1).min(1.);
        let value = self.from + (f64::from(self.target) - self.from) * ease_out_expo(t);
        (value, t < 1. && self.from != f64::from(self.target))
    }

    fn sample(&mut self, target: u32, now: Duration) -> (u32, bool) {
        if self.target != target {
            self.from = self.value(now).0;
            self.target = target;
            self.started = now;
        }
        let (value, moving) = self.value(now);
        (value.round() as u32, moving)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Tone {
    Context,
    Add,
    Delete,
}

fn marks_for(file: &ChangedFile) -> Vec<(f32, Tone)> {
    // JS spreads code points, then charCodeAt(0) reads their first UTF-16 unit.
    let seed: u32 = file
        .name
        .chars()
        .map(|ch| ch.encode_utf16(&mut [0; 2])[0] as u32)
        .sum();
    let jitter = |base: u32, i: u32| (base + (seed + i * 7) % 5 - 2).max(6) as f32;
    use Tone::*;
    let marks = if file.added > 0 && file.removed > 0 {
        [(16, Context), (10, Delete), (13, Add)]
    } else if file.added > 0 || file.change == FileChange::Added {
        [(15, Add), (10, Add), (8, Context)]
    } else if file.removed > 0 {
        [(15, Delete), (9, Delete), (7, Context)]
    } else {
        return vec![(15., Context), (10., Context)];
    };
    marks
        .into_iter()
        .enumerate()
        .map(|(i, (w, tone))| (jitter(w, i as u32), tone))
        .collect()
}

struct PaperColors {
    paper: kone_theme::Rgba,
    context: kone_theme::Rgba,
    add: kone_theme::Rgba,
    delete: kone_theme::Rgba,
    icon: kone_theme::Rgba,
    shadow: kone_theme::Rgba,
}

impl PaperColors {
    fn new(c: &Palette, dark: bool) -> Self {
        Self {
            paper: if dark {
                c.ink.mix(0.057, c.raised_high)
            } else {
                c.raised_high
            },
            context: if dark {
                c.ink.mix(0.446, c.ground)
            } else {
                c.faint.mix(0.5, c.raised_high)
            },
            // New-file marks keep Electron's fixed dark green.
            add: if dark { kone_theme::Rgba::hex(0x12b981) } else { c.diff_add },
            delete: c.diff_del,
            icon: c.file,
            shadow: kone_theme::Rgba::hex(0).alpha(0.07),
        }
    }
}

/// Rounded contours are transformed point-by-point around the paper's top-left.
/// This keeps the body, diff strokes and dashed deletion edge in one coordinate system.
fn rounded_contour(x: f32, y: f32, w: f32, h: f32, radius: f32) -> Vec<(f32, f32)> {
    let mut points = Vec::with_capacity(28);
    for (cx, cy, angle) in [
        (x + w - radius, y + radius, -90.),
        (x + w - radius, y + h - radius, 0.),
        (x + radius, y + h - radius, 90.),
        (x + radius, y + radius, 180.),
    ] {
        for step in 0..=6 {
            let a = (angle + step as f32 * 15.).to_radians();
            points.push((cx + radius * a.cos(), cy + radius * a.sin()));
        }
    }
    points
}

fn paint_papers(
    bounds: Bounds<Pixels>,
    files: &[ChangedFile],
    hover: [f32; 3],
    c: &PaperColors,
    window: &mut Window,
    cx: &mut App,
) {
    // left, bottom, rotation, hover dx/dy/dr: ProjectFolder.vue SLOTS.
    const SLOTS: [(f32, f32, f32, f32, f32, f32); 3] = [
        (44., 54., -10., -14., -4., -6.),
        (78., 60., 1., 0., -5., 0.),
        (112., 54., 11., 14., -4., 6.),
    ];
    let origin = bounds.origin;
    let scale = bounds.size.width.as_f32() / TILE_W;
    for (i, file) in files.iter().take(3).enumerate() {
        let (left, bottom, angle, dx, dy, dr) = SLOTS[i];
        let t = hover[i];
        let angle = (angle + dr * t).to_radians();
        let (sin, cos) = angle.sin_cos();
        let pivot = origin + point(px((left + dx * t) * scale), px((TILE_H - bottom - 62. + dy * t) * scale));
        let transform =
            |(x, y): (f32, f32)| pivot + point(px((x * cos - y * sin) * scale), px((x * sin + y * cos) * scale));
        let torn = file.change == FileChange::Deleted;
        // A small layered penumbra approximates CSS's rotated 0 4px 10px
        // shadow; GPUI's quad shadow cannot rotate with a custom path.
        for spread in (0..5).rev() {
            let spread = spread as f32;
            let contour = rounded_contour(-spread, -spread, 50. + 2.*spread, 62. + 2.*spread, 6. + spread);
            let mut path = PathBuilder::fill();
            let shadow_point = |p| transform(p) + point(px(0.), px(4.));
            path.move_to(shadow_point(contour[0]));
            for &p in &contour[1..] { path.line_to(shadow_point(p)); }
            path.close();
            if let Ok(path) = path.build() {
                window.paint_path(path, hsla(c.shadow.alpha(c.shadow.a * 0.2 * if torn { 0.9 } else { 1. })));
            }
        }
        let contour = rounded_contour(0., 0., 50., 62., 6.);
        let mut path = PathBuilder::fill();
        path.move_to(transform(contour[0]));
        for &p in &contour[1..] {
            path.line_to(transform(p));
        }
        path.close();
        if let Ok(path) = path.build() {
            window.paint_path(
                path,
                hsla(if torn {
                    c.paper.alpha(0.35 * 0.9)
                } else {
                    c.paper
                }),
            );
        }
        if torn {
            let mut path = PathBuilder::stroke(px(1.5));
            let mut distance: f32 = 0.;
            for edge in 0..contour.len() {
                let (x, y) = contour[edge];
                let (nx, ny) = contour[(edge + 1) % contour.len()];
                let length = (nx - x).hypot(ny - y);
                let mut along = 0.;
                while along < length {
                    let phase = distance % 7.;
                    let step = (if phase < 4. { 4. - phase } else { 7. - phase })
                        .min(length - along)
                        .max(0.001);
                    if phase < 4. {
                        path.move_to(transform((
                            x + (nx - x) * along / length,
                            y + (ny - y) * along / length,
                        )));
                        path.line_to(transform((
                            x + (nx - x) * (along + step) / length,
                            y + (ny - y) * (along + step) / length,
                        )));
                    }
                    along += step;
                    distance += step;
                }
            }
            if let Ok(path) = path.build() {
                window.paint_path(path, hsla(c.delete.alpha(0.9)));
            }
        } else {
            for (j, (width, tone)) in marks_for(file).into_iter().enumerate() {
                let contour = rounded_contour(8., 20. + j as f32 * 6., width, 3., 1.5);
                let mut path = PathBuilder::fill();
                path.move_to(transform(contour[0]));
                for &p in &contour[1..] {
                    path.line_to(transform(p));
                }
                path.close();
                let color = match tone {
                    Tone::Context => c.context,
                    Tone::Add => c.add,
                    Tone::Delete => c.delete,
                };
                if let Ok(path) = path.build() {
                    window.paint_path(path, hsla(color));
                }
            }
        }
        // Kit's bundled file asset is available through Assets' fallback.
        let entry_scale = scale;
        let scale = window.scale_factor();
        let rotation = TransformationMatrix {
            rotation_scale: [[cos, -sin], [sin, cos]],
            translation: [
                scale * (pivot.x.as_f32() * (1. - cos) + pivot.y.as_f32() * sin),
                scale * (pivot.y.as_f32() * (1. - cos) - pivot.x.as_f32() * sin),
            ],
        };
        let _ = window.paint_svg(
            Bounds::new(pivot + point(px(8. * entry_scale), px(8. * entry_scale)), size(px(10. * entry_scale), px(10. * entry_scale))),
            "icons/file.svg".into(),
            None,
            rotation,
            hsla(c.icon.alpha(if torn { 0.9 } else { 1. })),
            cx,
        );
    }
}

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
        let motion = self.tile_motion.entry(key.clone()).or_default();
        let (lift_t, side_t, moving) = motion.sample(active, now);
        let (paper_t, paper_moving) = motion.papers(now);
        let (entry, entering) = self.entry_motion.as_mut()
            .and_then(|motions| motions.get_mut(&key)).map(|m| m.sample(now)).unwrap_or((1., false));
        let scale = entry_scale(entry);
        let inset_x = TILE_W * (1. - scale) / 2.;
        let inset_y = TILE_H * (1. - scale) / 2.;
        let mut moving = moving || paper_moving || entering;
        let pinned = project.pinned == Some(true);
        let tile = self.tiles.get(&key);
        let missing = matches!(tile, Some(Tile::Missing));
        let lift = -6. * lift_t;
        // Position rides the spring's overshoot as Electron's x/y do; only
        // the opacity is held to 0..1.
        let fade = side_t.clamp(0., 1.);

        let mut meta = div().flex().items_center().gap(px(10.)).h(px(13.)).font_family(crate::folder_picker::MONO).text_size(px(11.5));
        match tile {
            Some(Tile::Missing) => {
                meta = meta.child(div().text_color(hsla(c.muted)).child("Folder not found"));
            }
            Some(Tile::Repo(s, partial)) => {
                // As Electron's CountUp: nothing counts until the tile is first
                // in view, so an offscreen row still counts up when scrolled to.
                let (added, removed) = if self.count_hold && !self.tile_counts.contains_key(&key) {
                    (0, 0)
                } else {
                    let counts = self.tile_counts.entry(key.clone()).or_default();
                    let (added, adding) = counts[0].sample(s.added, now);
                    let (removed, removing) = counts[1].sample(s.removed, now);
                    moving |= adding || removing;
                    (added, removed)
                };
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
                if s.added > 0 || s.removed > 0 || added > 0 || removed > 0 || *partial {
                    let mut diff = div().flex().gap(px(5.)).flex_shrink_0();
                    if s.added > 0 || added > 0 || *partial {
                        diff = diff.child(div().flex().text_color(hsla(if kone_theme::Theme::get(cx).is_dark() { kone_theme::Rgba::hex(0x10b981) } else { c.diff_add }))
                            .child(format!("+{}", group(added)))
                            .when(*partial, |d| d.child(div().id(SharedString::from(format!("partial:{key}")))
                                .text_color(hsla(c.muted)).child("+").tooltip(tip("Partial: very large change set")))));
                    }
                    if s.removed > 0 || removed > 0 {
                        diff = diff.child(div().text_color(hsla(c.diff_del)).child(format!("−{}", group(removed))));
                    }
                    meta = meta.child(diff);
                }
            }
            _ => {}
        }

        let papers = match tile { Some(Tile::Repo(s, _)) => s.files.iter().take(3).cloned().collect(), _ => Vec::new() };
        let paper_colors = PaperColors::new(c, kone_theme::Theme::get(cx).is_dark());
        let pocket_bg = c.raised;
        let sheet_bg = c.raised_high;
        let folder = div()
            .id(SharedString::from(format!("tile:{key}")))
            .relative()
            .w(px(TILE_W * scale))
            .h(px(TILE_H * scale))
            .left(px(inset_x))
            .top(px(lift + inset_y))
            .when(missing, |d| d.opacity(0.55))
            .when(!busy, |d| {
                let path = key.clone();
                d.cursor_pointer().on_click(cx.listener(move |this, _, window, cx| {
                    this.open_project(std::path::PathBuf::from(&path), window, cx)
                }))
            })
            // The back sheet peeking above the pocket.
            .child(div().absolute().left(px(16. * scale)).top(px(6. * scale)).w(px(168. * scale)).h(px(44. * scale)).rounded(px(15.)).bg(hsla(sheet_bg)).border_1().border_color(hsla(c.line_soft)))
            .child(canvas(move |_, _, _| (), move |bounds, _, window, cx| {
                paint_papers(bounds, &papers, paper_t, &paper_colors, window, cx);
            }).absolute().size_full())
            .child(
                div()
                    .absolute()
                    .left_0()
                    .bottom_0()
                    .w(px(TILE_W * scale))
                    .h(px(POCKET_H * scale))
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
                    .gap(px(7. * scale))
                    .px(px(18. * scale))
                    .pb(px(15. * scale))
                    .child(
                        div()
                            .flex()
                            .items_end()
                            .gap(px(9. * scale))
                            .min_w(px(0.))
                            .when(tile.is_none() || matches!(tile, Some(Tile::Repo(_, _))), |d| {
                                d.child(svg().path("icons/gh-mark.svg").size(px(15. * scale)).flex_shrink_0().text_color(hsla(c.ink_soft)))
                            })
                            .child(
                                div()
                                    .id(SharedString::from(format!("name:{key}")))
                                    .when(!busy, |d| d.tooltip(tip(project.name.clone())).tooltip_show_delay(Duration::from_millis(500)))
                                    .min_w(px(0.))
                                    .truncate()
                                    .text_size(px(17. * scale))
                                    .line_height(px(17. * scale))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(hsla(c.ink))
                                    .child(project.name.clone()),
                            ),
                    )
                    .child(meta),
            )
            // Electron rings the pocket, not the whole button, on keyboard focus.
            .when(focus == Some(0), |d| {
                d.child(ring(22., 3., c.ink.alpha(0.26)).left(px(-5.)).top(px(TILE_H - POCKET_H - 5.)))
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
                // Like Electron's pointer-events: none, a column on its way out
                // takes no pointer at all: no hand, no wash, no clicks, no tips.
                .when(active, |d| {
                    d.cursor_pointer()
                        .hover(|s| s.bg(hsla(c.hover)))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            // As Electron's onSideAction: drop hover and focus so the
                            // tile doesn't stay lifted after a reorder, a file
                            // manager window, or its own removal.
                            this.hovered = None;
                            this.clear_kb();
                            act(this, path.clone(), window, cx)
                        }))
                        .tooltip(tip(label)).tooltip_show_delay(Duration::from_millis(500))
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
            .opacity(fade)
            .when(fade < 0.01, |d| d.invisible())
            .child(side("pin", "icons/pin.svg", if pinned { "Unpin" } else { "Pin to top" }, pinned, focus == Some(1), cx, |this, p, _, cx| this.toggle_pin(p, cx)))
            .child(side("reveal", "icons/finder.svg", REVEAL_TIP, false, focus == Some(2), cx, |this, p, _, cx| this.reveal(p, cx)))
            .child(side("forget", "icons/cancel.svg", "Remove", false, focus == Some(3), cx, |this, p, _, cx| this.forget(p, cx)));

        let hover_key = key.clone();
        let el = div()
            .id(SharedString::from(format!("cell:{key}")))
            .relative()
            .w(px(CELL_W))
            .h(px(TILE_H))
            .top(px(12. * (1. - entry)))
            .opacity(entry.clamp(0., 1.))
            .pr(px(ACTIONS_W))
            .when(!busy, |d| d.on_hover(cx.listener(move |this, over: &bool, _, cx| {
                let next = if *over { Some(hover_key.clone()) } else if this.hovered.as_deref() == Some(hover_key.as_str()) { None } else { return };
                if this.hovered != next {
                    this.hovered = next;
                    cx.notify();
                }
            })))
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
    fn entry_scale_matches_electron_endpoints() {
        assert_eq!(entry_scale(0.), 0.97);
        assert_eq!(entry_scale(1.), 1.);
        assert!((entry_scale(0.5) - 0.985).abs() < 1e-6);
    }

    #[test]
    fn count_easing_matches_expo_and_finishes_exactly() {
        assert_eq!(ease_out_expo(0.), 0.);
        assert_eq!(ease_out_expo(0.5), 0.96875);
        assert_eq!(ease_out_expo(1.), 1.);
        let mut count = CountMotion::default();
        assert_eq!(count.sample(100, Duration::ZERO), (0, true));
        assert_eq!(count.sample(100, Duration::from_millis(550)), (97, true));
        assert_eq!(count.sample(100, Duration::from_millis(1100)), (100, false));
        assert_eq!(count.sample(100, Duration::from_secs(4)), (100, false));
    }

    #[test]
    fn count_retargets_from_current_fractional_value_and_can_decrease() {
        let mut count = CountMotion::default();
        count.sample(100, Duration::ZERO);
        let now = Duration::from_millis(550);
        let current = count.value(now).0;
        assert_eq!(count.sample(200, now), (97, true));
        assert_eq!(count.value(now).0, current);
        assert_eq!(count.sample(200, Duration::from_millis(1650)), (200, false));
        assert_eq!(count.sample(0, Duration::from_secs(2)), (200, true));
        assert_eq!(count.sample(0, Duration::from_millis(2550)), (6, true));
        assert_eq!(count.sample(0, Duration::from_millis(3100)), (0, false));
        assert_eq!(count.sample(0, Duration::from_secs(5)), (0, false));
        assert_eq!(CountMotion::default().sample(0, Duration::ZERO), (0, false));
    }

    #[test]
    fn papers_stagger_only_on_hover_in_and_settle() {
        let mut motion = TileMotion::default();
        motion.sample(true, Duration::ZERO);
        let (papers, moving) = motion.papers(Duration::from_millis(30));
        assert!(moving && papers[0] > 0.);
        assert_eq!(&papers[1..], &[0., 0.]);
        let (papers, moving) = motion.papers(Duration::from_secs(2));
        assert!(!moving && papers.iter().all(|t| (t-1.).abs() < 1e-3));
        motion.sample(false, Duration::from_secs(2));
        let (papers, moving) = motion.papers(Duration::from_millis(2020));
        assert!(moving && papers.iter().all(|t| *t < 1.));
        let (papers, moving) = motion.papers(Duration::from_secs(4));
        assert!(!moving && papers.iter().all(|t| t.abs() < 1e-3));
    }

    #[test]
    fn entry_staggers_then_stops_requesting_frames() {
        let mut entry = EntryMotion::new(2, Duration::ZERO);
        assert_eq!(entry.sample(Duration::from_millis(100)), (0., true));
        let (t, moving) = entry.sample(Duration::from_millis(150));
        assert!(t > 0. && moving);
        let (t, moving) = entry.sample(Duration::from_secs(3));
        assert!((t-1.).abs() < 1e-3 && !moving);
    }

    #[test]
    fn paper_marks_match_electrons_path_jitter_and_tones() {
        let mut file = ChangedFile { name: "a".into(), change: FileChange::Modified, added: 2, removed: 1 };
        assert_eq!(marks_for(&file), vec![(16., Tone::Context), (12., Tone::Delete), (12., Tone::Add)]);
        file.removed = 0;
        assert_eq!(marks_for(&file), vec![(15., Tone::Add), (12., Tone::Add), (7., Tone::Context)]);
        file.added = 0;
        assert_eq!(marks_for(&file), vec![(15., Tone::Context), (10., Tone::Context)]);
        file.change = FileChange::Added;
        assert_eq!(marks_for(&file)[0].1, Tone::Add);
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

    #[test]
    fn counts_group_thousands_like_countup() {
        assert_eq!(group(0), "0");
        assert_eq!(group(999), "999");
        assert_eq!(group(1000), "1,000");
        assert_eq!(group(1234567), "1,234,567");
    }
}

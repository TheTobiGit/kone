//! The in-app folder browser: a bottom-right card over a scrim, with an
//! editable path, a breadcrumb trail, the focused folder's subdirectories, and
//! a confirm action welded to the lower edge.
//!
//! The listing is read straight from the filesystem. A repository root is
//! recognised by its `.git` marker and its branch comes from that git dir's
//! `HEAD`, so rows can show their branch without shelling out to git.

use std::{
    cell::Cell,
    collections::HashMap,
    env, fs,
    rc::Rc,
    io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use gpui_ce_motion::{Bezier, Easing, MotionValue, Spring, Transition};
use gpui_kit::base::input::{Input, InputEditorStyle, InputEvent, InputState};
use gpui_kit::prelude::*;
use gpui_kit::*;
use kone_theme::{hsla, Palette, Theme};

use crate::magnet::Magnet;
use crate::shell::SANS;

const MONO: &str = "Menlo";

/// The card's fixed frame pieces. The browser's body carries the rest.
const HEADER_H: f32 = 37.;
const FOOTER_H: f32 = 37.;
/// The concave corner radius where a band meets a side wall.
const BAND_ARC: f32 = 14.;
/// The browser's breathing room between the bands and the list.
const BAND_GAP: f32 = 16.;

const ENTER: Duration = Duration::from_millis(420);
const EXIT: Duration = Duration::from_millis(240);
/// How far below its resting place the card starts, then rises from.
const CARD_RISE: f32 = 12.;

/// Indent per level, clamped so a deep trail stays on screen.
const STEP: f32 = 26.;
const MAX_STEPS: usize = 4;

/// A second click inside this window opens the folder instead of descending.
const DOUBLE_CLICK: Duration = Duration::from_millis(260);

const CARD_WIDTH: f32 = 448.;

/// How far an incoming row rises as it fades in.
const ROW_RISE: f32 = 24.;
/// Git metadata settles a beat after its row, drifting in from the glyph.
const META_DELAY: Duration = Duration::from_millis(80);
const META_SHIFT: f32 = -6.;
/// The list's height follows its content on this curve.
const HEIGHT_EASE: Duration = Duration::from_millis(420);
/// Autocomplete child names stay usable this long: long enough to skip
/// re-listing while one completion is typed out, short enough that a folder
/// created mid-session still turns up.
const CHILD_CACHE_TTL: Duration = Duration::from_secs(10);

fn row_spring() -> Transition {
    Transition::Spring(Spring::new(320., 20., 0.8).expect("valid spring"))
}

fn meta_spring() -> Transition {
    Transition::Spring(Spring::new(240., 26., 0.8).expect("valid spring"))
}

fn height_tween() -> Transition {
    Transition::Tween(HEIGHT_EASE, Easing::Bezier(Bezier::new(0.22, 1., 0.36, 1.).expect("valid curve")))
}

/// CSS `ease` over 180ms: the picker's hover wash, glyphs, and actions.
fn hover_tween() -> Transition {
    Transition::Tween(
        Duration::from_millis(180),
        Easing::Bezier(Bezier::new(0.25, 0.1, 0.25, 1.).expect("valid curve")),
    )
}

/// Eases a hover amount toward its target. A change restarts from wherever it
/// is, the way a CSS transition does. Returns the amount and whether it is
/// still moving.
fn sample_hover(
    value: &mut MotionValue,
    hovering: &mut bool,
    active: bool,
    now: Duration,
) -> (f32, bool) {
    if *hovering != active {
        *hovering = active;
        value.animate(if active { 1. } else { 0. }, hover_tween(), now);
    }
    let sample = value.sample(now, false);
    (sample.value() as f32, sample.is_animating())
}

/// One row's entrance: how far in it is, its git metadata after it, and how
/// strongly the pointer is over it.
struct RowMotion {
    enter: MotionValue,
    meta: MotionValue,
    hover: MotionValue,
    hovering: bool,
}

/// One message the picker sends back to whatever opened it.
#[derive(Debug)]
pub enum FolderPickerEvent {
    Cancel,
    Picked(PathBuf),
}

impl EventEmitter<FolderPickerEvent> for FolderPicker {}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    In,
    Out,
}

#[derive(Clone)]
struct Crumb {
    name: String,
    path: PathBuf,
    repo: bool,
    branch: Option<String>,
}

#[derive(Clone)]
struct Entry {
    name: String,
    path: PathBuf,
    repo: bool,
    branch: Option<String>,
}

struct Listing {
    repo: bool,
    branch: Option<String>,
    entries: Vec<Entry>,
}

/// What a background listing was asked for, and therefore what to do with it.
enum Load {
    /// The first read: the trail is already sitting on home, but a failure
    /// leaves nothing to browse, so it surfaces the modal's fatal message.
    Start,
    /// A level the trail already names (descend / climb). An unreadable folder
    /// is still adopted, so the rows can say why it is empty.
    Level(Vec<Crumb>),
    /// A typed or ascended path. Only move if it can be read; otherwise the
    /// view and the address bar stay where they were.
    Jump(PathBuf),
}

impl Load {
    fn path(&self, home: &Path) -> PathBuf {
        match self {
            Load::Start => home.to_path_buf(),
            Load::Level(trail) => trail.last().map(|crumb| crumb.path.clone()).unwrap_or_default(),
            Load::Jump(path) => path.clone(),
        }
    }
}

enum PickerRow {
    Ascend { name: String },
    Crumb {
        name: String,
        path: PathBuf,
        index: usize,
        current: bool,
        repo: bool,
        branch: Option<String>,
    },
    Entry {
        name: String,
        path: PathBuf,
        repo: bool,
        branch: Option<String>,
    },
}

struct RowVisual {
    idx: usize,
    indent: f32,
    name: String,
    icon: &'static str,
    rest_opacity: f32,
    active_opacity: f32,
    text: Hsla,
    repo: bool,
    branch: Option<String>,
    /// Entrance progress, 0 to 1 (a spring may overshoot a little).
    enter: f32,
    meta: f32,
}

pub struct FolderPicker {
    focus: FocusHandle,
    path_input: Entity<InputState>,
    home: PathBuf,
    trail: Vec<Crumb>,
    entries: Vec<Entry>,
    /// Set when the home directory itself could not be read.
    error: Option<&'static str>,
    /// Set when a navigation landed on a folder that could not be read.
    read_error: bool,
    hovered: Option<usize>,
    focus_idx: Option<usize>,
    loading: bool,
    /// Bumped on every listing request so a slow read can't overwrite a newer one.
    nav_seq: u64,
    open_hovered: bool,
    open_hover: MotionValue,
    open_hovering: bool,
    cancel_hovered: bool,
    cancel_hover: MotionValue,
    cancel_hovering: bool,
    scroll: ScrollHandle,
    recent_descend: Option<(PathBuf, Instant)>,
    /// The address bar's last text, so an edit can be told from a deletion.
    last_input: String,
    /// A delete key started the edit in flight; never complete over it.
    deleting: bool,
    /// Child folder names per parent, for the address bar's completion.
    child_cache: HashMap<PathBuf, (Vec<String>, Instant)>,
    /// Set when the address bar submits, so the same Enter is not read a
    /// second time by the bubble handler after focus moves to the card.
    enter_at: Option<Instant>,
    phase: Phase,
    started: Instant,
    exit_at: Option<Instant>,
    closing: bool,
    outcome: Option<FolderPickerEvent>,
    /// Keyed by row so a row that survives a navigation keeps its place
    /// instead of entering again; only new rows rise in.
    row_motion: HashMap<String, RowMotion>,
    /// Keyed the same way: a row's lean toward the cursor.
    magnets: HashMap<String, Magnet>,
    /// The list's drawn height and the content height it is chasing.
    list_height: MotionValue,
    list_measured: Rc<Cell<Option<f32>>>,
    list_target: Option<f32>,
    _input_sub: Subscription,
}

impl FolderPicker {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let colors = Theme::get(cx).colors.clone();
        let home = home_dir();
        let path_input = cx.new(|cx| InputState::new(window, cx).default_value(""));
        path_input.update(cx, |state, _| {
            state.set_editor_style(input_style(&colors, false));
        });

        let input_sub = cx.subscribe_in(
            &path_input,
            window,
            |this, _, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { .. } => this.submit_path(window, cx),
                InputEvent::Focus => this.set_input_ink(true, cx),
                InputEvent::Blur => this.set_input_ink(false, cx),
                InputEvent::Change => this.on_input_change(window, cx),
            },
        );

        let focus = cx.focus_handle();
        // Typing should land in the path once the card has mounted, not nowhere.
        let first_input = path_input.clone();
        window.defer(cx, move |window, cx| {
            first_input.read(cx).focus_handle(cx).focus(window, cx);
        });

        Self {
            focus,
            path_input,
            home,
            trail: Vec::new(),
            entries: Vec::new(),
            error: None,
            read_error: false,
            hovered: None,
            focus_idx: None,
            loading: false,
            nav_seq: 0,
            open_hovered: false,
            open_hover: MotionValue::new(0.),
            open_hovering: false,
            cancel_hovered: false,
            cancel_hover: MotionValue::new(0.),
            cancel_hovering: false,
            scroll: ScrollHandle::new(),
            recent_descend: None,
            last_input: String::new(),
            deleting: false,
            child_cache: HashMap::new(),
            enter_at: None,
            phase: Phase::In,
            started: Instant::now(),
            exit_at: None,
            closing: false,
            outcome: None,
            row_motion: HashMap::new(),
            magnets: HashMap::new(),
            list_height: MotionValue::new(0.),
            list_measured: Rc::new(Cell::new(None)),
            list_target: None,
            _input_sub: input_sub,
        }
    }

    fn clock(&self) -> Duration {
        self.started.elapsed()
    }

    /// Points the picker at home and kicks off its first listing. The read runs
    /// off the UI thread, so the card paints with its loading state instead of
    /// blocking the open action on a cold directory.
    pub fn start(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let home = self.home.clone();
        self.trail = vec![Crumb {
            name: dir_name(&home),
            path: home,
            repo: false,
            branch: None,
        }];
        self.sync_path(window, cx);
        self.request(Load::Start, window, cx);
    }

    /// Walks a directory on the background executor. Every call takes a new
    /// sequence number, so if the path changes again before this read lands,
    /// the older answer is simply dropped.
    fn request(&mut self, load: Load, window: &mut Window, cx: &mut Context<Self>) {
        let path = load.path(&self.home);
        self.nav_seq = self.nav_seq.wrapping_add(1);
        let seq = self.nav_seq;
        self.loading = true;
        cx.notify();
        let task = cx.background_spawn(async move { list_dir(&path) });
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            this.update_in(cx, |this, window, cx| this.finish(seq, load, result, window, cx)).ok();
        })
        .detach();
    }

    fn finish(
        &mut self,
        seq: u64,
        load: Load,
        result: io::Result<Listing>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if seq != self.nav_seq {
            return;
        }
        self.loading = false;
        match load {
            Load::Jump(path) => match result {
                Ok(listing) => {
                    self.set_path_with_listing(&path, listing, window, cx);
                    self.focus.focus(window, cx);
                }
                Err(_) => self.reject_path(window, cx),
            },
            Load::Start => match result {
                Ok(listing) => {
                    let trail = std::mem::take(&mut self.trail);
                    self.apply_listing(trail, listing, window, cx);
                }
                Err(_) => {
                    self.trail.clear();
                    self.entries.clear();
                    self.read_error = false;
                    self.error = Some("Couldn't read this folder.");
                    self.sync_path(window, cx);
                    cx.notify();
                }
            },
            Load::Level(trail) => match result {
                Ok(listing) => self.apply_listing(trail, listing, window, cx),
                Err(_) => {
                    self.trail = trail;
                    self.entries.clear();
                    self.read_error = true;
                    self.after_nav(window, cx);
                }
            },
        }
    }

    fn apply_listing(
        &mut self,
        mut trail: Vec<Crumb>,
        listing: Listing,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(last) = trail.last_mut() {
            last.repo = listing.repo;
            last.branch = listing.branch;
        }
        self.trail = trail;
        self.entries = listing.entries;
        self.read_error = false;
        self.error = None;
        self.after_nav(window, cx);
    }

    /// Starts entrances for rows that were not on screen and forgets the ones
    /// that left. Returns whether anything is still moving.
    fn sync_row_motion(&mut self, keys: &[String]) {
        let now = self.clock();
        self.row_motion.retain(|k, _| keys.contains(k));
        for key in keys {
            self.row_motion.entry(key.clone()).or_insert_with(|| {
                let mut enter = MotionValue::new(0.);
                enter.animate(1., row_spring(), now);
                let mut meta = MotionValue::new(0.);
                meta.animate_delayed(1., meta_spring(), META_DELAY, now);
                RowMotion { enter, meta, hover: MotionValue::new(0.), hovering: false }
            });
        }
    }

    /// Magnets ride the rows that can be pulled: crumbs and entries. The
    /// go-up row is a plain button, so it never leans.
    fn sync_magnets(&mut self, keys: &[String]) {
        self.magnets.retain(|k, _| keys.contains(k));
        for key in keys {
            self.magnets.entry(key.clone()).or_default();
        }
    }

    fn set_input_ink(&mut self, focused: bool, cx: &mut Context<Self>) {
        let colors = Theme::get(cx).colors.clone();
        self.path_input.update(cx, |state, cx| {
            state.set_editor_style(input_style(&colors, focused));
            cx.notify();
        });
    }

    fn set_input_error(&mut self, cx: &mut Context<Self>) {
        let colors = Theme::get(cx).colors.clone();
        self.path_input.update(cx, |state, cx| {
            state.set_editor_style(InputEditorStyle {
                foreground: hsla(colors.diff_del_soft),
                caret: hsla(colors.diff_del_soft),
                ..input_style(&colors, true)
            });
            cx.notify();
        });
    }

    fn collapse(&self, path: &Path) -> String {
        collapse(&self.home, path)
    }

    /// Completes the trailing segment of the address bar against the parent's
    /// children, the way a shell completes a path. Only runs on the way in:
    /// a deletion leaves the field exactly as the user left it.
    fn on_input_change(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let value = self.path_input.read(cx).value().to_string();
        let previous = std::mem::replace(&mut self.last_input, value.clone());
        if self.deleting {
            self.deleting = false;
            return;
        }
        if value == previous || self.path_input.read(cx).cursor() != value.len() {
            return;
        }
        let Some(frag) = value
            .rsplit('/')
            .next()
            .filter(|frag| !frag.is_empty())
            .map(str::to_string)
        else {
            return;
        };
        let expanded = expand(&self.home, &value);
        let Some(parent) = expanded
            .parent()
            .filter(|parent| parent.is_absolute())
            .map(Path::to_path_buf)
        else {
            return;
        };
        if let Some((names, at)) = self.child_cache.get(&parent) {
            if at.elapsed() < CHILD_CACHE_TTL {
                let names = names.clone();
                self.apply_completion(value, frag, names, window, cx);
                return;
            }
        }
        // Reading a parent can be slow on a network mount; keep it off the
        // frame and complete only if the field is still where it was.
        let task = cx.background_spawn(async move {
            let names = child_dir_names(&parent);
            (parent, names)
        });
        cx.spawn_in(window, async move |this, cx| {
            let (parent, names) = task.await;
            let Some(names) = names else { return };
            this.update_in(cx, |this, window, cx| {
                this.child_cache.insert(parent, (names.clone(), Instant::now()));
                this.apply_completion(value, frag, names, window, cx);
            })
            .ok();
        })
        .detach();
    }

    /// Appends the first child of the parent whose name starts with `frag` and
    /// selects the appended part, so the next keystroke replaces it.
    fn apply_completion(
        &mut self,
        base: String,
        frag: String,
        names: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.path_input.read(cx).value().to_string() != base
            || self.path_input.read(cx).cursor() != base.len()
        {
            return;
        }
        let lower = frag.to_lowercase();
        let typed_chars = frag.chars().count();
        let Some(name) = names.into_iter().find(|name| {
            name.chars().count() > typed_chars && name.to_lowercase().starts_with(&lower)
        }) else {
            return;
        };
        let suffix: String = name.chars().skip(typed_chars).collect();
        let completed = format!("{base}{suffix}");
        let typed = base.len();
        self.set_input_text(completed.clone(), window, cx);
        self.path_input.update(cx, |state, cx| {
            state.set_selected_range(typed..completed.len(), cx);
        });
    }

    /// Collapses a selected completion at the caret, accepting it. Returns
    /// whether there was one to accept.
    fn accept_completion(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if !self.path_input.read(cx).focus_handle(cx).is_focused(window) {
            return false;
        }
        let range = self.path_input.read(cx).selected_range();
        if range.is_empty() {
            return false;
        }
        let end = range.end;
        self.path_input.update(cx, |state, cx| state.set_selected_range(end..end, cx));
        true
    }

    fn current(&self) -> Option<&Crumb> {
        self.trail.last()
    }

    fn set_input_text(&mut self, value: String, window: &mut Window, cx: &mut Context<Self>) {
        self.last_input = value.clone();
        self.path_input.update(cx, |state, cx| {
            state.set_value(value, window, cx);
        });
    }

    fn sync_path(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let display = self.current().map(|c| self.collapse(&c.path)).unwrap_or_default();
        let focused = self.path_input.read(cx).focus_handle(cx).is_focused(window);
        self.set_input_text(display, window, cx);
        self.set_input_ink(focused, cx);
    }

    fn after_nav(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.hovered = None;
        self.focus_idx = None;
        self.error = None;
        // Rows that survive a navigation sit under a new layout, so whatever
        // lean they had is stale; let each glide home instead of popping.
        for magnet in self.magnets.values_mut() {
            magnet.release();
        }
        self.sync_path(window, cx);
        self.scroll.scroll_to_item(0);
        cx.notify();
    }

    fn load_trail(&mut self, trail: Vec<Crumb>, window: &mut Window, cx: &mut Context<Self>) {
        self.request(Load::Level(trail), window, cx);
    }

    fn descend(
        &mut self,
        path: PathBuf,
        name: String,
        repo: bool,
        branch: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut trail = self.trail.clone();
        trail.push(Crumb { name, path, repo, branch });
        self.load_trail(trail, window, cx);
    }

    fn climb_to(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if index == 0 || index >= self.trail.len() {
            return;
        }
        let trail = self.trail[..index].to_vec();
        self.load_trail(trail, window, cx);
    }

    fn ascend(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.focus.focus(window, cx);
        self.focus_idx = None;
        let Some(anchor) = self.trail.first() else { return };
        let Some(parent) = anchor.path.parent() else { return };
        let parent = parent.to_path_buf();
        if parent == anchor.path {
            return;
        }
        self.go_to_path(&parent, window, cx);
    }

    fn submit_path(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.enter_at = Some(Instant::now());
        let raw = self.path_input.read(cx).value().to_string();
        let expanded = expand(&self.home, &raw);
        if raw.trim().is_empty() || !expanded.is_absolute() {
            self.reject_path(window, cx);
            return;
        }
        if self.current().is_some_and(|crumb| crumb.path == expanded) {
            return;
        }
        self.go_to_path(&expanded, window, cx);
    }

    fn reject_path(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let display = self.current().map(|c| self.collapse(&c.path)).unwrap_or_default();
        self.set_input_text(display, window, cx);
        self.set_input_error(cx);
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(600)).await;
            this.update_in(cx, |this, window, cx| {
                let focused = this.path_input.read(cx).focus_handle(cx).is_focused(window);
                this.set_input_ink(focused, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn go_to_path(&mut self, path: &Path, window: &mut Window, cx: &mut Context<Self>) {
        let path = path.to_path_buf();
        if self.current().is_some_and(|crumb| crumb.path == path) {
            return;
        }
        self.request(Load::Jump(path), window, cx);
    }

    fn set_path_with_listing(
        &mut self,
        path: &Path,
        listing: Listing,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let base = if path == self.home || path.starts_with(&self.home) {
            self.home.clone()
        } else {
            PathBuf::from("/")
        };
        let base_name = if base == Path::new("/") {
            "/".into()
        } else {
            base.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| base.display().to_string())
        };
        let mut trail = vec![Crumb {
            name: base_name,
            path: base.clone(),
            repo: false,
            branch: None,
        }];
        if path != base {
            let mut acc = base.clone();
            if let Ok(rel) = path.strip_prefix(&base) {
                for segment in rel.iter() {
                    acc.push(segment);
                    trail.push(Crumb {
                        name: segment.to_string_lossy().into_owned(),
                        path: acc.clone(),
                        repo: false,
                        branch: None,
                    });
                }
            }
        }
        if let Some(last) = trail.last_mut() {
            last.repo = listing.repo;
            last.branch = listing.branch;
        }
        self.entries = listing.entries;
        self.read_error = false;
        self.trail = trail;
        self.after_nav(window, cx);
    }

    fn parent_name(&self) -> Option<String> {
        let anchor = self.trail.first()?;
        let parent = anchor.path.parent()?;
        if parent == anchor.path {
            return None;
        }
        Some(if parent == Path::new("/") {
            "/".into()
        } else {
            parent
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| parent.display().to_string())
        })
    }

    fn rows(&self) -> Vec<PickerRow> {
        let mut rows = Vec::new();
        if let Some(name) = self.parent_name() {
            rows.push(PickerRow::Ascend { name });
        }
        for (index, crumb) in self.trail.iter().enumerate().skip(1) {
            rows.push(PickerRow::Crumb {
                name: crumb.name.clone(),
                path: crumb.path.clone(),
                index,
                current: index + 1 == self.trail.len(),
                repo: crumb.repo,
                branch: crumb.branch.clone(),
            });
        }
        for entry in &self.entries {
            rows.push(PickerRow::Entry {
                name: entry.name.clone(),
                path: entry.path.clone(),
                repo: entry.repo,
                branch: entry.branch.clone(),
            });
        }
        rows
    }

    fn click_entry(
        &mut self,
        entry: Entry,
        event: &ClickEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.focus.focus(window, cx);
        self.focus_idx = None;
        let now = Instant::now();
        let double = click_count(event) >= 2
            && self.recent_descend.as_ref().is_some_and(|(recent, at)| {
                recent == &entry.path && now.duration_since(*at) < DOUBLE_CLICK
            });
        if double {
            self.recent_descend = None;
            self.close_to(FolderPickerEvent::Picked(entry.path), window, cx);
            return;
        }
        self.recent_descend = Some((entry.path.clone(), now));
        self.descend(entry.path, entry.name, entry.repo, entry.branch, window, cx);
    }

    fn click_crumb(
        &mut self,
        index: usize,
        path: PathBuf,
        current: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.focus.focus(window, cx);
        self.focus_idx = None;
        let now = Instant::now();
        let double = current
            && self
                .recent_descend
                .as_ref()
                .is_some_and(|(recent, at)| recent == &path && now.duration_since(*at) < DOUBLE_CLICK);
        if double {
            self.recent_descend = None;
            self.close_to(FolderPickerEvent::Picked(path), window, cx);
            return;
        }
        self.climb_to(index, window, cx);
    }

    fn activate(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let row = self.rows().into_iter().nth(index);
        match row {
            Some(PickerRow::Ascend { .. }) => self.ascend(window, cx),
            Some(PickerRow::Crumb { index, .. }) => self.climb_to(index, window, cx),
            Some(PickerRow::Entry { path, name, repo, branch }) => {
                self.descend(path, name, repo, branch, window, cx)
            }
            None => {}
        }
    }

    /// Tabs the keyboard between the address bar and the visible rows. The
    /// confirm and cancel actions stay reachable with Enter and Escape.
    fn tab_focus(&mut self, shift: bool, window: &mut Window, cx: &mut Context<Self>) {
        let count = self.rows().len();
        if count == 0 {
            self.path_input.read(cx).focus_handle(cx).focus(window, cx);
            return;
        }
        let input_focused = self.path_input.read(cx).focus_handle(cx).is_focused(window);
        let next = if shift {
            match self.focus_idx {
                Some(0) => None,
                Some(index) => Some(index - 1),
                None if input_focused => Some(count - 1),
                None => None,
            }
        } else {
            match self.focus_idx {
                None => Some(0),
                Some(index) if index + 1 < count => Some(index + 1),
                Some(_) => None,
            }
        };
        self.focus_idx = next;
        match next {
            Some(index) => {
                self.focus.focus(window, cx);
                self.scroll.scroll_to_item(index);
            }
            None => {
                self.path_input.read(cx).focus_handle(cx).focus(window, cx);
            }
        }
        cx.notify();
    }

    fn move_focus(&mut self, down: bool, window: &mut Window, cx: &mut Context<Self>) {
        let count = self.rows().len();
        if count == 0 {
            return;
        }
        let next = if down {
            Some(self.focus_idx.map_or(0, |index| (index + 1).min(count - 1)))
        } else {
            match self.focus_idx {
                None | Some(0) => {
                    self.focus_idx = None;
                    self.path_input.read(cx).focus_handle(cx).focus(window, cx);
                    cx.notify();
                    return;
                }
                Some(index) => Some(index - 1),
            }
        };
        self.focus_idx = next;
        self.focus.focus(window, cx);
        if let Some(index) = next {
            self.scroll.scroll_to_item(index);
        }
        cx.notify();
    }

    fn type_to_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_idx = None;
        self.hovered = None;
        let base = self.current().map(|c| self.collapse(&c.path)).unwrap_or_default();
        let seed = if base.ends_with('/') { base } else { format!("{base}/") };
        self.set_input_text(seed, window, cx);
        self.path_input.read(cx).focus_handle(cx).focus(window, cx);
        cx.notify();
    }

    fn reset_path(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_idx = None;
        let display = self.current().map(|c| self.collapse(&c.path)).unwrap_or_default();
        self.set_input_text(display, window, cx);
        self.focus.focus(window, cx);
        self.set_input_ink(false, cx);
        cx.notify();
    }

    fn on_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let input_focused = self.path_input.read(cx).focus_handle(cx).is_focused(window);
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        match key {
            "escape" => {
                if input_focused {
                    self.reset_path(window, cx);
                } else {
                    self.cancel(window, cx);
                }
                cx.stop_propagation();
            }
            "enter" => {
                if self
                    .enter_at
                    .take()
                    .is_some_and(|at| at.elapsed() < Duration::from_millis(120))
                {
                    return;
                }
                if input_focused {
                    return;
                }
                match self.focus_idx {
                    Some(index) => self.activate(index, window, cx),
                    None => self.pick_current(window, cx),
                }
                cx.stop_propagation();
            }
            "up" => {
                if !input_focused {
                    self.move_focus(false, window, cx);
                    cx.stop_propagation();
                }
            }
            "down" => {
                if !input_focused {
                    self.move_focus(true, window, cx);
                    cx.stop_propagation();
                }
            }
            _ => {
                if !input_focused
                    && !modifiers.platform
                    && !modifiers.control
                    && !modifiers.alt
                    && key != " "
                    && key.chars().count() == 1
                {
                    self.type_to_focus(window, cx);
                }
            }
        }
    }

    fn pick_current(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(current) = self.current() else { return };
        let path = current.path.clone();
        self.close_to(FolderPickerEvent::Picked(path), window, cx);
    }

    fn cancel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close_to(FolderPickerEvent::Cancel, window, cx);
    }

    fn close_to(
        &mut self,
        event: FolderPickerEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.closing {
            return;
        }
        self.closing = true;
        self.phase = Phase::Out;
        self.exit_at = Some(Instant::now());
        self.outcome = Some(event);
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(EXIT).await;
            this.update_in(cx, |this, _, cx| {
                if let Some(event) = this.outcome.take() {
                    cx.emit(event);
                }
            })
            .ok();
        })
        .detach();
    }

    fn animating(&self) -> bool {
        match self.phase {
            Phase::In => self.started.elapsed() < ENTER,
            Phase::Out => self.exit_at.is_some_and(|at| at.elapsed() < EXIT),
        }
    }

    /// Scrim opacity, card opacity, and the card's vertical offset.
    fn motion(&self) -> (f32, f32, f32) {
        match self.phase {
            Phase::In => {
                let scrim_t = (self.started.elapsed().as_secs_f32() / 0.240).min(1.);
                let scrim = bezier(0.22, 1.0, 0.36, 1.0, scrim_t);
                let card_t = (self.started.elapsed().as_secs_f32() / ENTER.as_secs_f32()).min(1.);
                let card = bezier(0.34, 1.3, 0.64, 1.0, card_t);
                let opacity = (card_t / 0.45).min(1.);
                (scrim, opacity, CARD_RISE * (1. - card))
            }
            Phase::Out => {
                let at = self.exit_at.unwrap_or_else(Instant::now);
                let t = (at.elapsed().as_secs_f32() / EXIT.as_secs_f32()).min(1.);
                let eased = bezier(0.4, 0.0, 1.0, 1.0, t);
                (1. - eased, 1. - eased, CARD_RISE * eased)
            }
        }
    }
}

impl Render for FolderPicker {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = Theme::get(cx).colors.clone();
        let (scrim, card_opacity, card_y) = self.motion();
        if self.animating() {
            window.request_animation_frame();
        }
        let now = self.clock();
        let mut moving = false;
        // A read in flight keeps the spinner turning, and the previous rows
        // stay in place until its answer lands.
        moving |= self.loading;
        // The actions fade rather than flip: a pointer crossing the card reads
        // as one motion, not a series of light switches.
        let (cancel_hover, cancel_moving) = sample_hover(
            &mut self.cancel_hover,
            &mut self.cancel_hovering,
            self.cancel_hovered,
            now,
        );
        moving |= cancel_moving;

        let max_list = f32::from(window.viewport_size().height) * 0.48;

        let input_focused = self.path_input.read(cx).focus_handle(cx).is_focused(window);
        let input_color = if input_focused { colors.ink } else { colors.muted };
        let input = div()
            .flex_1()
            .min_w(px(0.))
            .h(px(17.))
            .flex()
            .items_center()
            .font_family(MONO)
            .text_size(px(11.5))
            .line_height(px(17.))
            .text_color(hsla(input_color))
            .child(Input::new(&self.path_input));

        let header = div()
            .relative()
            .h(px(HEADER_H))
            .mb(px(BAND_GAP))
            .flex_shrink_0()
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, _| paint_header_band(bounds, hsla(colors.band), window),
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
                    .gap(px(12.))
                    .child(input)
                    .child(
                        // A fixed slot, so the Cancel action doesn't jump when a
                        // listing starts or finishes.
                        div()
                            .w(px(15.))
                            .h(px(15.))
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(if self.loading {
                                crate::shell::spinner(
                                    self.started.elapsed().as_secs_f32(),
                                    colors.muted.alpha(0.3),
                                    colors.ink_soft,
                                )
                                .into_any_element()
                            } else {
                                div().into_any_element()
                            }),
                    )
                    .child(
                        div()
                            .id("folder-picker-cancel")
                            .flex_shrink_0()
                            .cursor_pointer()
                            .text_size(px(14.))
                            .font_weight(FontWeight::NORMAL)
                            .text_color(hsla(colors.muted))
                            .opacity(1. - 0.3 * cancel_hover)
                            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                                this.cancel_hovered = *hovered;
                                cx.notify();
                            }))
                            .on_click(cx.listener(|this, _, window, cx| this.cancel(window, cx)))
                            .child("Cancel"),
                    ),
            );

        let rows = self.rows();
        let keys: Vec<String> = rows.iter().map(PickerRow::key).collect();
        self.sync_row_motion(&keys);
        let magnet_keys: Vec<String> = rows
            .iter()
            .filter(|row| !matches!(row, PickerRow::Ascend { .. }))
            .map(PickerRow::key)
            .collect();
        self.sync_magnets(&magnet_keys);
        if self.magnets.values().any(Magnet::settling) {
            window.request_animation_frame();
        }
        let entry_depth = indent(self.trail.len().saturating_sub(1));
        let entry_indent = entry_depth + 20.;
        let mut list = div()
            .id("folder-picker-list")
            .w_full()
            .flex()
            .flex_col()
            .items_start()
            .py(px(4.))
            .pl(px(16.))
            .max_h(px(max_list))
            .overflow_y_scroll()
            .overflow_x_hidden()
            .track_scroll(&self.scroll);

        if let Some(error) = self.error {
            list = list.child(message(error, 0., &colors));
        } else {
            for (index, row) in rows.into_iter().enumerate() {
                let (enter, meta) = match self.row_motion.get_mut(&keys[index]) {
                    Some(m) => {
                        let (e, g) = (m.enter.sample(now, false), m.meta.sample(now, false));
                        moving |= e.is_animating() || g.is_animating();
                        (e.value() as f32, g.value() as f32)
                    }
                    None => (1., 1.),
                };
                let mut visual = row.visual(index, entry_depth, &colors);
                visual.enter = enter;
                visual.meta = meta;
                let hovered = self.hovered == Some(index);
                let focused = self.focus_idx == Some(index);
                let (hover, hover_moving) = match self.row_motion.get_mut(&keys[index]) {
                    Some(motion) => {
                        sample_hover(&mut motion.hover, &mut motion.hovering, hovered || focused, now)
                    }
                    None => (if hovered || focused { 1. } else { 0. }, false),
                };
                moving |= hover_moving;
                // The go-up row is not wrapped, so it never leans.
                let (offset, probe) = match self.magnets.get(&keys[index]) {
                    Some(magnet) if !matches!(&row, PickerRow::Ascend { .. }) => {
                        let (x, y) = magnet.offset();
                        ((x, y), Some(magnet.probe()))
                    }
                    _ => ((0., 0.), None),
                };
                let element = match row {
                    PickerRow::Ascend { .. } => {
                        let on_click = cx.listener(|this, _, window, cx| this.ascend(window, cx));
                        row_element(visual, hover, &colors, offset, probe, on_click, cx)
                    }
                    PickerRow::Crumb { index, path, current, .. } => {
                        let on_click = cx.listener(move |this, _: &ClickEvent, window, cx| {
                            this.click_crumb(index, path.clone(), current, window, cx)
                        });
                        row_element(visual, hover, &colors, offset, probe, on_click, cx)
                    }
                    PickerRow::Entry { path, name, repo, branch } => {
                        let entry = Entry { name, path, repo, branch };
                        let click = entry.clone();
                        let on_click = cx.listener(move |this, event: &ClickEvent, window, cx| {
                            this.click_entry(click.clone(), event, window, cx)
                        });
                        row_element(visual, hover, &colors, offset, probe, on_click, cx)
                    }
                };
                list = list.child(element);
            }
            if self.entries.is_empty() && !self.loading {
                let text = if self.read_error {
                    "Can’t read this folder"
                } else {
                    "No subfolders"
                };
                list = list.child(message(text, entry_indent, &colors));
            }
        }

        // The list is laid out at its natural height and measured; the box
        // around it chases that height, taking the change up at the top since
        // the card is anchored to its lower edge. The first frame is drawn
        // unconstrained so there is something to measure.
        if let Some(measured) = self.list_measured.get() {
            match self.list_target {
                None => self.list_height.jump(measured as f64, now),
                Some(t) if (t - measured).abs() > 0.5 => self.list_height.animate(measured as f64, height_tween(), now),
                _ => {}
            }
            self.list_target = Some(measured);
        }
        let height = self.list_height.sample(now, false);
        moving |= height.is_animating();
        let probe = self.list_measured.clone();
        let natural = div()
            .relative()
            .w_full()
            .child(list)
            .child(canvas(
                move |b, window, _| {
                    let h = Some(f32::from(b.size.height));
                    // A new natural height needs one more render to chase it.
                    if probe.get() != h {
                        probe.set(h);
                        window.refresh();
                    }
                },
                |_, _, _, _| {},
            ).absolute().top_0().left_0().size_full());
        let list_box = div()
            .w_full()
            .flex_shrink_0()
            .overflow_hidden()
            .when(self.list_target.is_some(), |d| d.h(px(height.value() as f32)))
            .relative()
            .child(natural)
            .child(edge_fade(self.scroll.clone(), colors.panel));

        let current_name = self
            .current()
            .map(|crumb| crumb.name.clone())
            .unwrap_or_default();
        let current_branch = self.current().and_then(|crumb| crumb.branch.clone());
        let can_open = self.current().is_some();
        let (open_hover, open_moving) = sample_hover(
            &mut self.open_hover,
            &mut self.open_hovering,
            self.open_hovered && can_open,
            now,
        );
        moving |= open_moving;
        if moving {
            window.request_animation_frame();
        }
        let open_opacity = if can_open { 1. - 0.3 * open_hover } else { 0.4 };
        let mut open = div()
            .id("folder-picker-open")
            .min_w(px(0.))
            .max_w(relative(1.))
            .flex()
            .items_center()
            .gap(px(6.4))
            .cursor_pointer()
            .opacity(open_opacity)
            .when(!can_open, |this| this.cursor_default())
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                this.open_hovered = *hovered;
                cx.notify();
            }))
            .on_click(cx.listener(|this, _, window, cx| this.pick_current(window, cx)))
            .child(
                div()
                    .flex_shrink_0()
                    .text_size(px(14.))
                    .font_weight(FontWeight::NORMAL)
                    .text_color(hsla(colors.ink))
                    .child("Open "),
            )
            .child(
                div()
                    .min_w(px(0.))
                    .truncate()
                    .text_size(px(14.))
                    .font_weight(FontWeight::NORMAL)
                    .text_color(hsla(colors.ink_soft))
                    .child(format!("“{current_name}”")),
            );
        if let Some(branch) = current_branch {
            open = open.child(git_group(Some(branch), 0.85, &colors));
        }
        open = open.child(
            div()
                .relative()
                .left(px(3. * open_hover))
                .flex_shrink_0()
                .text_size(px(14.))
                .font_weight(FontWeight::NORMAL)
                .text_color(hsla(colors.accent))
                .child("→"),
        );

        let footer = div()
            .relative()
            .h(px(FOOTER_H))
            .mt(px(BAND_GAP))
            .flex_shrink_0()
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, _| paint_footer_band(bounds, hsla(colors.band), window),
                )
                .absolute()
                .left_0()
                .right_0()
                .bottom_0()
                .h(px(FOOTER_H + BAND_ARC)),
            )
            .child(
                div()
                    .relative()
                    .h_full()
                    .px(px(16.))
                    .flex()
                    .items_center()
                    .justify_end()
                    .child(open),
            );

        let card = div()
            .id("folder-picker-card")
            .relative()
            .top(px(card_y))
            .w_full()
            .max_w(px(CARD_WIDTH))
            .flex()
            .flex_col()
            .justify_end()
            .overflow_hidden()
            .rounded(px(18.))
            .bg(hsla(colors.panel))
            .border_1()
            .border_color(hsla(colors.ink.alpha(0.08)))
            .opacity(card_opacity)
            .font_family(SANS)
            .tab_group()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(header)
            .child(list_box)
            .child(footer);

        div()
            .absolute()
            .inset_0()
            .flex()
            .justify_end()
            .items_end()
            .p(px(24.))
            .bg(hsla(colors.ground.alpha(0.62 * scrim)))
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                let key = event.keystroke.key.as_str();
                let input_focused = this.path_input.read(cx).focus_handle(cx).is_focused(window);
                // Any key that isn't a delete ends the deletion it may follow,
                // so a no-op backspace can't swallow the next completion.
                if key != "backspace" && key != "delete" {
                    this.deleting = false;
                }
                match key {
                    "tab" => {
                        // A selected completion is the thing Tab is for; only
                        // once there is none does it walk the focus ring.
                        if !this.accept_completion(window, cx) {
                            this.tab_focus(event.keystroke.modifiers.shift, window, cx);
                        }
                        cx.stop_propagation();
                    }
                    "right" if this.accept_completion(window, cx) => {
                        cx.stop_propagation();
                    }
                    "/" => {
                        // Take the completion, then let the slash land after it.
                        this.accept_completion(window, cx);
                    }
                    "backspace" | "delete" if input_focused => this.deleting = true,
                    "up" | "down" if input_focused => {
                        // The field is one line, so the arrows belong to the
                        // rows, the way they do in the web picker.
                        this.move_focus(key == "down", window, cx);
                        cx.stop_propagation();
                    }
                    _ => {}
                }
            }))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                this.on_key(event, window, cx)
            }))
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| {
                // A row only repaints when its pull target changes; the glide
                // itself rides the animation frames requested in render.
                let mut moved = false;
                for magnet in this.magnets.values_mut() {
                    moved |= magnet.track(event.position);
                }
                if moved {
                    cx.notify();
                }
            }))
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| this.cancel(window, cx)))
            .child(card)
    }
}

impl PickerRow {
    fn key(&self) -> String {
        match self {
            PickerRow::Ascend { .. } => "\u{2191}".into(),
            PickerRow::Crumb { path, .. } | PickerRow::Entry { path, .. } => path.display().to_string(),
        }
    }

    fn visual(&self, idx: usize, entry_depth: f32, colors: &Palette) -> RowVisual {
        match self {
            PickerRow::Ascend { name } => RowVisual {
                idx,
                indent: 0.,
                name: name.clone(),
                icon: "icons/arrow-up.svg",
                rest_opacity: 0.55,
                active_opacity: 1.,
                text: hsla(colors.muted),
                repo: false,
                branch: None,
                enter: 1.,
                meta: 1.,
            },
            PickerRow::Crumb { name, index, current, repo, branch, .. } => RowVisual {
                idx,
                indent: indent(index.saturating_sub(1)),
                name: name.clone(),
                icon: "icons/arrow-turn-backward.svg",
                rest_opacity: 0.55,
                active_opacity: 1.,
                text: if *current {
                    hsla(colors.ink_soft)
                } else {
                    hsla(colors.muted)
                },
                repo: *repo,
                branch: branch.clone(),
                enter: 1.,
                meta: 1.,
            },
            PickerRow::Entry { name, repo, branch, .. } => RowVisual {
                idx,
                indent: entry_depth,
                name: name.clone(),
                icon: "icons/folder.svg",
                rest_opacity: 0.45,
                active_opacity: 0.8,
                text: hsla(colors.ink),
                repo: *repo,
                branch: branch.clone(),
                enter: 1.,
                meta: 1.,
            },
        }
    }
}

fn row_element<F>(
    visual: RowVisual,
    hover: f32,
    colors: &Palette,
    offset: (f32, f32),
    probe: Option<Rc<Cell<Option<Bounds<Pixels>>>>>,
    on_click: F,
    cx: &mut Context<FolderPicker>,
) -> Div
where
    F: Fn(&ClickEvent, &mut Window, &mut App) + 'static,
{
    let hover = hover.clamp(0., 1.);
    let idx = visual.idx;
    let RowVisual {
        indent,
        name,
        icon,
        rest_opacity,
        active_opacity,
        text,
        repo,
        branch,
        enter,
        meta,
        ..
    } = visual;
    let (x, y) = offset;
    let mut row = div()
        .id(("folder-picker-row", idx))
        .relative()
        .left(px(x))
        .top(px(ROW_RISE * (1. - enter) + y))
        .opacity(enter.clamp(0., 1.))
        .flex()
        .items_center()
        .gap(px(6.))
        .py(px(8.))
        .px(px(12.))
        .rounded(px(10.))
        .max_w(relative(1.))
        .cursor_pointer()
        .text_color(text)
        .bg(hsla(colors.hover.alpha(colors.hover.a * hover)))
        .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
            if *hovered {
                this.hovered = Some(idx);
            } else if this.hovered == Some(idx) {
                this.hovered = None;
            }
            cx.notify();
        }))
        .on_click(on_click)
        .child(
            div()
                .w(px(20.))
                .flex()
                .flex_shrink_0()
                .justify_center()
                .opacity(rest_opacity + (active_opacity - rest_opacity) * hover)
                .child(svg().path(icon).size(px(16.)).text_color(text)),
        )
        .child(
            div()
                .min_w(px(0.))
                .flex_shrink(1.)
                .truncate()
                .text_size(px(15.))
                .font_weight(FontWeight::NORMAL)
                .line_height(px(16.5))
                .child(name),
        );
    if repo {
        let rest = 0.7 + 0.3 * hover;
        row = row.child(
            div()
                .relative()
                .left(px(META_SHIFT * (1. - meta)))
                .opacity(meta.clamp(0., 1.))
                .child(git_group(branch, rest, colors)),
        );
    }
    // The probe sits on the unmoved wrapper, so the pull is measured from
    // where the row rests and only the row itself travels.
    let mut wrapper = div().relative().max_w(relative(1.)).ml(px(indent));
    if let Some(probe) = probe {
        wrapper = wrapper.child(
            canvas(move |b, _, _| probe.set(Some(b)), |_, _, _, _| {})
                .absolute()
                .size_full(),
        );
    }
    wrapper.child(row)
}

fn git_group(branch: Option<String>, opacity: f32, colors: &Palette) -> Div {
    let group = div()
        .flex()
        .items_center()
        .gap(px(8.))
        .ml(px(8.))
        .flex_shrink_0()
        .child(
            div()
                .flex()
                .items_center()
                .opacity(opacity)
                .child(
                    svg()
                        .path("icons/git-branch.svg")
                        .size(px(13.))
                        .text_color(hsla(colors.accent)),
                ),
        );
    match branch {
        Some(branch) => group.child(
            div()
                .min_w(px(0.))
                .max_w(px(192.))
                .truncate()
                .font_family(MONO)
                .text_size(px(11.5))
                .line_height(px(13.))
                .text_color(hsla(colors.muted))
                .child(branch),
        ),
        None => group,
    }
}

fn message(text: &str, indent: f32, colors: &Palette) -> Div {
    div()
        .ml(px(indent))
        .px(px(12.))
        .py(px(10.))
        .text_size(px(15.))
        .font_weight(FontWeight::NORMAL)
        .line_height(px(16.5))
        .text_color(hsla(colors.muted))
        .child(text.to_string())
}

fn input_style(colors: &Palette, focused: bool) -> InputEditorStyle {
    let ink = if focused { colors.ink } else { colors.muted };
    InputEditorStyle {
        foreground: hsla(ink),
        muted_foreground: hsla(colors.muted),
        // A hair of alpha keeps the editor from treating the field as unset
        // and painting a host surface behind the text. The band stays visible.
        background: hsla(colors.band.alpha(0.001)),
        border: hsla(colors.line_soft),
        selection: hsla(colors.accent.alpha(0.24)),
        caret: hsla(ink),
        ..Default::default()
    }
}

/// Paints the header band and its two concave scoops. The path starts along the
/// top edge, comes down the right wall into a quarter-circle bite, crosses the
/// band's lower edge, and mirrors back up the left wall.
fn paint_header_band(bounds: Bounds<Pixels>, color: Hsla, window: &mut Window) {
    let (x, y) = (f32::from(bounds.origin.x), f32::from(bounds.origin.y));
    let width = f32::from(bounds.size.width);
    let arc = BAND_ARC;
    let band = HEADER_H;
    let k = 0.552_284_8 * arc;
    let mut path = PathBuilder::fill();
    path.move_to(point(px(x), px(y)));
    path.line_to(point(px(x + width), px(y)));
    path.line_to(point(px(x + width), px(y + band + arc)));
    path.cubic_bezier_to(
        point(px(x + width - arc), px(y + band)),
        point(px(x + width), px(y + band + arc - k)),
        point(px(x + width - arc + k), px(y + band)),
    );
    path.line_to(point(px(x + arc), px(y + band)));
    path.cubic_bezier_to(
        point(px(x), px(y + band + arc)),
        point(px(x + arc - k), px(y + band)),
        point(px(x), px(y + band + arc - k)),
    );
    path.close();
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
}

/// Paints the footer band and its scoops, which bite upward into the list so
/// the two bands read as facing each other.
fn paint_footer_band(bounds: Bounds<Pixels>, color: Hsla, window: &mut Window) {
    let (x, y) = (f32::from(bounds.origin.x), f32::from(bounds.origin.y));
    let width = f32::from(bounds.size.width);
    let arc = BAND_ARC;
    let band = FOOTER_H;
    let k = 0.552_284_8 * arc;
    let mut path = PathBuilder::fill();
    path.move_to(point(px(x), px(y)));
    path.line_to(point(px(x), px(y + arc + band)));
    path.line_to(point(px(x + width), px(y + arc + band)));
    path.line_to(point(px(x + width), px(y)));
    path.cubic_bezier_to(
        point(px(x + width - arc), px(y + arc)),
        point(px(x + width), px(y + k)),
        point(px(x + width - arc + k), px(y + arc)),
    );
    path.line_to(point(px(x + arc), px(y + arc)));
    path.cubic_bezier_to(
        point(px(x), px(y)),
        point(px(x + arc - k), px(y + arc)),
        point(px(x), px(y + arc - k)),
    );
    path.close();
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
}

fn click_count(event: &ClickEvent) -> usize {
    match event {
        ClickEvent::Mouse(event) => event.down.click_count,
        ClickEvent::Touch(event) => event.tap_count,
        ClickEvent::Keyboard(_) => 1,
    }
}

fn indent(level: usize) -> f32 {
    level.min(MAX_STEPS) as f32 * STEP
}

fn dir_name(dir: &Path) -> String {
    dir.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir.display().to_string())
}

fn home_dir() -> PathBuf {
    env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

fn expand(home: &Path, raw: &str) -> PathBuf {
    let raw = raw.trim();
    if raw == "~" {
        return home.to_path_buf();
    }
    let path = if let Some(rest) = raw.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(raw)
    };
    // Typing `/a/b/` should land on the same folder as `/a/b`; the trailing
    // separators carry no information and would otherwise echo back in the bar.
    let text = path.to_string_lossy();
    if text.len() <= 1 || !text.ends_with('/') {
        return path;
    }
    let trimmed = text.trim_end_matches('/');
    if trimmed.is_empty() { PathBuf::from("/") } else { PathBuf::from(trimmed) }
}

fn collapse(home: &Path, path: &Path) -> String {
    if path == home {
        return "~/".into();
    }
    if let Ok(rest) = path.strip_prefix(home) {
        return format!("~/{}", rest.display());
    }
    path.display().to_string()
}

fn list_dir(dir: &Path) -> io::Result<Listing> {
    let metadata = fs::metadata(dir)?;
    if !metadata.is_dir() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a directory"));
    }

    let mut entries = Vec::new();
    // One unreadable child (a dangling mount, a permission-locked folder)
    // must not blank the whole listing; it is simply left out.
    for entry in fs::read_dir(dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if !entry_is_dir(&entry) {
            continue;
        }
        let repo = is_repo_root(&path);
        let branch = if repo { read_branch(&path) } else { None };
        entries.push(Entry { name, path, repo, branch });
    }
    entries.sort_by_cached_key(|entry| entry.name.to_lowercase());

    let repo = is_repo_root(dir);
    let branch = if repo { read_branch(dir) } else { None };
    Ok(Listing { repo, branch, entries })
}

/// The address bar only needs names, not the git enrichment a full listing
/// pays for.
fn child_dir_names(dir: &Path) -> Option<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if entry_is_dir(&entry) {
            names.push(name);
        }
    }
    names.sort_by_cached_key(|name| name.to_lowercase());
    Some(names)
}

fn entry_is_dir(entry: &fs::DirEntry) -> bool {
    let Ok(file_type) = entry.file_type() else { return false };
    if file_type.is_dir() {
        true
    } else if file_type.is_symlink() {
        fs::metadata(entry.path()).is_ok_and(|meta| meta.is_dir())
    } else {
        false
    }
}

fn is_repo_root(dir: &Path) -> bool {
    fs::symlink_metadata(dir.join(".git")).is_ok()
}

fn git_dir(dir: &Path) -> Option<PathBuf> {
    let marker = dir.join(".git");
    let metadata = fs::symlink_metadata(&marker).ok()?;
    if metadata.is_dir() {
        return Some(marker);
    }
    let text = fs::read_to_string(&marker).ok()?;
    let rest = text.trim().strip_prefix("gitdir:")?.trim();
    let path = Path::new(rest);
    Some(if path.is_absolute() { path.to_path_buf() } else { dir.join(path) })
}

fn read_branch(dir: &Path) -> Option<String> {
    let git = git_dir(dir)?;
    let head = fs::read_to_string(git.join("HEAD")).ok()?;
    let head = head.trim();
    if let Some(name) = head.strip_prefix("ref: refs/heads/") {
        return Some(name.to_string());
    }
    let short: String = head.chars().take(7).collect();
    (!short.is_empty()).then_some(short)
}

/// Solves a CSS-style cubic bezier for one axis and returns the eased value.
fn bezier(x1: f32, y1: f32, x2: f32, y2: f32, t: f32) -> f32 {
    let curve = |a: f32, b: f32, s: f32| {
        3. * a * s * (1. - s).powi(2) + 3. * b * s * s * (1. - s) + s.powi(3)
    };
    let (mut lo, mut hi) = (0f32, 1f32);
    for _ in 0..24 {
        let mid = (lo + hi) / 2.;
        if curve(x1, x2, mid) < t {
            lo = mid
        } else {
            hi = mid
        }
    }
    curve(y1, y2, (lo + hi) / 2.)
}

/// Electron's FADE: how far the rows dissolve into an edge with more beyond it.
const EDGE_FADE: f32 = 22.;

/// Stands in for the web picker's mask-image: strips of the card's own colour
/// over whichever edge of the list has rows past it. Read at paint time from the
/// scroll handle, so a scroll only repaints; nothing renders on its own.
fn edge_fade(scroll: ScrollHandle, panel: kone_theme::Rgba) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |b, _, window, _| {
            let (y, max) = (-f32::from(scroll.offset().y), f32::from(scroll.max_offset().y));
            let solid = hsla(panel);
            let clear = hsla(panel.alpha(0.));
            let h = px(EDGE_FADE.min(f32::from(b.size.height) / 2.));
            if y > 1. {
                let top = Bounds::new(b.origin, size(b.size.width, h));
                window.paint_quad(fill(top, linear_gradient(180., linear_color_stop(solid, 0.), linear_color_stop(clear, 1.))));
            }
            if y < max - 1. {
                let bottom = Bounds::new(point(b.origin.x, b.bottom() - h), size(b.size.width, h));
                window.paint_quad(fill(bottom, linear_gradient(180., linear_color_stop(clear, 0.), linear_color_stop(solid, 1.))));
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

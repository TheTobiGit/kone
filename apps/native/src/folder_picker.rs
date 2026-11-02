//! The in-app folder browser: a bottom-right card over a scrim, with an
//! editable path, a breadcrumb trail, the focused folder's subdirectories, and
//! a confirm action welded to the lower edge.
//!
//! The listing is read straight from the filesystem. A repository root is
//! recognised by its `.git` marker and its branch comes from that git dir's
//! `HEAD`, so rows can show their branch without shelling out to git.

use std::{
    env, fs,
    io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use gpui_kit::base::input::{Input, InputEditorStyle, InputEvent, InputState};
use gpui_kit::prelude::*;
use gpui_kit::*;
use kone_theme::{hsla, Palette, Theme};

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
    name: String,
    repo: bool,
    branch: Option<String>,
    entries: Vec<Entry>,
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
    open_hovered: bool,
    scroll: ScrollHandle,
    recent_descend: Option<(PathBuf, Instant)>,
    /// Set when the address bar submits, so the same Enter is not read a
    /// second time by the bubble handler after focus moves to the card.
    enter_at: Option<Instant>,
    phase: Phase,
    started: Instant,
    exit_at: Option<Instant>,
    closing: bool,
    outcome: Option<FolderPickerEvent>,
    _input_sub: Subscription,
}

impl FolderPicker {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let colors = Theme::get(cx).colors.clone();
        let home = home_dir();
        let (trail, entries, error) = match list_dir(&home) {
            Ok(listing) => (
                vec![Crumb {
                    name: listing.name,
                    path: home.clone(),
                    repo: listing.repo,
                    branch: listing.branch,
                }],
                listing.entries,
                None,
            ),
            Err(_) => (Vec::new(), Vec::new(), Some("Couldn't read this folder.")),
        };

        let display = trail
            .last()
            .map(|crumb| collapse(&home, &crumb.path))
            .unwrap_or_default();
        let path_input = cx.new(|cx| InputState::new(window, cx).default_value(display));
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
                InputEvent::Change => {}
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
            trail,
            entries,
            error,
            read_error: false,
            hovered: None,
            focus_idx: None,
            open_hovered: false,
            scroll: ScrollHandle::new(),
            recent_descend: None,
            enter_at: None,
            phase: Phase::In,
            started: Instant::now(),
            exit_at: None,
            closing: false,
            outcome: None,
            _input_sub: input_sub,
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

    fn current(&self) -> Option<&Crumb> {
        self.trail.last()
    }

    fn sync_path(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let display = self.current().map(|c| self.collapse(&c.path)).unwrap_or_default();
        let focused = self.path_input.read(cx).focus_handle(cx).is_focused(window);
        self.path_input.update(cx, |state, cx| {
            state.set_value(display, window, cx);
        });
        self.set_input_ink(focused, cx);
    }

    fn after_nav(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.hovered = None;
        self.focus_idx = None;
        self.error = None;
        self.sync_path(window, cx);
        self.scroll.scroll_to_item(0);
        cx.notify();
    }

    fn load_trail(&mut self, mut trail: Vec<Crumb>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(current) = trail.last() else { return };
        let path = current.path.clone();
        match list_dir(&path) {
            Ok(listing) => {
                self.entries = listing.entries;
                self.read_error = false;
                if let Some(last) = trail.last_mut() {
                    last.repo = listing.repo;
                    last.branch = listing.branch;
                }
            }
            Err(_) => {
                self.entries = Vec::new();
                self.read_error = true;
            }
        }
        self.trail = trail;
        self.after_nav(window, cx);
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
        if self.go_to_path(&expanded, window, cx) {
            self.focus.focus(window, cx);
        } else {
            self.reject_path(window, cx);
        }
    }

    fn reject_path(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let display = self.current().map(|c| self.collapse(&c.path)).unwrap_or_default();
        self.path_input.update(cx, |state, cx| {
            state.set_value(display, window, cx);
        });
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

    fn go_to_path(&mut self, path: &Path, window: &mut Window, cx: &mut Context<Self>) -> bool {
        match list_dir(path) {
            Ok(listing) => self.set_path_with_listing(path, listing, window, cx),
            Err(_) => false,
        }
    }

    fn set_path_with_listing(
        &mut self,
        path: &Path,
        listing: Listing,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
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
        true
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
        self.path_input.update(cx, |state, cx| {
            state.set_value(seed, window, cx);
        });
        self.path_input.read(cx).focus_handle(cx).focus(window, cx);
        cx.notify();
    }

    fn reset_path(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_idx = None;
        let display = self.current().map(|c| self.collapse(&c.path)).unwrap_or_default();
        self.path_input.update(cx, |state, cx| {
            state.set_value(display, window, cx);
        });
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
                        div()
                            .id("folder-picker-cancel")
                            .flex_shrink_0()
                            .cursor_pointer()
                            .text_size(px(14.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(hsla(colors.muted))
                            .hover(|style| style.opacity(0.7))
                            .on_click(cx.listener(|this, _, window, cx| this.cancel(window, cx)))
                            .child("Cancel"),
                    ),
            );

        let rows = self.rows();
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
                let visual = row.visual(index, entry_depth, &colors);
                let hovered = self.hovered == Some(index);
                let focused = self.focus_idx == Some(index);
                let element = match row {
                    PickerRow::Ascend { .. } => {
                        let on_click = cx.listener(|this, _, window, cx| this.ascend(window, cx));
                        row_element(visual, hovered, focused, &colors, on_click, cx)
                    }
                    PickerRow::Crumb { index, path, current, .. } => {
                        let on_click = cx.listener(move |this, _: &ClickEvent, window, cx| {
                            this.click_crumb(index, path.clone(), current, window, cx)
                        });
                        row_element(visual, hovered, focused, &colors, on_click, cx)
                    }
                    PickerRow::Entry { path, name, repo, branch } => {
                        let entry = Entry { name, path, repo, branch };
                        let click = entry.clone();
                        let on_click = cx.listener(move |this, event: &ClickEvent, window, cx| {
                            this.click_entry(click.clone(), event, window, cx)
                        });
                        row_element(visual, hovered, focused, &colors, on_click, cx)
                    }
                };
                list = list.child(element);
            }
            if self.entries.is_empty() {
                let text = if self.read_error {
                    "Can’t read this folder"
                } else {
                    "No subfolders"
                };
                list = list.child(message(text, entry_indent, &colors));
            }
        }

        let current_name = self
            .current()
            .map(|crumb| crumb.name.clone())
            .unwrap_or_default();
        let current_branch = self.current().and_then(|crumb| crumb.branch.clone());
        let can_open = self.current().is_some();
        let mut open = div()
            .id("folder-picker-open")
            .min_w(px(0.))
            .max_w(relative(1.))
            .flex()
            .items_center()
            .gap(px(6.4))
            .cursor_pointer()
            .when(self.open_hovered && can_open, |this| this.opacity(0.7))
            .when(!can_open, |this| this.opacity(0.4).cursor_default())
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                this.open_hovered = *hovered;
                cx.notify();
            }))
            .on_click(cx.listener(|this, _, window, cx| this.pick_current(window, cx)))
            .child(
                div()
                    .flex_shrink_0()
                    .text_size(px(14.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(hsla(colors.ink))
                    .child("Open "),
            )
            .child(
                div()
                    .min_w(px(0.))
                    .truncate()
                    .text_size(px(14.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(hsla(colors.ink_soft))
                    .child(format!("“{current_name}”")),
            );
        if let Some(branch) = current_branch {
            open = open.child(git_group(Some(branch), 0.85, &colors));
        }
        open = open.child(
            div()
                .flex_shrink_0()
                .ml(px(if self.open_hovered && can_open { 3. } else { 0. }))
                .text_size(px(14.))
                .font_weight(FontWeight::MEDIUM)
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
            .child(list)
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
                if event.keystroke.key == "tab" {
                    this.tab_focus(event.keystroke.modifiers.shift, window, cx);
                    cx.stop_propagation();
                }
            }))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                this.on_key(event, window, cx)
            }))
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| this.cancel(window, cx)))
            .child(card)
    }
}

impl PickerRow {
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
            },
        }
    }
}

fn row_element<F>(
    visual: RowVisual,
    hovered: bool,
    focused: bool,
    colors: &Palette,
    on_click: F,
    cx: &mut Context<FolderPicker>,
) -> Stateful<Div>
where
    F: Fn(&ClickEvent, &mut Window, &mut App) + 'static,
{
    let active = hovered || focused;
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
        ..
    } = visual;
    let mut row = div()
        .id(("folder-picker-row", idx))
        .flex()
        .items_center()
        .gap(px(6.))
        .py(px(8.))
        .px(px(12.))
        .rounded(px(10.))
        .ml(px(indent))
        .max_w(relative(1.))
        .cursor_pointer()
        .text_color(text)
        .when(active, |this| this.bg(hsla(colors.hover)))
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
                .opacity(if active { active_opacity } else { rest_opacity })
                .child(svg().path(icon).size(px(16.)).text_color(text)),
        )
        .child(
            div()
                .min_w(px(0.))
                .flex_shrink(1.)
                .truncate()
                .text_size(px(15.))
                .font_weight(FontWeight::SEMIBOLD)
                .line_height(px(16.5))
                .child(name),
        );
    if repo {
        row = row.child(git_group(branch, if active { 1. } else { 0.7 }, colors));
    }
    row
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
        .font_weight(FontWeight::SEMIBOLD)
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

fn home_dir() -> PathBuf {
    env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

fn expand(home: &Path, raw: &str) -> PathBuf {
    let raw = raw.trim();
    if raw == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return home.join(rest);
    }
    PathBuf::from(raw)
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
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let file_type = entry.file_type()?;
        let is_dir = if file_type.is_dir() {
            true
        } else if file_type.is_symlink() {
            fs::metadata(&path).is_ok_and(|meta| meta.is_dir())
        } else {
            false
        };
        if !is_dir {
            continue;
        }
        let repo = is_repo_root(&path);
        let branch = if repo { read_branch(&path) } else { None };
        entries.push(Entry { name, path, repo, branch });
    }
    entries.sort_by_cached_key(|entry| entry.name.to_lowercase());

    let repo = is_repo_root(dir);
    let branch = if repo { read_branch(dir) } else { None };
    let name = dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir.display().to_string());
    Ok(Listing { name, repo, branch, entries })
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

//! The empty launcher: three ways to begin, centred over a drifting loom of threads.

use std::time::{Duration, Instant};

use gpui_kit::prelude::*;
use gpui_kit::*;
use kone_theme::{hsla, Theme};

use gpui_kit::base::input::{Input, InputEvent, InputState};

use crate::magnet::{glide, Magnet};
use crate::recents::{Dir, Sort};

pub const SANS: &str = "Geist";

actions!(kone_home, [GridNext, GridPrev]);

/// The recents grid owns Tab while the page itself has focus; the kit's root
/// binds Tab to focus cycling, so a deeper context has to claim it first.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("tab", GridNext, Some("KoneGrid")),
        KeyBinding::new("shift-tab", GridPrev, Some("KoneGrid")),
    ]);
}

/// What shows through the frame band.
#[derive(Clone, Copy, PartialEq)]
pub enum FrameMode {
    /// The desktop behind, blurred, under a light kone tint.
    Vibrant,
    /// The desktop behind, untouched. `KONE_FRAME=clear`.
    Clear,
}

impl FrameMode {
    pub fn background(self) -> WindowBackgroundAppearance {
        match self {
            FrameMode::Vibrant => WindowBackgroundAppearance::Blurred,
            FrameMode::Clear => WindowBackgroundAppearance::Transparent,
        }
    }
}

pub fn frame_mode() -> FrameMode {
    match std::env::var("KONE_FRAME").as_deref() {
        Ok("clear") => FrameMode::Clear,
        _ => FrameMode::Vibrant,
    }
}

/// The frame band: a touch heavier on top, where a titlebar would be.
const FRAME: f32 = 6.;
const FRAME_TOP: f32 = 8.;
/// Inside the window's own ~10px corner, so the two curves stay concentric.
const PANEL_RADIUS: f32 = 8.;

/// The stick folk at ~30 fps, idle or stirred: smooth on a GPU, and only
/// while the start screen is up in a focused window.
#[cfg(not(target_os = "linux"))]
const ART_FRAME: Duration = Duration::from_millis(33);
/// ~24 fps on Linux, where many machines render in software and every
/// frame costs real CPU.
#[cfg(target_os = "linux")]
const ART_FRAME: Duration = Duration::from_millis(42);
/// How often an unfocused window, or a page with nothing moving, checks back.
/// Room under the recents grid now the floor strip is gone.
const GRID_FOOT: f32 = 40.;
const REST_FRAME: Duration = Duration::from_millis(250);

#[derive(Clone)]
enum Screen {
    Home,
    Project(Entity<crate::project::ProjectView>),
}

#[derive(Clone, Default)]
enum Modal {
    #[default]
    None,
    Picker(Entity<crate::folder_picker::FolderPicker>),
    Create(Entity<crate::create_project::CreateProject>),
    Clone(Entity<crate::clone_modal::CloneModal>),
}

impl Modal {
    fn is_open(&self) -> bool { !matches!(self, Self::None) }
}

pub struct Shell {
    magnets: [Magnet; 3],
    folk: crate::stickfolk::Hover,
    started: Instant,
    modal: Modal,
    _modal_sub: Option<Subscription>,
    create_session: crate::create_project::CreateProjectSession,
    /// Where the last successful clone this session landed.
    clone_location: Option<String>,
    screen: Screen,
    open_error: Option<String>,
    _open_task: Option<Task<()>>,
    open_generation: u64,
    origin_tile: Option<(String, usize)>,
    _project_sub: Option<Subscription>,
    pub(crate) home: crate::recents::home::Home,
    focus: FocusHandle,
    _ticker: Task<()>,
}

impl Shell {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        // Only a focused window animates; a background one holds its last frame.
        // Modal components request frames for their own motion and busy states.
        let ticker = cx.spawn_in(window, async move |this, cx| {
            let mut pace = REST_FRAME;
            let mut was_active = true;
            loop {
                cx.background_executor().timer(pace).await;
                let alive = this.update_in(cx, |this: &mut Self, window, cx| {
                    let active = window.is_window_active();
                    // Coming back to the window: folders may have moved or
                    // changed meanwhile, so re-read the recents and their git.
                    let came_back = active && !was_active;
                    was_active = active;
                    if came_back && matches!(this.screen, Screen::Home) {
                        this.reload_recents(cx);
                    }
                    if !active {
                        return REST_FRAME;
                    }
                    if this.modal.is_open() {
                        REST_FRAME
                    } else if this.folk_shown() {
                        cx.notify();
                        ART_FRAME
                    } else {
                        // The recents home and a project have no art to move.
                        REST_FRAME
                    }
                });
                match alive {
                    Ok(p) => pace = p,
                    Err(_) => return,
                }
            }
        });
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Search projects"));
        let query_sub = cx.subscribe_in(&query, window, |this, _, event: &InputEvent, _, cx| {
            if matches!(event, InputEvent::Change) {
                this.home.hovered = None;
                cx.notify();
            }
        });
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        let mut shell = Shell {
            magnets: Default::default(),
            folk: Default::default(),
            started: Instant::now(),
            modal: Modal::None,
            _modal_sub: None,
            create_session: Default::default(),
            clone_location: None,
            screen: Screen::Home,
            open_error: None,
            _open_task: None,
            open_generation: 0,
            origin_tile: None,
            _project_sub: None,
            home: crate::recents::home::Home::new(query, query_sub),
            focus,
            _ticker: ticker,
        };
        shell.reload_recents(cx);
        shell
    }

    /// Re-reads the recents list, then each row's folder state, off the UI thread.
    fn reload_recents(&mut self, cx: &mut Context<Self>) {
        let task = cx.background_spawn(async move {
            let list = crate::projects::recents();
            let paths: Vec<String> = list.iter().map(|p| p.path.clone()).collect();
            (list, paths)
        });
        self.home._recents_task = Some(cx.spawn(async move |this, cx| {
            let (list, paths) = task.await;
            let _ = this.update(cx, |this, cx| {
                this.home.recents = Some(list);
                cx.notify();
            });
            let tiles = cx.background_spawn(async move { crate::recents::read_tiles(&paths) }).await;
            let _ = this.update(cx, |this, cx| {
                this.home.tiles = tiles;
                cx.notify();
            });
        }));
    }

    /// Runs a store edit off the UI thread, then re-reads the list.
    fn edit_recents(&mut self, edit: impl FnOnce() -> std::io::Result<()> + Send + 'static, cx: &mut Context<Self>) {
        self.open_error = None;
        let task = cx.background_spawn(async move { edit() });
        // Detached, so a later reload can't cancel this edit's follow-up; the
        // store lock orders the writes themselves.
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if let Err(e) = result {
                    this.open_error = Some(format!("Couldn't save the project list: {e}"));
                }
                this.reload_recents(cx);
            });
        })
        .detach();
    }

    pub(crate) fn toggle_pin(&mut self, path: String, cx: &mut Context<Self>) {
        self.edit_recents(move || crate::projects::toggle_pin(&path), cx);
    }

    pub(crate) fn forget(&mut self, path: String, cx: &mut Context<Self>) {
        self.edit_recents(move || crate::projects::forget(&path), cx);
    }

    pub(crate) fn reveal(&mut self, path: String, cx: &mut Context<Self>) {
        self.open_error = None;
        let task = cx.background_spawn(async move { crate::projects::reveal(std::path::Path::new(&path)) });
        cx.spawn(async move |this, cx| {
            if let Err(message) = task.await {
                let _ = this.update(cx, |this, cx| {
                    this.open_error = Some(message);
                    cx.notify();
                });
            }
        })
        .detach();
    }

    /// Opens kone's own folder browser, not the system path panel.
    fn open_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.modal.is_open() {
            return;
        }
        for m in &mut self.magnets {
            m.release();
        }
        self.folk.release();
        self.open_error = None;
        let picker = cx.new(|cx| crate::folder_picker::FolderPicker::new(window, cx));
        picker.update(cx, |picker, cx| picker.start(window, cx));
        self._modal_sub = Some(cx.subscribe_in(
            &picker,
            window,
            |this, _, event: &crate::folder_picker::FolderPickerEvent, window, cx| {
                if let crate::folder_picker::FolderPickerEvent::Picked(path) = event {
                    this.open_project(path.clone(), window, cx);
                }
                this.modal = Modal::None;
                this.focus.focus(window, cx);
                cx.notify();
            },
        ));
        self.modal = Modal::Picker(picker);
        cx.notify();
    }
}

impl Shell {
    /// Opens the create card; a created project opens like a picked folder.
    fn create_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.modal.is_open() {
            return;
        }
        for m in &mut self.magnets {
            m.release();
        }
        self.folk.release();
        self.open_error = None;
        let creator = cx.new(|cx| crate::create_project::CreateProject::new(&self.create_session, window, cx));
        creator.update(cx, |c, cx| c.start(window, cx));
        self._modal_sub = Some(cx.subscribe_in(
            &creator,
            window,
            |this, creator, event: &crate::create_project::CreateProjectEvent, window, cx| {
                // Toggles carry over either way (as in Electron), but the
                // location is only remembered once a project was created there.
                let kept = this.create_session.location.clone();
                this.create_session = creator.read(cx).session(cx);
                // Remember where the project was actually made, not whatever
                // the Location field shows now (it stays editable while busy).
                this.create_session.location = match event {
                    crate::create_project::CreateProjectEvent::Created(path) => path.parent().map(|p| {
                        crate::path_complete::collapse(&crate::path_complete::home_dir(), p)
                    }),
                    _ => kept,
                };
                if let crate::create_project::CreateProjectEvent::Created(path) = event {
                    this.open_project(path.clone(), window, cx);
                }
                this.modal = Modal::None;
                this.focus.focus(window, cx);
                cx.notify();
            },
        ));
        self.modal = Modal::Create(creator);
        cx.notify();
    }

    /// Opens the clone card; a cloned project opens like a picked folder.
    fn clone_repo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.modal.is_open() {
            return;
        }
        for m in &mut self.magnets {
            m.release();
        }
        self.folk.release();
        self.open_error = None;
        let cloner = cx.new(|cx| crate::clone_modal::CloneModal::new(self.clone_location.clone(), window, cx));
        cloner.update(cx, |c, _| c.start());
        self._modal_sub = Some(cx.subscribe_in(
            &cloner,
            window,
            |this, _cloner, event: &crate::clone_modal::CloneModalEvent, window, cx| {
                if let crate::clone_modal::CloneModalEvent::Cloned(path) = event {
                    // Where the clone actually landed, not the field's current text.
                    this.clone_location = path.parent().map(|p| {
                        crate::path_complete::collapse(&crate::path_complete::home_dir(), p)
                    });
                    this.open_project(path.clone(), window, cx);
                }
                this.modal = Modal::None;
                this.focus.focus(window, cx);
                cx.notify();
            },
        ));
        self.modal = Modal::Clone(cloner);
        cx.notify();
    }

    /// Validates and records the folder off the UI thread, then shows it.
    pub(crate) fn open_project(&mut self, path: std::path::PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        self.open_error = None;
        self.open_generation += 1;
        let generation = self.open_generation;
        let origin = path.to_string_lossy().into_owned();
        let slot = self.home.kb.map_or(0, |(_, slot)| slot);
        let task = cx.background_spawn(async move { crate::projects::open(&path) });
        self._open_task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            let _ = this.update_in(cx, |this, window, cx| {
                if generation != this.open_generation { return; }
                match result {
                    Ok(project) => {
                        this.home.hovered = None;
                        this.origin_tile = Some((origin, slot));
                        let view = cx.new(|cx| crate::project::ProjectView::new(project, std::sync::Arc::new(crate::git_service::NativeGit), window, cx));
                        this._project_sub = Some(cx.subscribe_in(&view, window, |this, _, _: &crate::project::Back, window, cx| this.close_project(window, cx)));
                        this.screen = Screen::Project(view);
                    }
                    Err(message) => this.open_error = Some(message),
                }
                cx.notify();
            });
        }));
    }

    /// Arrow keys walk the grid, Tab walks every stop (folder, pin, reveal,
    /// remove, then the start actions), Enter or Space presses the focused
    /// stop, and P / R / Delete pin, reveal or remove the focused tile.
    /// Returns whether the key was the grid's.
    fn grid_key(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let m = e.keystroke.modifiers;
        if m.control || m.platform || m.alt || m.function {
            return false;
        }
        let Some(list) = self.home.recents.as_ref() else { return false };
        let query = self.home.query.read(cx).value().to_string();
        let shown = crate::recents::shown(list, &query, self.home.sort);
        let tiles = shown.len();
        let cells = tiles + 1;
        let key = e.keystroke.key.as_str();
        let dir = match key {
            "left" => Some(Dir::Left),
            "right" => Some(Dir::Right),
            "up" => Some(Dir::Up),
            "down" => Some(Dir::Down),
            _ => None,
        };
        if let Some(dir) = dir {
            if m.shift {
                return false;
            }
            let next = match self.home.kb {
                None => 0,
                Some((cell, _)) => crate::recents::grid_step(cell, cells, dir),
            };
            self.home.kb = Some((next, 0));
            self.home.kb_follow = None;
            // Bring it into view even within the same row (after a wheel scroll).
            self.home.kb_row = None;
            self.home.hovered = None;
            cx.notify();
            return true;
        }
        if m.shift {
            return false;
        }
        let Some((cell, slot)) = self.home.kb else { return false };
        if key == "escape" {
            self.home.kb = None;
            self.home.kb_follow = None;
            cx.notify();
            return true;
        }
        let tile = shown.get(cell).map(|p| p.path.clone());
        let action = match (key, slot) {
            ("enter" | "space", s) => s,
            ("p", _) if tile.is_some() => 1,
            ("r", _) if tile.is_some() => 2,
            ("delete" | "backspace", _) if tile.is_some() => 3,
            _ => return false,
        };
        match (tile, action) {
            (Some(path), 0) => self.open_project(std::path::PathBuf::from(path), window, cx),
            (Some(path), 1) => {
                self.home.kb_follow = Some((path.clone(), slot));
                self.toggle_pin(path, cx)
            }
            (Some(path), 2) => self.reveal(path, cx),
            (Some(path), _) => {
                // The next tile slides into this cell; focus stays on the folder.
                self.home.kb = Some((cell, 0));
                self.home.kb_follow = None;
                self.forget(path, cx);
            }
            (None, 0) => self.create_project(window, cx),
            (None, 1) => self.open_folder(window, cx),
            (None, _) => self.clone_repo(window, cx),
        }
        cx.notify();
        true
    }

    /// Tab / Shift+Tab: every stop in the grid, then out to the search field
    /// and back in.
    fn grid_tab(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(list) = self.home.recents.as_ref() else { return };
        let query = self.home.query.read(cx).value().to_string();
        let tiles = crate::recents::shown(list, &query, self.home.sort).len();
        let first = (0, 0);
        let last = (tiles, crate::recents::slots(tiles, tiles) - 1);
        self.home.kb_follow = None;
        self.home.hovered = None;
        self.home.kb_row = None;
        if !self.focus.is_focused(window) {
            // From the search field (the page's only other stop) into the grid.
            self.focus.focus(window, cx);
            self.home.kb = Some(if forward { first } else { last });
        } else {
            match self.home.kb {
                // Past either end of the grid, back to the search field.
                Some(at) if (forward && at == last) || (!forward && at == first) => {
                    self.home.kb = None;
                    self.home.query.update(cx, |q, cx| q.focus(window, cx));
                }
                Some(at) => self.home.kb = Some(crate::recents::tab_step(at, tiles, forward)),
                None => self.home.kb = Some(if forward { first } else { last }),
            }
        }
        cx.notify();
    }

    /// Leaves keyboard mode.
    pub(crate) fn clear_kb(&mut self) {
        self.home.kb = None;
        self.home.kb_follow = None;
    }

    /// The stick folk live only on the empty start screen.
    fn folk_shown(&self) -> bool {
        matches!(self.screen, Screen::Home) && self.home.recents.as_ref().is_some_and(|l| l.is_empty())
    }

    fn close_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_generation += 1;
        self._open_task = None;
        self._project_sub = None;
        self.screen = Screen::Home;
        if let Some(origin) = self.origin_tile.take() {
            self.home.kb = Some((0, origin.1));
            self.home.kb_follow = Some(origin);
            self.home.kb_row = None;
        }
        self.focus.focus(window, cx);
        self.reload_recents(cx);
        cx.notify();
    }


}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::get(cx);
        let dark = theme.is_dark();
        let c = theme.colors.clone();
        // Lifted off the ground in dark, pressed below it in light: either way
        // the band reads as a frame around the page rather than part of it.
        let frame = if dark { c.raised } else { c.sunken };
        // Over the blur a third of the tint keeps the band in kone's palette
        // without hiding what is behind it.
        let frame = match frame_mode() {
            FrameMode::Vibrant => frame.alpha(0.35),
            FrameMode::Clear => frame.alpha(0.),
        };

        if self.magnets.iter().any(Magnet::settling) {
            window.request_animation_frame();
        }
        let offsets: Vec<(f32, f32)> = self.magnets.iter().map(Magnet::offset).collect();
        let slots: Vec<_> = self.magnets.iter().map(|m| m.bounds.clone()).collect();
        // While a launcher modal is up the launcher is in session: the active row
        // spins, the others dim, and none of them answer the pointer.
        let busy = self.modal.is_open();
        let session = if matches!(self.modal, Modal::Create(_)) {
            "create"
        } else if matches!(self.modal, Modal::Clone(_)) {
            "clone"
        } else {
            "open"
        };
        let spin = self.started.elapsed().as_secs_f32();
        // Electron's rule: the recents home once there is anything to list.
        let recents = self.home.recents.clone().filter(|l| !l.is_empty());
        let query = self.home.query.read(cx).value().to_string();
        let shown = recents.as_ref().map(|l| crate::recents::shown(l, &query, self.home.sort)).unwrap_or_default();
        let now = self.started.elapsed();
        // Search or sort can shrink the grid under the keyboard focus.
        let cells = shown.len() + 1;
        if let Some((path, slot)) = &self.home.kb_follow
            && let Some(i) = shown.iter().position(|p| &p.path == path)
        {
            self.home.kb = self.home.kb.map(|_| (i, *slot));
        }
        if let Some((cell, slot)) = self.home.kb {
            let cell = cell.min(cells - 1);
            self.home.kb = Some((cell, slot.min(crate::recents::slots(cell, shown.len()) - 1)));
        }
        let kb = if busy || recents.is_none() { None } else { self.home.kb };
        let row = kb.map(|(cell, _)| cell / crate::recents::COLS);
        if row != self.home.kb_row {
            self.home.kb_row = row;
            if let Some(row) = row
                && self.home.grid_scroll.bounds().size.height > px(0.)
            {
                let view = self.home.grid_scroll.bounds().size.height.as_f32() - GRID_FOOT;
                let cur = -self.home.grid_scroll.offset().y.as_f32();
                let next = crate::recents::reveal_scroll(cur, row, view.max(0.));
                if next != cur {
                    let x = self.home.grid_scroll.offset().x;
                    self.home.grid_scroll.set_offset(point(x, px(-next)));
                }
            }
        }
        let mounted = matches!(self.screen, Screen::Home) && recents.is_some();
        if mounted && self.home.entry_motion.is_none() {
            self.home.entry_motion = Some(shown.iter().enumerate().map(|(i, p)|
                (p.path.clone(), crate::recents::EntryMotion::new(i, now))).collect());
            self.home.start_entry = Some(crate::recents::EntryMotion::new(shown.len(), now));
        } else if !mounted {
            self.home.entry_motion = None;
            self.home.start_entry = None;
        }
        let mut springing = false;
        let start_entry = self.home.start_entry.as_mut().map(|m| {
            let (t, moving) = m.sample(now);
            springing |= moving;
            t
        }).unwrap_or(1.);
        let tile_els: Vec<AnyElement> = if matches!(self.screen, Screen::Home) {
            let els = shown
                .iter()
                .enumerate()
                .map(|(i, p)| {
                    let focus = kb.filter(|(cell, _)| *cell == i).map(|(_, slot)| slot);
                    let row = i / crate::recents::COLS;
                    let top = crate::recents::GRID_TOP + row as f32 * (crate::recents::TILE_H + crate::recents::GAP_Y);
                    let cur = -self.home.grid_scroll.offset().y.as_f32();
                    let view = self.home.grid_scroll.bounds().size.height.as_f32();
                    // Before the first layout the view is 0: treat it as visible.
                    self.home.count_hold = view > 0. && (top + crate::recents::TILE_H < cur || top > cur + view);
                    let (el, moving) = self.home.tile(p, busy, focus, now, &c, cx);
                    self.home.count_hold = false;
                    springing |= moving;
                    el
                })
                .collect();
            // Counts belong to the mounted list, not the filter: a project
            // hidden by search keeps its settled total.
            if let Some(list) = recents.as_ref() {
                self.home.tile_counts.retain(|k, _| list.iter().any(|p| &p.path == k));
            }
            self.home.tile_motion.retain(|k, _| shown.iter().any(|p| &p.path == k));
            els
        } else {
            self.home.tile_counts.clear();
            self.home.tile_motion.clear();
            Vec::new()
        };
        // Frames only while entry, hover or counts are still moving.
        if springing {
            window.request_animation_frame();
        }
        let start_focus = kb.filter(|(cell, _)| *cell == shown.len()).map(|(_, slot)| slot);
        let row = |i: usize, id: &'static str, icon: &'static str, label: &'static str| {
            let loading = busy && id == session;
            let ringed = start_focus == Some(i);
            let slot = slots[i].clone();
            let (x, y) = offsets[i];
            // The pull is measured from where the row rests, so the probe sits
            // on the unmoved wrapper and only the inner row travels.
            div().relative().child(canvas(move |b, _, _| slot.set(Some(b)), |_, _, _, _| {}).absolute().size_full()).child(
            div()
                .id(id)
                .relative()
                .left(px(x))
                .top(px(y))
                .when(id == "open" && !busy, |r| {
                    r.on_click(cx.listener(|this, _, window, cx| this.open_folder(window, cx)))
                })
                .when(id == "create" && !busy, |r| {
                    r.on_click(cx.listener(|this, _, window, cx| this.create_project(window, cx)))
                })
                .when(id == "clone" && !busy, |r| {
                    r.on_click(cx.listener(|this, _, window, cx| this.clone_repo(window, cx)))
                })
                .when(busy && !loading, |r| r.opacity(0.35))
                .flex()
                .items_center()
                .gap(px(14.))
                .rounded(px(14.))
                .py(px(11.))
                .pr(px(12.))
                .pl(px(6.))
                .when(!busy, |r| r.cursor_pointer().hover(|s| s.bg(hsla(c.hover))))
                .when(ringed, |r| r.child(crate::recents::ring(14., 2., c.ink.alpha(0.34))))
                .child(
                    div().w(px(22.)).h(px(18.)).flex().flex_shrink_0().items_center().justify_center().child(if loading {
                        spinner(spin, c.muted.alpha(0.3), c.ink_soft).into_any_element()
                    } else {
                        svg().path(icon).size(px(18.)).text_color(hsla(c.ink)).into_any_element()
                    }),
                )
                .child(
                    div()
                        .text_size(px(14.))
                        .line_height(px(14.))
                        .font_weight(FontWeight::NORMAL)
                        .text_color(hsla(c.ink))
                        .whitespace_nowrap()
                        .child(label),
                ))
        };

        let start_rows = || {
            div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .child(row(0, "create", "icons/plus.svg", "Create a new project"))
                .child(row(1, "open", "icons/folder-open.svg", "Open from local folder"))
                .child(row(2, "clone", "icons/github.svg", "Clone from GitHub"))
        };
        let body = if let Screen::Project(project) = self.screen.clone() {
            div().flex_1().min_h(px(0.)).child(project).into_any_element()
        } else if self.home.recents.is_none() {
            // The list is a small file read; show nothing rather than flash the
            // empty launcher for a frame before it lands.
            div().flex_1().into_any_element()
        } else if recents.is_some() {
            let mut grid = div()
                .flex()
                .flex_wrap()
                .gap_x(px(crate::recents::GAP_X))
                .gap_y(px(crate::recents::GAP_Y))
                .pt(px(8.));
            grid = grid.children(tile_els);
            let start_scale = crate::recents::entry_scale(start_entry);
            grid = grid.child(div().relative().w(px(crate::recents::CELL_W)).h(px(crate::recents::TILE_H))
                .top(px(12. * (1. - start_entry))).opacity(start_entry.clamp(0., 1.))
                .flex().items_center().justify_center().ml(px(-6.))
                .child(div().w(px(crate::recents::CELL_W * start_scale)).h(px(crate::recents::TILE_H * start_scale))
                    .flex().items_center().child(start_rows())));
            let mut section = div()
                .id("recents")
                .track_scroll(&self.home.grid_scroll)
                .relative()
                .flex_1()
                .min_h(px(0.))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .items_center()
                .pt(px(72.))
                .pb(px(GRID_FOOT))
                .child(div().w(px(crate::recents::GRID_W)).child(grid));
            if shown.is_empty() {
                section = section.child(
                    div().w(px(crate::recents::GRID_W)).py(px(24.)).font_family(crate::style::MONO).text_size(px(12.)).text_color(hsla(c.muted))
                        .child(format!("No projects match \u{201c}{}\u{201d}", query.trim())),
                );
            }
            let wrap = div().relative().flex().flex_col().flex_1().min_h(px(0.)).child(section);
            match self.open_error.clone() {
                Some(err) => wrap
                    .child(
                        div().absolute().left_0().right_0().bottom(px(16.)).flex().justify_center()
                            .child(div().px(px(10.)).py(px(4.)).rounded(px(8.)).bg(hsla(c.ground)).text_size(px(12.)).text_color(hsla(c.danger)).child(err)),
                    )
                    .into_any_element(),
                None => wrap.into_any_element(),
            }
        } else {
            let actions = div().relative().flex().flex_1().flex_col().items_center().justify_center().child(
                    start_rows()
                        .with_animation("actions-in", Animation::new(Duration::from_millis(500)).with_easing(glide), |el, d| {
                            el.opacity(d).mt(px(8. * (1. - d) * 2.))
                        }),
                );
            match self.open_error.clone() {
                Some(err) => actions
                    .child(div().absolute().bottom(px(24.)).text_size(px(12.)).text_color(hsla(c.danger)).child(err))
                    .into_any_element(),
                None => actions.into_any_element(),
            }
        };

        let home = matches!(self.screen, Screen::Home) && self.home.recents.as_ref().is_some_and(|l| !l.is_empty());
        let search = div()
            .id("search")
            .flex()
            .items_center()
            .gap(px(10.))
            .h(px(36.))
            .px(px(12.))
            .rounded(px(11.))
            .bg(hsla(c.hover))
            .child(svg().path("icons/search.svg").size(px(15.)).flex_shrink_0().text_color(hsla(c.muted)))
            .child(div().w(px(176.)).text_size(px(13.)).text_color(hsla(c.ink)).child(Input::new(&self.home.query)))
            .child(
                div().px(px(6.)).py(px(2.)).rounded(px(5.)).border_1().border_color(hsla(c.muted.alpha(0.25)))
                    .font_family(crate::style::MONO).text_size(px(10.)).line_height(px(10.)).text_color(hsla(c.muted))
                    .child(if cfg!(target_os = "macos") { "\u{2318}K" } else { "Ctrl K" }),
            );
        let sort = div()
            .id("sort")
            .flex()
            .items_center()
            .gap(px(6.))
            .h(px(36.))
            .px(px(12.))
            .rounded(px(11.))
            .cursor_pointer()
            .text_size(px(13.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(hsla(c.ink_soft))
            .hover(|s| s.bg(hsla(c.hover)))
            .on_click(cx.listener(|this, _, _, cx| {
                this.home.sort = if this.home.sort == Sort::Recent { Sort::Name } else { Sort::Recent };
                this.home.hovered = None;
                cx.notify();
            }))
            .child(if self.home.sort == Sort::Recent { "Recent" } else { "Name" })
            .child(svg().path("icons/arrow-down.svg").size(px(12.)).text_color(hsla(c.muted)));
        let panel = div()
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(px(PANEL_RADIUS))
            .border_1()
            .border_color(hsla(c.line_soft))
            .bg(hsla(c.ground))
            // Presses inside the panel are the page's; only the frame drags.
            // A click on the floor strip tips a letter or kicks a ball for the crowd.
            .on_mouse_down(MouseButton::Left, cx.listener(|this, e: &MouseDownEvent, window, cx| {
                cx.stop_propagation();
                // A press outside any field gives focus back to the page (the
                // root's own focus-on-press never sees it past this listener);
                // a field claiming the press has already prevented default.
                let modal = this.modal.is_open();
                if matches!(this.screen, Screen::Home) && !modal && !window.default_prevented() && !this.focus.is_focused(window) {
                    this.focus.focus(window, cx);
                }
                // A pointer press ends keyboard mode, as :focus-visible does.
                this.home.kb_follow = None;
                if this.home.kb.take().is_some() {
                    cx.notify();
                }
                let busy = this.modal.is_open();
                if this.folk_shown() && this.folk.press(e.position, busy) {
                    cx.notify();
                }
            }))
            .font_family(SANS)
            .on_mouse_move(cx.listener(|this, e: &MouseMoveEvent, _, cx| {
                // Most moves land outside every pull zone; only a changed
                // target needs a frame (the glide itself runs on animation frames).
                let busy = this.modal.is_open();
                let mut moved = false;
                for m in &mut this.magnets {
                    moved |= if busy { m.release() } else { m.track(e.position) };
                }
                if this.folk_shown() {
                    moved |= this.folk.track(e.position, busy);
                } else {
                    // Off the start screen the crowd forgets the pointer, so
                    // it doesn't come back reacting to a stale cursor.
                    this.folk.release();
                    this.folk.strip.set(None);
                }
                if moved {
                    cx.notify();
                }
            }))
            .when(self.folk_shown(), |d| d.child({
                let t = self.started.elapsed().as_secs_f32();
                let look = crate::stickfolk::Look { color: c.accent, alpha: if dark { 0.45 } else { 0.55 } };
                let stir = self.folk.snapshot();
                let strip = self.folk.strip.clone();
                canvas(|_, _, _| (), move |b, _, window, _| {
                    strip.set(Some(b));
                    crate::stickfolk::paint(b, t, stir, &look, window)
                })
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .h(px(crate::stickfolk::STRIP))
            }))
            .when(matches!(self.screen, Screen::Home), |d| d.child(
                div().relative().flex().justify_end().items_center().gap(px(12.)).pt(px(8.)).pr(px(8.)).child(
                    div()
                        .id("settings")
                        .size(px(36.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(11.))
                        .cursor_pointer()
                        .text_color(hsla(c.muted))
                        .hover(|s| s.bg(hsla(c.hover)).text_color(hsla(c.ink)))
                        .when(!busy, |d| d.tooltip(crate::recents::tip("Settings")).tooltip_show_delay(Duration::from_millis(500)))
                        .child(svg().path("icons/settings.svg").size(px(16.)).text_color(hsla(c.muted))),
                ).when(home, |d| d.child(search).child(sort)),
            ))
            .child(body);

        // The frame: a thin band around the panel that moves the window like a
        // titlebar. AppKit claims the outermost pixels for resizing before the
        // view sees them, so the band never swallows a resize.
        let frame = div()
            .size_full()
            .bg(hsla(frame))
            .pt(px(FRAME_TOP))
            .px(px(FRAME))
            .pb(px(FRAME))
            .on_mouse_down(MouseButton::Left, |e, window, _| {
                if e.click_count == 2 {
                    window.zoom_window();
                } else {
                    window.start_window_move();
                }
            })
            .child(panel);

        let home_grid = home && !busy;
        // The folder browser and modals are layers of their own, over the frame and page.
        let mut root = div()
            .relative()
            .size_full()
            .track_focus(&self.focus)
            // Only on the recents home with no modal up: elsewhere Tab stays
            // the kit's focus cycling.
            .when(home_grid, |d| {
                d.key_context("KoneGrid")
                    .on_action(cx.listener(|this, _: &GridNext, window, cx| this.grid_tab(true, window, cx)))
                    .on_action(cx.listener(|this, _: &GridPrev, window, cx| this.grid_tab(false, window, cx)))
            })
            .capture_key_down(cx.listener(|this, e: &KeyDownEvent, window, cx| {
                let busy = this.modal.is_open();
                let home = matches!(this.screen, Screen::Home) && this.home.recents.as_ref().is_some_and(|l| !l.is_empty());
                // Esc in the search field clears it first, then leaves the field.
                if home && !busy && e.keystroke.key == "escape" && this.home.query.read(cx).focus_handle(cx).is_focused(window) {
                    if this.home.query.read(cx).value().is_empty() {
                        this.focus.focus(window, cx);
                    } else {
                        this.home.query.update(cx, |q, cx| q.set_value("", window, cx));
                    }
                    cx.stop_propagation();
                    return;
                }
                // The grid's keys belong to the page itself, never to the
                // search field or a modal that has focus. Caught on the way
                // down so Tab is ours before any focus-cycling binding.
                if home && !busy && this.focus.is_focused(window) && this.grid_key(e, window, cx) {
                    cx.stop_propagation();
                    return;
                }
                // Down from the search field drops into the grid.
                let m = e.keystroke.modifiers;
                if home && !busy && e.keystroke.key == "down" && !m.modified() && this.home.query.read(cx).focus_handle(cx).is_focused(window) {
                    this.focus.focus(window, cx);
                    this.home.kb = Some((0, 0));
                    this.home.kb_follow = None;
                    cx.notify();
                    cx.stop_propagation();
                }
            }))
            .on_key_down(cx.listener(|this, e: &KeyDownEvent, window, cx| {
                let m = e.keystroke.modifiers;
                let busy = this.modal.is_open();
                let home = matches!(this.screen, Screen::Home) && this.home.recents.as_ref().is_some_and(|l| !l.is_empty());
                if home && !busy && (m.platform || m.control) && !m.alt && e.keystroke.key.eq_ignore_ascii_case("k") {
                    this.home.kb = None;
                    this.home.kb_follow = None;
                    this.home.query.update(cx, |q, cx| q.focus(window, cx));
                    cx.stop_propagation();
                }
            }))
            .child(frame);
        root = match self.modal.clone() {
            Modal::None => root,
            Modal::Picker(picker) => root.child(picker),
            Modal::Create(creator) => root.child(creator),
            Modal::Clone(cloner) => root.child(cloner),
        };
        root
    }
}

/// A 15px ring with a lit quarter turning once a second, standing in for an
/// action's icon while it is in session.
pub(crate) fn spinner(t: f32, track: kone_theme::Rgba, lit: kone_theme::Rgba) -> impl IntoElement {
    canvas(|_, _, _| (), move |b, _, window, _| {
        let (cx, cy) = (f32::from(b.center().x), f32::from(b.center().y));
        let (r, w) = (6.625, 1.75);
        let ring = |from: f32, sweep: f32| {
            let mut p = PathBuilder::stroke(px(w));
            let steps = 32;
            for k in 0..=steps {
                let a = from + sweep * k as f32 / steps as f32;
                let pt = point(px(cx + r * a.cos()), px(cy + r * a.sin()));
                if k == 0 { p.move_to(pt) } else { p.line_to(pt) }
            }
            p.build().ok()
        };
        let tau = std::f32::consts::TAU;
        if let Some(p) = ring(0., tau) {
            window.paint_path(p, hsla(track));
        }
        let start = (t % 1.) * tau - tau / 4. - tau / 8.;
        if let Some(p) = ring(start, tau / 4.) {
            window.paint_path(p, hsla(lit));
        }
    })
    .size(px(15.))
}

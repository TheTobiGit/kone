//! The empty launcher: three ways to begin, centred over a drifting loom of threads.

use std::time::{Duration, Instant};

use gpui_kit::prelude::*;
use gpui_kit::*;
use kone_theme::{hsla, Theme};

use gpui_kit::base::input::{Input, InputEvent, InputState};

use crate::magnet::{glide, Magnet};
use crate::recents::{Sort, Tile};

pub const SANS: &str = "Geist";

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

/// The stick folk move in small hand-drawn steps; 8 frames a second reads as
/// a flip book and keeps an idle focused window cheap.
const ART_FRAME: Duration = Duration::from_millis(125);
/// Spinner pace while a launcher modal is open (~30 fps).
const SPIN_FRAME: Duration = Duration::from_millis(33);
/// The crowd reacting to the cursor (~15 fps): smoother than idle, well short
/// of vsync since every frame repaints the whole strip.
const STIR_FRAME: Duration = Duration::from_millis(66);

pub struct Shell {
    magnets: [Magnet; 3],
    folk: crate::stickfolk::Hover,
    started: Instant,
    picker: Option<Entity<crate::folder_picker::FolderPicker>>,
    _picker_sub: Option<Subscription>,
    creator: Option<Entity<crate::create_project::CreateProject>>,
    _creator_sub: Option<Subscription>,
    cloner: Option<Entity<crate::clone_modal::CloneModal>>,
    _cloner_sub: Option<Subscription>,
    create_session: crate::create_project::CreateProjectSession,
    /// Where the last successful clone this session landed.
    clone_location: Option<String>,
    project: Option<crate::projects::OpenProject>,
    open_error: Option<String>,
    _open_task: Option<Task<()>>,
    /// The recent projects, in launcher order; `None` until the first read lands.
    recents: Option<Vec<crate::projects::RecentProject>>,
    pub(crate) tiles: std::collections::HashMap<String, Tile>,
    pub(crate) hovered: Option<String>,
    query: Entity<InputState>,
    sort: Sort,
    focus: FocusHandle,
    _query_sub: Subscription,
    _recents_task: Option<Task<()>>,
    _ticker: Task<()>,
}

impl Shell {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        // Only a focused window animates; a background one holds its last frame.
        // While a launcher modal is up the active row's spinner needs a smoother
        // pace than the art, but still a timer: not a frame on every vsync.
        let ticker = cx.spawn_in(window, async move |this, cx| {
            let mut pace = ART_FRAME;
            let mut was_active = true;
            loop {
                cx.background_executor().timer(pace).await;
                let alive = this.update_in(cx, |this: &mut Self, window, cx| {
                    let active = window.is_window_active();
                    // Coming back to the window: folders may have moved or
                    // changed meanwhile, so re-read the recents and their git.
                    let came_back = active && !was_active;
                    was_active = active;
                    if came_back && this.project.is_none() {
                        this.reload_recents(cx);
                    }
                    if !active {
                        return ART_FRAME;
                    }
                    cx.notify();
                    if this.picker.is_some() || this.creator.is_some() || this.cloner.is_some() {
                        SPIN_FRAME
                    } else if this.folk.active() {
                        STIR_FRAME
                    } else {
                        ART_FRAME
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
                this.hovered = None;
                cx.notify();
            }
        });
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        let mut shell = Shell {
            magnets: Default::default(),
            folk: Default::default(),
            started: Instant::now(),
            picker: None,
            _picker_sub: None,
            creator: None,
            _creator_sub: None,
            cloner: None,
            _cloner_sub: None,
            create_session: Default::default(),
            clone_location: None,
            project: None,
            open_error: None,
            _open_task: None,
            recents: None,
            tiles: Default::default(),
            hovered: None,
            query,
            sort: Sort::Recent,
            focus,
            _query_sub: query_sub,
            _recents_task: None,
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
        self._recents_task = Some(cx.spawn(async move |this, cx| {
            let (list, paths) = task.await;
            let _ = this.update(cx, |this, cx| {
                this.recents = Some(list);
                cx.notify();
            });
            let tiles = cx.background_spawn(async move { crate::recents::read_tiles(&paths) }).await;
            let _ = this.update(cx, |this, cx| {
                this.tiles = tiles;
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
        if self.picker.is_some() || self.creator.is_some() || self.cloner.is_some() {
            return;
        }
        for m in &mut self.magnets {
            m.release();
        }
        self.folk.release();
        self.open_error = None;
        let picker = cx.new(|cx| crate::folder_picker::FolderPicker::new(window, cx));
        picker.update(cx, |picker, cx| picker.start(window, cx));
        self._picker_sub = Some(cx.subscribe_in(
            &picker,
            window,
            |this, _, event: &crate::folder_picker::FolderPickerEvent, window, cx| {
                if let crate::folder_picker::FolderPickerEvent::Picked(path) = event {
                    this.open_project(path.clone(), window, cx);
                }
                this.picker = None;
                this.focus.focus(window, cx);
                cx.notify();
            },
        ));
        self.picker = Some(picker);
        cx.notify();
    }
}

impl Shell {
    /// Opens the create card; a created project opens like a picked folder.
    fn create_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.picker.is_some() || self.creator.is_some() || self.cloner.is_some() {
            return;
        }
        for m in &mut self.magnets {
            m.release();
        }
        self.folk.release();
        self.open_error = None;
        let creator = cx.new(|cx| crate::create_project::CreateProject::new(&self.create_session, window, cx));
        creator.update(cx, |c, cx| c.start(window, cx));
        self._creator_sub = Some(cx.subscribe_in(
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
                this.creator = None;
                this.focus.focus(window, cx);
                cx.notify();
            },
        ));
        self.creator = Some(creator);
        cx.notify();
    }

    /// Opens the clone card; a cloned project opens like a picked folder.
    fn clone_repo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.picker.is_some() || self.creator.is_some() || self.cloner.is_some() {
            return;
        }
        for m in &mut self.magnets {
            m.release();
        }
        self.folk.release();
        self.open_error = None;
        let cloner = cx.new(|cx| crate::clone_modal::CloneModal::new(self.clone_location.clone(), window, cx));
        cloner.update(cx, |c, _| c.start());
        self._cloner_sub = Some(cx.subscribe_in(
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
                this.cloner = None;
                this.focus.focus(window, cx);
                cx.notify();
            },
        ));
        self.cloner = Some(cloner);
        cx.notify();
    }

    /// Validates and records the folder off the UI thread, then shows it.
    pub(crate) fn open_project(&mut self, path: std::path::PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        self.open_error = None;
        let task = cx.background_spawn(async move { crate::projects::open(&path) });
        self._open_task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            let _ = this.update_in(cx, |this, window, cx| {
                match result {
                    Ok(project) => {
                        this.hovered = None;
                        this.query.update(cx, |q, cx| q.set_value("", window, cx));
                        this.project = Some(project);
                    }
                    Err(message) => this.open_error = Some(message),
                }
                cx.notify();
            });
        }));
    }

    fn close_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.project = None;
        self.focus.focus(window, cx);
        self.reload_recents(cx);
        cx.notify();
    }

    fn project_view(&self, project: &crate::projects::OpenProject, c: &kone_theme::Palette, cx: &mut Context<Self>) -> Div {
        use kone_rpc::Branch;
        let branch = match &project.branch {
            Some(Branch::Named(name)) => name.clone(),
            Some(Branch::Detached(sha)) => format!("detached at {sha}"),
            Some(Branch::Unknown) => "unknown branch".into(),
            None => "not a git repository".into(),
        };
        let changes = if project.branch.is_none() {
            None
        } else if project.added == 0 && project.removed == 0 {
            Some("No uncommitted changes".to_string())
        } else {
            Some(format!("+{} −{} uncommitted", project.added, project.removed))
        };
        div()
            .relative()
            .flex()
            .flex_1()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(10.))
            .child(div().text_size(px(22.)).font_weight(FontWeight::MEDIUM).text_color(hsla(c.ink)).child(project.name.clone()))
            .child(div().text_size(px(13.)).text_color(hsla(c.muted)).child(project.path.to_string_lossy().into_owned()))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .text_size(px(13.))
                    .text_color(hsla(c.ink_soft))
                    .child(svg().path("icons/folder-open.svg").size(px(14.)).text_color(hsla(c.ink_soft)))
                    .child(branch),
            )
            .when_some(changes, |d, text| d.child(div().text_size(px(12.)).text_color(hsla(c.muted)).child(text)))
            .child(
                div()
                    .id("back")
                    .mt(px(18.))
                    .px(px(14.))
                    .py(px(8.))
                    .rounded(px(10.))
                    .cursor_pointer()
                    .text_size(px(13.))
                    .text_color(hsla(c.ink))
                    .border_1()
                    .border_color(hsla(c.line_soft))
                    .hover(|s| s.bg(hsla(c.hover)))
                    .on_click(cx.listener(|this, _, window, cx| this.close_project(window, cx)))
                    .child("Back to start"),
            )
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
        let busy = self.picker.is_some() || self.creator.is_some() || self.cloner.is_some();
        let session = if self.creator.is_some() {
            "create"
        } else if self.cloner.is_some() {
            "clone"
        } else {
            "open"
        };
        let spin = self.started.elapsed().as_secs_f32();
        // Electron's rule: the recents home once there is anything to list.
        let recents = self.recents.clone().filter(|l| !l.is_empty());
        let query = self.query.read(cx).value().to_string();
        let shown = recents.as_ref().map(|l| crate::recents::shown(l, &query, self.sort)).unwrap_or_default();
        let tile_els: Vec<AnyElement> = if self.project.is_none() {
            shown.iter().map(|p| self.tile(p, busy, &c, cx)).collect()
        } else {
            Vec::new()
        };
        let row = |i: usize, id: &'static str, icon: &'static str, label: &'static str| {
            let loading = busy && id == session;
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
        let body = if let Some(project) = self.project.clone() {
            self.project_view(&project, &c, cx).into_any_element()
        } else if self.recents.is_none() {
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
            grid = grid.child(div().w(px(crate::recents::CELL_W)).h(px(116.)).flex().items_center().ml(px(-6.)).child(start_rows()));
            let mut section = div()
                .id("recents")
                .relative()
                .flex_1()
                .min_h(px(0.))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .items_center()
                .pt(px(72.))
                .pb(px(crate::stickfolk::STRIP + 16.))
                .child(div().w(px(crate::recents::GRID_W)).child(grid));
            if shown.is_empty() {
                section = section.child(
                    div().w(px(crate::recents::GRID_W)).py(px(24.)).font_family(crate::folder_picker::MONO).text_size(px(12.)).text_color(hsla(c.muted))
                        .child(format!("No projects match \u{201c}{}\u{201d}", query.trim())),
                );
            }
            let wrap = div().relative().flex().flex_col().flex_1().min_h(px(0.)).child(section);
            match self.open_error.clone() {
                Some(err) => wrap
                    .child(
                        div().absolute().left_0().right_0().bottom(px(crate::stickfolk::STRIP + 4.)).flex().justify_center()
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

        let home = self.project.is_none() && self.recents.as_ref().is_some_and(|l| !l.is_empty());
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
            .child(div().w(px(176.)).text_size(px(13.)).text_color(hsla(c.ink)).child(Input::new(&self.query)))
            .child(
                div().px(px(6.)).py(px(2.)).rounded(px(5.)).border_1().border_color(hsla(c.muted.alpha(0.25)))
                    .font_family(crate::folder_picker::MONO).text_size(px(10.)).line_height(px(10.)).text_color(hsla(c.muted))
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
                this.sort = if this.sort == Sort::Recent { Sort::Name } else { Sort::Recent };
                this.hovered = None;
                cx.notify();
            }))
            .child(if self.sort == Sort::Recent { "Recent" } else { "Name" })
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
            .on_mouse_down(MouseButton::Left, cx.listener(|this, e: &MouseDownEvent, _, cx| {
                cx.stop_propagation();
                let busy = this.picker.is_some() || this.creator.is_some() || this.cloner.is_some();
                if this.folk.press(e.position, busy) {
                    cx.notify();
                }
            }))
            .font_family(SANS)
            .on_mouse_move(cx.listener(|this, e: &MouseMoveEvent, _, cx| {
                // Most moves land outside every pull zone; only a changed
                // target needs a frame (the glide itself runs on animation frames).
                let busy = this.picker.is_some() || this.creator.is_some() || this.cloner.is_some();
                let mut moved = false;
                for m in &mut this.magnets {
                    moved |= if busy { m.release() } else { m.track(e.position) };
                }
                moved |= this.folk.track(e.position, busy);
                if moved {
                    cx.notify();
                }
            }))
            .child({
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
            })
            .child(
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
                        .child(svg().path("icons/settings.svg").size(px(16.)).text_color(hsla(c.muted))),
                ).when(home, |d| d.child(search).child(sort)),
            )
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

        // The folder browser and modals are layers of their own, over the frame and page.
        let mut root = div()
            .relative()
            .size_full()
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(|this, e: &KeyDownEvent, window, cx| {
                let busy = this.picker.is_some() || this.creator.is_some() || this.cloner.is_some();
                let home = this.project.is_none() && this.recents.as_ref().is_some_and(|l| !l.is_empty());
                // Esc in the search field clears it first, then leaves the field.
                if home && !busy && e.keystroke.key == "escape" && this.query.read(cx).focus_handle(cx).is_focused(window) {
                    if this.query.read(cx).value().is_empty() {
                        this.focus.focus(window, cx);
                    } else {
                        this.query.update(cx, |q, cx| q.set_value("", window, cx));
                    }
                    cx.stop_propagation();
                }
            }))
            .on_key_down(cx.listener(|this, e: &KeyDownEvent, window, cx| {
                let m = e.keystroke.modifiers;
                let busy = this.picker.is_some() || this.creator.is_some() || this.cloner.is_some();
                let home = this.project.is_none() && this.recents.as_ref().is_some_and(|l| !l.is_empty());
                if home && !busy && (m.platform || m.control) && !m.alt && e.keystroke.key.eq_ignore_ascii_case("k") {
                    this.query.update(cx, |q, cx| q.focus(window, cx));
                    cx.stop_propagation();
                }
            }))
            .child(frame);
        if let Some(picker) = self.picker.clone() {
            root = root.child(picker);
        }
        if let Some(creator) = self.creator.clone() {
            root = root.child(creator);
        }
        if let Some(cloner) = self.cloner.clone() {
            root = root.child(cloner);
        }
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

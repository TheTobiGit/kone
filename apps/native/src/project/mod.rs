//! Project screen. Its lifetime owns cancellation of background git
//! operations; weak async updates cannot land in a later project's screen.
mod branch_picker;
mod changes;
mod chrome;
mod cycle;
mod detail;
mod folder;
mod keyboard;
mod model;
mod overview;
mod peek;
mod preferences;
mod switcher;
use preferences::{identity, load_folds, save_folds};

use gpui_kit::prelude::*;
use gpui_kit::*;
use kone_theme::{Theme, hsla};
use model::{FileEntry, Lane, OverviewModel};
use std::{collections::HashSet, sync::Arc, time::Duration};

actions!(kone_project, [ProjectNext, ProjectPrev]);
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("tab", ProjectNext, Some("KoneProject")),
        KeyBinding::new("shift-tab", ProjectPrev, Some("KoneProject")),
    ]);
}

#[derive(Clone)]
pub enum ProjectAction {
    Open(std::path::PathBuf),
    Create,
    OpenFolder,
    Clone,
    Profile,
}
impl EventEmitter<ProjectAction> for ProjectView {}

pub struct Back;
impl EventEmitter<Back> for ProjectView {}

pub struct ProjectView {
    pub(super) name: String,
    pub(super) path: String,
    pub(super) identity: String,
    pub(super) model: Option<OverviewModel>,
    branch_picker: Option<branch_picker::BranchPicker>,
    pub(super) loading: bool,
    pub(super) error: Option<String>,
    pub(super) folded: [bool; 2],
    pub(super) selected: Option<String>,
    focus: FocusHandle,
    git: Arc<dyn crate::git_service::GitService>,
    cancel: Arc<std::sync::atomic::AtomicBool>,
    _load: Option<Task<()>>,
    fold_save: Option<Task<()>>,
    _watch: Task<()>,
    generation: u64,
    peek: bool,
    peek_active: bool,
    peek_motion: gpui_ce_motion::MotionValue,
    peek_progress: f32,
    started: std::time::Instant,
    peek_scroll: ScrollHandle,
    peek_items: std::collections::HashMap<String, usize>,
    content_width: f32,
    overview_scroll: ScrollHandle,
    card_bounds: std::rc::Rc<std::cell::RefCell<std::collections::HashMap<String, Bounds<Pixels>>>>,
    collapsed: HashSet<String>,
    detail: Option<DetailState>,
    _detail_task: Option<Task<()>>,
    detail_generation: u64,
    opener: Option<String>,
    detail_control: usize,
    hovered: Option<String>,
    card_motion: std::collections::HashMap<String, (gpui_ce_motion::MotionValue, bool)>,
    card_lifts: std::collections::HashMap<String, f32>,
    folder_hover: bool,
    chrome_back: crate::magnet::Magnet,
    chrome_back_hover: bool,
    chrome_back_value: gpui_ce_motion::MotionValue,
    chrome_back_target: bool,
    focus_visible: bool,
    folder_motion: folder::FolderMotion,
    switcher: switcher::Switcher,
    _switcher_load: Option<Task<()>>,
    _activation: Subscription,
}
struct DetailState {
    entry: FileEntry,
    data: Option<crate::git_service::FileDetail>,
    error: Option<String>,
    source: bool,
    wrap: bool,
    scroll: ScrollHandle,
}

impl ProjectView {
    pub fn new(
        project: crate::projects::OpenProject,
        git: Arc<dyn crate::git_service::GitService>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _watch = cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(5)).await;
                let request = this.update_in(cx, |this: &mut Self, window, cx| {
                    if this.switcher.open && !this.switcher.suspended && window.is_window_active() {
                        this.load_switch_projects(cx);
                    }
                    (!this.loading
                        && !this.branch_picker.as_ref().is_some_and(|p| p.creating)
                        && window.is_window_active())
                    .then(|| {
                        (
                            this.git.clone(),
                            this.path.clone(),
                            this.cancel.clone(),
                            this.generation,
                        )
                    })
                });
                let Ok(request) = request else {
                    break;
                };
                let Some((git, path, cancel, generation)) = request else {
                    continue;
                };
                let result = cx
                    .background_spawn(
                        async move { git.snapshot(std::path::Path::new(&path), &cancel) },
                    )
                    .await;
                let _ = this.update(cx, |this, cx| {
                    if this.generation != generation || this.loading {
                        return;
                    }
                    match result {
                        Ok(snapshot) => {
                            let recovered = this.error.take().is_some();
                            this.apply_snapshot(snapshot, cx);
                            if recovered {
                                cx.notify();
                            }
                        }
                        Err(error) => {
                            if this.error.as_ref() != Some(&error) {
                                this.error = Some(error);
                                cx.notify();
                            }
                        }
                    }
                });
            }
        });
        let activation = cx.observe_window_activation(window, |this, window, cx| {
            if !window.is_window_active() {
                this.switcher.pending_cycle.clear();
                if this.switcher.cycle.take().is_some() {
                    cx.notify();
                }
            }
        });
        let mut view = Self {
            switcher: Default::default(),
            _switcher_load: None,
            _activation: activation,
            name: project.name,
            path: project.path.to_string_lossy().into_owned(),
            identity: identity(),
            model: None,
            branch_picker: None,
            loading: true,
            error: None,
            folded: [false; 2],
            selected: Some("back".into()),
            focus,
            git,
            cancel,
            _load: None,
            fold_save: None,
            _watch,
            generation: 0,
            peek: false,
            peek_active: false,
            peek_motion: gpui_ce_motion::MotionValue::new(0.),
            peek_progress: 0.,
            started: std::time::Instant::now(),
            peek_scroll: ScrollHandle::new(),
            peek_items: Default::default(),
            content_width: 896.,
            overview_scroll: ScrollHandle::new(),
            card_bounds: Default::default(),
            collapsed: HashSet::new(),
            detail: None,
            _detail_task: None,
            detail_generation: 0,
            opener: None,
            detail_control: 0,
            hovered: None,
            card_motion: Default::default(),
            card_lifts: Default::default(),
            folder_hover: false,
            chrome_back: Default::default(),
            chrome_back_hover: false,
            chrome_back_value: gpui_ce_motion::MotionValue::new(0.),
            chrome_back_target: false,
            focus_visible: false,
            folder_motion: folder::FolderMotion::default(),
        };
        view.refresh(cx);
        view.load_switch_projects(cx);
        view
    }
    pub(super) fn track_bounds(&self, key: String) -> AnyElement {
        let bounds = self.card_bounds.clone();
        canvas(
            move |rect, _, _| {
                bounds.borrow_mut().insert(key.clone(), rect);
            },
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0()
        .into_any_element()
    }
    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        let git = self.git.clone();
        let cancel = self.cancel.clone();
        let path = self.path.clone();
        self.loading = true;
        self.error = None;
        let initial = self.model.is_none();
        let task = cx.background_spawn(async move {
            let folded = initial.then(|| load_folds(&path));
            (git.snapshot(std::path::Path::new(&path), &cancel), folded)
        });
        self._load = Some(cx.spawn(async move |this, cx| {
            let (result, folded) = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                if let Some(folded) = folded {
                    this.folded = folded;
                }
                this.loading = false;
                match result {
                    Ok(snapshot) => this.apply_snapshot(snapshot, cx),
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    fn apply_snapshot(
        &mut self,
        snapshot: Option<crate::git_service::GitSnapshot>,
        cx: &mut Context<Self>,
    ) {
        if self.model.as_ref().map(|m| &m.snapshot) == snapshot.as_ref() {
            return;
        }
        self.model = snapshot.map(OverviewModel::from);
        if let Some(detail) = &self.detail {
            let survives = self.model.as_ref().is_some_and(|m| {
                m.entries(detail.entry.lane)
                    .iter()
                    .any(|e| e.key() == detail.entry.key())
            });
            if !survives {
                self.detail = None;
                self.detail_generation += 1;
            } else {
                let entry = detail.entry.clone();
                self.load_detail(entry, cx);
            }
        }
        cx.notify();
    }
    pub(super) fn toggle_lane(&mut self, lane: Lane, cx: &mut Context<Self>) {
        self.selected = Some(format!("lane-{lane:?}"));
        let i = usize::from(lane == Lane::Changed);
        self.folded[i] = !self.folded[i];
        let path = self.path.clone();
        let folded = self.folded;
        // Preserve toggle order even when background workers start out of
        // order. A mutex inside save_folds protects the file, not event order.
        let previous = self.fold_save.take();
        self.fold_save = Some(cx.background_spawn(async move {
            if let Some(previous) = previous {
                previous.await;
            }
            save_folds(&path, folded);
        }));
        cx.notify();
    }
    pub(super) fn reveal(&self, cx: &mut Context<Self>) {
        let path = self.path.clone();
        cx.background_spawn(async move { crate::projects::reveal(std::path::Path::new(&path)) })
            .detach();
    }
    pub(super) fn open_peek(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.opener = Some("peek".into());
        self.peek = true;
        self.selected = self.entries().first().map(FileEntry::key);
        self.focus.focus(window, cx);
        cx.notify();
    }
    pub(super) fn open_file(
        &mut self,
        entry: FileEntry,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.detail_control = 0;
        self.opener = Some(entry.key());
        self.selected = Some(entry.key());
        self.peek = false;
        self.focus.focus(window, cx);
        self.load_detail(entry, cx);
    }
    fn load_detail(&mut self, entry: FileEntry, cx: &mut Context<Self>) {
        self.detail_generation += 1;
        let generation = self.detail_generation;
        let git = self.git.clone();
        let cancel = self.cancel.clone();
        let path = self.path.clone();
        let file = entry.change.path.clone();
        let staged = entry.staged();
        let previous = self.detail.take().filter(|d| d.entry.key() == entry.key());
        let (source, wrap, scroll, data) = previous
            .map(|d| (d.source, d.wrap, d.scroll, d.data))
            .unwrap_or_else(|| (false, false, ScrollHandle::new(), None));
        self.detail = Some(DetailState {
            entry,
            data,
            error: None,
            source,
            wrap,
            scroll,
        });
        let task = cx.background_spawn(async move {
            git.detail(std::path::Path::new(&path), &file, staged, &cancel)
        });
        self._detail_task = Some(cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.detail_generation != generation {
                    return;
                }
                if let Some(detail) = &mut this.detail {
                    match result {
                        Ok(data) => detail.data = Some(data),
                        Err(e) => detail.error = Some(e),
                    }
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.detail.take().is_some() {
            self.detail_generation += 1;
            self._detail_task = None;
        } else {
            self.peek = false;
        }
        self.selected = self.opener.take();
        if !self.peek
            && self.selected.as_ref().is_some_and(|key| {
                key != "back" && key != "peek" && !self.entries().iter().any(|e| e.key() == *key)
            })
        {
            self.selected = Some("peek".into());
        }
        self.focus.focus(window, cx);
        cx.notify();
    }
}
impl Render for ProjectView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = Theme::get(cx).colors.clone();
        let now = self.started.elapsed();
        if self.peek_active != self.peek {
            self.peek_active = self.peek;
            self.peek_motion.animate(
                if self.peek { 1. } else { 0. },
                gpui_ce_motion::Transition::Spring(
                    gpui_ce_motion::Spring::new(520., 26., 0.8).expect("valid drawer spring"),
                ),
                now,
            );
        }
        let motion = self.peek_motion.sample(now, cx.reduce_motion());
        self.peek_progress = (motion.value() as f32).clamp(0., 1.);
        if motion.is_animating() {
            window.request_animation_frame();
        }
        let peek_layer = self.peek || motion.is_animating();
        // Layout bounds only describe the current frame; motion state only
        // belongs to visible cards. Removed/renamed paths must not accumulate
        // for the entire lifetime of a project.
        self.card_bounds.borrow_mut().clear();
        self.card_lifts.clear();
        let entries = self.entries();
        let keys: HashSet<_> = entries.iter().map(FileEntry::key).collect();
        self.card_motion.retain(|key, _| keys.contains(key));
        for entry in entries {
            let key = entry.key();
            let active = !self.peek
                && self.detail.is_none()
                && (self.hovered.as_ref() == Some(&key) || self.selected.as_ref() == Some(&key));
            let (value, was_active) = self
                .card_motion
                .entry(key.clone())
                .or_insert_with(|| (gpui_ce_motion::MotionValue::new(0.), false));
            if active != *was_active {
                *was_active = active;
                value.animate(
                    if active { 1. } else { 0. },
                    gpui_ce_motion::Transition::Tween(
                        Duration::from_millis(440),
                        gpui_ce_motion::Easing::Bezier(
                            gpui_ce_motion::Bezier::new(0.22, 1., 0.36, 1.)
                                .expect("valid card curve"),
                        ),
                    ),
                    now,
                );
            }
            let sample = value.sample(now, cx.reduce_motion());
            self.card_lifts.insert(key, sample.value() as f32);
            if sample.is_animating() {
                window.request_animation_frame();
            }
        }
        let (added, removed) = self.model.as_ref().map_or((0, 0), |m| (m.added, m.removed));
        let folder_hover = self.folder_hover && !self.peek && self.detail.is_none();
        self.folder_motion
            .sample(folder_hover, added, removed, now, window, cx);
        div()
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .id("project-view")
            .track_focus(&self.focus)
            .key_context("KoneProject")
            .on_action(cx.listener(|this, _: &ProjectNext, window, cx| {
                this.focus_visible = true;
                if this.branch_picker.is_some() {
                    cx.stop_propagation();
                } else {
                    this.cycle_focus(false, window, cx)
                }
            }))
            .on_action(cx.listener(|this, _: &ProjectPrev, window, cx| {
                this.focus_visible = true;
                if this.branch_picker.is_some() {
                    cx.stop_propagation();
                } else {
                    this.cycle_focus(true, window, cx)
                }
            }))
            .on_mouse_move(cx.listener(|this, e: &MouseMoveEvent, _, cx| {
                if this.detail.is_none() && this.chrome_back.track(e.position) {
                    cx.notify();
                }
            }))
            .on_hover(cx.listener(|this, over: &bool, _, cx| {
                if !*over && this.chrome_back.release() {
                    cx.notify();
                }
            }))
            .capture_key_down(cx.listener(Self::key))
            .on_modifiers_changed(cx.listener(|this, e: &ModifiersChangedEvent, window, cx| {
                if !e.modifiers.control {
                    this.commit_cycle(window, cx);
                }
            }))
            .child({
                let bounds = self.switcher.root_bounds.clone();
                canvas(move |b, _, _| bounds.set(Some(b)), |_, _, _, _| {})
                    .absolute()
                    .size_full()
            })
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.focus_visible = false;
                    this.focus.focus(window, cx);
                }),
            )
            .child(self.render_chrome(&c, window, cx))
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h(px(0.))
                    .left(px(-402. * self.peek_progress))
                    .child(self.render_overview(window, cx)),
            )
            .when(self.error.is_some(), |d| {
                d.child(
                    div()
                        .absolute()
                        .bottom(px(18.))
                        .left(px(64.))
                        .flex()
                        .gap(px(12.))
                        .text_size(px(13.))
                        .text_color(hsla(c.danger))
                        .child(self.error.clone().unwrap_or_default())
                        .child(
                            div()
                                .id("project-refresh")
                                .cursor_pointer()
                                .on_click(cx.listener(|this, _, _, cx| this.refresh(cx)))
                                .child("Refresh"),
                        ),
                )
            })
            .when(peek_layer, |d| d.child(self.render_peek(&c, cx)))
            .when(self.detail.is_some(), |d| {
                d.child(self.render_detail(&c, cx))
            })
            .when(self.switcher.open, |d| {
                d.child(self.render_switcher(&c, window, cx))
            })
            .when(self.switcher.cycle.is_some(), |d| {
                d.child(self.render_cycle(&c, window, cx))
            })
            .when(self.branch_picker.is_some(), |d| {
                d.child(self.render_branch_picker(&c, window, cx))
            })
    }
}

impl Drop for ProjectView {
    fn drop(&mut self) {
        if let Some(save) = self.fold_save.take() {
            save.detach();
        }
        self.cancel
            .store(true, std::sync::atomic::Ordering::Release);
    }
}

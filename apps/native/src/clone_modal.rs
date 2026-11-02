//! \"Clone from GitHub\": the folder picker and project creator's sibling modal.
//!
//! Paste a GitHub repository reference (owner/repo, https URL, or git SSH),
//! choose where it lands, and clone. Mirrors Electron's `GitHubCloneModal.vue`
//! and `useGitClone.ts`.

use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

use gpui_ce_motion::MotionValue;
use gpui_kit::base::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::*;
use gpui_kit::*;
use kone_theme::{hsla, Palette, Theme};

use crate::clone::{parse_repo_ref, CloneCanceller, CloneUpdate};
use crate::folder_picker::{
    bezier, card_enter_tween, card_fade_tween, collapse, expand, home_dir, input_style,
    paint_footer_band, paint_header_band, sample_hover, scrim_enter_tween, BAND_ARC, BAND_GAP,
    CARD_RISE, CARD_WIDTH, ENTER, EXIT, FOOTER_H, HEADER_H, MONO,
};
use crate::shell::SANS;

#[derive(Debug, Clone)]
pub enum CloneModalEvent {
    Cancel,
    Cloned(PathBuf),
}

impl EventEmitter<CloneModalEvent> for CloneModal {}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    In,
    Out,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ClonePhase {
    Idle,
    Cloning,
    Done,
    Error,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Repo,
    Location,
}

pub struct CloneModal {
    focus: FocusHandle,
    home: PathBuf,
    repo: Entity<InputState>,
    location: Entity<InputState>,
    phase: Phase,
    clone_phase: ClonePhase,
    busy: bool,
    progress: f32,
    stage: String,
    error: Option<String>,
    target_path: Option<PathBuf>,
    target_name: Option<String>,
    canceller: Option<CloneCanceller>,
    clone_hovered: bool,
    clone_hover: MotionValue,
    clone_hovering: bool,
    started: Instant,
    enter_scrim: MotionValue,
    enter_y: MotionValue,
    enter_fade: MotionValue,
    exit_at: Option<Instant>,
    closing: bool,
    outcome: Option<CloneModalEvent>,
    _task: Option<Task<()>>,
    _subs: Vec<Subscription>,
}

impl CloneModal {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let colors = Theme::get(cx).colors.clone();
        let home = home_dir();
        let make = |value: String, placeholder: &'static str, window: &mut Window, cx: &mut Context<Self>| {
            let state = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder).default_value(value));
            state.update(cx, |s, _| s.set_editor_style(input_style(&colors, false)));
            state
        };
        let repo = make(String::new(), "owner/repo or https://github.com/…", window, cx);
        let location = make(collapse(&home, &home), "~/", window, cx);

        let mut subs = Vec::new();
        for (state, field) in [(&repo, Field::Repo), (&location, Field::Location)] {
            subs.push(cx.subscribe_in(state, window, move |this, _, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { .. } => this.submit(window, cx),
                InputEvent::Focus => this.ink(field, true, cx),
                InputEvent::Blur => this.ink(field, false, cx),
                InputEvent::Change => {
                    if this.error.take().is_some() {
                        cx.notify();
                    }
                }
            }));
        }

        let first = repo.clone();
        window.defer(cx, move |window, cx| first.read(cx).focus_handle(cx).focus(window, cx));

        Self {
            focus: cx.focus_handle(),
            home,
            repo,
            location,
            phase: Phase::In,
            clone_phase: ClonePhase::Idle,
            busy: false,
            progress: 0.0,
            stage: String::new(),
            error: None,
            target_path: None,
            target_name: None,
            canceller: None,
            clone_hovered: false,
            clone_hover: MotionValue::new(0.),
            clone_hovering: false,
            started: Instant::now(),
            enter_scrim: MotionValue::new(0.),
            enter_y: MotionValue::new(CARD_RISE as f64),
            enter_fade: MotionValue::new(0.),
            exit_at: None,
            closing: false,
            outcome: None,
            _task: None,
            _subs: subs,
        }
    }

    pub fn start(&mut self) {
        let now = self.started.elapsed();
        self.enter_scrim.animate(1., scrim_enter_tween(), now);
        self.enter_y.animate(0., card_enter_tween(), now);
        self.enter_fade.animate(1., card_fade_tween(), now);
    }

    fn input(&self, field: Field) -> &Entity<InputState> {
        match field {
            Field::Repo => &self.repo,
            Field::Location => &self.location,
        }
    }

    fn ink(&mut self, field: Field, focused: bool, cx: &mut Context<Self>) {
        let colors = Theme::get(cx).colors.clone();
        self.input(field).clone().update(cx, |s, cx| {
            s.set_editor_style(input_style(&colors, focused));
            cx.notify();
        });
    }

    fn repo_text(&self, cx: &App) -> String {
        self.repo.read(cx).value().trim().to_string()
    }

    fn parent(&self, cx: &App) -> PathBuf {
        expand(&self.home, &self.location.read(cx).value())
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.closing || self.clone_phase == ClonePhase::Done {
            return;
        }

        let repo = match parse_repo_ref(&self.repo_text(cx)) {
            Some(r) => r,
            None => {
                self.error = Some("Enter a valid GitHub repository.".into());
                cx.notify();
                return;
            }
        };

        let parent = self.parent(cx);
        match std::fs::metadata(&parent) {
            Ok(m) if m.is_dir() => {}
            Ok(_) => {
                self.error = Some("The location is a file, not a folder.".into());
                cx.notify();
                return;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.error = Some("The location doesn't exist.".into());
                cx.notify();
                return;
            }
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                self.error = Some("You don't have permission to use that location.".into());
                cx.notify();
                return;
            }
            Err(e) => {
                self.error = Some(format!("Couldn't read the location: {e}"));
                cx.notify();
                return;
            }
        }

        let dest = parent.join(&repo.name);
        if dest.exists() {
            self.error = Some(format!("A folder already exists at {}", dest.display()));
            cx.notify();
            return;
        }

        self.clone_phase = ClonePhase::Cloning;
        self.busy = true;
        self.error = None;
        self.progress = 0.0;
        self.stage = "Connecting to github.com…".to_string();
        self.target_path = Some(dest.clone());
        self.target_name = Some(repo.name.clone());

        let canceller = CloneCanceller::new();
        self.canceller = Some(canceller.clone());
        cx.notify();

        let (tx, rx) = std::sync::mpsc::channel();
        let url = repo.url;
        let dest_clone = dest.clone();

        std::thread::spawn(move || {
            crate::clone::run_clone(url, dest_clone, canceller, tx);
        });

        self._task = Some(cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(20)).await;
                let mut done_msg = None;
                let mut latest_progress = None;

                while let Ok(msg) = rx.try_recv() {
                    match msg {
                        CloneUpdate::Progress(p) => latest_progress = Some(p),
                        other => {
                            done_msg = Some(other);
                            break;
                        }
                    }
                }

                let updated = this.update_in(cx, |this, window, cx| {
                    if let Some(p) = latest_progress
                        && this.clone_phase == ClonePhase::Cloning
                    {
                        this.progress = p.progress;
                        this.stage = p.stage;
                        cx.notify();
                    }
                    if let Some(msg) = done_msg {
                        match msg {
                            CloneUpdate::Done(path) => {
                                this.clone_phase = ClonePhase::Done;
                                this.progress = 1.0;
                                this.stage = "Done".to_string();
                                this.busy = false;
                                cx.notify();
                                cx.spawn_in(window, async move |this, cx| {
                                    cx.background_executor().timer(Duration::from_millis(420)).await;
                                    let _ = this.update_in(cx, |this, window, cx| {
                                        this.close_to(CloneModalEvent::Cloned(path), window, cx);
                                    });
                                })
                                .detach();
                            }
                            CloneUpdate::Error(err) => {
                                this.clone_phase = ClonePhase::Error;
                                this.busy = false;
                                this.error = Some(err);
                                cx.notify();
                            }
                            CloneUpdate::Cancelled => {
                                this.clone_phase = ClonePhase::Idle;
                                this.busy = false;
                                cx.notify();
                            }
                            CloneUpdate::Progress(_) => {}
                        }
                        return false;
                    }
                    true
                });

                if !updated.unwrap_or(false) {
                    break;
                }
            }
        }));
    }

    fn cancel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.clone_phase == ClonePhase::Done || self.closing {
            return;
        }
        if self.busy
            && let Some(c) = &self.canceller
        {
            c.cancel();
        }
        self.close_to(CloneModalEvent::Cancel, window, cx);
    }

    fn close_to(&mut self, event: CloneModalEvent, window: &mut Window, cx: &mut Context<Self>) {
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

    fn tab(&mut self, back: bool, window: &mut Window, cx: &mut Context<Self>) {
        let ring = [Field::Repo, Field::Location];
        let at = ring
            .iter()
            .position(|f| self.input(*f).read(cx).focus_handle(cx).is_focused(window))
            .unwrap_or(0);
        let next = if back { (at + ring.len() - 1) % ring.len() } else { (at + 1) % ring.len() };
        self.input(ring[next]).read(cx).focus_handle(cx).focus(window, cx);
    }

    fn motion(&mut self, now: Duration) -> (f32, f32, f32, bool) {
        match self.phase {
            Phase::In => {
                let scrim = self.enter_scrim.sample(now, false).value() as f32;
                let fade = self.enter_fade.sample(now, false).value() as f32;
                let y = self.enter_y.sample(now, false).value() as f32;
                (scrim.clamp(0., 1.), fade.clamp(0., 1.), y, now < ENTER)
            }
            Phase::Out => {
                let at = self.exit_at.unwrap_or_else(Instant::now);
                let t = (at.elapsed().as_secs_f32() / EXIT.as_secs_f32()).min(1.);
                let e = bezier(0.4, 0.0, 1.0, 1.0, t);
                (1. - e, 1. - e, CARD_RISE * e, t < 1.)
            }
        }
    }
}

impl Drop for CloneModal {
    fn drop(&mut self) {
        if self.busy
            && let Some(c) = &self.canceller
        {
            c.cancel();
        }
    }
}

fn label(text: &'static str, c: &Palette) -> Div {
    div().text_size(px(12.)).text_color(hsla(c.muted)).child(text)
}

fn repo_field(input: &Entity<InputState>, focused: bool, c: &Palette) -> Div {
    div()
        .h(px(32.))
        .px(px(10.))
        .flex()
        .items_center()
        .gap(px(8.))
        .rounded(px(9.))
        .border_1()
        .border_color(hsla(if focused { c.ink.alpha(0.22) } else { c.line_soft }))
        .bg(hsla(c.band.alpha(0.5)))
        .child(
            svg()
                .path("icons/github.svg")
                .size(px(16.))
                .text_color(hsla(if focused { c.ink_soft } else { c.muted })),
        )
        .child(
            div()
                .flex_1()
                .min_w(px(0.))
                .font_family(MONO)
                .text_size(px(12.))
                .text_color(hsla(if focused { c.ink } else { c.ink_soft }))
                .child(Input::new(input)),
        )
}

fn location_field(input: &Entity<InputState>, focused: bool, c: &Palette) -> Div {
    div()
        .h(px(32.))
        .px(px(10.))
        .flex()
        .items_center()
        .gap(px(8.))
        .rounded(px(9.))
        .border_1()
        .border_color(hsla(if focused { c.ink.alpha(0.22) } else { c.line_soft }))
        .bg(hsla(c.band.alpha(0.5)))
        .child(
            svg()
                .path("icons/folder.svg")
                .size(px(15.))
                .text_color(hsla(if focused { c.ink_soft } else { c.muted })),
        )
        .child(
            div()
                .flex_1()
                .min_w(px(0.))
                .font_family(MONO)
                .text_size(px(12.))
                .text_color(hsla(if focused { c.ink } else { c.ink_soft }))
                .child(Input::new(input)),
        )
}

impl Render for CloneModal {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = Theme::get(cx).colors.clone();
        let now = self.started.elapsed();
        let (scrim, opacity, card_y, moving) = self.motion(now);
        let (hover, hover_moving) =
            sample_hover(&mut self.clone_hover, &mut self.clone_hovering, self.clone_hovered, now);

        if moving || hover_moving || self.busy {
            window.request_animation_frame();
        }

        let focused = |f: &Entity<InputState>, window: &Window, cx: &App| f.read(cx).focus_handle(cx).is_focused(window);
        let (fr, fl) = (
            focused(&self.repo, window, cx),
            focused(&self.location, window, cx),
        );

        let repo_raw = self.repo_text(cx);
        let parsed = parse_repo_ref(&repo_raw);
        let can_clone = parsed.is_some() && !self.busy && self.clone_phase != ClonePhase::Done;

        let header = div()
            .relative()
            .h(px(HEADER_H))
            .mb(px(BAND_GAP))
            .flex_shrink_0()
            .child(
                canvas(|_, _, _| (), move |b, _, window, _| paint_header_band(b, hsla(c.band), window))
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
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(14.))
                            .text_color(hsla(c.ink))
                            .child("Clone from GitHub"),
                    )
                    .child(
                        div()
                            .w(px(15.))
                            .h(px(15.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(if self.busy {
                                crate::shell::spinner(now.as_secs_f32(), c.muted.alpha(0.3), c.ink_soft).into_any_element()
                            } else {
                                div().into_any_element()
                            }),
                    )
                    .child(
                        div()
                            .id("clone-modal-cancel")
                            .cursor_pointer()
                            .text_size(px(14.))
                            .text_color(hsla(c.muted))
                            .when(self.clone_phase == ClonePhase::Done, |d| d.opacity(0.4).cursor_default())
                            .when(self.clone_phase != ClonePhase::Done, |d| d.hover(|s| s.opacity(0.7)))
                            .on_click(cx.listener(|this, _, window, cx| this.cancel(window, cx)))
                            .child("Cancel"),
                    ),
            );

        let body = if self.clone_phase == ClonePhase::Cloning || self.clone_phase == ClonePhase::Done {
            let percent = (self.progress * 100.0).round() as u32;
            let target_display = match &self.target_path {
                Some(p) => collapse(&self.home, p),
                None => String::new(),
            };
            let repo_name = self.target_name.clone().unwrap_or_default();

            div()
                .px(px(16.))
                .py(px(6.))
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(
                    div()
                        .flex()
                        .items_baseline()
                        .gap(px(8.))
                        .min_w(px(0.))
                        .child(
                            div()
                                .text_size(px(14.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(hsla(c.ink))
                                .child(repo_name),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w(px(0.))
                                .truncate()
                                .text_size(px(11.5))
                                .font_family(MONO)
                                .text_color(hsla(c.muted))
                                .child(format!("→ {target_display}")),
                        ),
                )
                .child(
                    div()
                        .w_full()
                        .h(px(4.))
                        .rounded(px(2.))
                        .bg(hsla(c.ink.alpha(0.08)))
                        .overflow_hidden()
                        .child(
                            div()
                                .h_full()
                                .rounded(px(2.))
                                .bg(hsla(c.accent))
                                .w(relative(self.progress.clamp(0.0, 1.0))),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .font_family(MONO)
                        .text_size(px(11.5))
                        .child(
                            div()
                                .text_color(hsla(c.ink_soft))
                                .child(if self.clone_phase == ClonePhase::Done {
                                    "Done".to_string()
                                } else {
                                    self.stage.clone()
                                }),
                        )
                        .child(
                            div()
                                .text_color(hsla(c.muted))
                                .child(format!("{percent}%")),
                        ),
                )
        } else {
            let target_hint = match &parsed {
                Some(r) => {
                    let parent = expand(&self.home, &self.location.read(cx).value());
                    let dest = parent.join(&r.name);
                    format!("Clones to {}", collapse(&self.home, &dest))
                }
                None => "Enter a repository to see where it lands".to_string(),
            };

            let mut b = div()
                .px(px(16.))
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(label("Repository", &c))
                .child(repo_field(&self.repo, fr, &c))
                .child(
                    div()
                        .text_size(px(11.5))
                        .font_family(MONO)
                        .truncate()
                        .child(match &parsed {
                            Some(r) => div()
                                .flex()
                                .items_center()
                                .child(div().text_color(hsla(c.muted)).child(format!("{}/", r.owner)))
                                .child(
                                    div()
                                        .text_color(hsla(c.ink))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(r.name.clone()),
                                )
                                .into_any_element(),
                            None if !repo_raw.is_empty() => div()
                                .text_color(hsla(c.muted))
                                .child("That doesn’t look like a GitHub repository")
                                .into_any_element(),
                            None => div()
                                .text_color(hsla(c.muted))
                                .child("GitHub repository — owner/repo or a URL")
                                .into_any_element(),
                        }),
                )
                .child(div().h(px(4.)))
                .child(label("Clone into", &c))
                .child(location_field(&self.location, fl, &c))
                .child(
                    div()
                        .text_size(px(11.5))
                        .font_family(MONO)
                        .text_color(hsla(c.muted))
                        .truncate()
                        .child(target_hint),
                );

            if let Some(err) = &self.error {
                b = b.child(
                    div()
                        .pt(px(6.))
                        .text_size(px(12.))
                        .font_family(MONO)
                        .text_color(hsla(c.danger))
                        .child(err.clone()),
                );
            }
            b
        };

        let footer_action = if self.clone_phase == ClonePhase::Cloning || self.clone_phase == ClonePhase::Done {
            div().into_any_element()
        } else {
            let repo_name = parsed.as_ref().map(|r| r.name.clone());
            div()
                .id("clone-modal-go")
                .flex()
                .items_center()
                .gap(px(4.))
                .min_w(px(0.))
                .cursor_pointer()
                .opacity(if can_clone { 1. - 0.15 * hover } else { 0.4 })
                .when(!can_clone, |d| d.cursor_default())
                .on_hover(cx.listener(|this, h: &bool, _, cx| {
                    this.clone_hovered = *h;
                    cx.notify();
                }))
                .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx)))
                .child(
                    div()
                        .flex_shrink_0()
                        .text_size(px(14.))
                        .text_color(hsla(c.ink))
                        .child("Clone "),
                )
                .when_some(repo_name, |d, name| {
                    d.child(
                        div()
                            .min_w(px(0.))
                            .truncate()
                            .text_size(px(14.))
                            .text_color(hsla(c.ink_soft))
                            .child(format!("\u{201c}{name}\u{201d}")),
                    )
                })
                .child(
                    div()
                        .relative()
                        .left(px(3. * hover))
                        .flex_shrink_0()
                        .text_size(px(14.))
                        .text_color(hsla(c.accent))
                        .child("→"),
                )
                .into_any_element()
        };

        let footer = div()
            .relative()
            .h(px(FOOTER_H))
            .mt(px(BAND_GAP))
            .flex_shrink_0()
            .child(
                canvas(|_, _, _| (), move |b, _, window, _| paint_footer_band(b, hsla(c.band), window))
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
                    .child(footer_action),
            );

        let card = div()
            .id("clone-modal-card")
            .relative()
            .top(px(card_y))
            .w_full()
            .max_w(px(CARD_WIDTH))
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(px(18.))
            .bg(hsla(c.panel))
            .border_1()
            .border_color(hsla(c.ink.alpha(0.08)))
            .opacity(opacity)
            .font_family(SANS)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(header)
            .child(body)
            .child(footer);

        div()
            .absolute()
            .inset_0()
            .flex()
            .justify_end()
            .items_end()
            .p(px(24.))
            .bg(hsla(c.ground.alpha(0.62 * scrim)))
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(|this, e: &KeyDownEvent, window, cx| {
                match e.keystroke.key.as_str() {
                    "tab" => {
                        this.tab(e.keystroke.modifiers.shift, window, cx);
                        cx.stop_propagation();
                    }
                    "escape" => {
                        this.cancel(window, cx);
                        cx.stop_propagation();
                    }
                    _ => {}
                }
            }))
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| this.cancel(window, cx)))
            .child(card)
    }
}

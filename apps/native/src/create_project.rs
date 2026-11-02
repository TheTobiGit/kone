//! "Create a new project": the folder picker's sibling card. Name the project,
//! choose where it lives, and optionally turn it into a git repo. The work is
//! `projects::create`, run off the UI thread; it mirrors Electron's
//! `CreateProjectModal.vue` + `git/create.ts`.

use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

use gpui_ce_motion::MotionValue;
use gpui_kit::base::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::*;
use gpui_kit::*;
use kone_theme::{hsla, Palette, Theme};

use crate::folder_picker::{
    bezier, card_enter_tween, card_fade_tween, collapse, expand, home_dir, input_style,
    paint_footer_band, paint_header_band, sample_hover, scrim_enter_tween, BAND_ARC, BAND_GAP,
    CARD_RISE, CARD_WIDTH, ENTER, EXIT, FOOTER_H, HEADER_H, MONO,
};
use crate::projects::{self, CreateOptions};
use crate::shell::SANS;

#[derive(Debug)]
pub enum CreateProjectEvent {
    Cancel,
    Created(PathBuf),
}

impl EventEmitter<CreateProjectEvent> for CreateProject {}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    In,
    Out,
}

#[derive(Clone, Copy, PartialEq)]
enum Field {
    Name,
    Location,
    Branch,
}

pub struct CreateProject {
    focus: FocusHandle,
    home: PathBuf,
    name: Entity<InputState>,
    location: Entity<InputState>,
    branch: Entity<InputState>,
    git: bool,
    readme: bool,
    busy: bool,
    error: Option<String>,
    create_hovered: bool,
    create_hover: MotionValue,
    create_hovering: bool,
    phase: Phase,
    started: Instant,
    enter_scrim: MotionValue,
    enter_y: MotionValue,
    enter_fade: MotionValue,
    exit_at: Option<Instant>,
    closing: bool,
    outcome: Option<CreateProjectEvent>,
    _task: Option<Task<()>>,
    _subs: Vec<Subscription>,
}

impl CreateProject {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let colors = Theme::get(cx).colors.clone();
        let home = home_dir();
        // Electron seeds the location to the home directory itself.
        let make = |value: String, placeholder: &'static str, window: &mut Window, cx: &mut Context<Self>| {
            let state = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder).default_value(value));
            state.update(cx, |s, _| s.set_editor_style(input_style(&colors, false)));
            state
        };
        let name = make(String::new(), "my-project", window, cx);
        let location = make(collapse(&home, &home), "~/", window, cx);
        let branch = make("main".into(), "main", window, cx);
        let mut subs = Vec::new();
        for (state, field) in [(&name, Field::Name), (&location, Field::Location), (&branch, Field::Branch)] {
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
        let first = name.clone();
        window.defer(cx, move |window, cx| first.read(cx).focus_handle(cx).focus(window, cx));
        Self {
            focus: cx.focus_handle(),
            home,
            name,
            location,
            branch,
            git: false,
            readme: false,
            busy: false,
            error: None,
            create_hovered: false,
            create_hover: MotionValue::new(0.),
            create_hovering: false,
            phase: Phase::In,
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
            Field::Name => &self.name,
            Field::Location => &self.location,
            Field::Branch => &self.branch,
        }
    }

    fn ink(&mut self, field: Field, focused: bool, cx: &mut Context<Self>) {
        let colors = Theme::get(cx).colors.clone();
        self.input(field).clone().update(cx, |s, cx| {
            s.set_editor_style(input_style(&colors, focused));
            cx.notify();
        });
    }

    fn name_text(&self, cx: &App) -> String {
        self.name.read(cx).value().trim().to_string()
    }

    fn parent(&self, cx: &App) -> PathBuf {
        expand(&self.home, &self.location.read(cx).value())
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.closing {
            return;
        }
        let name = self.name_text(cx);
        if name.is_empty() {
            self.error = Some("Give the project a name.".into());
            cx.notify();
            return;
        }
        if !projects::valid_name(&name) {
            self.error = Some(format!("\u{201c}{name}\u{201d} isn't a valid folder name."));
            cx.notify();
            return;
        }
        let opts = CreateOptions {
            parent: self.parent(cx),
            name,
            git: self.git,
            readme: self.git && self.readme,
            branch: self.branch.read(cx).value().to_string(),
        };
        self.busy = true;
        self.error = None;
        cx.notify();
        let task = cx.background_spawn(async move { projects::create(&opts) });
        self._task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.busy = false;
                match result {
                    Ok(path) => this.close_to(CreateProjectEvent::Created(path), window, cx),
                    Err(message) => this.error = Some(message),
                }
                cx.notify();
            });
        }));
    }

    fn cancel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.busy {
            self.close_to(CreateProjectEvent::Cancel, window, cx);
        }
    }

    fn close_to(&mut self, event: CreateProjectEvent, window: &mut Window, cx: &mut Context<Self>) {
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

    /// Tab walks name → location → branch (when git is on) and back round.
    fn tab(&mut self, back: bool, window: &mut Window, cx: &mut Context<Self>) {
        let mut ring = vec![Field::Name, Field::Location];
        if self.git {
            ring.push(Field::Branch);
        }
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

fn label(text: &'static str, c: &Palette) -> Div {
    div().text_size(px(12.)).text_color(hsla(c.muted)).child(text)
}

fn field(input: &Entity<InputState>, mono: bool, focused: bool, c: &Palette) -> Div {
    div()
        .h(px(32.))
        .px(px(10.))
        .flex()
        .items_center()
        .rounded(px(9.))
        .border_1()
        .border_color(hsla(if focused { c.ink.alpha(0.22) } else { c.line_soft }))
        .bg(hsla(c.band.alpha(0.5)))
        .when(mono, |d| d.font_family(MONO).text_size(px(12.)))
        .when(!mono, |d| d.text_size(px(14.)))
        .text_color(hsla(if focused { c.ink } else { c.ink_soft }))
        .child(Input::new(input))
}

/// A small pill switch, kone's `ToggleSwitch`.
fn switch(on: bool, c: &Palette) -> Div {
    div()
        .w(px(28.))
        .h(px(16.))
        .flex_shrink_0()
        .rounded(px(8.))
        .bg(hsla(if on { c.accent } else { c.line_soft }))
        .relative()
        .child(
            div()
                .absolute()
                .top(px(2.))
                .left(px(if on { 14. } else { 2. }))
                .size(px(12.))
                .rounded(px(6.))
                .bg(hsla(c.panel)),
        )
}

impl Render for CreateProject {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = Theme::get(cx).colors.clone();
        let now = self.started.elapsed();
        let (scrim, opacity, card_y, moving) = self.motion(now);
        let (hover, hover_moving) =
            sample_hover(&mut self.create_hover, &mut self.create_hovering, self.create_hovered, now);
        if moving || hover_moving || self.busy {
            window.request_animation_frame();
        }
        let focused = |f: &Entity<InputState>, window: &Window, cx: &App| f.read(cx).focus_handle(cx).is_focused(window);
        let (fn_, fl, fb) = (
            focused(&self.name, window, cx),
            focused(&self.location, window, cx),
            focused(&self.branch, window, cx),
        );
        let name = self.name_text(cx);
        let can_create = projects::valid_name(&name) && !self.busy;
        let target = if name.is_empty() {
            None
        } else {
            Some(collapse(&self.home, &self.parent(cx).join(&name)))
        };

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
                    .child(div().flex_1().text_size(px(14.)).text_color(hsla(c.ink)).child("Create a new project"))
                    .child(div().w(px(15.)).h(px(15.)).flex().items_center().justify_center().child(if self.busy {
                        crate::shell::spinner(now.as_secs_f32(), c.muted.alpha(0.3), c.ink_soft).into_any_element()
                    } else {
                        div().into_any_element()
                    }))
                    .child(
                        div()
                            .id("create-project-cancel")
                            .cursor_pointer()
                            .text_size(px(14.))
                            .text_color(hsla(c.muted))
                            .hover(|s| s.opacity(0.7))
                            .on_click(cx.listener(|this, _, window, cx| this.cancel(window, cx)))
                            .child("Cancel"),
                    ),
            );

        let git_row = div()
            .id("create-project-git")
            .flex()
            .items_center()
            .gap(px(10.))
            .cursor_pointer()
            .on_click(cx.listener(|this, _, _, cx| {
                if !this.busy {
                    this.git = !this.git;
                    cx.notify();
                }
            }))
            .child(switch(self.git, &c))
            .child(div().text_size(px(13.)).text_color(hsla(c.ink)).child("Initialize a git repository"));

        let mut body = div()
            .px(px(16.))
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(label("Name", &c))
            .child(field(&self.name, false, fn_, &c))
            .child(div().h(px(6.)))
            .child(label("Location", &c))
            .child(field(&self.location, true, fl, &c))
            .child(
                div()
                    .text_size(px(11.5))
                    .font_family(MONO)
                    .text_color(hsla(c.muted))
                    .truncate()
                    .child(match &target {
                        Some(t) => format!("Creates {t}"),
                        None => "Name the project to see where it goes".into(),
                    }),
            )
            .child(div().h(px(8.)))
            .child(git_row);
        if self.git {
            body = body
                .child(
                    div()
                        .id("create-project-readme")
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .cursor_pointer()
                        .on_click(cx.listener(|this, _, _, cx| {
                            if !this.busy {
                                this.readme = !this.readme;
                                cx.notify();
                            }
                        }))
                        .child(switch(self.readme, &c))
                        .child(div().text_size(px(13.)).text_color(hsla(c.ink)).child("Add a README")),
                )
                .child(div().h(px(4.)))
                .child(label("Default branch", &c))
                .child(field(&self.branch, true, fb, &c));
        }
        if let Some(err) = &self.error {
            body = body.child(div().pt(px(6.)).text_size(px(12.)).text_color(hsla(c.danger)).child(err.clone()));
        }

        let create = div()
            .id("create-project-go")
            .flex()
            .items_center()
            .gap(px(4.))
            .min_w(px(0.))
            .cursor_pointer()
            .opacity(if can_create { 1. - 0.15 * hover } else { 0.4 })
            .when(!can_create, |d| d.cursor_default())
            .on_hover(cx.listener(|this, h: &bool, _, cx| {
                this.create_hovered = *h;
                cx.notify();
            }))
            .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx)))
            .child(div().flex_shrink_0().text_size(px(14.)).text_color(hsla(c.ink)).child(if self.busy {
                "Creating "
            } else {
                "Create "
            }))
            .when(!name.is_empty(), |d| {
                d.child(div().min_w(px(0.)).truncate().text_size(px(14.)).text_color(hsla(c.ink_soft)).child(format!("\u{201c}{name}\u{201d}")))
            })
            .child(
                div()
                    .relative()
                    .left(px(3. * hover))
                    .flex_shrink_0()
                    .text_size(px(14.))
                    .text_color(hsla(c.accent))
                    .child("→"),
            );

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
            .child(div().relative().h_full().px(px(16.)).flex().items_center().justify_end().child(create));

        let card = div()
            .id("create-project-card")
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

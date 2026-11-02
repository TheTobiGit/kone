//! The empty launcher: three ways to begin, centred over a drifting loom of threads.

use std::{cell::Cell, rc::Rc, time::{Duration, Instant}};

use gpui_kit::prelude::*;
use gpui_kit::*;
use kone_theme::{Theme, hsla};

pub const SANS: &str = "Geist";

/// `cubic-bezier(0.22, 1, 0.36, 1)`: a quick start that glides to rest.
fn glide(t: f32) -> f32 {
    let (x1, y1, x2, y2) = (0.22f32, 1f32, 0.36f32, 1f32);
    let bez = |a: f32, b: f32, s: f32| 3. * a * s * (1. - s).powi(2) + 3. * b * s * s * (1. - s) + s.powi(3);
    let (mut lo, mut hi) = (0f32, 1f32);
    for _ in 0..24 {
        let mid = (lo + hi) / 2.;
        if bez(x1, x2, mid) < t { lo = mid } else { hi = mid }
    }
    bez(y1, y2, (lo + hi) / 2.)
}

/// How far outside a row the cursor starts to pull it, and how weakly: the
/// row moves a ninth of the cursor's distance from its centre.
const MAGNET_PADDING: f32 = 12.;
const MAGNET_STRENGTH: f32 = 9.;
const PULL_IN: Duration = Duration::from_millis(350);
const LET_GO: Duration = Duration::from_millis(600);

/// One row's lean toward the cursor, eased like a CSS transform transition:
/// a new target restarts the glide from wherever the row is now.
#[derive(Default)]
struct Magnet {
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    from: (f32, f32),
    to: (f32, f32),
    since: Option<Instant>,
    active: bool,
}

impl Magnet {
    fn duration(&self) -> Duration {
        if self.active { PULL_IN } else { LET_GO }
    }

    fn progress(&self) -> f32 {
        self.since.map_or(1., |t| (t.elapsed().as_secs_f32() / self.duration().as_secs_f32()).min(1.))
    }

    fn offset(&self) -> (f32, f32) {
        let e = glide(self.progress());
        (self.from.0 + (self.to.0 - self.from.0) * e, self.from.1 + (self.to.1 - self.from.1) * e)
    }

    fn track(&mut self, cursor: Point<Pixels>) {
        let Some(b) = self.bounds.get() else { return };
        let (w, h) = (f32::from(b.size.width), f32::from(b.size.height));
        let (cx, cy) = (f32::from(b.origin.x) + w / 2., f32::from(b.origin.y) + h / 2.);
        let (dx, dy) = (f32::from(cursor.x) - cx, f32::from(cursor.y) - cy);
        let near = dx.abs() < w / 2. + MAGNET_PADDING && dy.abs() < h / 2. + MAGNET_PADDING;
        let to = if near { (dx / MAGNET_STRENGTH, dy / MAGNET_STRENGTH) } else { (0., 0.) };
        if to != self.to {
            self.from = self.offset();
            self.to = to;
            self.active = near;
            self.since = Some(Instant::now());
        }
    }

    fn settling(&self) -> bool {
        self.progress() < 1.
    }
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

/// The threads move a few pixels a second, so 15 frames read as smooth.
const ART_FRAME: Duration = Duration::from_millis(66);

pub struct Shell {
    magnets: [Magnet; 3],
    started: Instant,
    picker: Option<Entity<crate::folder_picker::FolderPicker>>,
    _picker_sub: Option<Subscription>,
    _ticker: Task<()>,
}

impl Shell {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        // Only a focused window animates; a background one holds its last frame.
        let ticker = cx.spawn_in(window, async move |this, cx| loop {
            cx.background_executor().timer(ART_FRAME).await;
            let alive = this.update_in(cx, |_, window, cx| {
                if window.is_window_active() {
                    cx.notify();
                }
            });
            if alive.is_err() {
                return;
            }
        });
        Shell {
            magnets: Default::default(),
            started: Instant::now(),
            picker: None,
            _picker_sub: None,
            _ticker: ticker,
        }
    }

    /// Opens kone's own folder browser, not the system path panel.
    fn open_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.picker.is_some() {
            return;
        }
        let picker = cx.new(|cx| crate::folder_picker::FolderPicker::new(window, cx));
        self._picker_sub = Some(cx.subscribe_in(
            &picker,
            window,
            |this, _, event: &crate::folder_picker::FolderPickerEvent, _, cx| {
                if let crate::folder_picker::FolderPickerEvent::Picked(path) = event {
                    eprintln!("open: {}", path.display());
                }
                this.picker = None;
                cx.notify();
            },
        ));
        self.picker = Some(picker);
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
        let row = |i: usize, id: &'static str, icon: &'static str, label: &'static str| {
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
                .when(id == "open", |r| {
                    r.on_click(cx.listener(|this, _, window, cx| this.open_folder(window, cx)))
                })
                .flex()
                .items_center()
                .gap(px(14.))
                .rounded(px(14.))
                .py(px(11.))
                .pr(px(12.))
                .pl(px(6.))
                .cursor_pointer()
                .hover(|s| s.bg(hsla(c.hover)))
                .child(div().w(px(22.)).flex().flex_shrink_0().justify_center().child(svg().path(icon).size(px(18.)).text_color(hsla(c.ink))))
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
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .font_family(SANS)
            .on_mouse_move(cx.listener(|this, e: &MouseMoveEvent, _, cx| {
                for m in &mut this.magnets {
                    m.track(e.position);
                }
                cx.notify();
            }))
            .child({
                let t = self.started.elapsed().as_secs_f32();
                let look = crate::strands::Look { color: c.accent, alpha: if dark { 0.30 } else { 0.38 } };
                canvas(|_, _, _| (), move |b, _, window, _| crate::strands::paint(b, t, &look, window))
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .h(relative(0.5))
            })
            .child(
                div().relative().flex().justify_end().pt(px(8.)).pr(px(8.)).child(
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
                ),
            )
            .child(
                div().relative().flex().flex_1().flex_col().items_center().justify_center().child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(row(0, "create", "icons/plus.svg", "Create a new project"))
                        .child(row(1, "open", "icons/folder-open.svg", "Open from local folder"))
                        .child(row(2, "clone", "icons/github.svg", "Clone from GitHub"))
                        .with_animation("actions-in", Animation::new(Duration::from_millis(500)).with_easing(glide), |el, d| {
                            el.opacity(d).mt(px(8. * (1. - d) * 2.))
                        }),
                ),
            );

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

        // The folder browser is a layer of its own, over the frame and page.
        let mut root = div().relative().size_full().child(frame);
        if let Some(picker) = self.picker.clone() {
            root = root.child(picker);
        }
        root
    }
}

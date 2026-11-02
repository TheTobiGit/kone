//! The empty launcher: three ways to begin, centred over a drifting loom of threads.

use std::time::{Duration, Instant};

use gpui_kit::prelude::*;
use gpui_kit::*;
use kone_theme::{Theme, hsla};

use crate::magnet::{glide, Magnet};

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

/// The threads drift ~5px a second, so 10 frames (half-pixel steps) read as smooth.
const ART_FRAME: Duration = Duration::from_millis(100);

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
        for m in &mut self.magnets {
            m.release();
        }
        let picker = cx.new(|cx| crate::folder_picker::FolderPicker::new(window, cx));
        picker.update(cx, |picker, cx| picker.start(window, cx));
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
        // While the picker is up the launcher is in session: the open row
        // spins, the others dim, and none of them answer the pointer.
        let busy = self.picker.is_some();
        if busy {
            window.request_animation_frame();
        }
        let spin = self.started.elapsed().as_secs_f32();
        let row = |i: usize, id: &'static str, icon: &'static str, label: &'static str| {
            let loading = busy && id == "open";
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
                // Most moves land outside every pull zone; only a changed
                // target needs a frame (the glide itself runs on animation frames).
                let busy = this.picker.is_some();
                let mut moved = false;
                for m in &mut this.magnets {
                    moved |= if busy { m.release() } else { m.track(e.position) };
                }
                if moved {
                    cx.notify();
                }
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

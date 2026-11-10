use super::start_motion as motion;
use crate::launcher::LauncherMode;
use crate::{
    state::{AppState, StartActionsState},
    theme::Palette,
};
use rune::{
    Cursor, Curve, Cx, Easing, El, Family, Icon, LoopSpec, TextStyle, Transition, col, el, icon,
    row, text,
};

const EASE: Easing = Easing::cubic(0.22, 1.0, 0.36, 1.0);
/// Tailwind's `transition-colors` default.
const COLORS_EASE: Easing = Easing::cubic(0.4, 0.0, 0.2, 1.0);
/// Lands a per-frame value at once: the poll clock already eased it.
const NOW: Curve = Curve::tween(0.0001, Easing::cubic(0.0, 0.0, 1.0, 1.0));

/// Electron loads Geist and Fraunces at weight 400 only (`@nuxt/fonts`) and sets
/// `font-synthesis: none`, so every weight it asks for paints as Regular.
const REGULAR: f32 = 400.0;

static SPINNER_BASE: Icon = Icon {
    name: "start-spinner-base",
    view: 24.0,
    body: r#"<circle cx="12" cy="12" r="10.6" fill="none" stroke="currentColor" stroke-width="2.8"/>"#,
};
static SPINNER_TOP: Icon = Icon {
    name: "start-spinner-top",
    view: 24.0,
    body: r#"<path d="M4.5047 4.5047A10.6 10.6 0 0 1 19.4953 4.5047" fill="none" stroke="currentColor" stroke-width="2.8"/>"#,
};

pub(super) static SETTINGS: Icon = Icon {
    name: "settings",
    view: 24.0,
    body: r#"<path d="M15.5 12C15.5 13.933 13.933 15.5 12 15.5C10.067 15.5 8.5 13.933 8.5 12C8.5 10.067 10.067 8.5 12 8.5C13.933 8.5 15.5 10.067 15.5 12Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M21.011 14.0965C21.5329 13.9558 21.7939 13.8854 21.8969 13.7508C22 13.6163 22 13.3998 22 12.9669V11.0332C22 10.6003 22 10.3838 21.8969 10.2493C21.7938 10.1147 21.5329 10.0443 21.011 9.90358C19.0606 9.37759 17.8399 7.33851 18.3433 5.40087C18.4817 4.86799 18.5509 4.60156 18.4848 4.44529C18.4187 4.28902 18.2291 4.18134 17.8497 3.96596L16.125 2.98673C15.7528 2.77539 15.5667 2.66972 15.3997 2.69222C15.2326 2.71472 15.0442 2.90273 14.6672 3.27873C13.208 4.73448 10.7936 4.73442 9.33434 3.27864C8.95743 2.90263 8.76898 2.71463 8.60193 2.69212C8.43489 2.66962 8.24877 2.77529 7.87653 2.98663L6.15184 3.96587C5.77253 4.18123 5.58287 4.28891 5.51678 4.44515C5.45068 4.6014 5.51987 4.86787 5.65825 5.4008C6.16137 7.3385 4.93972 9.37763 2.98902 9.9036C2.46712 10.0443 2.20617 10.1147 2.10308 10.2492C2 10.3838 2 10.6003 2 11.0332V12.9669C2 13.3998 2 13.6163 2.10308 13.7508C2.20615 13.8854 2.46711 13.9558 2.98902 14.0965C4.9394 14.6225 6.16008 16.6616 5.65672 18.5992C5.51829 19.1321 5.44907 19.3985 5.51516 19.5548C5.58126 19.7111 5.77092 19.8188 6.15025 20.0341L7.87495 21.0134C8.24721 21.2247 8.43334 21.3304 8.6004 21.3079C8.76746 21.2854 8.95588 21.0973 9.33271 20.7213C10.7927 19.2644 13.2088 19.2643 14.6689 20.7212C15.0457 21.0973 15.2341 21.2853 15.4012 21.3078C15.5682 21.3303 15.7544 21.2246 16.1266 21.0133L17.8513 20.034C18.2307 19.8187 18.4204 19.711 18.4864 19.5547C18.5525 19.3984 18.4833 19.132 18.3448 18.5991C17.8412 16.6616 19.0609 14.6226 21.011 14.0965Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
pub(super) static SEARCH: Icon = Icon {
    name: "search",
    view: 24.0,
    body: r#"<path d="M17 17L21 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11C3 15.4183 6.58172 19 11 19C15.4183 19 19 15.4183 19 11Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
pub(super) static BACK: Icon = Icon {
    name: "back",
    view: 24.0,
    body: r#"<path d="M11 6H15.5C17.9853 6 20 8.01472 20 10.5C20 12.9853 17.9853 15 15.5 15H4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.99998 12C6.99998 12 4.00001 14.2095 4 15C3.99999 15.7906 7 18 7 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

/// A start time on the poll clock a handler set before it could read the clock;
/// the next poll stamps it.
const PENDING: f64 = f64::INFINITY;

/// Seconds `s`'s poll clock has run since `at`.
fn since(s: &StartActionsState, at: Option<f64>) -> Option<f32> {
    at.map(|at| {
        if at == PENDING {
            0.0
        } else {
            (s.clock - at) as f32
        }
    })
}

fn fraunces() -> TextStyle {
    TextStyle::new(15.0, REGULAR)
        .lh(17.25)
        .family(Family::Named("Fraunces"))
}

/// The static `make it kone.` mark other pages show.
pub(super) fn wordmark(t: Palette) -> El {
    row()
        .center_y()
        .gap(4.2)
        .child(text("make it").font(fraunces()).color(t.ink))
        .child(text("kone.").font(fraunces()).color(t.accent))
}

/// `HomeRotatingWordmark`: `make it` and a word that builds the brand up letter
/// by letter, each letter springing up out of a clip and away above it.
fn rotating_wordmark(t: Palette, s: &StartActionsState) -> El {
    let elapsed = since(s, s.word_at);
    let (shown, phase) = match (elapsed, s.prev_word) {
        (Some(e), Some(prev)) if e < motion::exit_span(motion::word(prev).0.len()) => {
            (prev, Some((e, false)))
        }
        (Some(e), Some(prev)) => (
            s.word,
            Some((e - motion::exit_span(motion::word(prev).0.len()), true)),
        ),
        (Some(e), None) => (s.word, Some((e, true))),
        // Before the screen's first poll (live) every letter waits below the clip.
        (None, _) if s.live => (s.word, Some((0.0, true))),
        (None, _) => (s.word, None),
    };
    let (word, accent, _) = motion::word(shown);
    let mut letters = row()
        .key(format!("wordmark-word-{shown}"))
        .transition(Transition::none());
    for (i, ch) in word.chars().enumerate() {
        let (y, opacity) = phase.map_or((0.0, 1.0), |(e, entering)| {
            motion::letter(e - i as f32 * motion::STAGGER, entering)
        });
        letters = letters.child(
            text(ch.to_string())
                .font(fraunces())
                .color(if i < accent { t.accent } else { t.ink })
                .transition(Transition::none())
                .offset(0.0, y * 17.25)
                .offset_motion(NOW)
                .opacity(opacity)
                .opacity_motion(NOW),
        );
    }
    row()
        .center_y()
        .gap(4.2)
        .child(text("make it").font(fraunces()).color(t.ink))
        .child(el().h(17.25).clip_rounded(0.0).child(letters))
}

/// `SettingsButton`: a 36 pt muted gear that washes and inks on hover.
pub(super) fn settings_button(t: Palette) -> El {
    let fade = Curve::tween(0.15, COLORS_EASE);
    el().key("settings-button")
        .size(36.0, 36.0)
        .center()
        .radius(11.0)
        .hover(t.hover)
        .hover_group()
        .hover_motion(fade, fade)
        .focus_highlight(t.hover)
        .cursor(Cursor::Pointer)
        .help("Settings")
        .child(icon(&SETTINGS, 16.0).color(t.muted).group_color(t.ink))
}

pub(super) fn actions(t: Palette, s: &AppState, reduced: bool) -> El {
    start_actions(t, s.launcher.mode, Some(&s.start_actions), reduced)
}

fn start_actions(
    t: Palette,
    pending: Option<LauncherMode>,
    state: Option<&StartActionsState>,
    reduced: bool,
) -> El {
    let action = |index: usize, key: &'static str, mode: LauncherMode, title: &'static str| {
        let loading = pending == Some(mode);
        let disabled = pending.is_some();
        let symbol = if loading {
            // A 15 pt ring: a muted/30 track and an ink-soft top quarter, spinning.
            let top = icon(&SPINNER_TOP, 15.0)
                .color(t.ink_soft)
                .absolute(0.0, 0.0);
            let top = if reduced {
                top
            } else {
                top.looping(LoopSpec::rotation(1.0))
            };
            el().size(15.0, 15.0)
                .child(
                    icon(&SPINNER_BASE, 15.0)
                        .color(t.muted.alpha(0.3))
                        .absolute(0.0, 0.0),
                )
                .child(top)
        } else {
            let elapsed = state
                .filter(|_| !reduced && pending.is_none())
                .and_then(|s| since(s, s.started[index]))
                .filter(|e| *e < motion::DURATIONS[index]);
            icon(motion::glyph(index, elapsed), motion::GLYPH).color(t.ink)
        };
        let button = row()
            .key(key)
            .h(40.0)
            .pl(6.0)
            .pr(12.0)
            .gap(14.0)
            .center_y()
            .radius(14.0)
            .opacity(if disabled && !loading { 0.35 } else { 1.0 })
            .opacity_motion(Curve::tween(0.28, EASE))
            .child(el().w(22.0).h(18.0).center().child(symbol))
            .child(
                text(title)
                    .font(TextStyle::new(14.0, REGULAR).lh(14.0).tracking(-0.14))
                    .color(t.ink),
            );
        if disabled {
            button.disabled(true)
        } else {
            button
                .hover(t.hover)
                .hover_motion(Curve::tween(0.28, EASE), Curve::tween(0.28, EASE))
                .focus_highlight(t.hover)
                .cursor(Cursor::Pointer)
                .on_hover_change(move |s: &mut AppState, over, tx| {
                    // mouseenter replays the glyph's gesture unless it is mid-play.
                    if over && !reduced && s.launcher.mode.is_none() {
                        let action = &mut s.start_actions;
                        if since(action, action.started[index])
                            .is_none_or(|e| e >= motion::DURATIONS[index])
                        {
                            action.started[index] = Some(PENDING);
                            tx.wake_after(std::time::Duration::ZERO);
                        }
                    }
                })
        }
    };
    let create = action(
        0,
        "create-project",
        LauncherMode::Create,
        "Create a new project",
    );
    let open = action(
        1,
        "open-folder",
        LauncherMode::Open,
        "Open from local folder",
    );
    let clone = action(2, "clone-project", LauncherMode::Clone, "Clone from GitHub");
    let wrap = |index: usize, button: El| {
        let (offset, active) =
            state.map_or(([0.0; 2], false), |s| (s.offsets[index], s.active[index]));
        let offset = if pending.is_none() && !reduced {
            offset
        } else {
            [0.0; 2]
        };
        el().key(format!("start-anchor-{index}"))
            .on_layout(move |s: &mut AppState, bounds| s.start_actions.bounds[index] = bounds)
            .child(
                button
                    .offset(offset[0], offset[1])
                    .offset_motion(Curve::tween(
                        if active && pending.is_none() {
                            0.35
                        } else {
                            0.6
                        },
                        EASE,
                    )),
            )
    };
    let reset = |s: &mut AppState| {
        s.start_actions.offsets = [[0.0; 2]; 3];
        s.start_actions.active = [false; 3];
        s.start_actions.started = [None; 3];
    };
    let (create, open, clone) = if pending.is_none() {
        (
            create.on_press(move |s: &mut AppState| {
                reset(s);
                s.launcher.open(LauncherMode::Create);
            }),
            open.on_press_tx(move |s: &mut AppState, tx| {
                reset(s);
                crate::launcher::open_folder(s, tx);
            }),
            clone.on_press(move |s: &mut AppState| {
                reset(s);
                s.launcher.open(LauncherMode::Clone);
            }),
        )
    } else {
        (create, open, clone)
    };
    col()
        .items_start()
        .gap(4.0)
        .child(wrap(0, create))
        .child(wrap(1, open))
        .child(wrap(2, clone))
}

/// Entrance progress of the start options (`opacity 0, y 8` over 0.5 s) and of
/// the floor plasma (fade over 1.4 s after 0.2 s, `easeOut`).
fn entrance(s: &StartActionsState, reduced: bool) -> (f32, f32) {
    match since(s, s.mounted) {
        _ if reduced => (1.0, 1.0),
        Some(e) => (
            motion::bezier([0.22, 1.0, 0.36, 1.0], e / 0.5),
            motion::bezier([0.0, 0.0, 0.58, 1.0], (e - 0.2) / 1.4),
        ),
        None if s.live => (0.0, 0.0),
        None => (1.0, 1.0),
    }
}

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let t = Palette::new(cx.system_dark());
    let reduced = cx.is_reduced_motion();
    let (rise, glow) = entrance(&s.start_actions, reduced);
    col()
        .key("empty-root")
        .apply_start_pointer(reduced)
        .w_full()
        .h_full()
        .fill(t.ground)
        .child(crate::plasma::slot(s, cx, glow))
        .child(
            row()
                .w_full()
                .px(64.0)
                .pt(52.0)
                .justify_between()
                .center_y()
                .child(rotating_wordmark(t, &s.start_actions))
                .child(settings_button(t)),
        )
        .child(
            col().grow(1.0).w_full().center().child(
                el().key("start-hero")
                    .opacity(rise)
                    .opacity_motion(NOW)
                    .offset(0.0, 8.0 * (1.0 - rise))
                    .offset_motion(NOW)
                    .child(start_actions(
                        t,
                        s.launcher.mode,
                        Some(&s.start_actions),
                        reduced,
                    )),
            ),
        )
}

/// Steps the start screen's clocks from the app's poll (`clock`, the frame
/// clock, virtual in headless runs): mounts the entrance when the page appears,
/// rotates the wordmark, stamps hover gestures, and asks for frames while
/// anything moves. Returns whether the view should run again.
pub(crate) fn tick(s: &mut AppState, clock: f64, tx: &mut rune::Tx) -> bool {
    use std::time::Duration;
    let state = &mut s.start_actions;
    state.clock = clock;
    if s.page != crate::state::Page::Empty {
        let was = state.mounted.is_some();
        state.mounted = None;
        state.word_at = None;
        state.prev_word = None;
        state.word = 0;
        return was;
    }
    let mut changed = false;
    if state.mounted.is_none() {
        // A `--scene` snapshot opens settled, its wordmark already landed.
        state.mounted = Some(if state.live { clock } else { clock - 10.0 });
        state.prev_word = None;
        state.word_at = Some(if state.live { clock } else { clock - 1.5 });
        changed = true;
    }
    for start in state.started.iter_mut().flatten() {
        if *start == PENDING {
            *start = clock;
            changed = true;
        }
    }
    let shown = since(state, state.word_at).unwrap_or(0.0);
    if shown >= motion::word(state.word).2 {
        state.prev_word = Some(state.word);
        state.word = (state.word + 1) % motion::WORD_COUNT;
        state.word_at = Some(clock);
        changed = true;
    }
    let shown = since(state, state.word_at).unwrap_or(0.0);
    let word_end = state
        .prev_word
        .map_or(0.0, |p| motion::exit_span(motion::word(p).0.len()))
        + motion::enter_span(motion::word(state.word).0.len());
    let mounted = since(state, state.mounted).unwrap_or(0.0);
    let moving = shown < word_end
        || mounted < 1.6
        || (0..3).any(|i| {
            since(state, state.started[i]).is_some_and(|e| e < motion::DURATIONS[i] + 0.05)
        });
    if moving {
        tx.wake_after(Duration::ZERO);
        true
    } else {
        tx.wake_after(Duration::from_secs_f32(
            (motion::word(state.word).2 - shown).max(0.0),
        ));
        changed
    }
}

// Both home layouts use window coordinates for the same magnetic targets.
pub(super) trait StartPointer {
    fn apply_start_pointer(self, reduced: bool) -> Self;
}

impl StartPointer for El {
    fn apply_start_pointer(self, reduced: bool) -> Self {
        self.on_pointer_move_local(move |s: &mut AppState, p, tx| {
            if reduced || s.launcher.mode.is_some() {
                tx.live_only();
                return;
            }
            let mut offsets = [[0.0; 2]; 3];
            let mut active = [false; 3];
            for i in 0..3 {
                let [x, y, w, h] = s.start_actions.bounds[i];
                let dx = p.window_x - (x + w / 2.0);
                let dy = p.window_y - (y + h / 2.0);
                active[i] = w > 0.0 && dx.abs() < w / 2.0 + 12.0 && dy.abs() < h / 2.0 + 12.0;
                if active[i] {
                    offsets[i] = [dx / 9.0, dy / 9.0];
                }
            }
            if offsets == s.start_actions.offsets && active == s.start_actions.active {
                tx.live_only();
            } else {
                s.start_actions.offsets = offsets;
                s.start_actions.active = active;
            }
        })
    }
}

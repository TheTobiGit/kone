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

pub(crate) const EASE: Easing = Easing::cubic(0.22, 1.0, 0.36, 1.0);
/// Tailwind's `transition-colors` default.
pub(crate) const COLORS_EASE: Easing = Easing::cubic(0.4, 0.0, 0.2, 1.0);
/// Lands a per-frame value at once: the poll clock already eased it.
const NOW: Curve = Curve::tween(0.0001, Easing::cubic(0.0, 0.0, 1.0, 1.0));

/// Electron loads Geist and Fraunces at weight 400 only (`@nuxt/fonts`) and sets
/// `font-synthesis: none`, so every weight it asks for paints as Regular.
const REGULAR: f32 = 400.0;

/// Shared home-page chrome. The first-run screen uses the same outer inset
/// as the populated projects list. Start actions stay centered in the
/// content area; `CONTENT_PT` is the projects-list gap under the header.
pub(crate) const PAGE_PX: f32 = 64.0;
pub(crate) const PAGE_PT: f32 = 20.0;
pub(crate) const PAGE_PB: f32 = 64.0;
pub(crate) const CONTENT_PT: f32 = 96.0;

static START_PLUS: Icon = Icon {
    name: "start-plus",
    view: 24.0,
    body: r#"<path d="M12 4V20M20 12H4" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7"></path>"#,
};
static START_FOLDER: Icon = Icon {
    name: "start-folder",
    view: 24.0,
    body: r#"<path d="M2.5 20V8.87695C2.5 7.58945 2.5 6.9457 2.78533 6.47048C2.9541 6.18939 3.18939 5.9541 3.47048 5.78533C3.9457 5.5 4.59449 5.5 5.89206 5.5C6.52339 5.5 6.83906 5.5 7.12612 5.58819C7.31759 5.64702 7.49914 5.73428 7.66469 5.84705C7.91289 6.01611 8.10859 6.26074 8.5 6.75C8.89141 7.23926 9.08711 7.48389 9.33531 7.65295C9.50086 7.76572 9.68241 7.85298 9.87388 7.91181C10.1609 8 10.4742 8 11.1008 8H15C16.4045 8 17.1067 8 17.6111 8.33706C17.8295 8.48298 18.017 8.67048 18.1629 8.88886C18.5 9.39331 18.5 10.0955 18.5 11.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7"></path><path d="M4.42028 14.0144L3.63368 16.0144C2.65618 18.4998 2.16743 19.7425 2.7524 20.6213C3.33737 21.5 4.65337 21.5 7.28537 21.5H15.1903C16.4249 21.5 17.0422 21.5 17.5295 21.1795C18.0169 20.859 18.2702 20.2865 18.7769 19.1415L19.6618 17.1415C20.7866 14.5992 21.349 13.3281 20.7679 12.4141C20.1868 11.5 18.8163 11.5 16.0752 11.5H8.07196C6.78232 11.5 6.1375 11.5 5.63811 11.8439C5.13872 12.1877 4.89924 12.7966 4.42028 14.0144Z" stroke="currentColor" stroke-width="1.7"></path><path d="M11.5 4.51456C12.4151 3.28409 13.6662 2.55594 15.5125 2.50161C16.1155 2.48386 16.7152 2.61395 17.2682 2.85544C18.5748 3.42601 19.4185 4.15644 20 5.5L21.5 3" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7"></path>"#,
};
static START_GITHUB: Icon = Icon {
    name: "start-github",
    view: 24.0,
    body: r#"<path d="M10 20.5675C6.57143 21.7248 3.71429 20.5675 2 17" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7"></path><path d="M10 22V18.7579C10 18.1596 10.1839 17.6396 10.4804 17.1699C10.6838 16.8476 10.5445 16.3904 10.1771 16.2894C7.13394 15.4528 5 14.1077 5 9.64606C5 8.48611 5.38005 7.39556 6.04811 6.4464C6.21437 6.21018 6.29749 6.09208 6.31748 5.9851C6.33746 5.87813 6.30272 5.73852 6.23322 5.45932C5.95038 4.32292 5.96871 3.11619 6.39322 2.02823C6.39322 2.02823 7.27042 1.74242 9.26698 2.98969C9.72282 3.27447 9.95075 3.41686 10.1515 3.44871C10.3522 3.48056 10.6206 3.41384 11.1573 3.28041C11.8913 3.09795 12.6476 3 13.5 3C14.3524 3 15.1087 3.09795 15.8427 3.28041C16.3794 3.41384 16.6478 3.48056 16.8485 3.44871C17.0493 3.41686 17.2772 3.27447 17.733 2.98969C19.7296 1.74242 20.6068 2.02823 20.6068 2.02823C21.0313 3.11619 21.0496 4.32292 20.7668 5.45932C20.6973 5.73852 20.6625 5.87813 20.6825 5.9851C20.7025 6.09207 20.7856 6.21019 20.9519 6.4464C21.6199 7.39556 22 8.48611 22 9.64606C22 14.1077 19.8661 15.4528 16.8229 16.2894C16.4555 16.3904 16.3162 16.8476 16.5196 17.1699C16.8161 17.6396 17 18.1596 17 18.7579V22" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7"></path>"#,
};

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
    name: "overview-back",
    view: 24.0,
    body: r#"<path d="M11 18H15.5C17.9853 18 20 15.98528 20 13.5C20 11.0147 17.9853 9 15.5 9H4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.99998 12C6.99998 12 4.00001 9.7905 4 9C3.99999 8.2094 7 6 7 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

/// Seconds `s`'s poll clock has run since `at`.
fn since(s: &StartActionsState, at: Option<f64>) -> Option<f32> {
    at.map(|at| (s.clock - at) as f32)
}

#[allow(dead_code)]
fn fraunces() -> TextStyle {
    TextStyle::new(15.0, REGULAR)
        .lh(17.25)
        .family(Family::Named("Fraunces"))
}

/// `HomeRotatingWordmark`: `make it` and a word that builds the brand up letter
/// by letter, each letter springing up out of a clip and away above it.
#[allow(dead_code)]
pub(super) fn rotating_wordmark(t: Palette, s: &StartActionsState) -> El {
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
        .hover_group_focus()
        .hover_motion(fade, fade)
        .role("button")
        .label("Settings and personalization")
        .focusable(true)
        .no_focus_ring()
        .cursor(Cursor::Pointer)
        .help("Settings")
        .child(icon(&SETTINGS, 16.0).color(t.muted).group_color(t.ink))
}

pub(super) fn actions(t: Palette, s: &AppState, reduced: bool) -> El {
    start_actions(
        t,
        s.launcher.mode,
        (s.start_actions.page == Some(s.page)).then_some(&s.start_actions),
        reduced,
    )
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
            icon([&START_PLUS, &START_FOLDER, &START_GITHUB][index], 18.0).color(t.ink)
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
        let offset = if !reduced { offset } else { [0.0; 2] };
        el().key(format!("start-anchor-{index}"))
            .on_layout(move |s: &mut AppState, bounds| s.start_actions.bounds[index] = bounds)
            .child(
                button
                    .offset(offset[0], offset[1])
                    .offset_motion(Curve::tween(if active { 0.35 } else { 0.6 }, EASE)),
            )
    };
    let (create, open, clone) = if pending.is_none() {
        (
            create.on_press(move |s: &mut AppState| {
                s.launcher.open(LauncherMode::Create);
            }),
            open.on_press_tx(move |s: &mut AppState, tx| {
                crate::launcher::open_folder(s, tx);
            }),
            clone.on_press(move |s: &mut AppState| {
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

/// Entrance progress of the start options (`opacity 0, y 8` over 0.5 s).
fn entrance(s: &StartActionsState, reduced: bool) -> f32 {
    match since(s, s.mounted) {
        _ if reduced => 1.0,
        Some(e) => motion::bezier([0.22, 1.0, 0.36, 1.0], e / 0.5),
        None if s.live => 0.0,
        None => 1.0,
    }
}

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let t = Palette::new(cx.system_dark());
    let reduced = cx.is_reduced_motion();
    let rise = entrance(&s.start_actions, reduced);
    col()
        .key("empty-root")
        .apply_start_pointer(reduced)
        .w_full()
        .h_full()
        .fill(t.ground)
        .child(
            col()
                .w_full()
                .h_full()
                .px(PAGE_PX)
                .pt(PAGE_PT)
                .pb(PAGE_PB)
                .child(
                    row()
                        .w_full()
                        .justify_end()
                        .center_y()
                        .child(settings_button(t)),
                )
                .child(
                    col().w_full().grow(1.0).min_h(0.0).center().child(
                        el().key("start-hero")
                            .opacity(rise)
                            .opacity_motion(NOW)
                            .offset(0.0, 8.0 * (1.0 - rise))
                            .offset_motion(NOW)
                            .child(actions(t, s, reduced)),
                    ),
                ),
        )
}

/// Steps the start screen's clocks from the app's poll (`clock`, the frame
/// clock, virtual in headless runs): mounts the entrance when the page appears,
/// rotates the projects wordmark, and asks for frames while
/// anything moves. Returns whether the view should run again.
pub(crate) fn tick(s: &mut AppState, clock: f64, tx: &mut rune::Tx) -> bool {
    use std::time::Duration;
    let state = &mut s.start_actions;
    state.clock = clock;
    let previous_page = state.page;
    let page_changed = state.reset_for_page(s.page);
    if page_changed && state.live && previous_page.is_some() {
        state.mounted = None;
        state.word_at = None;
        state.prev_word = None;
        state.word = 0;
    }
    if s.page == crate::state::Page::Overview {
        if state.mounted.is_none() {
            state.mounted = Some(if state.live { clock } else { clock - 10.0 });
        }
        if since(state, state.mounted).unwrap_or(0.0) < 0.42 {
            tx.wake_after(Duration::ZERO);
            return true;
        }
        return page_changed;
    }
    if !matches!(
        s.page,
        crate::state::Page::Empty | crate::state::Page::Projects
    ) {
        let was = state.mounted.is_some();
        state.mounted = None;
        state.word_at = None;
        state.prev_word = None;
        state.word = 0;
        return was || page_changed;
    }
    let mut changed = page_changed;
    if state.mounted.is_none() {
        // A `--scene` snapshot opens settled, its wordmark already landed.
        state.mounted = Some(if state.live { clock } else { clock - 10.0 });
        state.prev_word = None;
        state.word_at = Some(if state.live { clock } else { clock - 1.5 });
        changed = true;
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
    let grid_end = if s.page == crate::state::Page::Projects {
        0.06 * s.projects.len() as f32 + 1.0
    } else {
        0.0
    };
    let moving = shown < word_end || mounted < 1.6_f32.max(grid_end);
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
            if reduced
                || s.start_actions.page != Some(s.page)
                || !s
                    .start_actions
                    .pointer_move(p.window_x, p.window_y, s.launcher.mode.is_some())
            {
                tx.live_only();
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rotating_wordmark_restarts_when_home_view_changes() {
        let mut state = AppState::default();
        state.start_actions.live = true;
        let mut tx = rune::Tx::default();
        tick(&mut state, 1.0, &mut tx);
        state.start_actions.word = 3;
        state.start_actions.word_at = Some(1.5);
        state.page = crate::state::Page::Projects;
        tick(&mut state, 2.0, &mut tx);
        assert_eq!(state.start_actions.word, 0);
        assert_eq!(state.start_actions.word_at, Some(2.0));
    }
}

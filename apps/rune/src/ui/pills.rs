use crate::{
    state::{AppState, StudioState},
    theme::{Palette, mix_srgb},
};
use rune::{Cursor, Curve, Easing, El, Icon, TextStyle, col, el, icon, row, text};

static WORKING: Icon = Icon {
    name: "pill-working",
    view: 28.0,
    body: r#"<circle cx="14" cy="14" r="9" fill="none" stroke="currentColor" stroke-width="1"/><ellipse cx="14" cy="14" rx="12" ry="5" transform="rotate(-20 14 14)" fill="none" stroke="currentColor" stroke-width="1"/>"#,
};
static CHECK: Icon = Icon {
    name: "pill-check",
    view: 24.0,
    body: r#"<path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static CLOSE: Icon = Icon {
    name: "pill-close",
    view: 24.0,
    body: r#"<path d="M18 6L6 18M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>"#,
};

fn pill(s: &AppState, thread: &StudioState, t: Palette) -> El {
    let id = thread.thread_id.clone();
    let hovered = s.pill_hover.as_deref() == Some(&id);
    let seconds = thread
        .turn_started
        .and_then(|at| at.elapsed().ok())
        .map_or(0, |d| d.as_secs());
    let time = if seconds < 60 {
        format!("{seconds}s")
    } else if seconds.is_multiple_of(60) {
        format!("{}m", seconds / 60)
    } else {
        format!("{}m {}s", seconds / 60, seconds % 60)
    };
    let title = thread.turn_title.trim();
    let bare = title.is_empty();
    let height = if bare { 44.0 } else { 52.0 };
    let green = rune::color::hex("#059669").unwrap();
    let orb = if thread.busy {
        el().size(28.0, 28.0)
            .center()
            .child(icon(&WORKING, 28.0).color(t.muted))
    } else {
        el().size(30.0, 30.0)
            .radius(15.0)
            .fill(green.alpha(0.14))
            .center()
            .child(icon(&CHECK, 18.0).color(green))
    };
    let mut identity = row()
        .center_y()
        .gap(5.0)
        .child(super::studio::provider_mark(Some(thread), t).opacity(0.65))
        .child(
            text(title.to_owned())
                .font(TextStyle::new(10.5, 400.0).tracking(0.105))
                .color(t.muted)
                .w(130.0),
        );
    if thread.busy && seconds >= 15 && !hovered {
        identity = identity.child(text(time).font(TextStyle::new(10.5, 400.0)).color(t.muted));
    }
    let label = if thread.busy {
        "Working"
    } else if thread.error.is_some() {
        "Couldn't finish"
    } else {
        "Replied"
    };
    let mut lines = col().gap(1.0).w(182.0);
    if !bare {
        lines = lines.child(identity);
    }
    lines = lines.child(
        text(label)
            .font(TextStyle::new(13.0, 400.0).tracking(-0.156))
            .color(t.ink),
    );
    let open_id = id.clone();
    let dismiss_id = id.clone();
    let hover_id = id.clone();
    let motion = Curve::tween(0.35, Easing::cubic(0.22, 1.0, 0.36, 1.0));
    el().key(format!("pill-{id}"))
        .size(248.0, height)
        .on_hover_change(move |s: &mut AppState, over, _| {
            s.pill_hover = if over { Some(hover_id.clone()) } else { None };
        })
        .child(
            row()
                .size(248.0, height)
                .center_y()
                .gap(11.0)
                .px(9.0)
                .radius(999.0)
                .fill(
                    mix_srgb(t.ground, t.ink, if hovered { 0.079 } else { 0.054 })
                        .alpha(if hovered { 0.89 } else { 0.93 }),
                )
                .offset(0.0, if hovered { -2.0 } else { 0.0 })
                .offset_motion(motion)
                .cursor(Cursor::Pointer)
                .role("button")
                .label(format!("{title}: {label}. Back to the conversation"))
                .focusable(true)
                .on_press(move |s: &mut AppState| {
                    s.enter_studio();
                    s.open_studio_thread(open_id.clone());
                    if !s.studio.busy {
                        s.studio.turn_seen = true;
                    }
                    s.page = crate::state::Page::Studio;
                })
                .child(el().size(32.0, 32.0).center().child(orb))
                .child(lines),
        )
        .child(if hovered {
            el().pin(
                None,
                Some(if bare { (height - 20.0) / 2.0 } else { 7.0 }),
                Some(10.0),
                None,
            )
            .size(20.0, 20.0)
            .center()
            .radius(10.0)
            .cursor(Cursor::Pointer)
            .role("button")
            .label("Dismiss this status pill")
            .focusable(true)
            .hover_group()
            .child(icon(&CLOSE, 13.0).color(t.muted).group_color(t.ink))
            .on_press(move |s: &mut AppState| {
                if s.studio.thread_id == dismiss_id {
                    s.studio.turn_dismissed = true;
                } else if let Some(thread) = s.studio_threads.get_mut(&dismiss_id) {
                    thread.turn_dismissed = true;
                }
            })
        } else {
            el()
        })
}

pub fn view(s: &AppState, t: Palette) -> Option<El> {
    let mut threads: Vec<_> = std::iter::once(&s.studio)
        .chain(s.studio_threads.values())
        .filter(|thread| {
            thread.turn_started.is_some()
                && !thread.turn_dismissed
                && (thread.busy || !thread.turn_seen)
        })
        .collect();
    threads.sort_by_key(|thread| thread.turn_started);
    if threads.is_empty() {
        return None;
    }
    let mut stack = col().gap(10.0);
    for thread in threads {
        stack = stack.child(pill(s, thread, t));
    }
    Some(el().pin(None, None, Some(32.0), Some(32.0)).child(stack))
}

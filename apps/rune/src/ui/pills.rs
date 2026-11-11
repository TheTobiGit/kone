use crate::{
    state::{AppState, StudioState},
    theme::{Palette, mix_srgb},
};
use rune::{Cursor, Curve, Easing, El, Icon, LoopSpec, TextStyle, col, el, icon, row, text};

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

fn activity(thread: &StudioState) -> (String, bool) {
    let Some(item) = thread.items.last().filter(|i| i.status == "in-progress") else {
        return ("Working".into(), false);
    };
    match item.kind.as_str() {
        "reasoning_text" => ("Thinking".into(), false),
        "plan_text" => ("Planning".into(), false),
        "tool_call" => {
            let target = item.text.trim();
            let target = if target.chars().count() > 30 {
                let base = target.rsplit('/').next().unwrap_or(target);
                if base.chars().count() <= 30 {
                    base.to_owned()
                } else {
                    format!("{}…", base.chars().take(29).collect::<String>())
                }
            } else {
                target.to_owned()
            };
            let (verb, fallback) = match item.name.as_str() {
                "read_file" | "view_file" | "read" => ("Reading", "a file"),
                "write_to_file" | "create_file" | "write" => ("Writing", "a file"),
                "edit_file" | "apply_patch" | "str_replace" | "edit" | "multiedit" => {
                    ("Editing", "a file")
                }
                "list_dir" | "ls" => ("Listing", "a folder"),
                "delete_file" | "rm" => ("Deleting", "a file"),
                "grep_search" | "ripgrep" | "grep" | "codebase_search" | "search" => {
                    ("Searching for", "the codebase")
                }
                "bash" | "run_terminal_cmd" | "execute_command" | "run_command" | "run"
                | "command" => ("Running", "a command"),
                "web_search" | "search_web" | "websearch" => ("Searching the web for", "a query"),
                "web_fetch" | "webfetch" => ("Fetching", "a page"),
                _ => {
                    return (
                        format!(
                            "Running {}",
                            if item.name.is_empty() {
                                "a tool".into()
                            } else {
                                item.name.replace(['_', '-'], " ")
                            }
                        ),
                        true,
                    );
                }
            };
            (
                format!(
                    "{verb} {}",
                    if target.is_empty() { fallback } else { &target }
                ),
                true,
            )
        }
        _ => ("Working".into(), false),
    }
}

fn active_task(thread: &StudioState) -> Option<(String, usize, usize)> {
    let item = thread
        .items
        .iter()
        .rev()
        .find(|i| i.kind == "plan_text" && (!i.tasks.is_empty() || !i.text.is_empty()))?;
    let tasks: Vec<(String, String)> = if item.tasks.is_empty() {
        item.text
            .lines()
            .filter_map(|line| {
                let line = line.trim().trim_start_matches(['-', '*', '+']).trim_start();
                let (status, label) = if let Some(x) = line.strip_prefix("[ ] ") {
                    ("pending", x)
                } else if let Some(x) = line
                    .strip_prefix("[/] ")
                    .or_else(|| line.strip_prefix("[-] "))
                {
                    ("in-progress", x)
                } else if let Some(x) = line
                    .strip_prefix("[x] ")
                    .or_else(|| line.strip_prefix("[X] "))
                {
                    ("completed", x)
                } else if let Some(x) = line.strip_prefix("○ ") {
                    ("pending", x)
                } else if let Some(x) = line.strip_prefix("→ ") {
                    ("in-progress", x)
                } else {
                    ("completed", line.strip_prefix("✓ ")?)
                };
                Some((status.to_owned(), label.to_owned()))
            })
            .collect()
    } else {
        item.tasks
            .iter()
            .map(|t| {
                let status = t["status"].as_str().unwrap_or("pending");
                let label = if status == "in-progress" {
                    t["activeForm"].as_str().filter(|x| !x.is_empty())
                } else {
                    None
                }
                .or_else(|| t["content"].as_str())
                .unwrap_or("");
                (status.to_owned(), label.to_owned())
            })
            .collect()
    };
    let index = tasks
        .iter()
        .position(|t| t.0 == "in-progress")
        .or_else(|| tasks.iter().position(|t| t.0 == "pending"))?;
    Some((tasks[index].1.clone(), index + 1, tasks.len()))
}

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
    let green = if thread.error.is_some() {
        rune::color::hex("#dc2626").unwrap()
    } else if thread.turn_interrupted {
        t.muted
    } else {
        rune::color::hex("#059669").unwrap()
    };
    let orb = if thread.busy {
        el().size(28.0, 28.0).center().child(
            icon(&WORKING, 28.0)
                .color(t.muted)
                .looping(LoopSpec::rotation(3.0)),
        )
    } else {
        el().size(30.0, 30.0)
            .radius(15.0)
            .fill(green.alpha(0.14))
            .center()
            .child(if thread.error.is_some() {
                icon(&CLOSE, 18.0).color(green)
            } else if thread.turn_interrupted {
                el().size(6.0, 6.0).radius(3.0).fill(green)
            } else {
                icon(&CHECK, 18.0).color(green)
            })
    };
    let task = if thread.busy {
        active_task(thread)
    } else {
        None
    };
    let (activity_label, is_tool) = activity(thread);
    let width = if task.is_some() { 368.0 } else { 248.0 };
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
    if let Some((_, index, total)) = &task
        && *total > 1
        && !hovered
    {
        identity = identity.child(
            text(format!("{index}/{total}"))
                .font(TextStyle::new(10.5, 400.0))
                .color(t.muted),
        );
    }
    if thread.busy && seconds >= 15 && !hovered {
        identity = identity.child(text(time).font(TextStyle::new(10.5, 400.0)).color(t.muted));
    }
    let label = if thread.busy {
        task.as_ref()
            .map_or(activity_label.as_str(), |t| t.0.as_str())
    } else if thread.error.is_some() {
        "Couldn't finish"
    } else if thread.turn_interrupted {
        "Stopped"
    } else {
        "Replied"
    };
    let mut lines = col().gap(1.0).w(width - 66.0);
    if !bare {
        lines = lines.child(identity);
    }
    let mut status = row().center_y().gap(6.0).child(
        text(label)
            .font(TextStyle::new(13.0, 400.0).tracking(-0.156))
            .color(t.ink),
    );
    if task.is_some() && is_tool {
        status = status
            .child(text("•").font(TextStyle::new(10.0, 400.0)).color(t.muted))
            .child(
                text(activity_label.clone())
                    .font(TextStyle::new(11.0, 400.0))
                    .color(t.muted),
            );
    }
    lines = lines.child(status);
    let open_id = id.clone();
    let dismiss_id = id.clone();
    let hover_id = id.clone();
    let motion = Curve::tween(0.35, Easing::cubic(0.22, 1.0, 0.36, 1.0));
    el().key(format!("pill-{id}"))
        .size(width, height)
        .on_hover_focus_change(move |s: &mut AppState, over, _| {
            s.pill_hover = if over { Some(hover_id.clone()) } else { None };
        })
        .child(
            row()
                .size(width, height)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::StudioItem;

    #[test]
    fn plan_and_latest_tool_drive_activity() {
        let mut thread = StudioState::default();
        thread.items.push(StudioItem {
            kind: "plan_text".into(),
            text: "- [x] First\n- [/] Second\n- [ ] Third".into(),
            ..Default::default()
        });
        thread.items.push(StudioItem {
            kind: "tool_call".into(),
            status: "in-progress".into(),
            name: "read_file".into(),
            text: "file.rs".into(),
            ..Default::default()
        });
        assert_eq!(active_task(&thread), Some(("Second".into(), 2, 3)));
        assert_eq!(activity(&thread), ("Reading file.rs".into(), true));
        thread.items.last_mut().unwrap().status = "completed".into();
        assert_eq!(activity(&thread), ("Working".into(), false));
    }
}

use super::empty::BACK;

use super::empty::StartPointer;
use super::projects::{folder_with_git, sessions};
use crate::{
    state::{AppState, Page},
    theme::{Palette, mix_srgb},
};
use rune::{Cursor, Curve, Cx, Easing, El, TextStyle, col, el, icon, row, text};

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let t = Palette::new(cx.system_dark());
    let name = s
        .selected_project
        .and_then(|i| s.projects.get(i))
        .map(|p| p.name.as_str())
        .unwrap_or("");
    let elapsed = if cx.is_reduced_motion() || !s.start_actions.live {
        10.0
    } else {
        s.start_actions
            .mounted
            .map_or(0.0, |at| (s.start_actions.clock - at) as f32)
    };
    let progress = |duration: f32| {
        super::start_motion::bezier([0.22, 1.0, 0.36, 1.0], (elapsed / duration).clamp(0.0, 1.0))
    };
    let now = Curve::tween(0.0001, Easing::cubic(0.0, 0.0, 1.0, 1.0));
    let back_in = progress(0.3);
    let nav_in = progress(0.42);
    let avatar_in = progress(0.35);
    let ease = Easing::cubic(0.22, 1.0, 0.36, 1.0);
    let nav = row()
        .opacity(nav_in)
        .opacity_motion(now)
        .offset(0.0, -8.0 * (1.0 - nav_in))
        .offset_motion(now)
        .h(30.0)
        .center_y()
        .child(
            el().w(84.0)
                .h(24.0)
                .center()
                .radius(20.0)
                .fill(mix_srgb(t.ground, t.ink, 0.065))
                .role("button")
                .label("Overview")
                .focusable(true)
                .no_focus_ring()
                .child(
                    text("Overview")
                        .font(TextStyle::new(12.5, 400.0).tracking(-0.1))
                        .color(t.ink),
                ),
        )
        .child(
            el().w(84.0).h(30.0).center().child(
                text("Git")
                    .font(TextStyle::new(12.5, 400.0).tracking(-0.1))
                    .color(t.muted.alpha(0.4)),
            ),
        );
    let [dx, dy] = s.start_actions.offsets[0];
    let active = s.start_actions.active[0];
    let back = el()
        .key("overview-back-anchor")
        .size(18.0, 18.0)
        .opacity(back_in)
        .opacity_motion(now)
        .offset(-6.0 * (1.0 - back_in), 0.0)
        .offset_motion(now)
        .on_layout(|s: &mut AppState, bounds| s.start_actions.bounds[0] = bounds)
        .child(
            el().key("overview-back")
                .size(18.0, 18.0)
                .offset(
                    if cx.is_reduced_motion() { 0.0 } else { dx },
                    if cx.is_reduced_motion() { 0.0 } else { dy },
                )
                .offset_motion(Curve::tween(if active { 0.35 } else { 0.6 }, ease))
                .role("button")
                .label("Back to projects")
                .focusable(true)
                .no_focus_ring()
                .hover_group_focus()
                .cursor(Cursor::Pointer)
                .child(
                    icon(&BACK, 18.0)
                        .color(t.muted.alpha(0.7))
                        .group_color(t.ink),
                )
                .on_press(|s: &mut AppState| {
                    s.refresh_project_list();
                    s.page = if s.projects.is_empty() {
                        Page::Empty
                    } else {
                        Page::Projects
                    };
                }),
        );
    let mut avatar = el()
        .w(84.0)
        .h(30.0)
        .justify_end()
        .opacity(progress(0.3))
        .opacity_motion(now)
        .offset(0.0, -6.0 * (1.0 - avatar_in))
        .offset_motion(now);
    if let Some(name) = &s.profile.name {
        avatar = avatar.child(
            el().key("overview-profile")
                .size(30.0, 30.0)
                .radius(15.0)
                .center()
                .fill(t.ink)
                .scale(if s.profile_hover { 1.06 } else { 1.0 })
                .scale_motion(Curve::tween(0.35, ease))
                .role("button")
                .label(format!("Open profile — {name}"))
                .focusable(true)
                .focus_ring(2.0, 2.0, t.ink.alpha(0.26))
                .cursor(Cursor::Pointer)
                .help(name.clone())
                .on_hover_change(|s: &mut AppState, over, _| s.profile_hover = over)
                .child(
                    text(s.profile.initial.clone())
                        .font(TextStyle::new(13.0, 400.0).lh(13.0))
                        .color(t.ground),
                ),
        );
    }
    let top = row()
        .w_full()
        .h(52.0)
        .px(32.0)
        .pt(20.0)
        .child(el().w(84.0).child(back))
        .child(el().grow(1.0).center().child(nav))
        .child(avatar);
    let overview = &s.project_data.overview;
    let tree = &overview["workingTree"];
    let loaded = !overview.is_null();
    let repo = !tree.is_null();
    let changes = tree["changes"].as_array();
    let count = changes.map_or(0, Vec::len);
    let clean = tree["clean"].as_bool().unwrap_or(count == 0);
    let branch = tree["branch"].as_str().unwrap_or("");
    let message = if !loaded {
        name.to_owned()
    } else if !repo {
        format!(
            "{name} isn't a git repository yet. Initialize a repo to track changes, then start your first session"
        )
    } else if tree["head"].is_null() {
        format!(
            "{name} is a fresh repository. Nothing committed yet — your first changes will show up here"
        )
    } else if clean {
        format!(
            "{name} is ready when you are. No changes — everything's committed{}",
            if branch.is_empty() {
                String::new()
            } else {
                format!(" on {branch}")
            }
        )
    } else {
        format!(
            "{name} has {count} {} with changes",
            if count == 1 { "file" } else { "files" }
        )
    };
    let greeting = col()
        .gap(2.0)
        .grow(1.0)
        .child(
            text("Hey, there")
                .font(TextStyle::new(30.0, 500.0))
                .color(t.ink_soft),
        )
        .child(
            text(message)
                .font(TextStyle::new(30.0, 500.0))
                .color(t.ink_soft)
                .wrap(),
        );
    let mut changes_panel = col().w_full().gap(20.0);
    if loaded {
        let label = if !repo {
            "Not a git repository"
        } else if clean {
            "Working tree clean"
        } else {
            "Changes"
        };
        let caption = if !repo {
            "NOT TRACKED"
        } else if clean {
            "ALL CLEAR"
        } else {
            "WORKING TREE"
        };
        changes_panel = changes_panel.child(
            row()
                .w_full()
                .justify_between()
                .center_y()
                .child(text(label).font(TextStyle::new(12.0, 500.0)).color(t.muted))
                .child(
                    text(caption)
                        .font(
                            TextStyle::new(10.0, 500.0)
                                .family(rune::Family::Mono)
                                .tracking(1.2),
                        )
                        .color(t.faint),
                ),
        );
        if !repo || clean {
            let paper = el()
                .size(76.0, 92.0)
                .radius(12.0)
                .border(1.0, t.line)
                .fill(t.raised_high)
                .shadow(0.0, 3.0, t.line)
                .center()
                .child(el().size(14.0, 6.0).radius(3.0).fill(t.hover));
            changes_panel = changes_panel.child(
                col()
                    .w_full()
                    .h(230.0)
                    .center()
                    .gap(24.0)
                    .child(paper)
                    .child(
                        text(if repo {
                            "Working tree clean"
                        } else {
                            "Not tracked yet"
                        })
                        .font(TextStyle::new(14.0, 400.0))
                        .color(t.ink_soft),
                    ),
            );
        } else if let Some(changes) = changes {
            let mut cards = row().gap(12.0);
            for change in changes.iter().take(4) {
                let path = change["path"].as_str().unwrap_or("");
                cards = cards.child(
                    col()
                        .w(150.0)
                        .h(116.0)
                        .padding(14.0)
                        .gap(12.0)
                        .radius(12.0)
                        .border(1.0, t.line)
                        .fill(t.raised_high)
                        .child(
                            text(path.to_owned())
                                .font(TextStyle::new(12.0, 500.0))
                                .color(t.ink)
                                .truncate(),
                        ),
                );
            }
            changes_panel = changes_panel.child(cards);
        }
    }
    col()
        .w_full()
        .h_full()
        .fill(t.ground)
        .apply_start_pointer(cx.is_reduced_motion())
        .child(top)
        .child(
            row().w_full().justify_center().pt(44.0).px(64.0).child(
                col()
                    .w(896.0)
                    .gap(44.0)
                    .child(
                        row()
                            .w_full()
                            .justify_between()
                            .gap(32.0)
                            .child(greeting)
                            .child(folder_with_git(name, t, tree)),
                    )
                    .child(changes_panel)
                    .child(sessions(s, &s.project_data.sessions, t, false)),
            ),
        )
}

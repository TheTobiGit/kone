use super::empty::BACK;
use super::projects::{folder_with_git, sessions};
use crate::{
    state::{AppState, Page},
    theme::Palette,
};
use rune::{Cx, El, TextStyle, col, el, icon, row, text};

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let t = Palette::new(cx.system_dark());
    let name = s
        .selected_project
        .and_then(|i| s.projects.get(i))
        .map(|p| p.name.as_str())
        .unwrap_or("");
    let nav = row()
        .h(34.0)
        .center_y()
        .child(
            el().w(84.0)
                .h(28.0)
                .center()
                .radius(20.0)
                .fill(t.hover)
                .child(
                    text("Overview")
                        .font(TextStyle::new(12.5, 400.0))
                        .color(t.ink),
                ),
        )
        .child(
            el().w(84.0)
                .h(28.0)
                .center()
                .radius(20.0)
                .hover(t.hover)
                .child(
                    text("Studio")
                        .font(TextStyle::new(12.5, 400.0))
                        .color(t.muted),
                )
                .on_press(|s: &mut AppState| s.enter_studio()),
        );
    let top = row()
        .w_full()
        .h(52.0)
        .px(32.0)
        .center_y()
        .child(
            el().w(84.0)
                .child(icon(&BACK, 18.0).color(t.muted))
                .on_press(|s: &mut AppState| {
                    s.refresh_project_list();
                    s.page = if s.projects.is_empty() {
                        Page::Empty
                    } else {
                        Page::Projects
                    }
                }),
        )
        .child(el().grow(1.0).center().child(nav))
        .child(el().w(84.0));
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
    col().w_full().h_full().fill(t.ground).child(top).child(
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

use super::empty::{SEARCH, SETTINGS, actions, wordmark};
use crate::{
    project_state::{ProjectSession, ProjectSort},
    state::AppState,
    theme::Palette,
};
use rune::{Cx, El, Family, Icon, TextStyle, col, el, icon, row, text, text_input};

static CHAT: Icon = Icon {
    name: "session-chat",
    view: 24.0,
    body: r#"<path d="M4 5h16v12H9l-5 3V5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>"#,
};
static CLOCK: Icon = Icon {
    name: "session-clock",
    view: 24.0,
    body: r#"<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>"#,
};
static PIN: Icon = Icon {
    name: "session-pin",
    view: 24.0,
    body: r#"<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Zm3 11v7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>"#,
};

static BRANCH: Icon = Icon {
    name: "git-branch",
    view: 24.0,
    body: r#"<circle cx="6" cy="18" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="18" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M6 15V3m12 6a9 9 0 0 1-9 9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>"#,
};

pub(super) fn folder(name: &str, t: Palette) -> El {
    folder_with_git(name, t, &serde_json::Value::Null)
}

pub(super) fn folder_with_git(name: &str, t: Palette, tree: &serde_json::Value) -> El {
    let (sheet_top, sheet_bottom, pocket_top, pocket_middle, pocket_bottom, shadow) = if t.dark {
        (
            t.ground.mix(t.ink, 0.068),
            t.ground.mix(t.ink, 0.04),
            t.ground.mix(t.ink, 0.094),
            t.ground.mix(t.ink, 0.057),
            t.ground.mix(t.ink, 0.035),
            t.ground.alpha(0.3),
        )
    } else {
        (
            t.raised.mix(t.ink, 0.052),
            t.raised.mix(t.ink, 0.123),
            t.raised.mix(t.ink, 0.013),
            t.raised.mix(t.ink, 0.077),
            t.raised.mix(t.ink, 0.12),
            t.ink.alpha(0.06),
        )
    };
    let sheet = el()
        .size(168.0, 44.0)
        .radius(16.0)
        .fill(sheet_bottom)
        .linear_gradient(
            160_f32.to_radians(),
            [(0.0, sheet_top), (1.0, sheet_bottom)],
        )
        .absolute(16.0, 6.0);
    let changes = tree["changes"].as_array();
    let branch = tree["branch"].as_str();
    let added: i64 = changes
        .into_iter()
        .flatten()
        .map(|c| c["added"].as_i64().unwrap_or(0))
        .sum();
    let removed: i64 = changes
        .into_iter()
        .flatten()
        .map(|c| c["removed"].as_i64().unwrap_or(0))
        .sum();
    let mut pocket = col()
        .size(200.0, 92.0)
        .radius(22.0)
        .justify_end()
        .px(18.0)
        .pb(15.0)
        .fill(pocket_bottom)
        .linear_gradient(
            168_f32.to_radians(),
            [
                (0.0, pocket_top),
                (0.55, pocket_middle),
                (1.0, pocket_bottom),
            ],
        )
        .shadow(4.0, 10.0, shadow)
        .absolute(0.0, 24.0)
        .child(
            text(name.to_owned())
                .font(TextStyle::new(17.0, 600.0).tracking(-0.408))
                .color(t.ink)
                .truncate(),
        );
    if let Some(branch) = branch {
        let mut meta = row().w_full().center_y().justify_between().gap(6.0).child(
            row()
                .center_y()
                .gap(4.0)
                .child(icon(&BRANCH, 12.0).color(t.muted))
                .child(
                    text(branch.to_owned())
                        .font(TextStyle::new(11.0, 400.0).family(Family::Mono))
                        .color(t.muted)
                        .truncate(),
                ),
        );
        if added > 0 || removed > 0 {
            meta = meta.child(
                text(format!("+{added}  −{removed}"))
                    .font(TextStyle::new(11.0, 500.0).family(Family::Mono))
                    .color(t.ink_soft),
            );
        }
        pocket = pocket.gap(7.0).child(meta);
    }
    let mut stage = el().size(200.0, 116.0).child(sheet);
    for (i, change) in changes.into_iter().flatten().take(3).enumerate() {
        let add = change["added"].as_i64().unwrap_or(0);
        let del = change["removed"].as_i64().unwrap_or(0);
        let mut paper = col()
            .size(50.0, 62.0)
            .padding(8.0)
            .gap(3.0)
            .radius(6.0)
            .fill(t.raised_high)
            .shadow(0.0, 4.0, t.line)
            .child(el().size(10.0, 9.0).radius(2.0).fill(t.hover));
        for (width, color) in [
            (16.0, t.faint),
            (
                10.0,
                if del > 0 {
                    rune::color::hex("#e86b79").unwrap()
                } else {
                    t.faint
                },
            ),
            (
                13.0,
                if add > 0 {
                    rune::color::hex("#35ae83").unwrap()
                } else {
                    t.faint
                },
            ),
        ] {
            paper = paper.child(el().size(width, 3.0).radius(2.0).fill(color));
        }
        stage = stage.child(paper.absolute([44.0, 78.0, 112.0][i], [0.0, -6.0, 0.0][i]));
    }
    stage.child(pocket)
}

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let t = Palette::new(cx.system_dark());
    let header = row()
        .w_full()
        .center_y()
        .justify_between()
        .child(wordmark(t))
        .child(
            row()
                .center_y()
                .gap(12.0)
                .child(
                    el().size(36.0, 36.0)
                        .center()
                        .child(icon(&SETTINGS, 16.0).color(t.muted)),
                )
                .child(
                    row()
                        .h(36.0)
                        .px(12.0)
                        .gap(10.0)
                        .center_y()
                        .radius(11.0)
                        .fill(t.hover)
                        .child(icon(&SEARCH, 15.0).color(t.muted))
                        .child(
                            text_input(&s.search, TextStyle::new(14.0, 400.0))
                                .key("project-search")
                                .w(176.0)
                                .single_line()
                                .placeholder("Search projects", t.muted)
                                .color(t.ink)
                                .on_edit(|s: &mut AppState| &mut s.search),
                        )
                        .child(text("⌘K").font(TextStyle::new(10.0, 400.0)).color(t.muted)),
                )
                .child(
                    el().h(36.0)
                        .px(12.0)
                        .center()
                        .radius(11.0)
                        .hover(t.hover)
                        .child(
                            text(match s.project_data.sort {
                                ProjectSort::Recent => "Recent  ⌄",
                                ProjectSort::Name => "Name  ⌄",
                            })
                            .font(TextStyle::new(14.0, 500.0))
                            .color(t.ink_soft),
                        )
                        .on_press(|s: &mut AppState| {
                            s.project_data.sort = match s.project_data.sort {
                                ProjectSort::Recent => ProjectSort::Name,
                                ProjectSort::Name => ProjectSort::Recent,
                            };
                        }),
                ),
        );
    let mut cells: Vec<El> = s
        .sorted_projects()
        .into_iter()
        .filter(|(_, p)| {
            p.name
                .to_lowercase()
                .contains(&s.search.text.trim().to_lowercase())
        })
        .map(|(i, p)| {
            let path = p.path.clone();
            let menu_path = path.clone();
            let pin_path = path.clone();
            let reveal_path = path.clone();
            let forget_path = path.clone();
            let pinned = s.project_data.metadata.get(&path).is_some_and(|m| m.pinned);
            let menu_open = s.project_data.menu_path.as_deref() == Some(path.as_str());
            let mut tile = row().center_y().gap(6.0).child(
                folder(&p.name, t)
                    .key(format!("project-{i}"))
                    .on_press(move |s: &mut AppState| s.open_project(path.clone())),
            );
            let mut menu = col().gap(3.0).child(
                el().size(24.0, 24.0)
                    .center()
                    .radius(6.0)
                    .hover(t.hover)
                    .child(text("⋯").font(TextStyle::new(18.0, 500.0)).color(t.muted))
                    .on_press(move |s: &mut AppState| {
                        s.project_data.menu_path =
                            if s.project_data.menu_path.as_deref() == Some(menu_path.as_str()) {
                                None
                            } else {
                                Some(menu_path.clone())
                            };
                    }),
            );
            if menu_open {
                for (label, action) in [
                    (if pinned { "Unpin" } else { "Pin" }, 0),
                    ("Reveal", 1),
                    ("Forget", 2),
                ] {
                    let pin_path = pin_path.clone();
                    let reveal_path = reveal_path.clone();
                    let forget_path = forget_path.clone();
                    menu = menu.child(
                        el().px(4.0)
                            .h(22.0)
                            .center()
                            .radius(5.0)
                            .hover(t.hover)
                            .child(
                                text(label)
                                    .font(TextStyle::new(10.0, 500.0))
                                    .color(t.ink_soft),
                            )
                            .on_press(move |s: &mut AppState| match action {
                                0 => s.pin_project(pin_path.clone()),
                                1 => s.reveal_project(reveal_path.clone()),
                                _ => s.forget_project(forget_path.clone()),
                            }),
                    );
                }
            }
            tile = tile.child(menu);
            tile
        })
        .collect();
    let no_matches = cells.is_empty();
    cells.push(actions(t).opacity(0.65));
    let mut grid = col().gap(24.0);
    let mut iter = cells.into_iter();
    loop {
        let Some(first) = iter.next() else { break };
        let mut line = row()
            .w_full()
            .gap(56.0)
            .center_y()
            .child(el().w(236.0).child(first));
        for _ in 0..2 {
            if let Some(cell) = iter.next() {
                line = line.child(el().w(236.0).child(cell));
            }
        }
        grid = grid.child(line);
    }
    if no_matches {
        grid = grid.child(
            el().pt(24.0).child(
                text(format!("No projects match “{}”", s.search.text))
                    .font(
                        TextStyle::new(12.0, 400.0)
                            .family(Family::Mono)
                            .tracking(0.6),
                    )
                    .color(t.muted),
            ),
        );
    }
    col()
        .w_full()
        .h_full()
        .fill(t.ground)
        .px(64.0)
        .pt(20.0)
        .child(header)
        .child(
            row()
                .w_full()
                .justify_center()
                .pt(86.0)
                .child(col().w(820.0).child(grid)),
        )
        .child(
            row()
                .w_full()
                .justify_center()
                .pt(96.0)
                .child(
                    el().w(820.0)
                        .child(sessions(&s.project_data.home_sessions, t, true)),
                ),
        )
}

fn time_ago(timestamp: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let seconds = ((now - timestamp).max(0)) / 1000;
    if seconds < 60 {
        "now".into()
    } else if seconds < 3600 {
        format!("{}m ago", seconds / 60)
    } else if seconds < 86400 {
        format!("{}h ago", seconds / 3600)
    } else {
        format!("{}d ago", seconds / 86400)
    }
}

fn token_count(tokens: i64) -> String {
    if tokens >= 1_000_000 {
        let value = format!("{:.2}", tokens as f64 / 1_000_000.0);
        format!("{}M", value.trim_end_matches('0').trim_end_matches('.'))
    } else if tokens >= 1000 {
        format!("{}K", tokens / 1000)
    } else {
        tokens.to_string()
    }
}

pub(super) fn sessions(sessions: &[ProjectSession], t: Palette, home: bool) -> El {
    let mut list = col().w_full().gap(16.0);
    for (pinned, label) in [(true, "PINNED"), (false, "RECENT")] {
        let group: Vec<_> = sessions
            .iter()
            .filter(|session| session.pinned == pinned)
            .collect();
        if group.is_empty() {
            continue;
        }
        list = list.child(
            row()
                .center_y()
                .gap(8.0)
                .child(icon(if pinned { &PIN } else { &CLOCK }, 12.0).color(t.muted))
                .child(
                    text(label)
                        .font(
                            TextStyle::new(10.0, 500.0)
                                .family(Family::Mono)
                                .tracking(1.2),
                        )
                        .color(if pinned { t.folder } else { t.muted }),
                ),
        );
        for session in group {
            let id = session.id.clone();
            let path = session.project_path.clone();
            let mut metadata = row().gap(10.0).center_y();
            let mono = TextStyle::new(11.0, 400.0).family(Family::Mono);
            if !session.provider.is_empty() {
                metadata = metadata.child(text(session.provider.clone()).font(mono).color(t.muted));
            }
            if home {
                if let Some(project) = std::path::Path::new(&session.project_path)
                    .file_name()
                    .and_then(|p| p.to_str())
                {
                    metadata = metadata.child(text(project.to_owned()).font(mono).color(t.muted));
                }
            }
            if let Some(branch) = &session.branch {
                metadata = metadata.child(
                    row()
                        .center_y()
                        .gap(4.0)
                        .child(icon(&BRANCH, 12.0).color(t.muted))
                        .child(text(branch.clone()).font(mono).color(t.muted)),
                );
            }
            if session.added > 0 {
                metadata = metadata.child(
                    text(format!("+{}", session.added))
                        .font(mono)
                        .color(rune::color::hex("#35ae83").unwrap()),
                );
            }
            if session.removed > 0 {
                metadata = metadata.child(
                    text(format!("−{}", session.removed))
                        .font(mono)
                        .color(rune::color::hex("#e86b79").unwrap()),
                );
            }
            metadata = metadata.child(text(time_ago(session.updated_at)).font(mono).color(t.faint));
            let mut item = row()
                .w_full()
                .h(48.0)
                .gap(14.0)
                .center_y()
                .radius(10.0)
                .hover(t.hover)
                .child(
                    el().size(36.0, 36.0)
                        .radius(18.0)
                        .fill(t.hover)
                        .center()
                        .child(icon(&CHAT, 16.0).color(t.muted)),
                )
                .child(
                    col()
                        .grow(1.0)
                        .gap(4.0)
                        .child(
                            text(session.title.clone())
                                .font(TextStyle::new(16.0, 500.0))
                                .color(t.ink_soft)
                                .truncate(),
                        )
                        .child(metadata),
                );
            if session.tokens > 0 {
                item = item.child(
                    col()
                        .gap(2.0)
                        .child(
                            text(token_count(session.tokens))
                                .font(TextStyle::new(23.0, 400.0).family(Family::Mono))
                                .color(t.ink_soft),
                        )
                        .child(
                            text("TOKENS")
                                .font(
                                    TextStyle::new(9.0, 400.0)
                                        .family(Family::Mono)
                                        .tracking(1.0),
                                )
                                .color(t.faint),
                        ),
                );
            }
            list = list.child(item.on_press(move |s: &mut AppState| {
                if home {
                    s.open_home_session(path.clone(), id.clone())
                } else {
                    s.open_recent_session(id.clone())
                }
            }));
        }
    }
    list
}

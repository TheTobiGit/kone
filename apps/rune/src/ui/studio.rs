use rune::{Cx, El, Icon, ScrollSpec, TextStyle, col, el, icon, row, text, text_input};

use crate::{
    state::{AppState, StudioState},
    theme::Palette,
};

static EXPAND: Icon = Icon {
    name: "studio-expand",
    view: 24.0,
    body: r#"<path d="M16.4999 3.26621C17.3443 3.25421 20.1408 2.67328 20.7337 3.26621C21.3266 3.85913 20.7457 6.65559 20.7337 7.5M20.5059 3.49097L13.5021 10.4961M3.26636 16.5001C3.25436 17.3445 2.67343 20.141 3.26636 20.7339C3.85928 21.3268 6.65574 20.7459 7.50015 20.7339M10.502 13.4976L3.49824 20.5027" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static SHRINK: Icon = Icon {
    name: "studio-shrink",
    view: 24.0,
    body: r#"<path d="M6.5023 10.7365C7.34671 10.7485 10.1432 11.3294 10.7361 10.7365C11.329 10.1436 10.7481 7.34708 10.7361 6.50267M13.2685 17.5027C13.2565 16.6583 12.6756 13.8618 13.2685 13.2689C13.8614 12.676 16.6579 13.2569 17.5023 13.2689M20.9991 21.001L13.6102 13.6188M10.3691 10.3763L2.99998 2.99902" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static CLOSE: Icon = Icon {
    name: "studio-close",
    view: 24.0,
    body: r#"<path d="M18 6L6.00081 17.9992M17.9992 18L6 6.00085" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>"#,
};

static STUDIO_PROVIDER_CODEX: Icon = Icon {
    name: "studio-provider-codex",
    view: 24.0,
    body: r#"<path d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z" fill="currentColor" fill-rule="evenodd"/>"#,
};
static STUDIO_PROVIDER_GPT: Icon = Icon {
    name: "studio-provider-gpt",
    view: 24.0,
    body: r#"<path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.998-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.142-.08 4.778-2.758a.795.795 0 0 0 .393-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.495 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.677l5.815 3.354-2.02 1.169a.076.076 0 0 1-.071 0l-4.83-2.787A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.856-5.833-3.388L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.666zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.062l4.83-2.786a4.5 4.5 0 0 1 6.68 4.66zM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.057V6.074a4.5 4.5 0 0 1 7.376-3.454l-.142.08L8.704 5.46a.795.795 0 0 0-.393.68zm1.098-2.366 2.602-1.5 2.607 1.5v3l-2.597 1.5-2.607-1.5z" fill="currentColor" fill-rule="evenodd"/>"#,
};
static STUDIO_PROVIDER_CURSOR: Icon = Icon {
    name: "studio-provider-cursor",
    view: 24.0,
    body: r#"<path d="M22.07 5.7L12.5 0.18C12.19 0 11.81 0 11.5 0.18L1.93 5.7C1.67 5.85 1.51 6.13 1.51 6.43V17.57C1.51 17.87 1.67 18.15 1.93 18.3L11.5 23.82C11.81 24 12.19 24 12.5 23.82L22.07 18.3C22.33 18.15 22.49 17.87 22.49 17.57V6.43C22.49 6.13 22.33 5.85 22.07 5.7H22.07ZM21.47 6.87L12.23 22.88C12.16 22.99 12 22.94 12 22.82V12.34C12 12.13 11.89 11.94 11.71 11.83L2.63 6.59C2.52 6.53 2.57 6.36 2.69 6.36H21.17C21.44 6.36 21.6 6.65 21.47 6.88H21.47Z" fill="currentColor" fill-rule="evenodd"/>"#,
};
static STUDIO_PROVIDER_OPENCODE: Icon = Icon {
    name: "studio-provider-opencode",
    view: 24.0,
    body: r#"<path d="M22 24H2V0h20zM17 4.8H7v14.4h10z" fill="currentColor" fill-rule="evenodd"/>"#,
};
static STUDIO_PROVIDER_CLAUDE: Icon = Icon {
    name: "studio-provider-claude",
    view: 256.0,
    body: r#"<path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z" fill="currentColor" fill-rule="evenodd"/>"#,
};

pub(super) fn provider_mark(state: Option<&StudioState>, t: Palette) -> El {
    let provider = state
        .and_then(|s| s.providers.get(s.provider_index))
        .map(|p| p.id.as_str())
        .unwrap_or("codex");
    let model = state
        .and_then(|s| s.models.get(s.model_index))
        .map(|m| m.id.as_str())
        .unwrap_or("");
    let mark = if model.starts_with("gpt-") {
        &STUDIO_PROVIDER_GPT
    } else {
        match provider {
            "claudeAgent" => &STUDIO_PROVIDER_CLAUDE,
            "cursor" => &STUDIO_PROVIDER_CURSOR,
            "opencode" => &STUDIO_PROVIDER_OPENCODE,
            _ => &STUDIO_PROVIDER_CODEX,
        }
    };
    icon(mark, 15.0).color(if provider == "claudeAgent" {
        t.accent
    } else {
        t.ink_soft
    })
}

fn label(value: impl Into<String>, size: f32, weight: f32, color: rune::Color) -> El {
    text(value).font(TextStyle::new(size, weight)).color(color)
}

fn project_nav(s: &AppState, t: Palette) -> El {
    let mut nav = row().center_y().gap(4.0);
    for (index, project) in s.projects.iter().enumerate() {
        let has_row = s.studio_layout["rows"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|r| r["projectPath"] == project.path));
        if !has_row && Some(index) != s.selected_project {
            continue;
        }
        let path = project.path.clone();
        nav = nav.child(
            el().key(format!("studio-row-{index}"))
                .px(8.0)
                .h(26.0)
                .center()
                .radius(8.0)
                .hover(t.hover)
                .child(label(
                    project.name.clone(),
                    12.0,
                    500.0,
                    if Some(index) == s.selected_project {
                        t.ink
                    } else {
                        t.muted
                    },
                ))
                .on_press_tx(move |s: &mut AppState, tx| {
                    s.select_studio_project(index);
                    tx.scroll_into_view(format!("studio-row-slot-{path}"));
                }),
        );
    }
    nav
}

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let t = Palette::new(cx.system_dark());
    if s.selected_project.is_none() {
        let mut choices = col().w(300.0).gap(4.0);
        for (index, project) in s.projects.iter().enumerate() {
            choices = choices.child(
                row()
                    .key(format!("studio-project-{index}"))
                    .w_full()
                    .h(44.0)
                    .px(12.0)
                    .center_y()
                    .radius(10.0)
                    .hover(t.hover)
                    .child(label(project.name.clone(), 14.0, 600.0, t.ink).grow(1.0))
                    .child(label("→", 15.0, 400.0, t.muted))
                    .on_press(move |s: &mut AppState| s.select_studio_project(index)),
            );
        }
        return col().w_full().h_full().fill(t.ground).center().child(
            col()
                .items_center()
                .gap(18.0)
                .child(label("Choose a project", 16.0, 600.0, t.ink))
                .child(choices),
        );
    }
    let (viewport_w, viewport_h) = if s.studio_viewport.0 > 0.0 {
        s.studio_viewport
    } else {
        (1280.0, 840.0)
    };
    let mut plane = col().w_full();
    let rows = s.studio_layout["rows"].as_array();
    let mut selected_present = false;
    if let Some(rows) = rows {
        for saved in rows {
            let Some(path) = saved["projectPath"].as_str() else {
                continue;
            };
            let Some(index) = s.projects.iter().position(|p| p.path == path) else {
                continue;
            };
            let selected = Some(index) == s.selected_project;
            selected_present |= selected;
            plane = plane.child(studio_row(
                s, saved, index, selected, viewport_w, viewport_h, t,
            ));
        }
    }
    if !selected_present && let Some(index) = s.selected_project {
        let empty = serde_json::json!({"projectPath":s.projects[index].path,"panes":[]});
        plane = plane.child(studio_row(
            s, &empty, index, true, viewport_w, viewport_h, t,
        ));
    }
    col()
        .key("studio-plane")
        .w_full()
        .h_full()
        .fill(t.ground)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .on_layout_tx(|s: &mut AppState, [_, _, w, h], tx| {
            s.studio_viewport = (w, h);
            if let Some(path) = s.studio_scroll_row.take() {
                tx.scroll_into_view(format!("studio-row-slot-{path}"));
                if !s.studio.thread_id.is_empty() {
                    tx.scroll_into_view(format!("studio-pane-{}", s.studio.thread_id));
                }
            }
        })
        .child(plane)
}

fn studio_row(
    s: &AppState,
    saved: &serde_json::Value,
    project_index: usize,
    selected_row: bool,
    viewport_w: f32,
    viewport_h: f32,
    t: Palette,
) -> El {
    let project = &s.projects[project_index];
    let path = project.path.clone();
    let panes = saved["panes"].as_array();
    let mut rail = row().h_full();
    let count = panes.map_or(0, Vec::len);
    if count == 1 {
        rail = rail.w_full().justify_center();
    }
    if let Some(panes) = panes {
        for (i, pane) in panes.iter().enumerate() {
            let Some(thread) = pane["anchor"]["threadId"].as_str() else {
                continue;
            };
            let focused = selected_row && thread == s.studio.thread_id;
            let state = if focused {
                Some(&s.studio)
            } else {
                s.studio_threads.get(thread)
            };
            let width = [840.0_f32, 960.0, 1120.0, 1240.0]
                [(pane["width"].as_u64().unwrap_or(0) as usize).min(3)]
            .min(viewport_w);
            let zen = focused && pane["zen"].as_bool().unwrap_or(false);
            let width = if zen { viewport_w } else { width };
            let id = thread.to_owned();
            let focus_id = id.clone();
            let width_id = id.clone();
            let zen_id = id.clone();
            let close_id = id.clone();
            let project_path = path.clone();
            let title = state
                .and_then(|state| {
                    state
                        .items
                        .iter()
                        .find(|item| item.kind == "user" && !item.text.is_empty())
                })
                .map(|item| {
                    item.text
                        .lines()
                        .next()
                        .unwrap_or("New thread")
                        .chars()
                        .take(36)
                        .collect::<String>()
                })
                .unwrap_or_else(|| "New thread".into());
            let head = row()
                .w_full()
                .h(38.0)
                .center_y()
                .justify_between()
                .child(el().w(100.0))
                .child(
                    row()
                        .gap(8.0)
                        .center_y()
                        .child(provider_mark(state, t))
                        .child(label(
                            title,
                            13.5,
                            620.0,
                            if focused { t.ink } else { t.muted },
                        )),
                )
                .child(
                    row()
                        .w(100.0)
                        .justify_end()
                        .center_y()
                        .gap(2.0)
                        .child(
                            el().key(format!("studio-width-{id}"))
                                .px(4.0)
                                .h(22.0)
                                .center()
                                .radius(6.0)
                                .hover(t.hover)
                                .child(label(
                                    if zen {
                                        "max".into()
                                    } else {
                                        format!("{width:.0}")
                                    },
                                    10.0,
                                    600.0,
                                    t.muted,
                                ))
                                .on_press(move |s: &mut AppState| {
                                    s.select_studio_project(project_index);
                                    s.open_studio_thread(width_id.clone());
                                    s.cycle_studio_width(&width_id);
                                }),
                        )
                        .child(
                            el().key(format!("studio-zen-{id}"))
                                .w(20.0)
                                .h(20.0)
                                .center()
                                .radius(6.0)
                                .hover(t.hover)
                                .child(
                                    icon(if zen { &SHRINK } else { &EXPAND }, 13.0).color(t.muted),
                                )
                                .on_press_tx(move |s: &mut AppState, tx| {
                                    s.select_studio_project(project_index);
                                    s.open_studio_thread(zen_id.clone());
                                    s.toggle_studio_zen(&zen_id);
                                    tx.scroll_into_view(format!("studio-pane-{zen_id}"));
                                }),
                        )
                        .child(
                            el().key(format!("studio-close-{id}"))
                                .w(20.0)
                                .h(20.0)
                                .center()
                                .radius(6.0)
                                .hover(t.hover)
                                .child(icon(&CLOSE, 13.0).color(t.muted))
                                .on_press(move |s: &mut AppState| {
                                    s.select_studio_project(project_index);
                                    s.close_studio_thread(&close_id);
                                }),
                        ),
                );
            let body = if focused {
                focused_body(s, &project.name, t)
            } else if let Some(state) = state {
                parked_body(state, &id, t)
            } else {
                col().w_full().grow(1.0)
            };
            if i == 0 {
                rail = rail.child(
                    el().key(format!("studio-seam-{path}-0"))
                        .w(14.0)
                        .h_full()
                        .center()
                        .child(el().w(5.0).h(18.0).radius(3.0).fill(t.ink.alpha(0.32)))
                        .on_press_tx(move |s: &mut AppState, tx| {
                            s.select_studio_project(project_index);
                            s.insert_studio_thread(0);
                            tx.scroll_into_view(format!("studio-pane-{}", s.studio.thread_id));
                        }),
                );
            }
            rail = rail.child(
                col()
                    .key(format!("studio-pane-{id}"))
                    .w(width)
                    .h_full()
                    .pt(24.0)
                    .on_press_tx(move |s: &mut AppState, tx| {
                        s.select_studio_project(project_index);
                        s.open_studio_thread(focus_id.clone());
                        tx.scroll_into_view(format!("studio-row-slot-{project_path}"));
                        tx.scroll_into_view(format!("studio-pane-{focus_id}"));
                    })
                    .child(head)
                    .child(body),
            );
            rail = rail.child(
                el().key(format!("studio-seam-{path}-{}", i + 1))
                    .w(14.0)
                    .h_full()
                    .center()
                    .child(el().w(5.0).h(18.0).radius(3.0).fill(t.ink.alpha(0.32)))
                    .on_press_tx(move |s: &mut AppState, tx| {
                        s.select_studio_project(project_index);
                        s.insert_studio_thread(i + 1);
                        tx.scroll_into_view(format!("studio-pane-{}", s.studio.thread_id));
                    }),
            );
        }
        if count > 1 {
            rail = rail.child(el().w((viewport_w / 2.0 - 420.0).max(0.0)).h_full());
        }
    }
    let mut bar = row().w_full().h(32.0).px(32.0).justify_between().center_y();
    if count > 1 {
        let mut dashes = row().gap(5.0).center_y();
        for pane in panes.into_iter().flatten() {
            if let Some(thread) = pane["anchor"]["threadId"].as_str() {
                let id = thread.to_owned();
                let project_path = path.clone();
                dashes = dashes.child(
                    el().key(format!("studio-index-{id}"))
                        .w(if selected_row && id == s.studio.thread_id {
                            22.0
                        } else {
                            14.0
                        })
                        .h(20.0)
                        .center()
                        .child(el().w_full().h(2.0).radius(1.0).fill(
                            if selected_row && id == s.studio.thread_id {
                                t.ink
                            } else {
                                t.faint
                            },
                        ))
                        .on_press_tx(move |s: &mut AppState, tx| {
                            s.select_studio_project(project_index);
                            s.open_studio_thread(id.clone());
                            tx.scroll_into_view(format!("studio-row-slot-{project_path}"));
                            tx.scroll_into_view(format!("studio-pane-{id}"));
                        }),
                );
            }
        }
        bar = bar.child(dashes);
    } else {
        bar = bar.child(el().w(24.0));
    }
    bar = bar.child(project_nav(s, t));
    let content = if count == 0 {
        let parent = project.path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        col().w_full().grow(1.0).center().child(
            col()
                .w(256.0)
                .items_center()
                .gap(10.0)
                .child(
                    col()
                        .w(176.0)
                        .h(98.0)
                        .radius(12.0)
                        .fill(t.folder)
                        .justify_end()
                        .padding(14.0)
                        .child(label(project.name.clone(), 14.0, 600.0, t.accent_ink)),
                )
                .child(label(parent.to_owned(), 12.0, 450.0, t.muted))
                .child(el().h(10.0))
                .child(
                    row()
                        .key("studio-new-thread")
                        .w_full()
                        .h(40.0)
                        .px(11.0)
                        .gap(10.0)
                        .center_y()
                        .radius(12.0)
                        .hover(t.hover)
                        .child(label("◯", 16.0, 500.0, t.muted))
                        .child(label("New thread", 13.5, 500.0, t.ink_soft).grow(1.0))
                        .child(label("⌘ N", 11.0, 500.0, t.muted))
                        .on_press_tx(move |s: &mut AppState, tx| {
                            s.select_studio_project(project_index);
                            s.new_studio_thread();
                            tx.scroll_into_view(format!("studio-pane-{}", s.studio.thread_id));
                        }),
                ),
        )
    } else {
        col()
            .key(format!("studio-rail-{path}"))
            .w_full()
            .grow(1.0)
            .shrink()
            .scroll_x()
            .child(rail)
    };
    col()
        .key(format!("studio-row-slot-{path}"))
        .w_full()
        .h(viewport_h)
        .fill(t.ground)
        .child(bar)
        .child(content)
}

fn parked_body(state: &StudioState, id: &str, t: Palette) -> El {
    let mut transcript = col().w_full().max_w(680.0).gap(34.0).self_center().py(34.0);
    for item in &state.items {
        if item.text.is_empty() && item.name.is_empty() {
            continue;
        }
        let value = if item.kind == "tool_call" {
            format!("{}  {}", item.name, item.text)
        } else {
            item.text.clone()
        };
        let mut line = label(value, 14.0, 400.0, t.muted).w_full();
        if item.kind == "user" {
            line = line.padding(14.0).radius(14.0).fill(t.hover);
        }
        transcript = transcript.child(line);
    }
    col()
        .key(format!("studio-parked-{id}"))
        .w_full()
        .grow(1.0)
        .shrink()
        .child(transcript)
}

fn resting_orb(t: Palette) -> El {
    el().w(55.0)
        .h(55.0)
        .radius(27.5)
        .fill(t.ink)
        .child(
            el().w(5.0)
                .h(11.0)
                .radius(2.5)
                .fill(t.ground)
                .rotate(-0.43)
                .absolute(30.0, 11.0),
        )
        .child(
            el().w(4.0)
                .h(9.0)
                .radius(2.0)
                .fill(t.ground)
                .rotate(-0.43)
                .absolute(41.0, 8.0),
        )
}

fn focused_body(s: &AppState, name: &str, t: Palette) -> El {
    let dock =
        if let Some(approval) = &s.studio.approval {
            col()
                .w_full()
                .max_w(680.0)
                .padding(18.0)
                .gap(12.0)
                .radius(20.0)
                .border(1.0, t.line)
                .fill(t.raised_high)
                .child(label("Approval requested", 12.0, 600.0, t.muted))
                .child(label(approval.title.clone(), 14.0, 600.0, t.ink))
                .child(label(approval.detail.clone(), 13.0, 400.0, t.ink_soft))
                .child(
                    row()
                        .gap(8.0)
                        .child(
                            el().key("approval-reject")
                                .px(14.0)
                                .h(32.0)
                                .center()
                                .radius(9.0)
                                .hover(t.hover)
                                .child(label("Decline", 12.5, 500.0, t.ink_soft))
                                .on_press(|s: &mut AppState| s.answer_approval("reject-once")),
                        )
                        .child(
                            el().key("approval-allow")
                                .px(14.0)
                                .h(32.0)
                                .center()
                                .radius(9.0)
                                .fill(t.accent)
                                .child(label("Allow once", 12.5, 500.0, t.accent_ink))
                                .on_press(|s: &mut AppState| s.answer_approval("allow-once")),
                        ),
                )
        } else if let Some(request) = &s.studio.question {
            let question = &request.questions[request.index];
            let mut card = col()
                .w_full()
                .max_w(680.0)
                .padding(18.0)
                .gap(12.0)
                .radius(20.0)
                .border(1.0, t.line)
                .fill(t.raised_high)
                .child(label(question.prompt.clone(), 14.0, 600.0, t.ink));
            for (index, option) in question.options.iter().enumerate() {
                let answer = option.clone();
                let multi = question.multi;
                let prefix = if multi {
                    if request.selected.contains(option) {
                        "☑  "
                    } else {
                        "□  "
                    }
                } else {
                    ""
                };
                card = card.child(
                    el().key(format!("question-option-{index}"))
                        .w_full()
                        .h(32.0)
                        .px(8.0)
                        .center_y()
                        .radius(8.0)
                        .hover(t.hover)
                        .child(label(format!("{prefix}{option}"), 13.0, 500.0, t.ink_soft))
                        .on_press(move |s: &mut AppState| {
                            if multi {
                                s.toggle_question_option(answer.clone());
                            } else {
                                s.answer_question(answer.clone().into());
                            }
                        }),
                );
            }
            if question.multi {
                card.child(
                    el().key("question-submit")
                        .h(32.0)
                        .px(12.0)
                        .center()
                        .radius(9.0)
                        .fill(t.accent)
                        .child(label("Continue", 12.5, 500.0, t.accent_ink))
                        .on_press(|s: &mut AppState| {
                            let selected = s
                                .studio
                                .question
                                .as_ref()
                                .map(|q| q.selected.clone())
                                .unwrap_or_default();
                            s.answer_question(serde_json::json!(selected));
                        }),
                )
            } else {
                card.child(
                    text_input(&s.studio.answer, TextStyle::new(14.0, 400.0))
                        .key("studio-answer")
                        .w_full()
                        .h(38.0)
                        .placeholder("Your answer…", t.placeholder)
                        .color(t.ink)
                        .on_edit(|s: &mut AppState| &mut s.studio.answer)
                        .on_submit(|s: &mut AppState, _: &mut rune::Tx| {
                            let answer = s.studio.answer.text.clone();
                            s.answer_question(answer.into());
                        }),
                )
            }
        } else if s.studio.composer_open {
            let input = text_input(&s.composer, TextStyle::new(14.0, 400.0))
                .key("studio-composer")
                .placeholder("Ask anything…", t.placeholder)
                .color(t.ink)
                .w_full()
                .h(54.0)
                .on_edit(|s: &mut AppState| &mut s.composer)
                .on_submit(AppState::send_studio);
            let bar = row()
                .w_full()
                .h(39.0)
                .center_y()
                .gap(8.0)
                .child(label("+", 21.0, 400.0, t.muted))
                .child(
                    el().key("studio-mode-picker")
                        .px(7.0)
                        .h(30.0)
                        .center()
                        .radius(9.0)
                        .hover(t.hover)
                        .child(label(
                            if s.studio.mode.is_empty() {
                                "Ask"
                            } else {
                                &s.studio.mode
                            },
                            12.0,
                            500.0,
                            t.ink_soft,
                        ))
                        .on_press(|s: &mut AppState| {
                            s.studio.mode_picker_open = !s.studio.mode_picker_open;
                            s.studio.effort_picker_open = false;
                            s.studio.picker_open = false;
                        }),
                )
                .child(el().grow(1.0))
                .child(
                    el().key("studio-model-picker")
                        .px(7.0)
                        .h(30.0)
                        .center()
                        .radius(9.0)
                        .hover(t.hover)
                        .child(label(
                            format!(
                                "{}  {}",
                                s.studio
                                    .providers
                                    .get(s.studio.provider_index)
                                    .map(|p| p.label.as_str())
                                    .unwrap_or("Select provider"),
                                s.studio
                                    .models
                                    .get(s.studio.model_index)
                                    .map(|m| m.label.as_str())
                                    .unwrap_or("")
                            ),
                            12.5,
                            500.0,
                            t.ink_soft,
                        ))
                        .on_press(|s: &mut AppState| s.studio.picker_open = !s.studio.picker_open),
                )
                .child(
                    el().key("studio-effort-picker")
                        .px(7.0)
                        .h(30.0)
                        .center()
                        .radius(9.0)
                        .hover(t.hover)
                        .child(label(
                            if s.studio.effort.is_empty() {
                                "Effort"
                            } else {
                                &s.studio.effort
                            },
                            12.0,
                            500.0,
                            t.ink_soft,
                        ))
                        .on_press(|s: &mut AppState| {
                            s.studio.effort_picker_open = !s.studio.effort_picker_open;
                            s.studio.mode_picker_open = false;
                            s.studio.picker_open = false;
                        }),
                )
                .child(
                    el().w(32.0)
                        .h(32.0)
                        .center()
                        .radius(16.0)
                        .fill(t.accent)
                        .child(label(
                            if s.studio.busy { "■" } else { "↑" },
                            18.0,
                            600.0,
                            t.accent_ink,
                        ))
                        .on_press_tx(|s: &mut AppState, tx| {
                            if s.studio.busy {
                                s.interrupt_studio();
                            } else {
                                s.send_studio(tx);
                            }
                        }),
                );
            let mut picker = col()
                .w_full()
                .max_w(360.0)
                .padding(6.0)
                .gap(2.0)
                .radius(14.0)
                .border(1.0, t.line)
                .fill(t.raised_high);
            if s.studio.picker_open {
                picker = picker.child(label("PROVIDER", 10.0, 600.0, t.muted).px(8.0).py(4.0));
                for (index, provider) in s.studio.providers.iter().enumerate() {
                    picker = picker.child(
                        el().key(format!("provider-{index}"))
                            .w_full()
                            .h(32.0)
                            .px(8.0)
                            .center_y()
                            .radius(8.0)
                            .hover(t.hover)
                            .child(label(
                                format!(
                                    "{}{}",
                                    if index == s.studio.provider_index {
                                        "✓  "
                                    } else {
                                        "    "
                                    },
                                    provider.label
                                ),
                                12.5,
                                500.0,
                                t.ink,
                            ))
                            .on_press(move |s: &mut AppState| s.select_provider(index)),
                    );
                }
                picker = picker.child(label("MODEL", 10.0, 600.0, t.muted).px(8.0).py(4.0));
                for (index, model) in s.studio.models.iter().enumerate() {
                    picker = picker.child(
                        el().key(format!("model-{index}"))
                            .w_full()
                            .h(32.0)
                            .px(8.0)
                            .center_y()
                            .radius(8.0)
                            .hover(t.hover)
                            .child(label(
                                format!(
                                    "{}{}",
                                    if index == s.studio.model_index {
                                        "✓  "
                                    } else {
                                        "    "
                                    },
                                    model.label
                                ),
                                12.5,
                                500.0,
                                t.ink,
                            ))
                            .on_press(move |s: &mut AppState| {
                                s.studio.model_index = index;
                                s.studio.effort = s.studio.models[index]
                                    .default_effort
                                    .clone()
                                    .unwrap_or_default();
                                s.studio.picker_open = false;
                            }),
                    );
                }
            }
            let mut dock = col().w_full().max_w(680.0).items_center();
            if s.studio.picker_open {
                dock = dock.child(picker);
            }
            if s.studio.mode_picker_open {
                let mut menu = col()
                    .w_full()
                    .max_w(240.0)
                    .padding(6.0)
                    .radius(14.0)
                    .border(1.0, t.line)
                    .fill(t.raised_high);
                for (value, title) in [
                    ("ask", "Ask"),
                    ("accept-edits", "Accept edits"),
                    ("full-access", "Full access"),
                ] {
                    menu = menu.child(
                        el().key(format!("mode-{value}"))
                            .w_full()
                            .h(32.0)
                            .px(8.0)
                            .center_y()
                            .hover(t.hover)
                            .child(label(title, 12.5, 500.0, t.ink))
                            .on_press(move |s: &mut AppState| {
                                s.studio.mode = value.into();
                                s.studio.mode_picker_open = false;
                            }),
                    );
                }
                dock = dock.child(menu);
            }
            if s.studio.effort_picker_open {
                let mut menu = col()
                    .w_full()
                    .max_w(240.0)
                    .padding(6.0)
                    .radius(14.0)
                    .border(1.0, t.line)
                    .fill(t.raised_high);
                if let Some(model) = s.studio.models.get(s.studio.model_index) {
                    for effort in &model.efforts {
                        let value = effort.clone();
                        menu = menu.child(
                            el().key(format!("effort-{effort}"))
                                .w_full()
                                .h(32.0)
                                .px(8.0)
                                .center_y()
                                .hover(t.hover)
                                .child(label(effort.clone(), 12.5, 500.0, t.ink))
                                .on_press(move |s: &mut AppState| {
                                    s.studio.effort = value.clone();
                                    s.studio.effort_picker_open = false;
                                }),
                        );
                    }
                }
                dock = dock.child(menu);
            }
            dock.child(
                col()
                    .w_full()
                    .padding(14.0)
                    .radius(26.0)
                    .border(1.0, t.line)
                    .fill(t.raised_high)
                    .child(input)
                    .child(bar),
            )
            .child(
                row()
                    .w_full()
                    .h(26.0)
                    .px(20.0)
                    .gap(16.0)
                    .center_y()
                    .child(label("ϟ  Guest", 11.5, 500.0, t.ink_soft))
                    .child(label(format!("▱  {name}"), 11.5, 500.0, t.ink_soft))
                    .child(el().grow(1.0))
                    .child(label("New thread", 11.5, 500.0, t.muted)),
            )
        } else {
            col().w_full().items_center().child(
                resting_orb(t)
                    .key("studio-wake-composer")
                    .on_press(|s: &mut AppState| {
                        s.studio.composer_open = true;
                        s.composer.focused = true;
                    }),
            )
        };
    let mut transcript = col().w_full().max_w(680.0).gap(34.0).self_center().py(34.0);
    for item in &s.studio.items {
        if item.text.is_empty() && item.name.is_empty() {
            continue;
        }
        let value = if item.kind == "tool_call" {
            format!("{}  {}", item.name, item.text)
        } else {
            item.text.clone()
        };
        let item_color = if item.kind == "reasoning_text" || item.kind == "tool_call" {
            t.muted
        } else {
            t.ink
        };
        let mut line = label(
            value,
            if item.kind == "tool_call" { 12.5 } else { 14.0 },
            400.0,
            item_color,
        )
        .w_full();
        if item.kind == "user" {
            line = line.padding(14.0).radius(14.0).fill(t.hover);
        }
        transcript = transcript.child(line);
    }
    if let Some(error) = &s.studio.error {
        transcript = transcript.child(label(error.clone(), 12.5, 400.0, t.accent));
    }
    col()
        .w_full()
        .grow(1.0)
        .shrink()
        .child(
            col()
                .key("studio-transcript")
                .w_full()
                .grow(1.0)
                .shrink()
                .scroll(ScrollSpec { stick_bottom: true })
                .child(transcript),
        )
        .child(row().w_full().px(16.0).justify_center().child(dock))
        .child(el().h(32.0))
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use crate::state::{Page, Project, StudioItem};
    use rune::{Env, Runtime};
    use serde_json::json;

    #[test]
    fn saved_project_rows_are_mounted_and_clicking_a_row_changes_focus() {
        let mut s = AppState {
            page: Page::Studio,
            studio_layout_ready: true,
            ..Default::default()
        };
        s.projects = vec![
            Project {
                name: "first".into(),
                path: "/first".into(),
            },
            Project {
                name: "second".into(),
                path: "/second".into(),
            },
        ];
        s.selected_project = Some(0);
        s.studio.project_path = "/first".into();
        s.studio.thread_id = "a".into();
        s.studio.thread_open = true;
        s.studio_layout = json!({"version":2,"rows":[
            {"projectPath":"/first","focusedId":"a","panes":[{"id":"a","anchor":{"threadId":"a"}}]},
            {"projectPath":"/second","focusedId":"b","panes":[{"id":"b","anchor":{"threadId":"b"}}]}
        ]});
        s.studio_threads.insert(
            "b".into(),
            StudioState {
                thread_id: "b".into(),
                project_path: "/second".into(),
                thread_open: true,
                ..Default::default()
            },
        );
        let mut rt = Runtime::new(s, view, (1280.0, 840.0), Env::new(false, 1.0));
        rt.frame(0.0);
        assert!(rt.find("studio-row-slot-/first").is_some());
        assert!(rt.find("studio-row-slot-/second").is_some());
        let (x, y) = rt.find("studio-row-1").unwrap();
        rt.pointer_move(x, y);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);
        assert_eq!(rt.state.studio.project_path, "/second");
        assert_eq!(rt.state.studio.thread_id, "b");
        assert_eq!(rt.state.studio_layout["focusedRow"], "/second");
    }

    #[test]
    fn rail_renders_and_focuses_a_streaming_background_thread() {
        let mut s = AppState::default();
        s.page = Page::Studio;
        s.projects.push(Project {
            name: "demo".into(),
            path: "/demo".into(),
        });
        s.selected_project = Some(0);
        s.studio_layout_ready = true;
        s.studio_layout = json!({"version": 2, "focusedRow": "/demo", "rows": [{"projectPath":"/demo", "focusedId":"a", "panes":[
            {"id":"a", "anchor":{"threadId":"a"}, "width":0},
            {"id":"b", "anchor":{"threadId":"b"}, "width":0}
        ]}]});
        s.studio.thread_open = true;
        s.studio.thread_id = "a".into();
        s.studio.project_path = "/demo".into();
        s.studio.items.push(StudioItem {
            id: "one".into(),
            kind: "assistant_text".into(),
            text: "first response".into(),
            name: String::new(),
        });
        s.studio_threads.insert(
            "b".into(),
            StudioState {
                thread_open: true,
                thread_id: "b".into(),
                project_path: "/demo".into(),
                items: vec![StudioItem {
                    id: "two".into(),
                    kind: "assistant_text".into(),
                    text: "background response".into(),
                    name: String::new(),
                }],
                ..Default::default()
            },
        );
        for (thread, content) in [("a", "foreground streaming"), ("b", "background streaming")] {
            s.studio_message(json!({"method":"agent.event", "params":{"threadId":thread, "type":"item.updated", "item":{"itemId":if thread == "a" { "one" } else { "two" }, "kind":"assistant_text", "text":content}}}));
        }
        let mut rt = Runtime::new(s, view, (1900.0, 800.0), Env::new(false, 1.0));
        rt.frame(0.0);
        assert!(rt.find("studio-pane-a").is_some());
        assert!(rt.find("studio-pane-b").is_some());
        assert!(
            rt.elements()
                .iter()
                .any(|e| e.text.as_deref() == Some("background streaming"))
        );
        let (x, y) = rt.find("studio-parked-b").unwrap();
        rt.pointer_move(x, y);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);
        assert_eq!(rt.state.studio.thread_id, "b");
        assert_eq!(rt.state.studio.items[0].text, "background streaming");
        assert_eq!(
            rt.state.studio_threads["a"].items[0].text,
            "foreground streaming"
        );
    }
}

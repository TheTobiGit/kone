use rune::{Cx, El, ScrollSpec, TextStyle, col, el, row, text, text_input};

use crate::{
    state::{AppState, StudioState},
    theme::Palette,
};

fn label(value: impl Into<String>, size: f32, weight: f32, color: rune::Color) -> El {
    text(value).font(TextStyle::new(size, weight)).color(color)
}

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let t = Palette::new(cx.system_dark());
    let project = s.selected_project.and_then(|i| s.projects.get(i));
    let name = project.map(|p| p.name.as_str()).unwrap_or("");
    let path = project
        .and_then(|p| p.path.rsplit_once('/').map(|(parent, _)| parent))
        .unwrap_or("");

    if !s.studio.thread_open {
        let folder = col()
            .w(176.0)
            .h(98.0)
            .radius(12.0)
            .fill(t.folder)
            .justify_end()
            .padding(14.0)
            .child(label(name.to_owned(), 14.0, 600.0, t.accent_ink));
        let action = row()
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
            .child(label("⌘", 11.0, 500.0, t.muted))
            .child(label("N", 11.0, 500.0, t.muted))
            .on_press_tx(|s: &mut AppState, tx| {
                s.new_studio_thread();
                tx.scroll_into_view(format!("studio-pane-{}", s.studio.thread_id));
            });
        return col().w_full().h_full().fill(t.ground).center().child(
            col()
                .w(256.0)
                .items_center()
                .gap(10.0)
                .child(folder)
                .child(label(path.to_owned(), 12.0, 450.0, t.muted))
                .child(el().h(10.0))
                .child(action),
        );
    }

    let panes = s.studio_layout["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| r["projectPath"] == s.studio.project_path)
        .and_then(|r| r["panes"].as_array());
    let mut rail = row().h_full().gap(14.0).px(24.0);
    if panes.is_some_and(|panes| panes.len() == 1) {
        rail = rail.w_full().justify_center();
    }
    if let Some(panes) = panes {
        for pane in panes {
            let Some(thread) = pane["anchor"]["threadId"].as_str() else {
                continue;
            };
            let focused = thread == s.studio.thread_id;
            let state = if focused {
                Some(&s.studio)
            } else {
                s.studio_threads.get(thread)
            };
            let Some(state) = state else { continue };
            let width = [840.0, 960.0, 1120.0, 1240.0]
                [(pane["width"].as_u64().unwrap_or(0) as usize).min(3)];
            let id = thread.to_owned();
            let close_id = id.clone();
            let width_id = id.clone();
            let focus_id = id.clone();
            let title = state
                .items
                .iter()
                .find(|item| item.kind == "user" && !item.text.is_empty())
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
                .child(
                    el().key(format!("studio-focus-{id}"))
                        .w(100.0)
                        .h(30.0)
                        .center_y()
                        .child(label(if focused { "+" } else { "◯" }, 16.0, 500.0, t.muted))
                        .on_press_tx(move |s: &mut AppState, tx| {
                            s.open_studio_thread(focus_id.clone());
                            tx.scroll_into_view(format!("studio-pane-{focus_id}"));
                        }),
                )
                .child(label(
                    title,
                    13.5,
                    620.0,
                    if focused { t.ink } else { t.muted },
                ))
                .child(
                    row()
                        .w(100.0)
                        .justify_end()
                        .center_y()
                        .gap(8.0)
                        .child(
                            el().key(format!("studio-width-{id}"))
                                .px(4.0)
                                .h(26.0)
                                .center()
                                .hover(t.hover)
                                .child(label(format!("{width:.0}"), 10.0, 600.0, t.muted))
                                .on_press(move |s: &mut AppState| s.cycle_studio_width(&width_id)),
                        )
                        .child(
                            el().key(format!("studio-close-{id}"))
                                .w(24.0)
                                .h(26.0)
                                .center()
                                .hover(t.hover)
                                .child(label("×", 17.0, 400.0, t.muted))
                                .on_press(move |s: &mut AppState| s.close_studio_thread(&close_id)),
                        ),
                );
            let body = if focused {
                focused_body(s, name, t)
            } else {
                parked_body(state, &id, t)
            };
            rail = rail.child(
                col()
                    .key(format!("studio-pane-{id}"))
                    .w(width)
                    .h_full()
                    .pt(48.0)
                    .child(head)
                    .child(body),
            );
        }
    }
    col()
        .w_full()
        .h_full()
        .fill(t.ground)
        .child(
            row()
                .w_full()
                .h(32.0)
                .px(32.0)
                .justify_between()
                .center_y()
                .child(
                    el().key("studio-add-thread")
                        .w(32.0)
                        .h(30.0)
                        .center()
                        .hover(t.hover)
                        .child(label("+", 17.0, 400.0, t.muted))
                        .on_press_tx(|s: &mut AppState, tx| {
                            s.new_studio_thread();
                            tx.scroll_into_view(format!("studio-pane-{}", s.studio.thread_id));
                        }),
                )
                .child(label(name.to_owned(), 12.5, 500.0, t.muted)),
        )
        .child(
            col()
                .key("studio-rail")
                .w_full()
                .grow(1.0)
                .shrink()
                .scroll_x()
                .child(rail),
        )
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
    let thread = id.to_owned();
    col()
        .key(format!("studio-parked-{id}"))
        .w_full()
        .grow(1.0)
        .shrink()
        .on_press_tx(move |s: &mut AppState, tx| {
            s.open_studio_thread(thread.clone());
            tx.scroll_into_view(format!("studio-pane-{thread}"));
        })
        .child(transcript)
}

fn focused_body(s: &AppState, name: &str, t: Palette) -> El {
    let dock = if let Some(approval) = &s.studio.approval {
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
            .child(el().grow(1.0))
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
            el().key("studio-wake-composer")
                .w(55.0)
                .h(55.0)
                .radius(28.0)
                .fill(t.accent)
                .on_press(|s: &mut AppState| s.studio.composer_open = true),
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
mod tests {
    use super::*;
    use crate::state::{Page, Project, StudioItem};
    use rune::{Env, Runtime};
    use serde_json::json;

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
        let (x, y) = rt.find("studio-focus-b").unwrap();
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

use rune::{Cx, El, ScrollSpec, TextStyle, col, el, row, text, text_input};

use crate::{state::AppState, theme::Palette};

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
            .on_press(|s: &mut AppState| {
                s.studio.thread_open = true;
                s.studio.composer_open = true;
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

    let header = row()
        .w_full()
        .h(56.0)
        .px(32.0)
        .items_end()
        .justify_between()
        .child(el().w(120.0))
        .child(label("New thread", 13.5, 620.0, t.ink))
        .child(
            row()
                .w(120.0)
                .justify_end()
                .child(label(name.to_owned(), 12.5, 500.0, t.muted)),
        );
    let dock = if let Some(approval) = &s.studio.approval {
        col().w_full().max_w(680.0).padding(18.0).gap(12.0).radius(20.0).border(1.0, t.line).fill(t.raised_high)
            .child(label("Approval requested", 12.0, 600.0, t.muted))
            .child(label(approval.title.clone(), 14.0, 600.0, t.ink))
            .child(label(approval.detail.clone(), 13.0, 400.0, t.ink_soft))
            .child(row().gap(8.0)
                .child(el().key("approval-reject").px(14.0).h(32.0).center().radius(9.0).hover(t.hover).child(label("Decline", 12.5, 500.0, t.ink_soft)).on_press(|s: &mut AppState| s.answer_approval("reject-once")))
                .child(el().key("approval-allow").px(14.0).h(32.0).center().radius(9.0).fill(t.accent).child(label("Allow once", 12.5, 500.0, t.accent_ink)).on_press(|s: &mut AppState| s.answer_approval("allow-once"))))
    } else if let Some(question) = &s.studio.question {
        let mut card = col().w_full().max_w(680.0).padding(18.0).gap(12.0).radius(20.0).border(1.0, t.line).fill(t.raised_high)
            .child(label(question.prompt.clone(), 14.0, 600.0, t.ink));
        for (index, option) in question.options.iter().enumerate() {
            let answer = option.clone();
            card = card.child(el().key(format!("question-option-{index}")).w_full().h(32.0).px(8.0).center_y().radius(8.0).hover(t.hover)
                .child(label(option.clone(), 13.0, 500.0, t.ink_soft)).on_press(move |s: &mut AppState| s.answer_question(Some(answer.clone()))));
        }
        card.child(text_input(&s.studio.answer, TextStyle::new(14.0, 400.0)).key("studio-answer").w_full().h(38.0).placeholder("Your answer…", t.placeholder).color(t.ink)
            .on_edit(|s: &mut AppState| &mut s.studio.answer)
            .on_submit(|s: &mut AppState, _: &mut rune::Tx| { let answer = s.studio.answer.text.clone(); s.answer_question(Some(answer)); }))
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
            .child(el().key("studio-provider").px(7.0).h(30.0).center().radius(9.0).hover(t.hover)
                .child(label(s.studio.providers.get(s.studio.provider_index).map(|p| p.label.as_str()).unwrap_or("No provider").to_owned(), 12.5, 500.0, t.ink_soft))
                .on_press(|s: &mut AppState| { if !s.studio.providers.is_empty() { let next = (s.studio.provider_index + 1) % s.studio.providers.len(); s.select_provider(next); } }))
            .child(el().key("studio-model").px(7.0).h(30.0).center().radius(9.0).hover(t.hover)
                .child(label(s.studio.models.get(s.studio.model_index).map(|m| m.label.as_str()).unwrap_or("Default model").to_owned(), 12.5, 500.0, t.ink_soft))
                .on_press(|s: &mut AppState| { if !s.studio.models.is_empty() { s.studio.model_index = (s.studio.model_index + 1) % s.studio.models.len(); } }))
            .child(
                el().w(32.0)
                    .h(32.0)
                    .center()
                    .radius(16.0)
                    .fill(t.accent)
                    .child(label(if s.studio.busy { "■" } else { "↑" }, 18.0, 600.0, t.accent_ink))
                    .on_press_tx(|s: &mut AppState, tx| { if s.studio.busy { s.interrupt_studio(); } else { s.send_studio(tx); } }),
            );
        col()
            .w_full()
            .max_w(680.0)
            .items_center()
            .child(
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
        if item.text.is_empty() && item.name.is_empty() { continue; }
        let value = if item.kind == "tool_call" { format!("{}  {}", item.name, item.text) } else { item.text.clone() };
        let item_color = if item.kind == "reasoning_text" || item.kind == "tool_call" { t.muted } else { t.ink };
        let mut line = label(value, if item.kind == "tool_call" { 12.5 } else { 14.0 }, 400.0, item_color).w_full();
        if item.kind == "user" { line = line.padding(14.0).radius(14.0).fill(t.hover); }
        transcript = transcript.child(line);
    }
    if let Some(error) = &s.studio.error {
        transcript = transcript.child(label(error.clone(), 12.5, 400.0, t.accent));
    }
    col()
        .w_full()
        .h_full()
        .fill(t.ground)
        .child(header)
        .child(col().key("studio-transcript").w_full().grow(1.0).shrink().scroll(ScrollSpec { stick_bottom: true }).child(transcript))
        .child(row().w_full().px(16.0).justify_center().child(dock))
        .child(el().h(32.0))
}

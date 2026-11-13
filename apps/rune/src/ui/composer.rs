use super::{
    sphere_face::{Aim, aim_from_offset, sphere_face},
    start_motion::bezier,
    studio::{PICKER_BRAIN, avatar_at, brand_mark_size, label},
};
use crate::{
    state::AppState,
    theme::{Palette, mix_srgb},
};
use rune::{
    Color, Cursor, El, Icon, ScrollSpec, Shadow, TextStyle, auto_grow, col, color::hex, el, icon,
    row, text, text_input,
};

static MODEL_SEARCH: Icon = Icon {
    name: "composer-model-search",
    view: 24.0,
    body: r#"<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m15.5 15.5 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>"#,
};

fn composer_trigger_menu(s: &AppState, t: Palette) -> Option<El> {
    let marker = s.studio.composer_menu_marker?;
    if marker == '@' && s.studio.busy {
        return None;
    }
    let query = s
        .composer
        .text
        .trim_start_matches(marker)
        .trim()
        .to_lowercase();
    let mut menu = col()
        .key("composer-trigger-menu")
        .w_full()
        .mb(12.0)
        .padding(8.0)
        .radius(18.0)
        .fill(t.field)
        .border(1.0, t.line)
        .box_shadow(Shadow {
            x: 0.0,
            y: 8.0,
            blur: 28.0,
            spread: 0.0,
            color: Color {
                r: 0.0,
                g: 0.0,
                b: 0.0,
                a: if t.dark { 0.34 } else { 0.12 },
            },
            inset: false,
        });
    let title = if marker == '/' {
        "Commands"
    } else {
        "Project files"
    };
    menu = menu.child(
        row()
            .h(27.0)
            .px(8.0)
            .gap(5.0)
            .center_y()
            .child(label(marker.to_string(), 12.0, 600.0, t.accent))
            .child(label(title, 11.5, 500.0, t.muted)),
    );
    let rows = if marker == '/' {
        [
            ("/model", "Open model picker"),
            ("/new", "Start a new thread"),
        ]
        .into_iter()
        .filter(|(cmd, desc)| {
            query.is_empty() || cmd.contains(&query) || desc.to_lowercase().contains(&query)
        })
        .map(|(name, detail)| (name.to_owned(), detail.to_owned()))
        .collect::<Vec<_>>()
    } else {
        s.composer_mention_files()
            .into_iter()
            .filter(|(name, path)| {
                query.is_empty()
                    || name.to_lowercase().contains(&query)
                    || path.to_lowercase().contains(&query)
            })
            .collect::<Vec<_>>()
    };
    if rows.is_empty() {
        return None;
    }
    for (index, (name, detail)) in rows.iter().enumerate() {
        let selected = index == s.studio.composer_menu_index;
        let mut item = row()
            .key(format!("composer-menu-row-{index}"))
            .w_full()
            .h(34.0)
            .px(9.0)
            .gap(8.0)
            .center_y()
            .radius(10.0)
            .hover(t.hover)
            .cursor(Cursor::Pointer);
        if selected {
            item = item.fill(t.accent.alpha(0.12));
        }
        if marker == '@' {
            let (mark, color) = if name.ends_with(".vue") {
                ("V", "#42b883")
            } else if name.ends_with(".css") {
                ("▦", "#a855f7")
            } else if name.ends_with(".json") {
                ("{}", "#e34f26")
            } else {
                ("TS", "#3182ce")
            };
            item = item
                .child(
                    el().w(15.0)
                        .center()
                        .child(label(mark, 9.0, 700.0, hex(color).unwrap())),
                )
                .child(label(name.clone(), 13.0, 500.0, t.ink))
                .child(label(detail.clone(), 11.0, 400.0, t.muted));
        } else {
            let glyph = if name == "/model" { "⚙" } else { "+" };
            item = item
                .child(label(glyph, 13.0, 500.0, t.muted))
                .child(label(name.clone(), 13.0, 600.0, t.ink))
                .child(label(detail.clone(), 11.0, 400.0, t.muted));
        }
        let name = name.clone();
        let detail = detail.clone();
        menu = menu.child(item.on_press(move |s: &mut AppState| {
            s.studio.composer_menu_marker = None;
            s.studio.composer_menu_index = 0;
            if marker == '/' {
                if name == "/model" {
                    s.composer.clear();
                    s.studio.picker_open = true;
                    s.studio.handoff_query.text.clear();
                } else if name == "/new" {
                    s.composer.clear();
                    s.new_studio_thread();
                }
            } else {
                let path = if detail.is_empty() {
                    name.clone()
                } else {
                    format!("{detail}/{name}")
                };
                s.composer.text = format!("@{path} ");
                s.composer.focus = s.composer.text.len();
                s.composer.anchor = s.composer.focus;
            }
        }));
    }
    Some(menu)
}

static PLUS_SIGN: Icon = Icon {
    name: "composer-plus",
    view: 24.0,
    body: r#"<path d="M12 4V20M20 12H4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static MODE_ASK: Icon = Icon {
    name: "composer-mode-ask",
    view: 18.0,
    body: r#"<path d="M3 5.2c0-.9.7-1.6 1.6-1.6h8.8c.9 0 1.6.7 1.6 1.6v4.6c0 .9-.7 1.6-1.6 1.6H8l-3 2.4V11.4H4.6c-.9 0-1.6-.7-1.6-1.6Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.6 6.7a1.4 1.4 0 1 1 1.9 1.3c-.5.3-.7.6-.7 1.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.8 10.7v.02" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static MODE_EDITS: Icon = Icon {
    name: "composer-mode-edits",
    view: 18.0,
    body: r#"<path d="M11.4 3.7 14.3 6.6 6.9 14H4v-2.9Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.4 4.7 13.3 7.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static MODE_FULL: Icon = Icon {
    name: "composer-mode-full",
    view: 18.0,
    body: r#"<path d="M9 2.6 14 4.6V9C14 12 11.9 14 9 15.4 6.1 14 4 12 4 9V4.6Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static FLASH_STROKE_2: Icon = Icon {
    name: "composer-flash-2",
    view: 24.0,
    body: r#"<path d="M5.22576 11.3294L12.224 2.34651C12.7713 1.64397 13.7972 2.08124 13.7972 3.01707V9.96994C13.7972 10.5305 14.1995 10.985 14.6958 10.985H18.0996C18.8729 10.985 19.2851 12.0149 18.7742 12.6706L11.776 21.6535C11.2287 22.356 10.2028 21.9188 10.2028 20.9829V14.0301C10.2028 13.4695 9.80048 13.015 9.3042 13.015H5.90035C5.12711 13.015 4.71494 11.9851 5.22576 11.3294Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static FLASH_TRAY: Icon = Icon {
    name: "composer-flash-tray",
    view: 24.0,
    body: r#"<path d="M5.22576 11.3294L12.224 2.34651C12.7713 1.64397 13.7972 2.08124 13.7972 3.01707V9.96994C13.7972 10.5305 14.1995 10.985 14.6958 10.985H18.0996C18.8729 10.985 19.2851 12.0149 18.7742 12.6706L11.776 21.6535C11.2287 22.356 10.2028 21.9188 10.2028 20.9829V14.0301C10.2028 13.4695 9.80048 13.015 9.3042 13.015H5.90035C5.12711 13.015 4.71494 11.9851 5.22576 11.3294Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static FOLDER_TRAY: Icon = Icon {
    name: "composer-folder-tray",
    view: 24.0,
    body: r#"<path d="M8 7H16.75C18.8567 7 19.91 7 20.6667 7.50559C20.9943 7.72447 21.2755 8.00572 21.4944 8.33329C22 9.08996 22 10.1433 22 12.25C22 15.7612 22 17.5167 21.1573 18.7779C20.7926 19.3238 20.3238 19.7926 19.7779 20.1573C18.5167 21 16.7612 21 13.25 21H12C7.28595 21 4.92893 21 3.46447 19.5355C2 18.0711 2 15.714 2 11V7.94427C2 6.1278 2 5.21956 2.38032 4.53806C2.65142 4.05227 3.05227 3.65142 3.53806 3.38032C4.21956 3 5.1278 3 6.94427 3C8.10802 3 8.6899 3 9.19926 3.19101C10.3622 3.62712 10.8418 4.68358 11.3666 5.73313L12 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static GIT_BRANCH_TRAY: Icon = Icon {
    name: "composer-git-branch",
    view: 24.0,
    body: r#"<path d="M7 19H13C15.8284 19 17.2426 19 18.1213 18.1213C19 17.2426 19 15.8284 19 13V10M19 10C19.7002 10 21.0085 11.9943 21.5 12.5M19 10C18.2998 10 16.9915 11.9943 16.5 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 7L5 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="5" cy="5" r="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="19" cy="5" r="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="5" cy="19" r="2" fill="none" stroke="currentColor" stroke-width="1.8"/>"#,
};

static SOLAR_CHAT_LINE: Icon = Icon {
    name: "composer-solar-chat-line",
    view: 24.0,
    body: r#"<path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2S2 6.477 2 12c0 1.6.376 3.112 1.043 4.453c.178.356.237.763.134 1.148l-.595 2.226a1.3 1.3 0 0 0 1.591 1.592l2.226-.596a1.63 1.63 0 0 1 1.149.133A9.96 9.96 0 0 0 12 22Z" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 10.5h8M8 14h5.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>"#,
};

static ALERT_CIRCLE: Icon = Icon {
    name: "composer-alert-circle",
    view: 24.0,
    body: r#"<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 8V12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.125 15.75H12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static SEED_ARROW: Icon = Icon {
    name: "composer-seed-arrow",
    view: 18.0,
    body: r#"<path d="M9 14V4.2M9 4.2L4.3 8.9M9 4.2L13.7 8.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static SEED_STOP: Icon = Icon {
    name: "composer-seed-stop",
    view: 18.0,
    body: r#"<rect x="5" y="5" width="8" height="8" rx="2" fill="currentColor"/>"#,
};

fn mode_meta(mode: &str) -> (&'static str, &'static str, &'static Icon) {
    match mode {
        "ask" => ("Ask user", "#6E8BEF", &MODE_ASK),
        "full-access" => ("Full access", "#D08466", &MODE_FULL),
        _ => ("Edits only", "#5EAF8C", &MODE_EDITS),
    }
}

fn effort_meta(effort: &str) -> (&'static str, &'static str, usize, bool) {
    match effort {
        "base" => ("Standard", "#71717a", 2, false),
        "none" => ("None", "#a1a1aa", 1, false),
        "minimal" => ("Minimal", "#71717a", 1, false),
        "low" => ("Low", "#0ea5e9", 1, false),
        "high" => ("High", "#6366f1", 3, false),
        "xhigh" => ("Extra High", "#a855f7", 4, false),
        "max" => ("Max", "#d946ef", 4, true),
        "ultra" => ("Ultra", "#ec4899", 5, true),
        "thinking" => ("Thinking", "#8b5cf6", 3, true),
        _ => ("Medium", "#10b981", 2, false),
    }
}

fn brain_stack(count: usize, hue: Color, glow: bool) -> El {
    let mut stack = row().center_y();
    for i in 0..count.max(1) {
        let mut mark = icon(&PICKER_BRAIN, 15.0).color(hue);
        if glow {
            mark = mark.shadow(0.0, 3.0, hue.alpha(0.65));
        }
        if i > 0 {
            mark = mark.ml(-6.0);
        }
        stack = stack.child(mark);
    }
    stack
}

pub(super) fn model_picker(s: &AppState, t: Palette) -> El {
    let query = s.studio.handoff_query.text.trim().to_lowercase();
    let mut rail = col().w(44.0).pt(4.0).gap(10.0).items_center();
    for (index, provider) in s.studio.providers.iter().enumerate() {
        rail = rail.child(
            el().key(format!("composer-picker-provider-{index}"))
                .w(44.0)
                .h(44.0)
                .center()
                .cursor(Cursor::Pointer)
                .opacity(if index == s.studio.provider_index {
                    1.0
                } else {
                    0.48
                })
                .child(brand_mark_size(
                    if provider.id == "codex" {
                        "gpt"
                    } else {
                        &provider.id
                    },
                    20.0,
                    t,
                ))
                .on_press(move |s: &mut AppState| {
                    if index != s.studio.provider_index {
                        s.select_provider(index);
                    }
                }),
        );
    }
    let search = row()
        .h(32.0)
        .mx(10.0)
        .mt(10.0)
        .px(10.0)
        .gap(8.0)
        .center_y()
        .radius(12.0)
        .fill(t.hover)
        .border(1.0, t.line)
        .child(icon(&MODEL_SEARCH, 14.0).color(t.muted))
        .child(
            text_input(&s.studio.handoff_query, TextStyle::new(12.5, 400.0))
                .key("composer-model-search")
                .grow(1.0)
                .single_line()
                .placeholder("Search models…", t.placeholder)
                .color(t.ink)
                .on_edit(|s: &mut AppState| &mut s.studio.handoff_query),
        );
    let mut entries = Vec::new();
    for (provider_index, provider) in s.studio.providers.iter().enumerate() {
        if query.is_empty() && provider_index != s.studio.provider_index {
            continue;
        }
        let provider_models = s
            .studio
            .model_catalog
            .get(&provider.id)
            .cloned()
            .or_else(|| {
                (provider_index == s.studio.provider_index).then(|| s.studio.models.clone())
            })
            .unwrap_or_default();
        for (model_index, model) in provider_models.into_iter().enumerate() {
            if query.is_empty()
                || format!("{} {} {}", model.label, model.id, provider.label)
                    .to_lowercase()
                    .contains(&query)
            {
                entries.push((provider_index, model_index, provider.clone(), model));
            }
        }
    }
    let has_current = entries.iter().any(|(provider, model, _, _)| {
        *provider == s.studio.provider_index && *model == s.studio.model_index
    });
    let first_entry = entries
        .first()
        .map(|(provider, model, _, _)| (*provider, *model));
    let mut models = col().w_full().padding(14.0);
    let mut count = 0;
    for (provider_index, model_index, provider, model) in entries {
        count += 1;
        let selected = (provider_index == s.studio.provider_index
            && model_index == s.studio.model_index)
            || (!has_current && first_entry == Some((provider_index, model_index)));
        let mut item = row()
            .key(format!(
                "composer-picker-model-{provider_index}-{model_index}"
            ))
            .w_full()
            .px(10.0)
            .py(9.0)
            .gap(10.0)
            .center_y()
            .radius(11.0)
            .hover(t.hover)
            .cursor(Cursor::Pointer)
            .opacity(if selected { 1.0 } else { 0.72 });
        if selected {
            item = item.fill(t.ink.alpha(0.04));
        }
        item = item.child(el().w(22.0).center().child(brand_mark_size(
            if provider.id == "codex" {
                "gpt"
            } else {
                &provider.id
            },
            17.0,
            t,
        )));
        if !query.is_empty() && provider_index != s.studio.provider_index {
            item = item.child(label(provider.label.clone(), 11.0, 400.0, t.muted));
        }
        item = item.child(label(model.label.clone(), 15.0, 400.0, t.ink));
        let effort = if selected && !s.studio.effort.is_empty() {
            Some(s.studio.effort.as_str())
        } else {
            model
                .default_effort
                .as_deref()
                .or_else(|| model.efforts.first().map(String::as_str))
        };
        if let Some(effort) = effort {
            let (_, hue, count, glow) = effort_meta(effort);
            item = item.child(brain_stack(count, hex(hue).unwrap(), glow).opacity(0.8));
        }
        models = models.child(item.on_press(move |s: &mut AppState| {
            s.choose_studio_model(provider_index, model_index);
        }));
    }
    if count == 0 {
        let message = if query.is_empty() {
            "No models available.".to_owned()
        } else {
            format!("No models match “{}”.", s.studio.handoff_query.text.trim())
        };
        models = models.child(label(message, 13.0, 400.0, t.muted).px(14.0).py(22.0));
    }
    let content = col()
        .grow(1.0)
        .h(300.0)
        .radius(18.0)
        .fill(t.field)
        .border(1.0, t.line)
        .clip_rounded(18.0)
        .child(search)
        .child(
            col()
                .key("composer-model-list")
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(models),
        );
    row()
        .w(384.0)
        .max_w(384.0)
        .h(300.0)
        .radius(22.0)
        .fill(t.sunken)
        .child(rail)
        .child(content)
}

pub(super) fn resting_orb(s: &AppState, t: Palette) -> El {
    let clock = s.studio.orb_clock.unwrap_or(0.9);
    let aim = s.studio.orb_aim.map(|(nx, ny, mix)| Aim { nx, ny, mix });
    el().w(55.0)
        .h(55.0)
        .radius(27.5)
        .cursor(Cursor::Pointer)
        .child(sphere_face(clock, 55.0, aim, t.ink))
        .on_pointer_move_local(|s: &mut AppState, p, _| {
            s.studio.orb_aim =
                aim_from_offset(p.x - 27.5, p.y - 27.5, 55.0).map(|a| (a.nx, a.ny, a.mix));
        })
        .on_hover_change(|s: &mut AppState, hovered, _| {
            s.studio.orb_hover = hovered;
            if hovered && s.studio.orb_aim.is_none() {
                s.studio.orb_aim = Some((0.0, 0.0, 1.0));
            } else if !hovered {
                s.studio.orb_aim = None;
            }
        })
}

pub(super) fn wake_orb(s: &AppState, t: Palette) -> El {
    col().w_full().items_center().child(
        resting_orb(s, t)
            .key("studio-wake-composer")
            .on_press(|s: &mut AppState| s.open_composer()),
    )
}

fn status_tray(s: &AppState, track_w: f32, t: Palette) -> Option<El> {
    let (reason, severe, action) = s.studio.blocked_reason.as_ref()?;
    let tone = if *severe { t.danger } else { t.warn };
    let bg = mix_srgb(t.sunken, tone, 0.12);
    let tray_w = (track_w - 26.0).max(0.0);
    let mut bar = row()
        .w(tray_w)
        .self_center()
        .mb(-14.0)
        .h(40.0)
        .px(8.0)
        .pb(14.0)
        .center_y()
        .gap(4.0)
        .corners([18.0, 18.0, 0.0, 0.0])
        .fill(bg)
        .child(
            row()
                .grow(1.0)
                .shrink()
                .px(6.0)
                .py(3.0)
                .gap(6.0)
                .center_y()
                .child(icon(&ALERT_CIRCLE, 13.0).color(tone))
                .child(label(reason.clone(), 12.5, 400.0, t.ink)),
        );
    if let Some(act) = action {
        bar = bar.child(
            el().px(6.0)
                .py(3.0)
                .radius(7.0)
                .hover(t.hover)
                .cursor(Cursor::Pointer)
                .child(label(act.clone(), 12.5, 600.0, t.ink)),
        );
    }
    Some(bar)
}

fn workspace_tray(s: &AppState, track_w: f32, t: Palette) -> Option<El> {
    if s.studio.workspace_steps.is_empty() {
        return None;
    }
    let tray_w = (track_w - 26.0).max(0.0);
    let mut inner = col()
        .w(tray_w)
        .self_center()
        .mb(-14.0)
        .pt(6.0)
        .px(8.0)
        .pb(20.0)
        .corners([18.0, 18.0, 0.0, 0.0])
        .fill(t.sunken);
    if s.studio.workspace_tray_open {
        let mut steps = col().w_full().px(6.0).pt(4.0).pb(6.0).gap(2.0);
        for (step_label, detail, state) in &s.studio.workspace_steps {
            let dot_color = match state.as_str() {
                "failed" => t.warn,
                "done" => hex("#10b981").unwrap(),
                "running" => t.accent,
                _ => t.faint,
            };
            steps = steps.child(
                row()
                    .w_full()
                    .gap(6.0)
                    .center_y()
                    .child(el().w(6.0).h(6.0).radius(3.0).fill(dot_color))
                    .child(label(step_label.clone(), 11.5, 400.0, t.ink.alpha(0.86)))
                    .child(label(detail.clone(), 11.5, 400.0, t.ink.alpha(0.42))),
            );
        }
        inner = inner.child(steps);
    }
    let heading = if s.studio.workspace_heading.is_empty() {
        "Workspace"
    } else {
        s.studio.workspace_heading.as_str()
    };
    inner = inner.child(
        row()
            .w_full()
            .px(6.0)
            .py(3.0)
            .gap(6.0)
            .center_y()
            .cursor(Cursor::Pointer)
            .child(icon(&GIT_BRANCH_TRAY, 12.0).color(t.faint))
            .child(label(heading, 11.5, 400.0, t.ink.alpha(0.86)))
            .on_press(|s: &mut AppState| {
                s.studio.workspace_tray_open = !s.studio.workspace_tray_open;
            }),
    );
    Some(inner)
}

fn context_tray(s: &AppState, project_name: &str, t: Palette) -> El {
    let branch_label = s.studio.worktree_path.as_deref().and_then(|path| {
        std::path::Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|n| !n.is_empty())
    });
    let thread_title = if s.studio.turn_title.is_empty() {
        if s.studio.title.is_empty() {
            "New thread"
        } else {
            s.studio.title.as_str()
        }
    } else {
        s.studio.turn_title.as_str()
    };

    let who_item = if let Some(id) = &s.studio.connected_identity {
        row()
            .h(20.0)
            .px(6.0)
            .gap(5.0)
            .center_y()
            .radius(7.0)
            .child(avatar_at(id, 14.0, t))
            .child(
                text(id.name.clone())
                    .font(TextStyle::new(11.5, 400.0).lh(14.0))
                    .color(t.ink.alpha(0.86)),
            )
    } else {
        row()
            .h(20.0)
            .px(6.0)
            .gap(5.0)
            .center_y()
            .radius(7.0)
            .child(icon(&FLASH_TRAY, 13.0).color(t.faint))
            .child(
                text("Guest")
                    .font(TextStyle::new(11.5, 400.0).lh(14.0))
                    .color(t.ink.alpha(0.86)),
            )
    };

    let project_item = row()
        .h(20.0)
        .px(6.0)
        .gap(5.0)
        .center_y()
        .radius(7.0)
        .child(icon(&FOLDER_TRAY, 13.0).color(t.faint))
        .child(
            text(project_name.to_owned())
                .font(TextStyle::new(11.5, 400.0).lh(14.0))
                .color(t.ink.alpha(0.86)),
        );

    let mut items = row()
        .w_full()
        .h_full()
        .pt(12.0)
        .center_y()
        .gap(4.0)
        .child(who_item)
        .child(project_item);

    if let Some(branch) = branch_label {
        items = items.child(
            row()
                .h(20.0)
                .px(6.0)
                .gap(5.0)
                .center_y()
                .radius(7.0)
                .child(icon(&GIT_BRANCH_TRAY, 13.0).color(t.faint))
                .child(
                    text(branch.to_owned())
                        .font(TextStyle::new(11.5, 400.0).lh(14.0))
                        .color(t.ink.alpha(0.62)),
                ),
        );
    }

    items = items.child(el().grow(1.0)).child(
        row()
            .h(20.0)
            .px(6.0)
            .gap(5.0)
            .center_y()
            .radius(7.0)
            .child(icon(&SOLAR_CHAT_LINE, 13.0).color(t.faint))
            .child(
                text(thread_title.to_owned())
                    .font(TextStyle::new(11.5, 400.0).lh(14.0))
                    .max_w(220.0)
                    .color(t.ink.alpha(0.62)),
            ),
    );

    el().pin(Some(13.0), None, Some(13.0), Some(0.0))
        .h(40.0)
        .px(14.0)
        .corners([0.0, 0.0, 18.0, 18.0])
        .fill(t.sunken)
        .child(items)
}

/// Expanded AgentComposer dock (plus morph & collapse transitions).
pub(super) fn composer_dock(s: &AppState, project_name: &str, track_w: f32, t: Palette) -> El {
    let closing_progress = s
        .studio
        .composer_closing_at
        .map(|at| (at.elapsed().as_secs_f32() / 0.18).clamp(0.0, 1.0));
    let closing = closing_progress.is_some() && !s.studio.composer_open;

    let open_t = s
        .studio
        .composer_opened_at
        .map_or(1.0, |at| at.elapsed().as_secs_f32());
    let size_p = if closing {
        1.0
    } else if s.studio.composer_opened_at.is_some() {
        let u = ((open_t - 0.09) / 0.42).clamp(0.0, 1.0);
        bezier([0.34, 1.56, 0.64, 1.0], u)
    } else {
        1.0
    };
    let radius_p = if s.studio.composer_opened_at.is_some() && !closing {
        bezier([0.4, 0.0, 0.2, 1.0], (open_t / 0.13).clamp(0.0, 1.0))
    } else {
        1.0
    };
    let bar_alpha = if closing {
        1.0
    } else if s.studio.composer_opened_at.is_some() {
        ((open_t - 0.12) / 0.22).clamp(0.0, 1.0)
    } else {
        1.0
    };
    let tray_alpha = if closing {
        0.0
    } else if s.studio.composer_opened_at.is_some() {
        ((open_t - 0.14) / 0.24).clamp(0.0, 1.0)
    } else {
        1.0
    };
    let card_alpha = closing_progress.map_or(1.0, |p| 1.0 - p);

    let card_w = (55.0 + (track_w - 55.0) * size_p).clamp(55.0, track_w + 18.0);
    let corner_r = 27.5 - 1.5 * radius_p;

    let selection = hex("#d97757").unwrap().alpha(0.24);
    let field = text_input(&s.composer, TextStyle::new(14.0, 400.0).lh(22.0))
        .key("studio-composer")
        .placeholder("Ask anything…", t.placeholder)
        .color(t.ink)
        .caret(t.ink, selection)
        .w_full()
        .on_edit(|s: &mut AppState| &mut s.composer)
        .on_submit(AppState::send_studio)
        .on_key(|s: &mut AppState, ev, tx| {
            if s.studio.composer_menu_marker.is_none()
                && let rune::Key::Text(text) = &ev.key
                && (text == "/" || text == "@")
            {
                s.studio.composer_menu_marker = text.chars().next();
                s.studio.composer_menu_index = 0;
            }
            AppState::studio_key(s, ev, tx)
        });
    let mut field_box = el()
        .w_full()
        .pt(16.0)
        .px(14.0)
        .pb(4.0)
        .child(auto_grow(field, 1, 11).min_h(50.0).max_h(260.0));
    if let Some(path) = s.composer.text.strip_prefix('@').map(str::trim)
        && !path.is_empty()
        && !path.contains(char::is_whitespace)
    {
        let name = path.rsplit('/').next().unwrap_or(path);
        let chip_color = mix_srgb(t.ink, t.accent, 0.62);
        field_box = field_box
            .child(
                el().pin(Some(13.0), Some(15.0), None, None)
                    .w(82.0)
                    .h(24.0)
                    .fill(t.field),
            )
            .child(
                row()
                    .pin(Some(14.0), Some(16.0), None, None)
                    .h(21.0)
                    .px(5.0)
                    .gap(4.0)
                    .center_y()
                    .radius(6.0)
                    .fill(t.accent.alpha(0.12))
                    .child(label("TS", 8.0, 700.0, hex("#3182ce").unwrap()))
                    .child(label(name, 11.5, 500.0, chip_color)),
            );
    }

    let (mode_label, mode_hue_hex, mode_icon) = mode_meta(s.studio.mode.as_str());
    let mode_hue = hex(mode_hue_hex).unwrap();

    let attach_btn = el()
        .key("studio-attach")
        .w(30.0)
        .h(30.0)
        .center()
        .radius(9.0)
        .hover(t.hover)
        .cursor(Cursor::Pointer)
        .opacity(0.78)
        .child(icon(&PLUS_SIGN, 17.0).color(t.ink_soft));

    let mode_btn = row()
        .key("studio-mode-picker")
        .h(30.0)
        .px(7.0)
        .gap(6.0)
        .center_y()
        .radius(9.0)
        .hover(t.hover)
        .cursor(Cursor::Pointer)
        .opacity(0.92)
        .child(icon(mode_icon, 15.0).color(mode_hue))
        .child(label(mode_label, 12.5, 400.0, t.ink))
        .on_press(|s: &mut AppState| s.cycle_studio_mode());

    let model_btn = {
        let model = s.studio.models.get(s.studio.model_index);
        let provider = s.studio.providers.get(s.studio.provider_index);
        let mut btn = row()
            .key("studio-model-picker")
            .h(30.0)
            .px(7.0)
            .gap(7.0)
            .center_y()
            .radius(9.0)
            .hover(t.hover)
            .cursor(Cursor::Pointer)
            .opacity(0.78)
            .on_press(|s: &mut AppState| {
                s.studio.picker_open = !s.studio.picker_open;
                if s.studio.picker_open {
                    s.studio.handoff_query.text.clear();
                }
            });
        if let Some(p) = provider {
            let text_label = model
                .map(|m| m.label.as_str())
                .filter(|l| !l.is_empty())
                .unwrap_or(p.label.as_str());
            btn = btn
                .child(brand_mark_size(
                    if p.id == "codex" { "gpt" } else { &p.id },
                    15.0,
                    t,
                ))
                .child(label(text_label, 12.5, 400.0, t.ink));
        } else {
            btn = btn
                .child(
                    row()
                        .gap(4.0)
                        .center_y()
                        .opacity(0.38)
                        .child(brand_mark_size("claudeAgent", 12.0, t))
                        .child(brand_mark_size("gpt", 12.0, t))
                        .child(brand_mark_size("cursor", 12.0, t))
                        .child(brand_mark_size("opencode", 12.0, t)),
                )
                .child(label("No provider", 12.5, 400.0, t.ink));
        }
        btn
    };

    let has_efforts = !s.studio.effort.is_empty()
        || s.studio
            .models
            .get(s.studio.model_index)
            .is_some_and(|m| !m.efforts.is_empty());

    let armed = !s.composer.text.trim().is_empty();
    let show_stop = s.studio.busy && !armed;
    let ring_rgb = if t.dark {
        Color {
            r: 168.0 / 255.0,
            g: 171.0 / 255.0,
            b: 179.0 / 255.0,
            a: 0.16,
        }
    } else {
        Color {
            r: 138.0 / 255.0,
            g: 141.0 / 255.0,
            b: 149.0 / 255.0,
            a: 0.16,
        }
    };

    let mut seed_btn = el()
        .key("studio-seed")
        .ml(4.0)
        .w(32.0)
        .h(32.0)
        .center()
        .radius(16.0)
        .fill(t.accent)
        .cursor(Cursor::Pointer)
        .child(if show_stop {
            icon(&SEED_STOP, 18.0).color(t.accent_ink)
        } else {
            icon(&SEED_ARROW, 15.0).color(t.accent_ink)
        })
        .on_press_tx(|s: &mut AppState, tx| {
            if s.studio.busy && s.composer.text.trim().is_empty() {
                s.interrupt_studio();
            } else {
                s.send_studio(tx);
            }
        });
    if armed {
        seed_btn = seed_btn.box_shadow(Shadow {
            x: 0.0,
            y: 0.0,
            blur: 0.0,
            spread: 4.0,
            color: ring_rgb,
            inset: false,
        });
    }

    let mut right_group = row().gap(4.0).center_y().child(model_btn);
    if has_efforts {
        let effort_key = if s.studio.effort.is_empty() {
            "medium"
        } else {
            s.studio.effort.as_str()
        };
        let (eff_label, eff_hue, brains, glow) = effort_meta(effort_key);
        right_group = right_group.child(
            row()
                .key("studio-effort-picker")
                .h(30.0)
                .px(7.0)
                .gap(6.0)
                .center_y()
                .radius(9.0)
                .hover(t.hover)
                .cursor(Cursor::Pointer)
                .opacity(0.9)
                .child(brain_stack(brains, hex(eff_hue).unwrap(), glow))
                .child(label(eff_label, 12.5, 400.0, t.ink))
                .on_press(|s: &mut AppState| s.cycle_studio_effort()),
        );
    }
    if s.studio.fast_tier {
        let mut fast = el()
            .key("studio-fast-toggle")
            .w(28.0)
            .h(30.0)
            .center()
            .radius(9.0)
            .hover(t.hover)
            .cursor(Cursor::Pointer)
            .opacity(if s.studio.fast_mode { 1.0 } else { 0.66 })
            .child(icon(&FLASH_STROKE_2, 15.0).color(if s.studio.fast_mode {
                t.boost
            } else {
                t.ink
            }))
            .on_press(|s: &mut AppState| s.studio.fast_mode = !s.studio.fast_mode);
        if s.studio.fast_mode {
            fast = fast.shadow(0.0, 4.0, t.boost.alpha(0.5));
        }
        right_group = right_group.child(fast);
    }
    if let Some(cw) = &s.studio.context_window {
        right_group = right_group.child(
            el().min_w(32.0)
                .h(30.0)
                .px(4.0)
                .center()
                .radius(9.0)
                .hover(t.hover)
                .opacity(0.66)
                .child(
                    text(cw.clone())
                        .font(TextStyle::new(11.0, 400.0).mono())
                        .color(t.ink),
                ),
        );
    }
    right_group = right_group.child(seed_btn);

    let bar = row()
        .w_full()
        .h(41.0)
        .px(8.0)
        .pb(9.0)
        .center_y()
        .justify_between()
        .gap(12.0)
        .opacity(bar_alpha)
        .child(row().gap(2.0).center_y().child(attach_btn).child(mode_btn))
        .child(right_group);

    let black = hex("#000000").unwrap();
    let surface = col()
        .w(card_w)
        .self_center()
        .mb(26.0 * tray_alpha)
        .radius(corner_r)
        .border(1.0, t.line)
        .fill(t.field)
        .box_shadow(Shadow {
            x: 0.0,
            y: 10.0,
            blur: 26.0,
            spread: -12.0,
            color: black.alpha(0.07),
            inset: false,
        })
        .box_shadow(Shadow {
            x: 0.0,
            y: 2.0,
            blur: 6.0,
            spread: -3.0,
            color: black.alpha(0.05),
            inset: false,
        })
        .clip_rounded(corner_r)
        .child(
            col()
                .w_full()
                .radius(corner_r)
                .fill(t.field)
                .child(field_box)
                .child(bar),
        );

    let mut dock = col().w(track_w).items_center().opacity(card_alpha);
    if !closing && tray_alpha > 0.0 {
        dock = dock.child(context_tray(s, project_name, t).opacity(tray_alpha));
    }
    if !closing
        && s.studio.composer_menu_marker.is_some()
        && let Some(menu) = composer_trigger_menu(s, t)
    {
        dock = dock.child(menu);
    }
    if let Some(top_tray) = status_tray(s, track_w, t).or_else(|| workspace_tray(s, track_w, t)) {
        dock = dock.child(top_tray);
    }
    dock = dock.child(surface);

    // During collapse (`closing`), the resting orb sits underneath while the card fades out.
    if closing {
        el().w(track_w)
            .items_center()
            .child(
                el().pin(Some(0.0), None, Some(0.0), Some(0.0))
                    .items_center()
                    .child(wake_orb(s, t)),
            )
            .child(dock)
    } else {
        dock
    }
}

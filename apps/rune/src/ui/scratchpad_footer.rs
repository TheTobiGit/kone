//! Scratchpad metadata and Markdown interchange actions.
use crate::{
    state::{AppState, StudioState},
    theme::Palette,
};
use rune::{Curve, Easing, El, Family, Icon, Key, Phase, TextStyle, el, icon, row, text};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static COPY: Icon = Icon {
    name: "pad-Copy01",
    view: 24.0,
    body: r#"<path d="M9 15C9 12.1716 9 10.7574 9.87868 9.87868C10.7574 9 12.1716 9 15 9L16 9C18.8284 9 20.2426 9 21.1213 9.87868C22 10.7574 22 12.1716 22 15V16C22 18.8284 22 20.2426 21.1213 21.1213C20.2426 22 18.8284 22 16 22H15C12.1716 22 10.7574 22 9.87868 21.1213C9 20.2426 9 18.8284 9 16L9 15Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M16.9999 9C16.9975 6.04291 16.9528 4.51121 16.092 3.46243C15.9258 3.25989 15.7401 3.07418 15.5376 2.90796C14.4312 2 12.7875 2 9.5 2C6.21252 2 4.56878 2 3.46243 2.90796C3.25989 3.07417 3.07418 3.25989 2.90796 3.46243C2 4.56878 2 6.21252 2 9.5C2 12.7875 2 14.4312 2.90796 15.5376C3.07417 15.7401 3.25989 15.9258 3.46243 16.092C4.51121 16.9528 6.04291 16.9975 9 16.9999" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static DOWNLOAD: Icon = Icon {
    name: "pad-Download04",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.99969 17.0002C2.99969 17.9302 2.99969 18.3952 3.10192 18.7767C3.37932 19.8119 4.18796 20.6206 5.22324 20.898C5.60474 21.0002 6.06972 21.0002 6.99969 21.0002L16.9997 21.0002C17.9297 21.0002 18.3947 21.0002 18.7762 20.898C19.8114 20.6206 20.6201 19.8119 20.8975 18.7767C20.9997 18.3952 20.9997 17.9302 20.9997 17.0002"/><path d="M16.4998 11.5002C16.4998 11.5002 13.1856 16.0002 11.9997 16.0002C10.8139 16.0002 7.49976 11.5002 7.49976 11.5002M11.9997 15.0002V3.00016"/></g>"#,
};
fn label(value: impl Into<String>, size: f32, color: rune::Color) -> El {
    text(value)
        .font(
            TextStyle::new(size, 400.0)
                .family(Family::Named("Geist"))
                .lh(size * 1.55)
                .features("'tnum' 1"),
        )
        .color(color)
}
fn focus(s: &mut AppState, project: usize, id: &str) {
    if s.studio.thread_id != id {
        s.select_studio_project(project);
        s.open_studio_thread(id.to_owned());
    }
}
pub fn saved_time_now() -> String {
    saved_time(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    )
}
pub fn saved_time(milliseconds: u64) -> String {
    // The OS applies the user's locale/time zone, as the Electron Date formatter does.
    let seconds = (milliseconds / 1000).to_string();
    #[cfg(target_os = "macos")]
    let output = std::process::Command::new("date")
        .args(["-r", &seconds, "+%l:%M %p"])
        .output();
    #[cfg(not(target_os = "macos"))]
    let output = std::process::Command::new("date")
        .args(["-d", &format!("@{seconds}"), "+%l:%M %p"])
        .output();
    output
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .unwrap_or_default()
}
fn retract_ease(time: f32) -> f32 {
    // Solve the source CSS cubic-bezier(.22,1,.36,1) at the elapsed time.
    let coordinate = |t: f32, a: f32, b: f32| {
        3.0 * (1.0 - t).powi(2) * t * a + 3.0 * (1.0 - t) * t * t * b + t.powi(3)
    };
    let (mut low, mut high) = (0.0, 1.0);
    for _ in 0..18 {
        let middle = (low + high) / 2.0;
        if coordinate(middle, 0.22, 0.36) < time {
            low = middle;
        } else {
            high = middle;
        }
    }
    coordinate((low + high) / 2.0, 1.0, 1.0)
}
fn cancel(state: &mut StudioState, tx: &mut rune::Tx) {
    if state.scratchpad_clear_started.take().is_some() {
        state.scratchpad_clear_cancelled = Some((Instant::now(), state.scratchpad_clear_progress));
        tx.wake_after(Duration::ZERO);
    }
}
pub fn poll(state: &mut StudioState, tx: &mut rune::Tx) -> bool {
    if let Some(start) = state.scratchpad_clear_started {
        state.scratchpad_clear_progress = (start.elapsed().as_secs_f32() / 0.850).min(1.0);
        if state.scratchpad_clear_progress >= 1.0 {
            if let Some(edit) = state.scratchpad.as_mut() {
                edit.replace_text("");
            }
            state.scratchpad_clear_started = None;
            state.scratchpad_clear_progress = 0.0;
        } else {
            tx.wake_after(Duration::from_millis(16));
        }
        return true;
    }
    if let Some((start, initial)) = state.scratchpad_clear_cancelled {
        let elapsed = (start.elapsed().as_secs_f32() / 0.220).min(1.0);
        state.scratchpad_clear_progress = initial * (1.0 - retract_ease(elapsed));
        if elapsed >= 1.0 {
            state.scratchpad_clear_progress = 0.0;
            state.scratchpad_clear_cancelled = None;
        } else {
            tx.wake_after(Duration::from_millis(16));
        }
        return true;
    }
    false
}
pub fn view(s: &AppState, state: &StudioState, t: Palette, project: usize, id: &str) -> El {
    let danger = rune::color::hex("#e11d48").unwrap();
    // Electron counts body.textContent: paragraph boundaries add no whitespace.
    let words = state.scratchpad.as_ref().map_or(0, |edit| {
        parse(&edit.to_html(), &mut 0)
            .iter()
            .map(plain)
            .collect::<String>()
            .split_whitespace()
            .count()
    });
    let saving = state.scratchpad_save_request.is_some()
        || state
            .scratchpad
            .as_ref()
            .is_some_and(|e| e.to_html() != state.scratchpad_saved);
    let saved = if saving {
        "Saving…".into()
    } else {
        state
            .scratchpad_saved_at
            .as_ref()
            .map_or_else(|| "Not saved".into(), |at| format!("Saved {at}"))
    };
    let copy_hover_id = id.to_owned();
    let export_hover_id = id.to_owned();
    let copy_id = id.to_owned();
    let export_id = id.to_owned();
    let clear_id = id.to_owned();
    let hover_id = id.to_owned();
    let foot_id = id.to_owned();
    let key_id = id.to_owned();
    let key_up_id = id.to_owned();
    let clear = el()
        .key(format!("pad-clear-{id}"))
        .role("button")
        .label("Hold to clear scratchpad")
        .focusable(true)
        .px(6.0)
        .py(3.0)
        .radius(7.0)
        .clip_rounded(7.0)
        .scale(
            if state.scratchpad_clear_started.is_some()
                || (state.scratchpad_clear_progress > 0.0
                    && state.scratchpad_clear_cancelled.is_none())
            {
                0.97
            } else {
                1.0
            },
        )
        .scale_motion(Curve::tween(0.12, Easing::cubic(0.25, 0.1, 0.25, 1.0)))
        .child(
            el().absolute(0.0, 0.0)
                .w(38.90625 * state.scratchpad_clear_progress)
                .h_full()
                .fill(danger.alpha(0.15)),
        )
        .child(label(
            "Clear",
            11.0,
            if state.scratchpad_clear_hover || state.scratchpad_clear_started.is_some() {
                danger
            } else {
                t.muted
            },
        ))
        .on_key(move |s: &mut AppState, event, tx| {
            if !matches!(&event.key, Key::Enter) && !matches!(&event.key, Key::Text(t) if t == " ")
            {
                return false;
            }
            focus(s, project, &key_id);
            if !s.studio.scratchpad_clear_key_held {
                s.studio.scratchpad_clear_key_held = true;
                s.studio.scratchpad_clear_cancelled = None;
                s.studio.scratchpad_clear_started = Some(Instant::now());
                tx.wake_after(Duration::ZERO);
            }
            true
        })
        .on_key_up(move |s: &mut AppState, event, tx| {
            if !matches!(&event.key, Key::Enter) && !matches!(&event.key, Key::Text(t) if t == " ")
            {
                return false;
            }
            focus(s, project, &key_up_id);
            s.studio.scratchpad_clear_key_held = false;
            cancel(&mut s.studio, tx);
            true
        })
        .on_drag(move |s: &mut AppState, drag, tx| {
            focus(s, project, &clear_id);
            match drag.phase {
                Phase::Down => {
                    s.studio.scratchpad_clear_cancelled = None;
                    s.studio.scratchpad_clear_started = Some(Instant::now());
                    tx.wake_after(Duration::ZERO);
                }
                Phase::Move
                    if drag.x < 0.0 || drag.y < 0.0 || drag.x > drag.w || drag.y > drag.h =>
                {
                    cancel(&mut s.studio, tx);
                }
                Phase::Up => {
                    cancel(&mut s.studio, tx);
                }
                _ => {}
            }
        })
        .on_hover_change(move |s: &mut AppState, over, tx| {
            focus(s, project, &hover_id);
            s.studio.scratchpad_clear_hover = over;
            if !over {
                cancel(&mut s.studio, tx);
            }
        });
    row()
        .w_full()
        .center_y()
        .gap(14.4)
        .pt(12.0)
        .pb(3.2)
        .px(1.6)
        .opacity(
            if state.scratchpad_footer_hover || s.studio_column_hover.as_deref() == Some(id) {
                1.0
            } else {
                0.45
            },
        )
        .on_hover_focus_change(move |s: &mut AppState, over, _| {
            focus(s, project, &foot_id);
            s.studio.scratchpad_footer_hover = over;
        })
        .child(label(format!("{words} words"), 12.0, t.muted))
        .child(
            label(saved, 12.0, if saving { t.accent } else { t.muted })
                .min_w(76.8)
                .opacity(if saving { 1.0 } else { 0.82 }),
        )
        .child(el().grow(1.0))
        .child(
            row()
                .center_y()
                .gap(5.6)
                .child(
                    el().key(format!("pad-copy-{id}"))
                        .role("button")
                        .label("Copy as Markdown")
                        .focusable(true)
                        .px(5.6)
                        .py(4.48)
                        .radius(8.0)
                        .hover(t.hover)
                        .child(icon(&COPY, 13.0).color(
                            if state.scratchpad_tool_hover == Some("copy") {
                                t.ink
                            } else {
                                t.muted
                            },
                        ))
                        .on_hover_change(move |s: &mut AppState, over, _| {
                            focus(s, project, &copy_hover_id);
                            s.studio.scratchpad_tool_hover = over.then_some("copy");
                        })
                        .on_press_tx(move |s: &mut AppState, tx| {
                            focus(s, project, &copy_id);
                            if let Some(edit) = &s.studio.scratchpad {
                                let md = markdown(&edit.to_html());
                                if !md.trim().is_empty() {
                                    tx.copy(md);
                                }
                            }
                        }),
                )
                .child(
                    el().key(format!("pad-export-{id}"))
                        .role("button")
                        .label("Export .md")
                        .focusable(true)
                        .px(5.6)
                        .py(4.48)
                        .radius(8.0)
                        .hover(t.hover)
                        .child(icon(&DOWNLOAD, 13.0).color(
                            if state.scratchpad_tool_hover == Some("export") {
                                t.ink
                            } else {
                                t.muted
                            },
                        ))
                        .on_hover_change(move |s: &mut AppState, over, _| {
                            focus(s, project, &export_hover_id);
                            s.studio.scratchpad_tool_hover = over.then_some("export");
                        })
                        .on_press_tx(move |s: &mut AppState, tx| {
                            focus(s, project, &export_id);
                            let md = s
                                .studio
                                .scratchpad
                                .as_ref()
                                .map(|e| markdown(&e.to_html()))
                                .unwrap_or_default();
                            tx.save_file(
                                rune::FileDialogOptions {
                                    title: "Export Scratchpad".into(),
                                    file_name: Some("scratchpad.md".into()),
                                    ..Default::default()
                                },
                                move |s: &mut AppState, result, _| match result {
                                    Ok(Some(path)) => {
                                        if let Err(error) = std::fs::write(path, &md) {
                                            s.studio.error = Some(error.to_string());
                                        }
                                    }
                                    Err(error) => s.studio.error = Some(error.to_string()),
                                    _ => {}
                                },
                            );
                        }),
                )
                .child(clear),
        )
}

#[derive(Default)]
struct Node {
    tag: String,
    attrs: String,
    text: String,
    children: Vec<Node>,
}
fn decode(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace('\u{200b}', "")
}
fn parse(html: &str, cursor: &mut usize) -> Vec<Node> {
    let mut nodes = Vec::new();
    while *cursor < html.len() {
        let rest = &html[*cursor..];
        if rest.starts_with("</") {
            *cursor += rest.find('>').map_or(rest.len(), |i| i + 1);
            break;
        }
        if rest.starts_with('<') {
            let Some(end) = rest.find('>') else {
                break;
            };
            let inner = &rest[1..end];
            let tag = inner
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_end_matches('/')
                .to_lowercase();
            let attrs = inner[tag.len()..].to_owned();
            *cursor += end + 1;
            let children = if matches!(tag.as_str(), "br" | "hr" | "input") || inner.ends_with('/')
            {
                Vec::new()
            } else {
                parse(html, cursor)
            };
            nodes.push(Node {
                tag,
                attrs,
                children,
                ..Default::default()
            });
        } else {
            let end = rest.find('<').unwrap_or(rest.len());
            nodes.push(Node {
                text: decode(&rest[..end]),
                ..Default::default()
            });
            *cursor += end;
        }
    }
    nodes
}
fn wrap(delimiter: &str, body: String) -> String {
    let core = body.trim();
    if core.is_empty() {
        return body;
    }
    let left = body.len() - body.trim_start().len();
    let right = body.trim_end().len();
    format!(
        "{}{delimiter}{core}{delimiter}{}",
        &body[..left],
        &body[right..]
    )
}
fn inline(node: &Node) -> String {
    if node.tag.is_empty() {
        return node.text.clone();
    }
    let body: String = node.children.iter().map(inline).collect();
    match node.tag.as_str() {
        "b" | "strong" => wrap("**", body),
        "i" | "em" => wrap("*", body),
        "s" | "strike" | "del" => wrap("~~", body),
        "mark" => wrap("==", body),
        "code" => wrap("`", body),
        "br" => "\n".into(),
        "span" if node.attrs.contains("background-color") => wrap("==", body),
        "a" => {
            if let Some(href) = attribute(&node.attrs, "href") {
                format!("[{body}]({href})")
            } else {
                body
            }
        }
        _ => body,
    }
}
fn attribute(attrs: &str, key: &str) -> Option<String> {
    let tail = attrs.split_once(&format!("{key}="))?.1;
    let quote = tail.chars().next()?;
    if quote == '\'' || quote == '"' {
        Some(decode(tail[1..].split(quote).next()?))
    } else {
        Some(decode(tail.split_whitespace().next()?))
    }
}
fn plain(node: &Node) -> String {
    if node.tag.is_empty() {
        node.text.clone()
    } else {
        node.children.iter().map(plain).collect()
    }
}
fn list(node: &Node, indent: &str, out: &mut Vec<String>) {
    let start = attribute(&node.attrs, "start")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(1);
    for (n, li) in (start..).zip(node.children.iter().filter(|n| n.tag == "li")) {
        let own: String = li
            .children
            .iter()
            .filter(|n| n.tag != "ul" && n.tag != "ol")
            .map(inline)
            .collect();
        let marker = if node.tag == "ol" {
            format!("{n}.")
        } else {
            "-".into()
        };
        let checked = attribute(&li.attrs, "data-checked")
            .map_or("", |v| if v == "true" { "[x] " } else { "[ ] " });
        out.push(
            format!("{indent}{marker} {checked}{}", own.trim())
                .trim_end()
                .to_owned(),
        );
        for sub in li
            .children
            .iter()
            .filter(|n| n.tag == "ul" || n.tag == "ol")
        {
            list(sub, &format!("{indent}  "), out);
        }
    }
}
fn block(node: &Node, out: &mut Vec<String>) {
    match node.tag.as_str() {
        "ul" | "ol" => {
            list(node, "", out);
            out.push(String::new());
        }
        "blockquote" => {
            let mut inner = Vec::new();
            for child in &node.children {
                block(child, &mut inner);
            }
            out.push(
                inner
                    .join("\n")
                    .trim()
                    .split('\n')
                    .map(|line| {
                        if line.is_empty() {
                            ">".into()
                        } else {
                            format!("> {line}")
                        }
                    })
                    .collect::<Vec<String>>()
                    .join("\n"),
            );
            out.push(String::new());
        }
        "pre" => {
            out.extend([
                "```".into(),
                plain(node).trim_end_matches('\n').into(),
                "```".into(),
                String::new(),
            ]);
        }
        "hr" => {
            out.extend(["---".into(), String::new()]);
        }
        "br" => {}
        "div"
            if node.children.iter().any(|n| {
                matches!(
                    n.tag.as_str(),
                    "p" | "div"
                        | "ul"
                        | "ol"
                        | "blockquote"
                        | "pre"
                        | "hr"
                        | "h1"
                        | "h2"
                        | "h3"
                        | "h4"
                        | "h5"
                        | "h6"
                )
            }) =>
        {
            for child in &node.children {
                block(child, out);
            }
        }
        tag => {
            let body = inline(node).trim().to_owned();
            if !body.is_empty() || matches!(tag, "p" | "div") {
                let prefix = if matches!(tag, "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
                    format!("{} ", "#".repeat(tag[1..].parse().unwrap_or(1)))
                } else {
                    String::new()
                };
                out.extend([format!("{prefix}{body}"), String::new()]);
            }
        }
    }
}
pub fn markdown(html: &str) -> String {
    let mut out = Vec::new();
    for node in parse(html, &mut 0) {
        block(&node, &mut out);
    }
    let mut result = out.join("\n");
    while result.contains("\n\n\n") {
        result = result.replace("\n\n\n", "\n\n");
    }
    result.trim().to_owned()
}
#[cfg(test)]
mod tests {
    #[test]
    fn cancelling_retracts_without_clearing_the_document() {
        let mut state = crate::state::StudioState {
            scratchpad: Some(rune::TextEdit::from_html("<p>Keep</p>")),
            scratchpad_clear_started: Some(std::time::Instant::now()),
            scratchpad_clear_progress: 0.5,
            ..Default::default()
        };
        let mut tx = rune::Tx::default();
        super::cancel(&mut state, &mut tx);
        assert!(state.scratchpad_clear_started.is_none());
        assert_eq!(state.scratchpad_clear_progress, 0.5);
        state.scratchpad_clear_cancelled = Some((
            std::time::Instant::now() - std::time::Duration::from_millis(110),
            0.5,
        ));
        assert!(super::poll(&mut state, &mut tx));
        assert!(state.scratchpad_clear_progress > 0.0 && state.scratchpad_clear_progress < 0.1);
        state.scratchpad_clear_cancelled = Some((
            std::time::Instant::now() - std::time::Duration::from_millis(221),
            0.5,
        ));
        assert!(super::poll(&mut state, &mut tx));
        assert_eq!(state.scratchpad_clear_progress, 0.0);
        assert_eq!(state.scratchpad.as_ref().unwrap().text, "Keep");
        assert!(state.scratchpad_clear_cancelled.is_none());
    }
    #[test]
    fn clear_requires_full_hold_and_resets_progress() {
        let mut state = crate::state::StudioState {
            scratchpad: Some(rune::TextEdit::from_html("<p><b>Keep this</b></p>").rich()),
            scratchpad_clear_started: Some(std::time::Instant::now()),
            ..Default::default()
        };
        let mut tx = rune::Tx::default();
        assert!(super::poll(&mut state, &mut tx));
        assert_eq!(state.scratchpad.as_ref().unwrap().text, "Keep this");
        state.scratchpad_clear_started =
            Some(std::time::Instant::now() - std::time::Duration::from_millis(851));
        assert!(super::poll(&mut state, &mut tx));
        assert!(state.scratchpad.as_ref().unwrap().text.is_empty());
        assert!(state.scratchpad.as_ref().unwrap().marks().is_empty());
        assert!(state.scratchpad_clear_started.is_none());
        assert_eq!(state.scratchpad_clear_progress, 0.0);
        assert!(!super::poll(&mut state, &mut tx));
    }
    #[test]
    fn markdown_preserves_rich_document_interchange() {
        assert_eq!(
            super::markdown(
                "<h2>Notes</h2><p><b> bold </b><i>idea</i> <mark data-hl=\"amber\">highlight</mark></p><ul><li data-checked=\"true\">done</li><li>next<ul><li>child</li></ul></li></ul><blockquote><p>quoted</p></blockquote><pre><code>let x = 1;\n</code></pre>"
            ),
            "## Notes\n\n**bold** *idea* ==highlight==\n\n- [x] done\n- next\n  - child\n\n> quoted\n\n```\nlet x = 1;\n```"
        );
    }
}

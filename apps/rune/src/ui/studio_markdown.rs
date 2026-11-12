use rune::{El, Link, Span, TextStyle, col, el, icon, row, text};

use crate::{
    state::AppState,
    theme::{Palette, mix_srgb},
};

fn body_style(size: f32, line_height: f32) -> TextStyle {
    let mut style = TextStyle::new(size, 400.0);
    style.line_height = line_height;
    style
}

// Preserve text as a single wrapped layout, while styling inline code and links.
fn inline(source: &str, t: Palette) -> El {
    let mut output = String::new();
    let mut spans = Vec::new();
    let mut links = Vec::new();
    let mut rest = source;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix('`')
            && let Some(end) = after.find('`')
        {
            let start = output.len();
            output.push_str(&after[..end]);
            spans.push(
                Span::new(start, output.len())
                    .mono()
                    .size(12.0)
                    .bg(t.hover, 4.5),
            );
            rest = &after[end + 1..];
            continue;
        }
        if let Some(after) = rest.strip_prefix('[')
            && let Some(end) = after.find("](")
            && let Some(close) = after[end + 2..].find(')')
        {
            let url = &after[end + 2..end + 2 + close];
            if url.starts_with("https://") || url.starts_with("http://") {
                let icon_start = output.len();
                output.push_str("M↓");
                spans.push(
                    Span::new(icon_start, output.len())
                        .size(8.0)
                        .color(rune::color::hex("#ffffff").unwrap())
                        .bg(rune::color::hex("#00a8d5").unwrap(), 3.0),
                );
                output.push(' ');
            }
            let start = output.len();
            output.push_str(&after[..end]);
            links.push(Link::new(
                start..output.len(),
                &after[end + 2..end + 2 + close],
            ));
            spans.push(
                Span::new(start, output.len())
                    .color(t.accent)
                    .underline(t.accent),
            );
            rest = &after[end + 2 + close + 1..];
            continue;
        }
        let ch = rest.chars().next().expect("non-empty");
        output.push(ch);
        rest = &rest[ch.len_utf8()..];
    }
    let mut rendered = text(output)
        .font(body_style(14.0, 23.0))
        .color(t.ink)
        .spans(spans)
        .wrap()
        .w_full()
        .on_link(|_: &mut AppState, url, tx| {
            let _ = tx.open_url(url);
        });
    for link in links {
        rendered = rendered.link(link);
    }
    rendered
}

// Colours from Shiki's light-plus and dark-plus themes. Keep punctuation in
// the theme's foreground; classify identifiers using their immediate context.
fn syntax_spans(line: &str, dark: bool) -> Vec<Span> {
    let mut spans = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    let mut previous = "";
    while i < bytes.len() {
        let start = i;
        let b = bytes[i];
        if b == b'"' || b == b'\'' || b == b'`' {
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' {
                    i = (i + 2).min(bytes.len());
                    continue;
                }
                if bytes[i] == b {
                    i += 1;
                    break;
                }
                i += 1;
            }
            spans.push(
                Span::new(start, i)
                    .color(rune::color::hex(if dark { "#CE9178" } else { "#A31515" }).unwrap()),
            );
        } else if b.is_ascii_digit() {
            i += 1;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            spans.push(
                Span::new(start, i)
                    .color(rune::color::hex(if dark { "#B5CEA8" } else { "#098658" }).unwrap()),
            );
        } else if b.is_ascii_alphabetic() || b == b'_' || b == b'$' {
            i += 1;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'$')
            {
                i += 1;
            }
            let word = &line[start..i];
            let next = line[i..].trim_start();
            let color = if matches!(word, "const" | "let" | "var" | "function") {
                if dark { "#569CD6" } else { "#0000FF" }
            } else if matches!(word, "export" | "return" | "if" | "else" | "type") {
                if dark { "#C586C0" } else { "#AF00DB" }
            } else if matches!(word, "number" | "boolean" | "void" | "string")
                || word.chars().next().is_some_and(char::is_uppercase)
            {
                if dark { "#4EC9B0" } else { "#267F99" }
            } else if next.starts_with('(') || previous == "function" {
                if dark { "#DCDCAA" } else { "#795E26" }
            } else if matches!(previous, "const" | "let" | "var") {
                if dark { "#4FC1FF" } else { "#0070C1" }
            } else if dark {
                "#9CDCFE"
            } else {
                "#001080"
            };
            spans.push(Span::new(start, i).color(rune::color::hex(color).unwrap()));
            previous = word;
        } else {
            i += 1;
        }
    }
    spans
}

fn code_block(language: &str, source: &str, t: Palette) -> El {
    let name = match language.trim() {
        "ts" | "typescript" => "typescript",
        "js" | "javascript" => "javascript",
        "" => "code",
        other => other,
    };
    let copied = source.trim_end_matches('\n').to_owned();
    let mut content = col();
    for line in copied.split('\n') {
        let spans = syntax_spans(line, t.dark);
        content = content.child(
            text(if line.is_empty() { " " } else { line }.to_owned())
                .font(body_style(12.5, 20.0).mono())
                .color(rune::color::hex(if t.dark { "#D4D4D4" } else { "#000000" }).unwrap())
                .spans(spans),
        );
    }
    col()
        .w_full()
        .clip_rounded(13.0)
        .hover_group_focus()
        .fill(mix_srgb(t.raised, t.ink, 0.03))
        .child(
            row()
                .w_full()
                .h(33.0)
                .pl(14.0)
                .pr(10.0)
                .center_y()
                .child(
                    text(name.to_owned())
                        .font(TextStyle::new(11.0, 400.0).mono())
                        .color(t.muted),
                )
                .child(el().grow(1.0))
                .child(
                    row()
                        .center_y()
                        .gap(4.0)
                        .group_opacity(0.0, 1.0)
                        .child(icon(&super::studio::FOOTER_COPY01, 14.0).color(t.muted))
                        .child(
                            text("Copy")
                                .font(TextStyle::new(11.0, 400.0).mono())
                                .color(t.muted),
                        )
                        .on_press_tx(move |_: &mut AppState, tx| tx.copy(copied.clone())),
                ),
        )
        .child(
            el().w_full()
                .clip_rounded(0.0)
                .scroll_x()
                .pb(33.0)
                .child(content.px(14.0)),
        )
}

pub(super) fn render(source: &str, t: Palette) -> El {
    let mut result = col().w_full();
    let mut lines = source.lines().peekable();
    while let Some(line) = lines.next() {
        if line.trim().is_empty() {
            continue;
        }
        if let Some(lang) = line.strip_prefix("```") {
            let mut code = String::new();
            for next in lines.by_ref() {
                if next.starts_with("```") {
                    break;
                }
                code.push_str(next);
                code.push('\n');
            }
            result = result.child(code_block(lang, &code, t).mb(12.0));
        } else if let Some(heading) = line.strip_prefix("## ") {
            result = result.child(
                text(heading.to_owned())
                    .font(TextStyle::new(16.0, 600.0))
                    .color(t.ink)
                    .wrap()
                    .w_full()
                    .mb(8.0),
            );
        } else if let Some(item) = line.strip_prefix("- ") {
            result = result.child(
                row()
                    .w_full()
                    .pl(10.0)
                    .gap(12.0)
                    .child(text("•").font(body_style(14.0, 23.0)).color(t.muted))
                    .child(inline(item, t).grow(1.0))
                    .mb(10.0),
            );
            if lines.peek().is_none_or(|line| !line.starts_with("- ")) {
                result = result.child(el().h(8.0));
            }
        } else {
            let mut paragraph = line.to_owned();
            while let Some(next) = lines.peek() {
                if next.trim().is_empty()
                    || next.starts_with("```")
                    || next.starts_with("- ")
                    || next.starts_with("## ")
                {
                    break;
                }
                paragraph.push(' ');
                paragraph.push_str(lines.next().unwrap());
            }
            result = result.child(inline(&paragraph, t).mb(12.0));
        }
    }
    result
}

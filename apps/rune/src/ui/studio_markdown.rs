use rune::{El, Link, Span, TextStyle, col, el, row, text};

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
                    .bg(t.hover, 3.0),
            );
            rest = &after[end + 1..];
            continue;
        }
        if let Some(after) = rest.strip_prefix('[')
            && let Some(end) = after.find("](")
            && let Some(close) = after[end + 2..].find(')')
        {
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
        let mut spans = Vec::new();
        // Shiki's two themes both distinguish keywords, strings and numbers.
        for word in ["const", "export", "function", "return", "if", "type"] {
            for (start, _) in line.match_indices(word) {
                let end = start + word.len();
                let boundary = |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric() && c != '_');
                if boundary(line[..start].chars().next_back())
                    && boundary(line[end..].chars().next())
                {
                    spans.push(Span::new(start, end).color(
                        rune::color::hex(if t.dark { "#c792b5" } else { "#b600ff" }).unwrap(),
                    ));
                }
            }
        }
        if let Some(start) = line.find('"')
            && let Some(end) = line[start + 1..].find('"')
        {
            spans.push(
                Span::new(start, start + end + 2)
                    .color(rune::color::hex(if t.dark { "#ce9178" } else { "#c00000" }).unwrap()),
            );
        }
        content = content.child(
            text(if line.is_empty() { " " } else { line }.to_owned())
                .font(body_style(12.5, 20.0).mono())
                .color(rune::color::hex(if t.dark { "#9cdcfe" } else { "#001080" }).unwrap())
                .spans(spans),
        );
    }
    col()
        .w_full()
        .clip_rounded(13.0)
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
                    text("▢ Copy")
                        .font(TextStyle::new(11.0, 400.0).mono())
                        .color(t.muted)
                        .on_press_tx(move |_: &mut AppState, tx| tx.copy(copied.clone())),
                ),
        )
        .child(
            el().w_full()
                .clip_rounded(0.0)
                .scroll_x()
                .pb(13.0)
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
                    .mb(4.0),
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

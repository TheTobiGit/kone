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
fn inline(source: &str, t: Palette, key: String) -> El {
    let mut output = String::new();
    let mut spans = Vec::new();
    let mut links = Vec::new();
    let mut rest = source;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix('`')
            && let Some(end) = after.find('`')
        {
            let start = output.len();
            // Chromium's inline-code rule has horizontal padding. Text spans
            // cannot paint CSS padding, so include a space at each edge of
            // the highlighted range; the source's own surrounding spaces stay
            // outside the pill.
            output.push(' ');
            let padded_start = start;
            output.push_str(&after[..end]);
            output.push(' ');
            spans.push(
                Span::new(padded_start, output.len())
                    .mono()
                    .size(11.97)
                    .bg(t.hover, 4.55),
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
                output.push_str("\u{00a0}\u{00a0}");
                let icon_start = output.len();
                output.push_str("M↓");
                spans.push(
                    Span::new(icon_start, output.len())
                        .size(8.0)
                        .color(rune::color::hex("#ffffff").unwrap())
                        .bg(rune::color::hex("#00a8d5").unwrap(), 3.0),
                );
                output.push_str("\u{00a0}\u{00a0}");
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
                    .underline(t.accent.alpha(0.4)),
            );
            rest = &after[end + 2 + close + 1..];
            continue;
        }
        let ch = rest.chars().next().expect("non-empty");
        output.push(ch);
        rest = &rest[ch.len_utf8()..];
    }
    let mut rendered = text(output)
        .key(key)
        .font(body_style(14.0, 22.96))
        .color(t.ink)
        .selectable(true)
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

// Colours from Shiki's light-plus and dark-plus themes, as pixel-sampled from
// the reference captures: storage keywords are blue, control flow purple, types
// green, and identifiers their plain foreground navy (the light theme has no
// special colour for const-declared names). Keep punctuation in the theme's
// foreground; classify identifiers using their immediate context.
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
            let color = if matches!(word, "const" | "let" | "var" | "function" | "type") {
                if dark { "#569CD6" } else { "#0000FF" }
            } else if matches!(word, "export" | "return" | "if" | "else") {
                if dark { "#C586C0" } else { "#AF00DB" }
            } else if matches!(word, "number" | "boolean" | "void" | "string")
                || word.chars().next().is_some_and(char::is_uppercase)
            {
                if dark { "#4EC9B0" } else { "#267F99" }
            } else if next.starts_with('(') || previous == "function" {
                if dark { "#DCDCAA" } else { "#795E26" }
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

fn code_block(language: &str, source: &str, t: Palette, force_copy: bool) -> El {
    let name = match language.trim() {
        "ts" | "typescript" => "typescript",
        "js" | "javascript" => "javascript",
        "" => "code",
        other => other,
    };
    // The copy payload strips one trailing newline (`CodeBlock.vue`'s
    // `code.replace(/\n$/,"")`) while the render keeps the trailing empty line
    // box the reference draws.
    let copied = source.strip_suffix('\n').unwrap_or(source).to_owned();
    let mut content = col();
    for line in source.split('\n') {
        let spans = syntax_spans(line, t.dark);
        content = content.child(
            text(if line.is_empty() { " " } else { line }.to_owned())
                .font(body_style(12.5, 20.0).mono())
                .color(rune::color::hex(if t.dark { "#D4D4D4" } else { "#000000" }).unwrap())
                .spans(spans),
        );
    }
    let mut label_style = TextStyle::new(11.0, 400.0).mono().lh(18.04);
    label_style.tracking = 0.22;
    // `.cb:hover .cb__copy`: the whole figure is the hover group; the Copy
    // button rests hidden and shows on hover — unless the fixture pins it
    // visible (the reference pointer parks over one block per scene).
    col()
        .w_full()
        .clip_rounded(13.0)
        .hover_group()
        .fill(mix_srgb(t.raised, t.ink, 0.03))
        .child(
            row()
                .w_full()
                .h(37.0)
                .pl(14.0)
                .pr(10.0)
                .center_y()
                .child(text(name.to_owned()).font(label_style).color(t.muted))
                .child(el().grow(1.0))
                .child(
                    row()
                        .center_y()
                        .gap(4.0)
                        .px(7.0)
                        .py(3.0)
                        .radius(7.0)
                        .hover(t.hover)
                        .group_opacity(if force_copy { 1.0 } else { 0.0 }, 1.0)
                        .child(icon(&super::studio::FOOTER_COPY01, 13.0).color(t.muted))
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
                .pb(13.0)
                .child(content.px(14.0)),
        )
}

fn slug(heading: &str) -> String {
    let mut out = String::new();
    for ch in heading.to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
        } else if (ch == ' ' || ch == '-') && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_owned()
}

/// One Markdown block: heading, paragraph, bullet list or fenced code block.
enum Block {
    Heading(String),
    Paragraph(String),
    List(Vec<String>),
    Code { language: String, source: String },
}

/// `global_copy`: the 0-based index of the code block whose Copy button the
/// fixture pins visible, in the thread-wide count; `None` hides all of them at
/// rest (live threads show Copy under the pointer via the hover group).
pub(super) fn render(
    source: &str,
    t: Palette,
    cb_base: usize,
    global_copy: Option<usize>,
    key_prefix: &str,
) -> El {
    let force = |local_index: usize| Some(cb_base + local_index) == global_copy;
    let mut blocks: Vec<Block> = Vec::new();
    let mut lines = source.lines().peekable();
    while let Some(line) = lines.next() {
        if line.trim().is_empty() {
            continue;
        }
        if line.starts_with("```") {
            let language = line.strip_prefix("```").unwrap_or_default().to_owned();
            let mut code = String::new();
            for next in lines.by_ref() {
                if next.starts_with("```") {
                    break;
                }
                code.push_str(next);
                code.push('\n');
            }
            blocks.push(Block::Code {
                language,
                source: code,
            });
        } else if let Some(heading) = line.strip_prefix("## ") {
            blocks.push(Block::Heading(heading.to_owned()));
        } else if let Some(item) = line.strip_prefix("- ") {
            let mut items = vec![item.to_owned()];
            while let Some(item) = lines.peek().and_then(|next| next.strip_prefix("- ")) {
                items.push(item.to_owned());
                lines.next();
            }
            blocks.push(Block::List(items));
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
            blocks.push(Block::Paragraph(paragraph));
        }
    }
    let last = blocks.len().saturating_sub(1);
    let mut result = col().w_full();
    let mut code_index = 0usize;
    for (index, block) in blocks.iter().enumerate() {
        // `.md > :last-child` carries no bottom margin.
        if index == last {
            match block {
                Block::Heading(heading) => result = result.child(heading_el(heading, t, 0.0, 0.0)),
                Block::Paragraph(paragraph) => {
                    result = result.child(inline(paragraph, t, format!("{key_prefix}-{index}")))
                }
                Block::List(items) => {
                    result = result.child(list_el(items, t, 0.0, key_prefix, index))
                }
                Block::Code { language, source } => {
                    let forced = force(code_index);
                    code_index += 1;
                    result = result.child(code_block(language, source, t, forced))
                }
            }
            continue;
        }
        match block {
            Block::Heading(heading) => {
                result = result.child(heading_el(
                    heading,
                    t,
                    if index == 0 { 0.0 } else { 18.0 },
                    8.0,
                ))
            }
            Block::Paragraph(paragraph) => {
                result =
                    result.child(inline(paragraph, t, format!("{key_prefix}-{index}")).mb(12.0))
            }
            Block::List(items) => result = result.child(list_el(items, t, 12.0, key_prefix, index)),
            Block::Code { language, source } => {
                let forced = force(code_index);
                code_index += 1;
                result = result.child(code_block(language, source, t, forced).mb(4.0))
            }
        }
    }
    result
}

fn heading_el(heading: &str, t: Palette, mt: f32, mb: f32) -> El {
    let mut style = TextStyle::new(16.0, 640.0).lh(21.12);
    style.tracking = -0.192;
    text(heading.to_owned())
        .key(format!("md-h-{}", slug(heading)))
        .font(style)
        .color(t.ink)
        .selectable(true)
        .wrap()
        .w_full()
        .mt(mt)
        .mb(mb)
}

fn list_el(items: &[String], t: Palette, mb: f32, key_prefix: &str, index: usize) -> El {
    // `ul` has no padding; each `li` wraps a `p` whose 12px bottom margin
    // collapses with the li's 4px, so the pitch is lh + 12 and the first li
    // sits at the ul's top. The 5pt disc marker's left edge lands at 7.5 with
    // its centre on the first line's midline; text at 27.
    let mut list = col().w_full().gap(12.0);
    for (item_index, item) in items.iter().enumerate() {
        list = list.child(
            row()
                .w_full()
                .pl(7.5)
                .gap(14.5)
                .child(el().w(5.0).h(5.0).corners([2.5; 4]).fill(t.muted).mt(8.98))
                .child(inline(item, t, format!("{key_prefix}-{index}-{item_index}")).grow(1.0)),
        );
    }
    list.mb(mb)
}

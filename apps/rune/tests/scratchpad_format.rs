use rune::{Block, Mark, TextEdit};

#[test]
fn scratchpad_formats_roundtrip_through_html() {
    let source = "<h2>Title</h2><p><mark data-hl=\"sky\">wash</mark> <span data-tc=\"orchid\">pen</span></p><ul><li data-checked=\"true\">done</li><li data-checked=\"false\">next</li></ul>";
    let edit = TextEdit::from_html(source);
    assert_eq!(
        edit.blocks(),
        &[
            Block::Heading(2),
            Block::Paragraph,
            Block::Task(true),
            Block::Task(false)
        ]
    );
    assert!(
        edit.marks()
            .iter()
            .any(|m| m.mark == Mark::Highlight("sky".into()))
    );
    assert!(
        edit.marks()
            .iter()
            .any(|m| m.mark == Mark::TextColor("orchid".into()))
    );
    let restored = TextEdit::from_html(&edit.to_html());
    assert_eq!(restored.text, edit.text);
    assert_eq!(restored.blocks(), edit.blocks());
    assert_eq!(restored.marks(), edit.marks());
}

#[test]
fn changing_pen_replaces_only_the_selected_part() {
    let mut edit = TextEdit::new("alpha beta gamma").rich();
    edit.set_selection(0, 16);
    edit.toggle_mark(Mark::Highlight("copper".into()));
    edit.set_selection(6, 10);
    edit.toggle_mark(Mark::Highlight("sky".into()));
    assert_eq!(
        edit.marks()
            .iter()
            .map(|m| (m.start, m.end, &m.mark))
            .collect::<Vec<_>>(),
        vec![
            (0, 6, &Mark::Highlight("copper".into())),
            (6, 10, &Mark::Highlight("sky".into())),
            (10, 16, &Mark::Highlight("copper".into())),
        ]
    );
}

#[test]
fn stored_pen_names_resolve_per_theme() {
    let light = rune::RichStyle::default();
    let dark = rune::RichStyle {
        dark: true,
        ..light
    };
    assert_ne!(
        light.pen_color("orchid", false),
        dark.pen_color("orchid", false)
    );
    assert_eq!(light.pen_color("sky", true).hex(), "#3884ff38");
    assert_eq!(dark.pen_color("sky", true).hex(), "#5698ff52");
}

#[test]
fn document_paragraph_gap_moves_selection_geometry_and_soft_breaks_do_not() {
    use rune::{Cx, El, Env, RichStyle, Runtime, TextStyle, text_input};
    struct State {
        edit: TextEdit,
        boxes: std::cell::RefCell<Vec<[f32; 4]>>,
    }
    fn view(state: &State, cx: &mut Cx<State>) -> El {
        *state.boxes.borrow_mut() = cx.selection_rects();
        text_input(&state.edit, TextStyle::new(16.0, 400.0).lh(26.88))
            .rich_style(RichStyle {
                document_spacing: true,
                ..RichStyle::default()
            })
            .w(500.0)
            .h(300.0)
            .on_edit(|state: &mut State| &mut state.edit)
    }
    fn distance(html: &str) -> f32 {
        let mut edit = TextEdit::from_html(html);
        edit.focused = true;
        edit.set_selection(0, edit.text.len());
        let mut runtime = Runtime::new(
            State {
                edit,
                boxes: Default::default(),
            },
            view,
            (500.0, 300.0),
            Env::new(false, 1.0),
        );
        runtime.frame(0.0);
        runtime.frame(0.0);
        let rectangles = runtime.state.boxes.borrow();
        assert_eq!(rectangles.len(), 2, "{rectangles:?}");
        rectangles[1][1] - rectangles[0][1]
    }
    let paragraphs = distance("<p>one</p><p>two</p>");
    let soft = distance("<p>one<br>two</p>");
    assert!(
        (paragraphs - soft - 8.8).abs() < 0.02,
        "paragraphs={paragraphs}, soft={soft}"
    );
}

#[test]
fn task_return_continues_unchecked_and_keeps_undo() {
    use rune::{Key, KeyEvent, Mods};
    let mut edit = TextEdit::from_html("<ul><li data-checked=\"true\">finished</li></ul>");
    edit.set_selection(edit.text.len(), edit.text.len());
    edit.key(
        &KeyEvent {
            key: Key::Enter,
            mods: Mods::default(),
        },
        None,
    );
    assert_eq!(edit.blocks(), &[Block::Task(true), Block::Task(false)]);
    edit.undo();
    assert_eq!(edit.blocks(), &[Block::Task(true)]);
    assert_eq!(edit.text, "finished");
}

#[test]
fn document_return_edits_instead_of_submitting() {
    use rune::{Cx, El, Env, Key, KeyEvent, Mods, RichStyle, Runtime, TextStyle, text_input};
    fn view(edit: &TextEdit, _: &mut Cx<TextEdit>) -> El {
        text_input(edit, TextStyle::new(16.0, 400.0).lh(26.88))
            .rich_style(RichStyle {
                document_spacing: true,
                ..RichStyle::default()
            })
            .w(500.0)
            .h(300.0)
            .on_edit(|edit: &mut TextEdit| edit)
    }
    let mut edit = TextEdit::from_html("<p>one</p>");
    edit.focused = true;
    edit.set_selection(edit.text.len(), edit.text.len());
    let mut runtime = Runtime::new(edit, view, (500.0, 300.0), Env::new(false, 1.0));
    runtime.frame(0.0);
    runtime.key(KeyEvent {
        key: Key::Enter,
        mods: Mods::default(),
    });
    runtime.frame(0.0);
    assert_eq!(runtime.state.text, "one\n");
    assert_eq!(
        runtime.state.blocks(),
        &[Block::Paragraph, Block::Paragraph]
    );
}

#[test]
fn inline_padding_changes_advance_and_its_cache_key() {
    use rune::text::TextSystem;
    use rune::{Span, TextStyle};
    let mut text = TextSystem::default();
    let style = TextStyle::new(16.0, 400.0);
    let plain = text.layout_rich("hello world", &[], style, 2.0, None);
    let padded = text.layout_rich(
        "hello world",
        &[Span {
            start: 0,
            end: 5,
            inline_pad: [4.5; 2],
            ..Span::default()
        }],
        style,
        2.0,
        None,
    );
    assert!((padded.full_width() - plain.full_width() - 18.0).abs() < 0.02);
    let plain_again = text.layout_rich("hello world", &[], style, 2.0, None);
    assert_eq!(plain_again.full_width(), plain.full_width());
}

#[test]
fn trailing_inline_padding_moves_following_glyph_run() {
    use rune::text::TextSystem;
    use rune::{Span, TextStyle};
    let mut text = TextSystem::default();
    let style = TextStyle::new(16.0, 400.0);
    let a = text.layout_rich(
        "codeafter",
        &[Span {
            start: 0,
            end: 4,
            mono: true,
            ..Span::default()
        }],
        style,
        2.0,
        None,
    );
    let b = text.layout_rich(
        "codeafter",
        &[Span {
            start: 0,
            end: 4,
            mono: true,
            inline_pad: [4.5; 2],
            ..Span::default()
        }],
        style,
        2.0,
        None,
    );
    let mut first = Vec::new();
    let mut padded = Vec::new();
    text.glyphs_for_layout(&a, 2.0, [0.0; 2], false, &mut first);
    text.glyphs_for_layout(&b, 2.0, [0.0; 2], false, &mut padded);
    assert_eq!(first.len(), padded.len());
    assert!((padded.last().unwrap().rect[0] - first.last().unwrap().rect[0] - 18.0).abs() < 0.01);
}

#[test]
fn synthetic_bold_preserves_regular_face_advance() {
    use rune::text::TextSystem;
    use rune::{Family, Span, TextStyle};
    let mut text = TextSystem::new(
        &[
            include_bytes!("../assets/fonts/Geist-Regular.ttf"),
            include_bytes!("../assets/fonts/Geist-Bold.ttf"),
        ],
        ("Geist", "Geist"),
    );
    let style = TextStyle::new(22.0, 400.0).family(Family::Named("Geist"));
    let plain = text.layout_rich("Notes, snippets, drafts.", &[], style, 2.0, None);
    let bold = text.layout_rich(
        "Notes, snippets, drafts.",
        &[Span {
            start: 0,
            end: 23,
            weight: Some(700.0),
            synthetic_bold: true,
            ..Span::default()
        }],
        style,
        2.0,
        None,
    );
    assert!((plain.full_width() - bold.full_width()).abs() < 0.01);
}

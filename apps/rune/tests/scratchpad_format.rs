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

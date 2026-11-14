use rune::{Cx, El, Env, RichStyle, Runtime, ScrollSpec, TextEdit, TextStyle, el, text_input};
use std::cell::{Cell, RefCell};

struct State {
    edit: TextEdit,
    dragging: Cell<bool>,
    boxes: RefCell<Vec<[f32; 4]>>,
    editor_rect: Cell<Option<[f32; 4]>>,
}

fn view(state: &State, cx: &mut Cx<State>) -> El {
    state.dragging.set(cx.selection_dragging());
    let boxes = cx.selection_rects();
    *state.boxes.borrow_mut() = boxes.clone();
    state.editor_rect.set(cx.window_layout("editor"));
    let editor = text_input(&state.edit, TextStyle::new(16.0, 400.0).lh(26.88))
        .key("editor")
        .w(300.0)
        .h(700.0)
        .py(40.0)
        .rich_style(RichStyle {
            document_spacing: true,
            ..RichStyle::default()
        })
        .on_edit(|state: &mut State| &mut state.edit);
    let mut root = el().w_full().h_full().child(
        el().key("viewport")
            .w(300.0)
            .h(180.0)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .child(editor),
    );
    if let Some(rect) = boxes.first() {
        root = root.child(
            el().key("toolbar")
                .instant_changes()
                .absolute(rect[0], rect[1] - 20.0)
                .size(20.0, 10.0),
        );
    }
    root
}

fn runtime(selected: bool) -> Runtime<State> {
    let mut edit = TextEdit::from_html(
        "<p>first line</p><p>second line</p><p>third line</p><p>fourth line</p><p>fifth line</p>",
    );
    edit.focused = true;
    if selected {
        edit.set_selection(11, 17);
    }
    let state = State {
        edit,
        dragging: Cell::new(false),
        boxes: RefCell::default(),
        editor_rect: Cell::new(None),
    };
    let mut runtime = Runtime::new(state, view, (400.0, 300.0), Env::new(false, 2.0));
    runtime.frame(0.0);
    runtime.frame(0.0);
    runtime
}

#[test]
fn dragging_read_tracks_release_even_when_selection_does_not_move() {
    let mut runtime = runtime(false);
    assert!(!runtime.state.dragging.get());
    runtime.pointer_down(5.0, 50.0);
    runtime.frame(0.0);
    assert!(
        runtime.state.dragging.get(),
        "press begins selection lifecycle"
    );
    runtime.pointer_move(75.0, 50.0);
    runtime.frame(0.0);
    runtime.frame(0.0);
    assert!(runtime.state.dragging.get());
    assert!(
        !runtime.state.boxes.borrow().is_empty(),
        "selection boxes remain live while dragging, range={:?}",
        runtime.state.edit.range()
    );
    let selected = runtime.state.edit.range();
    runtime.pointer_up(75.0, 50.0);
    runtime.frame(0.0);
    runtime.frame(0.0);
    assert_eq!(runtime.state.edit.range(), selected);
    assert!(
        !runtime.state.dragging.get(),
        "release re-runs reader despite unchanged selected range"
    );
}

#[test]
fn scrolled_input_selection_and_toolbar_share_exact_window_translation() {
    let mut runtime = runtime(true);
    let before = runtime.state.boxes.borrow()[0];
    let editor_before = runtime.state.editor_rect.get().unwrap();
    let toolbar_before = runtime.find("toolbar").unwrap();
    runtime.wheel(150.0, 100.0, -30.0);
    runtime.frame(0.1);
    runtime.frame(0.1);
    let after = runtime.state.boxes.borrow()[0];
    let editor_after = runtime.state.editor_rect.get().unwrap();
    let toolbar_after = runtime.find("toolbar").unwrap();
    let shift = editor_after[1] - editor_before[1];
    assert!(shift < -1.0, "viewport must actually scroll: {shift}");
    assert!(
        (after[1] - before[1] - shift).abs() < 0.001,
        "selection follows same scroll translation"
    );
    assert!(
        (toolbar_after.1 - toolbar_before.1 - shift).abs() < 0.001,
        "toolbar remains attached to selection: before={toolbar_before:?}, after={toolbar_after:?}, shift={shift}, boxes={before:?}->{after:?}"
    );
    assert_eq!(
        (after[0], after[2], after[3]),
        (before[0], before[2], before[3])
    );
}

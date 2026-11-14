//! Scratchpad selection toolbar. Dimensions and paths follow PadFormatBar.vue.
use crate::{
    state::{AppState, StudioState},
    theme::Palette,
};
use rune::{
    Block, Color, El, Family, Icon, Key, KeyEvent, Mark, TextStyle, col, el, icon, row, text,
};
#[path = "scratchpad_icons.rs"]
mod icons;
use icons::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Popover {
    Block,
    Highlight,
    Text,
}
#[derive(Clone, Debug)]
pub struct ToolbarState {
    pub open: Option<Popover>,
    pub hover: Option<String>,
    pub code_spacer: Option<usize>,
    pub highlight: String,
    pub text: String,
    pub dismissed: Option<(usize, usize)>,
    pub selection: Option<(usize, usize)>,
    pub shown_after: Option<std::time::Instant>,
}
impl Default for ToolbarState {
    fn default() -> Self {
        Self {
            open: None,
            hover: None,
            code_spacer: None,
            highlight: "copper".into(),
            text: "default".into(),
            dismissed: None,
            selection: None,
            shown_after: None,
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Anchor {
    pub x: f32,
    pub top: f32,
    pub bottom: f32,
}
#[derive(Clone, Copy, Debug)]
pub struct Placement {
    pub left: f32,
    pub top: f32,
    pub above: bool,
    pub pop_above: bool,
}
pub fn placement(
    anchor: Anchor,
    width: f32,
    viewport: (f32, f32),
    pop: Option<Popover>,
) -> Placement {
    let above = anchor.top >= 60.0;
    let top = if above {
        anchor.top - 48.0
    } else {
        anchor.bottom + 10.0
    };
    let left = (anchor.x - width / 2.0).clamp(12.0, (viewport.0 - width - 12.0).max(12.0));
    let room_above = top - 12.0;
    let room_below = viewport.1 - top - 38.0 - 12.0;
    let need = if pop == Some(Popover::Block) {
        249.0
    } else {
        40.0
    };
    let pop_above = if above {
        room_above >= need || room_above >= room_below
    } else {
        !(room_below >= need || room_below >= room_above)
    };
    Placement {
        left: left.round(),
        top: top.round(),
        above,
        pop_above,
    }
}
fn label(value: impl Into<String>, size: f32, color: Color) -> El {
    text(value)
        .font(
            TextStyle::new(size, 400.0)
                .family(Family::Named("Geist"))
                .lh(size),
        )
        .color(color)
}
fn color(hex: &str) -> Color {
    rune::color::hex(hex).unwrap()
}
pub fn highlight_color(id: &str, dark: bool, dot: bool) -> Color {
    let (hex, alpha) = match (dark, dot, id) {
        (false, true, "amber") => ("#eab308", 0.68),
        (false, true, "moss") => ("#10b981", 0.58),
        (false, true, "sky") => ("#3884ff", 0.55),
        (false, true, "orchid") => ("#a76af0", 0.56),
        (true, true, "amber") => ("#eab308", 0.8),
        (true, true, "moss") => ("#34c794", 0.75),
        (true, true, "sky") => ("#6ca6ff", 0.75),
        (true, true, "orchid") => ("#bc8df7", 0.75),
        (true, true, _) => ("#e2896c", 0.8),
        (false, true, _) => ("#d97757", 0.62),
        (_, false, "amber") => ("#eab308", 0.32),
        (false, false, "moss") => ("#10b981", 0.26),
        (true, false, "moss") => ("#10b981", 0.3),
        (false, false, "sky") => ("#3884ff", 0.22),
        (true, false, "sky") => ("#5698ff", 0.32),
        (false, false, "orchid") => ("#a76af0", 0.24),
        (true, false, "orchid") => ("#b27cf5", 0.32),
        (false, false, _) => ("#d97757", 0.3),
        (true, false, _) => ("#d97757", 0.36),
    };
    color(hex).alpha(alpha)
}
pub fn text_color(id: &str, t: Palette) -> Color {
    color(match (t.dark, id) {
        (false, "copper") => "#c1613f",
        (true, "copper") => "#e8907a",
        (false, "moss") => "#3f9e6f",
        (true, "moss") => "#5fc294",
        (false, "sky") => "#4d86d8",
        (true, "sky") => "#7fa9f0",
        (false, "orchid") => "#9268c9",
        (true, "orchid") => "#b58ae0",
        (false, "ash") => "#8a8a90",
        (true, "ash") => "#9c9ca4",
        _ => return t.ink,
    })
}
#[derive(Clone)]
enum Action {
    Mark(Mark),
    Block(Block),
    Highlight(String),
    Text(String),
    Clear,
    Pop(Popover),
}
fn apply(state: &mut StudioState, action: Action) {
    if let Action::Pop(pop) = action {
        state.scratchpad_toolbar.open = if state.scratchpad_toolbar.open == Some(pop) {
            None
        } else {
            Some(pop)
        };
        return;
    }
    let Some(edit) = state.scratchpad.as_mut() else {
        return;
    };
    match action {
        Action::Mark(mark) => {
            let code = mark == Mark::Code;
            let end = edit.range().1;
            edit.toggle_mark(mark);
            if code {
                edit.set_caret(end);
                state.scratchpad_toolbar.code_spacer = Some(end);
            }
        }
        Action::Block(block) => {
            edit.set_block(block);
            state.scratchpad_toolbar.open = None;
        }
        Action::Highlight(id) => {
            edit.toggle_mark(Mark::Highlight(id.clone()));
            state.scratchpad_toolbar.highlight = id;
            state.scratchpad_toolbar.open = None;
        }
        Action::Text(id) => {
            if id == "default" {
                edit.remove_mark(&Mark::TextColor(String::new()));
            } else {
                edit.toggle_mark(Mark::TextColor(id.clone()));
            }
            state.scratchpad_toolbar.text = id;
            state.scratchpad_toolbar.open = None;
        }
        Action::Clear => {
            let (a, b) = edit.range();
            let marks: Vec<_> = edit
                .marks()
                .iter()
                .filter(|m| m.start < b && a < m.end)
                .map(|m| m.mark.clone())
                .collect();
            for mark in marks {
                edit.remove_mark(&mark);
            }
        }
        Action::Pop(_) => {}
    }
}
pub fn sync(state: &mut StudioState, tx: &mut rune::Tx) -> bool {
    let range = state.scratchpad.as_ref().map(|edit| edit.range());
    if state
        .scratchpad_toolbar
        .code_spacer
        .is_some_and(|at| range != Some((at, at)))
    {
        state.scratchpad_toolbar.code_spacer = None;
    }
    if state.scratchpad_toolbar.selection != range {
        state.scratchpad_toolbar.selection = range;
        state.scratchpad_toolbar.dismissed = None;
        state.scratchpad_toolbar.open = None;
        state.scratchpad_toolbar.shown_after = Some(std::time::Instant::now());
        tx.wake_after(std::time::Duration::from_millis(90));
        return true;
    }
    if let Some(at) = state.scratchpad_toolbar.shown_after {
        let delay = std::time::Duration::from_millis(90);
        if at.elapsed() >= delay {
            state.scratchpad_toolbar.shown_after = None;
            return true;
        }
        tx.wake_after(delay.saturating_sub(at.elapsed()));
    }
    false
}
pub fn key(state: &mut StudioState, event: &KeyEvent) -> bool {
    let Some(edit) = state.scratchpad.as_ref() else {
        return false;
    };
    let range = edit.range();
    if event.key == Key::Escape
        && range.0 != range.1
        && state.scratchpad_toolbar.dismissed != Some(range)
    {
        if state.scratchpad_toolbar.open.is_some() {
            state.scratchpad_toolbar.open = None;
        } else {
            state.scratchpad_toolbar.dismissed = Some(range);
        }
        return true;
    }
    let action = if event.is_command('b') {
        Some(Action::Mark(Mark::Bold))
    } else if event.is_command('i') {
        Some(Action::Mark(Mark::Italic))
    } else if event.is_command('s') && event.mods.shift {
        Some(Action::Mark(Mark::Strike))
    } else if event.is_command('e') {
        Some(Action::Mark(Mark::Code))
    } else if event.is_command('h') && event.mods.shift {
        Some(Action::Highlight(
            state.scratchpad_toolbar.highlight.clone(),
        ))
    } else if event.is_command('k') && event.mods.shift {
        Some(Action::Block(Block::Task(false)))
    } else {
        None
    };
    if let Some(action) = action {
        apply(state, action);
        true
    } else {
        false
    }
}
fn hot(mut t: Palette, ui: &ToolbarState, key: &str) -> Palette {
    if ui.hover.as_deref() == Some(key) {
        t.ink_soft = t.ink;
        t.muted = t.ink;
    }
    t
}
fn button(
    key: &str,
    art: &'static Icon,
    width: f32,
    active: bool,
    accent: Color,
    t: Palette,
    action: Action,
) -> El {
    let hover_key = key.to_owned();
    let mut button = el()
        .key(key.to_string())
        .role("button")
        .focusable(true)
        .label(key.to_string())
        .w(width)
        .h(28.0)
        .corners(if width == 16.0 {
            [3.0, 9.0, 9.0, 3.0]
        } else {
            [9.0; 4]
        })
        .center()
        .hover(t.hover)
        .press_scale(0.93)
        .on_hover_change(move |s: &mut AppState, over, _| {
            if over {
                s.studio.scratchpad_toolbar.hover = Some(hover_key.clone());
            } else if s.studio.scratchpad_toolbar.hover.as_ref() == Some(&hover_key) {
                s.studio.scratchpad_toolbar.hover = None;
            }
        })
        .child(
            icon(art, if width == 16.0 { 11.0 } else { 14.0 }).color(if active {
                t.ink
            } else if width == 16.0 {
                t.muted
            } else {
                t.ink_soft
            }),
        )
        .on_press(move |s: &mut AppState| apply(&mut s.studio, action.clone()));
    if active {
        button = button
            .fill(accent.alpha(accent.a * 0.18))
            .border(1.0, accent.alpha(accent.a * 0.32));
    }
    button
}
fn rule(t: Palette) -> El {
    el().w(9.0)
        .h(18.0)
        .px(4.0)
        .child(el().w(1.0).h(18.0).fill(t.ink.alpha(0.11)))
}
fn blocks() -> [(
    Block,
    &'static Icon,
    &'static str,
    &'static str,
    &'static str,
); 8] {
    [
        (Block::Paragraph, &PARAGRAPH, "Body text", "Text", ""),
        (Block::Heading(1), &HEADING01, "Heading 1", "H1", "# "),
        (Block::Heading(2), &HEADING02, "Heading 2", "H2", "## "),
        (Block::Heading(3), &HEADING03, "Heading 3", "H3", "### "),
        (
            Block::Bullet(0),
            &LEFTTORIGHTLISTBULLET,
            "Bulleted list",
            "List",
            "- ",
        ),
        (
            Block::Numbered(0),
            &LEFTTORIGHTLISTNUMBER,
            "Numbered list",
            "1. List",
            "1. ",
        ),
        (Block::Task(false), &CHECKLIST, "Task", "Task", "⌘⇧K"),
        (Block::Quote, &LEFTTORIGHTBLOCKQUOTE, "Quote", "Quote", "> "),
    ]
}
fn same_block(a: Block, b: Block) -> bool {
    match (a, b) {
        (Block::Task(_), Block::Task(_)) => true,
        _ => a.same_kind(b),
    }
}
fn shell(t: Palette) -> El {
    el().fill(t.ground)
        .radius(12.0)
        .border(1.0, t.ink.alpha(0.12))
        .shadow(10.0, 26.0, Color::BLACK.alpha(0.12))
}
pub fn overlay(s: &AppState, t: Palette, anchor: Anchor, viewport: (f32, f32)) -> El {
    let state = &s.studio;
    let Some(edit) = state.scratchpad.as_ref() else {
        return el();
    };
    let ui = &state.scratchpad_toolbar;
    let active = blocks()
        .into_iter()
        .find(|b| same_block(b.0, edit.active_block()))
        .unwrap_or(blocks()[0]);
    let label_width = match active.3 {
        "Text" => 22.171875,
        "H1" | "H2" | "H3" => 15.21875,
        "List" => 19.171875,
        "1. List" => 31.421875,
        "Task" => 24.703125,
        _ => 32.25,
    };
    let block_width = 14.0 + label_width + 12.0 + 9.0 + 13.0;
    let width = 10.0 + block_width + 3.0 * 9.0 + 4.0 * 28.0 + 2.0 * 44.0 + 28.0 + 10.0;
    let p = placement(anchor, width, viewport, ui.open);
    let expanded = ui.open == Some(Popover::Block);
    let block_button = row()
        .key("pad-block")
        .role("button")
        .label("Block kind")
        .expanded(expanded)
        .focusable(true)
        .h(28.0)
        .w(block_width)
        .pl(7.0)
        .pr(6.0)
        .gap(5.0)
        .center_y()
        .radius(9.0)
        .hover(t.hover)
        .fill(if expanded {
            t.ink.alpha(0.08)
        } else {
            Color::TRANSPARENT
        })
        .child(icon(active.1, 14.0).color(if expanded { t.ink } else { t.ink_soft }))
        .child(
            label(active.3, 11.5, if expanded { t.ink } else { t.ink_soft }).font(
                TextStyle::new(11.5, 400.0)
                    .family(Family::Named("Geist"))
                    .lh(11.5)
                    .tracking(0.0575),
            ),
        )
        .child(icon(&BLOCK_CHEVRON, 12.0).ml(-1.0).color(t.muted))
        .on_press(|s: &mut AppState| apply(&mut s.studio, Action::Pop(Popover::Block)));
    let mut bar = row()
        .key("pad-format-bar")
        .instant_changes()
        .role("toolbar")
        .label("Formatting")
        .focus_group()
        .on_key(|s: &mut AppState, event, _| key(&mut s.studio, event))
        .pin(Some(p.left), Some(p.top), None, None)
        .w(width)
        .h(38.0)
        .padding(5.0)
        .gap(1.0)
        .center_y()
        .radius(13.0)
        .fill(t.ground.alpha(0.94))
        .border(1.0, t.ink.alpha(0.12))
        .shadow(10.0, 28.0, Color::BLACK.alpha(0.11))
        .keeps_text_selection()
        .preserve_focus_on_press(true)
        .child(block_button)
        .child(rule(t));
    for (name, art, mark) in [
        ("Bold", &TEXTBOLD, Mark::Bold),
        ("Italic", &TEXTITALIC, Mark::Italic),
        ("Strikethrough", &TEXTSTRIKETHROUGH, Mark::Strike),
        ("Code", &SOURCECODE, Mark::Code),
    ] {
        bar = bar.child(button(
            name,
            art,
            28.0,
            edit.has_mark(&mark),
            t.accent,
            hot(t, ui, name),
            Action::Mark(mark),
        ));
    }
    bar = bar.child(rule(t));
    let mut slots = Vec::new();
    for (pop, art, pen, action, active_mark) in [
        (
            Popover::Highlight,
            &HIGHLIGHTER,
            highlight_color(&ui.highlight, t.dark, true),
            Action::Highlight(ui.highlight.clone()),
            edit.active_marks()
                .iter()
                .any(|m| matches!(m, Mark::Highlight(_))),
        ),
        (
            Popover::Text,
            &TEXTCOLOR,
            text_color(&ui.text, t),
            Action::Text(ui.text.clone()),
            false,
        ),
    ] {
        let slot_x = if pop == Popover::Highlight {
            block_width + 142.0
        } else {
            block_width + 187.0
        };
        slots.push((pop, slot_x + 22.0));
        let pen_button = button(
            if pop == Popover::Highlight {
                "Highlight"
            } else {
                "Text colour"
            },
            art,
            28.0,
            active_mark,
            pen,
            hot(
                t,
                ui,
                if pop == Popover::Highlight {
                    "Highlight"
                } else {
                    "Text colour"
                },
            ),
            action,
        )
        .corners([9.0, 3.0, 3.0, 9.0])
        .pl(2.0)
        .child(
            el().pin(Some(5.0), None, Some(3.0), Some(3.0))
                .h(2.0)
                .radius(99.0)
                .fill(pen),
        );
        let chev = button(
            if pop == Popover::Highlight {
                "Choose highlight colour"
            } else {
                "Choose text colour"
            },
            &SPLIT_CHEVRON,
            16.0,
            false,
            t.accent,
            hot(
                t,
                ui,
                if pop == Popover::Highlight {
                    "Choose highlight colour"
                } else {
                    "Choose text colour"
                },
            ),
            Action::Pop(pop),
        )
        .expanded(ui.open == Some(pop))
        .fill(if ui.open == Some(pop) {
            t.ink.alpha(0.08)
        } else {
            Color::TRANSPARENT
        });
        bar = bar.child(row().h(28.0).child(pen_button).child(chev));
    }
    bar = bar.child(rule(t)).child(button(
        "Clear formatting",
        &TEXTCLEAR,
        28.0,
        false,
        t.accent,
        hot(t, ui, "Clear formatting"),
        Action::Clear,
    ));
    if ui.open.is_none() {
        bar = bar.child(
            el().absolute(width / 2.0 - 5.0, if p.above { 33.0 } else { -5.0 })
                .size(10.0, 10.0)
                .rotate(std::f32::consts::FRAC_PI_4)
                .fill(t.ground)
                .border_sides(
                    if p.above {
                        [0.0, 1.0, 1.0, 0.0]
                    } else {
                        [1.0, 0.0, 0.0, 1.0]
                    },
                    t.ink.alpha(0.12),
                ),
        );
    }
    let mut overlay = el()
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .child(bar);
    if let Some(pop) = ui.open {
        let height = if pop == Popover::Block { 243.0 } else { 34.0 };
        let top = if p.pop_above {
            p.top - height - 2.0
        } else {
            p.top + 40.0
        };
        let panel = if pop == Popover::Block {
            let mut panel = col().gap(1.0).padding(6.0).w(194.0);
            for (block, art, name, _, hint) in blocks() {
                let on = same_block(block, edit.active_block());
                let mut item = row()
                    .key(format!("pad-block-{name}"))
                    .role("menuitemradio")
                    .label(name)
                    .focusable(true)
                    .w_full()
                    .h(28.0)
                    .px(7.0)
                    .gap(9.0)
                    .center_y()
                    .radius(8.0)
                    .hover(t.hover)
                    .child(icon(art, 14.0).color(if on { t.accent } else { t.muted }))
                    .child(label(name, 12.0, if on { t.ink } else { t.ink_soft }).grow(1.0));
                if on {
                    item = item.child(icon(&TICK02, 13.0).color(t.accent).mr(-2.0));
                } else if !hint.is_empty() {
                    item = item.child(label(hint, 10.5, t.muted));
                }
                panel =
                    panel.child(item.on_press(move |s: &mut AppState| {
                        apply(&mut s.studio, Action::Block(block))
                    }));
            }
            shell(t)
                .child(panel)
                .pin(Some(p.left + 5.0), Some(top), None, None)
        } else {
            let ids: &[&str] = if pop == Popover::Highlight {
                &["copper", "amber", "moss", "sky", "orchid"]
            } else {
                &["default", "copper", "moss", "sky", "orchid", "ash"]
            };
            let slot = slots.iter().find(|a| a.0 == pop).unwrap().1;
            let mut panel = row().padding(7.0).gap(5.0).center_y();
            for id in ids {
                let id = (*id).to_string();
                let dot = if pop == Popover::Highlight {
                    highlight_color(&id, t.dark, true)
                } else {
                    text_color(&id, t)
                };
                let armed = if pop == Popover::Highlight {
                    ui.highlight == id
                } else {
                    ui.text == id
                };
                let mut swatch = el()
                    .key(format!("pad-{pop:?}-{id}"))
                    .role("button")
                    .label(format!(
                        "{} {}",
                        if pop == Popover::Highlight {
                            "Highlight"
                        } else {
                            "Text colour"
                        },
                        {
                            let mut chars = id.chars();
                            match chars.next() {
                                None => String::new(),
                                Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                            }
                        }
                    ))
                    .focusable(true)
                    .size(20.0, 20.0)
                    .radius(99.0);
                if pop == Popover::Highlight {
                    swatch = swatch.fill(dot);
                } else {
                    swatch = swatch.child(
                        el().absolute(2.0, 2.0)
                            .size(16.0, 16.0)
                            .radius(99.0)
                            .fill(dot),
                    );
                }
                if armed {
                    swatch = swatch.child(
                        el().absolute(-3.5, -3.5)
                            .size(27.0, 27.0)
                            .radius(99.0)
                            .border(1.5, dot),
                    );
                }
                let action = if pop == Popover::Highlight {
                    Action::Highlight(id)
                } else {
                    Action::Text(id)
                };
                panel =
                    panel
                        .child(swatch.on_press(move |s: &mut AppState| {
                            apply(&mut s.studio, action.clone())
                        }));
            }
            shell(t)
                .child(panel)
                .pin(Some(p.left + slot), Some(top), None, None)
        };
        overlay = overlay.child(panel.keeps_text_selection().preserve_focus_on_press(true));
    }
    overlay
}
#[cfg(test)]
mod tests {
    use super::*;
    fn toolbar_view(s: &AppState, _: &mut rune::Cx<AppState>) -> El {
        let edit = s.studio.scratchpad.as_ref().unwrap();
        el().w_full()
            .h_full()
            .on_key(|s: &mut AppState, event, _| key(&mut s.studio, event))
            .child(
                rune::text_input(edit, TextStyle::new(16.0, 400.0))
                    .absolute(150.0, 150.0)
                    .w(400.0)
                    .h(100.0)
                    .on_input_key(|s: &mut AppState, event, _| key(&mut s.studio, event))
                    .on_edit(|s: &mut AppState| s.studio.scratchpad.as_mut().unwrap()),
            )
            .child(overlay(
                s,
                Palette::new(false),
                Anchor {
                    x: 250.0,
                    top: 150.0,
                    bottom: 177.0,
                },
                (600.0, 500.0),
            ))
    }
    #[test]
    fn toolbar_click_keeps_editor_focus_selection_and_escape_steps_back() {
        let mut state = AppState::default();
        let mut edit = rune::TextEdit::new("hello world").rich();
        edit.focused = true;
        edit.set_selection(0, 5);
        state.studio.scratchpad = Some(edit);
        let mut rt = rune::Runtime::new(
            state,
            toolbar_view,
            (600.0, 500.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        rt.pointer_down(177.0, 121.0);
        rt.pointer_up(177.0, 121.0);
        rt.frame(0.0);
        let edit = rt.state.studio.scratchpad.as_ref().unwrap();
        assert!(edit.focused);
        assert_eq!(edit.range(), (0, 5));
        assert!(edit.has_mark(&Mark::Bold));
        rt.state.studio.scratchpad_toolbar.open = Some(Popover::Highlight);
        let escape = KeyEvent {
            key: Key::Escape,
            mods: Default::default(),
        };
        rt.key(escape.clone());
        rt.frame(0.0);
        assert_eq!(rt.state.studio.scratchpad_toolbar.open, None);
        assert_eq!(rt.state.studio.scratchpad_toolbar.dismissed, None);
        rt.key(escape);
        rt.frame(0.0);
        assert_eq!(rt.state.studio.scratchpad_toolbar.dismissed, Some((0, 5)));
    }
    #[test]
    fn placement_flips_and_clamps() {
        let a = placement(
            Anchor {
                x: 2.0,
                top: 40.0,
                bottom: 66.0,
            },
            370.0,
            (800.0, 600.0),
            None,
        );
        assert_eq!((a.left, a.top, a.above), (12.0, 76.0, false));
        let b = placement(
            Anchor {
                x: 790.0,
                top: 300.0,
                bottom: 326.0,
            },
            370.0,
            (800.0, 600.0),
            Some(Popover::Block),
        );
        assert_eq!((b.left, b.top, b.above), (418.0, 252.0, true));
        assert!(!b.pop_above);
    }
    #[test]
    fn clear_keeps_paragraph_kind() {
        let mut state = StudioState::default();
        let mut edit = rune::TextEdit::new("hello").rich();
        edit.set_selection(0, 5);
        edit.set_block(Block::Quote);
        edit.toggle_mark(Mark::Bold);
        state.scratchpad = Some(edit);
        apply(&mut state, Action::Clear);
        let edit = state.scratchpad.unwrap();
        assert_eq!(edit.active_block(), Block::Quote);
        assert!(!edit.has_mark(&Mark::Bold));
    }
}

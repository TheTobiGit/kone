//! The empty main window: kone's ground, with room left for the traffic lights.

use gpui_kit::*;
use kone_theme::{Theme, hsla};

pub const SANS: &str = "Geist";

pub struct Shell;

impl Render for Shell {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = &Theme::get(cx).colors;
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(hsla(c.ground))
            .font_family(SANS)
            .text_size(px(17.))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(hsla(c.muted))
            .child("kone")
    }
}

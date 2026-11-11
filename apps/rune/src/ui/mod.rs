mod empty;
mod file_icons;
mod icon_motion;
mod overview;
mod projects;
pub(crate) mod start_motion;
mod studio;

pub(crate) use empty::tick as start_tick;

use crate::state::{AppState, Page};
use rune::{Cx, El, el};

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let page = match s.page {
        Page::Empty => empty::view(s, cx),
        Page::Projects => projects::view(s, cx),
        Page::Overview => overview::view(s, cx),
        Page::Studio => studio::view(s, cx),
    };
    let t = crate::theme::Palette::new(cx.system_dark());
    let stage = el().w_full().h_full().child(page);
    let stage = if s.launcher.mode.is_some() {
        stage.child(crate::launcher::view(s, cx))
    } else {
        stage
    };
    let clear = std::env::var("KONE_FRAME").as_deref() == Ok("clear");
    let tint = if clear {
        rune::Color::TRANSPARENT
    } else if t.dark {
        t.raised.alpha(0.35)
    } else {
        t.sunken.alpha(0.35)
    };
    let mut frame = el().w_full().h_full();
    if !clear {
        frame = frame.system_material(rune::SystemMaterial::Popover);
    }
    frame.fill(tint).window_drag().child(
        el().pin(Some(6.0), Some(8.0), Some(6.0), Some(6.0))
            .fill(t.ground)
            .radius(8.0)
            .clip_rounded(8.0)
            .border(1.0, t.line_soft)
            .no_window_drag()
            .child(stage),
    )
}

mod composer;
mod empty;
mod file_icons;
mod icon_motion;
pub(crate) mod overview;
mod pills;
mod projects;
mod sphere_face;
pub(crate) mod start_motion;
mod studio;
mod studio_markdown;

pub(crate) use empty::tick as start_tick;

use crate::state::{AppState, Page};
use rune::{Cx, El, el};

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let under = if s.page == Page::Studio {
        s.studio_under_page
    } else {
        s.page
    };
    let page = match under {
        Page::Empty => empty::view(s, cx),
        Page::Projects => projects::view(s, cx),
        Page::Overview => overview::view(s, cx),
        Page::Studio => studio::view(s, cx),
    };
    let t = crate::theme::Palette::new(cx.system_dark());
    let mut stage = el().w_full().h_full().child(page);
    if s.page == Page::Studio || s.studio_fade.is_some_and(|(_, opening)| !opening) {
        let opacity = s.studio_fade.map_or(1.0, |(at, opening)| {
            let x = (at.elapsed().as_secs_f32() / 0.22).clamp(0.0, 1.0);
            let eased = x * x * (3.0 - 2.0 * x);
            if opening { eased } else { 1.0 - eased }
        });
        stage = stage.child(
            el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .opacity(opacity)
                .child(studio::view(s, cx)),
        );
    }
    let stage = if s.page == Page::Overview {
        if let Some(pills) = pills::view(s, t) {
            stage.child(pills)
        } else {
            stage
        }
    } else {
        stage
    };
    let stage = if s.launcher.mode.is_some() {
        stage.child(crate::launcher::view(s, cx))
    } else {
        stage
    };
    let clear = std::env::var("KONE_FRAME").as_deref() == Ok("clear");
    let flat = std::env::var("KONE_FRAME").as_deref() == Ok("flat");
    let tint = if clear {
        rune::Color::TRANSPARENT
    } else if t.dark {
        t.raised.alpha(0.35)
    } else {
        t.sunken.alpha(0.35)
    };
    let mut frame = el().w_full().h_full();
    if flat {
        // Capture parity: the page fills the window like the browser capture
        // does, with no drawn card frame.
        return frame.fill(t.ground).window_drag().child(stage);
    }
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

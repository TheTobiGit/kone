mod empty;
mod overview;
mod projects;
mod studio;

use rune::{Cx, El, el};
use crate::state::{AppState, Page};

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let page = match s.page {
        Page::Empty => empty::view(s, cx),
        Page::Projects => projects::view(s, cx),
        Page::Overview => overview::view(s, cx),
        Page::Studio => studio::view(s, cx),
    };
    if s.launcher.mode.is_some() {
        el().w_full().h_full().child(page).child(crate::launcher::view(s, cx))
    } else { page }
}

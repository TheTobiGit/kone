use rune::{col, el, row, text, Cx, El, TextStyle};
use crate::{state::AppState, theme::Palette};

pub(super) fn wordmark(t: Palette) -> El {
    row().center_y().gap(4.0)
        .child(text("make it").font(TextStyle::new(15.0, 500.0)).color(t.ink))
        .child(text("kone.").font(TextStyle::new(15.0, 500.0)).color(t.accent))
}

pub(super) fn actions(t: Palette) -> El {
    let action = |key: &'static str, icon: &'static str, title: &'static str| {
        row().key(key).h(42.0).px(6.0).gap(14.0).center_y().radius(14.0).hover(t.hover)
            .child(el().w(22.0).center().child(text(icon).font(TextStyle::new(19.0, 400.0)).color(t.ink)))
            .child(text(title).font(TextStyle::new(14.0, 600.0)).color(t.ink))
    };
    col().gap(4.0)
        .child(action("create-project", "+", "Create a new project").on_press(|s: &mut AppState| s.launcher.open(crate::launcher::LauncherMode::Create)))
        .child(action("open-folder", "▱", "Open from local folder").on_press_tx(|s: &mut AppState, tx| crate::launcher::open_folder(s, tx)))
        .child(action("clone-project", "◉", "Clone from GitHub").on_press(|s: &mut AppState| s.launcher.open(crate::launcher::LauncherMode::Clone)))
}

pub fn view(_: &AppState, cx: &mut Cx<AppState>) -> El {
    let t = Palette::new(cx.system_dark());
    col().w_full().h_full().fill(t.ground)
        .child(row().w_full().px(64.0).pt(52.0).justify_between().center_y()
            .child(wordmark(t)).child(text("⚙").font(TextStyle::new(18.0, 400.0)).color(t.muted)))
        .child(col().grow(1.0).w_full().center().child(actions(t)))
}

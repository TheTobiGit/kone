use rune::{col, el, row, text, icon, Cx, El, TextStyle};
use crate::{state::{AppState, Page}, theme::Palette};
use super::projects::folder;
use super::empty::BACK;

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let t = Palette::new(cx.system_dark());
    let name = s.selected_project.and_then(|i| s.projects.get(i)).map(|p| p.name.as_str()).unwrap_or("");
    let nav = row().h(34.0).center_y()
        .child(el().w(84.0).h(28.0).center().radius(20.0).fill(t.hover)
            .child(text("Overview").font(TextStyle::new(12.5, 400.0)).color(t.ink)))
        .child(el().w(84.0).h(28.0).center().radius(20.0).hover(t.hover)
            .child(text("Studio").font(TextStyle::new(12.5, 400.0)).color(t.muted))
            .on_press(|s: &mut AppState| s.enter_studio()));
    let top = row().w_full().h(52.0).px(32.0).center_y()
        .child(el().w(84.0).child(icon(&BACK, 18.0).color(t.muted))
            .on_press(|s: &mut AppState| s.page = if s.projects.is_empty() { Page::Empty } else { Page::Projects }))
        .child(el().grow(1.0).center().child(nav)).child(el().w(84.0));
    let greeting = col().gap(2.0).grow(1.0)
        .child(text("Hey, there").font(TextStyle::new(30.0, 600.0)).color(t.ink_soft))
        .child(text(name.to_owned())
            .font(TextStyle::new(30.0, 600.0)).color(t.ink_soft).wrap());
    col().w_full().h_full().fill(t.ground).child(top)
        .child(row().w_full().justify_center().pt(44.0).px(64.0)
            .child(col().w(896.0).gap(44.0)
                .child(row().w_full().justify_between().gap(32.0).child(greeting).child(folder(name, t)))))
}

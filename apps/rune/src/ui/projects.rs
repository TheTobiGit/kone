use rune::{col, el, row, text, text_input, Cx, El, TextStyle};
use crate::{state::{AppState, Page}, theme::Palette};
use super::empty::{actions, wordmark};

pub(super) fn folder(name: &str, t: Palette) -> El {
    let sheet = el().size(168.0, 44.0).radius(16.0)
        .gradient(t.raised.mix(t.ink, 0.052), t.raised.mix(t.ink, 0.123)).absolute(16.0, 6.0);
    let pocket = col().size(200.0, 92.0).radius(22.0).justify_end().px(18.0).pb(15.0)
        .gradient(t.raised.mix(t.ink, 0.013), t.raised.mix(t.ink, 0.12))
        .shadow(4.0, 10.0, t.ink.alpha(0.06)).absolute(0.0, 24.0)
        .child(text(name.to_owned()).font(TextStyle::new(17.0, 600.0)).color(t.ink).truncate());
    el().size(200.0, 116.0).child(sheet).child(pocket)
}

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let t = Palette::new(cx.system_dark());
    let header = row().w_full().center_y().justify_between()
        .child(wordmark(t))
        .child(row().center_y().gap(12.0)
            .child(text("⚙").font(TextStyle::new(18.0, 400.0)).color(t.muted))
            .child(row().h(36.0).px(12.0).gap(10.0).center_y().radius(11.0).fill(t.hover)
                .child(text("⌕").font(TextStyle::new(16.0, 400.0)).color(t.muted))
                .child(text_input(&s.search, TextStyle::new(14.0, 400.0)).key("project-search").w(176.0).single_line().placeholder("Search projects", t.muted).color(t.ink).on_edit(|s: &mut AppState| &mut s.search))
                .child(text("⌘K").font(TextStyle::new(10.0, 400.0)).color(t.muted)))
            .child(text("Recent  ⌄").font(TextStyle::new(14.0, 500.0)).color(t.ink_soft)));
    let mut cells: Vec<El> = s.projects.iter().enumerate().filter(|(_, p)| p.name.to_lowercase().contains(&s.search.text.trim().to_lowercase())).map(|(i, p)| {
        folder(&p.name, t).key(format!("project-{i}"))
            .on_press(move |s: &mut AppState| { s.selected_project = Some(i); s.page = Page::Overview; })
    }).collect();
    cells.push(actions(t));
    let mut grid = col().gap(24.0);
    let mut iter = cells.into_iter();
    loop {
        let Some(first) = iter.next() else { break };
        let mut line = row().w_full().gap(56.0).center_y().child(el().w(236.0).child(first));
        for _ in 0..2 {
            if let Some(cell) = iter.next() { line = line.child(el().w(236.0).child(cell)); }
        }
        grid = grid.child(line);
    }
    col().w_full().h_full().fill(t.ground).px(64.0).pt(20.0)
        .child(header)
        .child(row().w_full().justify_center().pt(96.0).child(col().w(820.0).child(grid)))
}

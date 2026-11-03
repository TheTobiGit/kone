use super::*;
use kone_theme::Palette;
use std::collections::BTreeMap;
impl ProjectView {
    pub(super) fn render_peek(&mut self, c: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let entries = self
            .model
            .as_ref()
            .map(|m| m.all_entries())
            .unwrap_or_default();
        let max_lines = entries
            .iter()
            .map(|e| e.change.added.saturating_add(e.change.removed))
            .max()
            .unwrap_or(1)
            .max(1) as f32;
        let mut list = Vec::<AnyElement>::new();
        self.peek_items.clear();
        for lane in [Lane::Staged, Lane::Changed] {
            let rows: Vec<_> = entries.iter().filter(|e| e.lane == lane).cloned().collect();
            if rows.is_empty() {
                continue;
            }
            list.push(
                (div()
                    .mt(px(20.))
                    .mb(px(6.))
                    .text_size(px(12.))
                    .text_color(hsla(c.muted))
                    .child(format!(
                        "{}  {}",
                        if lane == Lane::Staged {
                            "Staged"
                        } else {
                            "Changed"
                        },
                        rows.len()
                    )))
                .into_any_element(),
            );
            let mut groups: BTreeMap<String, Vec<FileEntry>> = BTreeMap::new();
            for entry in rows {
                let parent = std::path::Path::new(&entry.change.path)
                    .parent()
                    .map(|p| p.to_string_lossy().into_owned())
                    .filter(|p| !p.is_empty())
                    .unwrap_or_else(|| "/".into());
                groups.entry(parent).or_default().push(entry);
            }
            for (parent, files) in groups {
                let group = format!("{lane:?}:{parent}");
                let collapsed = self.collapsed.contains(&group);
                let group_key = format!("group:{group}");
                self.peek_items.insert(group_key.clone(), list.len());
                list.push(
                    (div()
                        .id(SharedString::from(format!("group-{group}")))
                        .rounded(px(5.))
                        .when(self.selected.as_ref() == Some(&group_key), |d| {
                            d.bg(hsla(c.hover))
                        })
                        .flex()
                        .gap(px(8.))
                        .cursor_pointer()
                        .py(px(6.))
                        .text_size(px(12.))
                        .text_color(hsla(c.ink_soft))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if !this.collapsed.remove(&group) {
                                this.collapsed.insert(group.clone());
                            }
                            cx.notify();
                        }))
                        .child(if collapsed { "›" } else { "⌄" })
                        .child(parent))
                    .into_any_element(),
                );
                if collapsed {
                    continue;
                }
                for entry in files {
                    let key = entry.key();
                    self.peek_items.insert(key.clone(), list.len());
                    let selected = self.selected.as_ref() == Some(&key);
                    let name = std::path::Path::new(&entry.change.path)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned();
                    let total = max_lines;
                    let add = entry.change.added;
                    let del = entry.change.removed;
                    list.push(
                        (div()
                            .id(SharedString::from(format!("peek-{key}")))
                            .rounded(px(8.))
                            .px(px(10.))
                            .py(px(10.))
                            .cursor_pointer()
                            .bg(hsla(if selected { c.selected } else { c.ground }))
                            .hover(|s| s.bg(hsla(c.hover)))
                            .flex()
                            .flex_col()
                            .gap(px(7.))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.open_file(entry.clone(), window, cx)
                            }))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(8.))
                                    .text_size(px(13.))
                                    .text_color(hsla(c.ink))
                                    .child(div().min_w(px(0.)).truncate().child(name))
                                    .child(
                                        div()
                                            .flex()
                                            .gap(px(8.))
                                            .font_family(crate::style::MONO)
                                            .text_size(px(11.))
                                            .child(
                                                div()
                                                    .text_color(hsla(c.diff_add))
                                                    .child(format!("+{add}")),
                                            )
                                            .child(
                                                div()
                                                    .text_color(hsla(c.diff_del))
                                                    .child(format!("−{del}")),
                                            ),
                                    ),
                            )
                            .child(
                                div()
                                    .flex()
                                    .h(px(3.))
                                    .rounded(px(2.))
                                    .overflow_hidden()
                                    .bg(hsla(c.line_soft))
                                    .child(
                                        div()
                                            .w(relative(add as f32 / total))
                                            .h_full()
                                            .bg(hsla(c.diff_add)),
                                    )
                                    .child(
                                        div()
                                            .w(relative(del as f32 / total))
                                            .h_full()
                                            .bg(hsla(c.diff_del)),
                                    ),
                            ))
                        .into_any_element(),
                    );
                }
            }
        }
        div()
            .absolute()
            .inset_0()
            .flex()
            .justify_end()
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .id("peek-dismiss")
                    .bg(hsla(c.ground.alpha(0.25 * self.peek_progress)))
                    .on_click(cx.listener(|this, _, window, cx| this.dismiss(window, cx))),
            )
            .child(
                div()
                    .id("peek-panel")
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .relative()
                    .right(px(-402. * (1. - self.peek_progress)))
                    .w(px(402.))
                    .h_full()
                    .bg(hsla(c.ground))
                    .border_l_1()
                    .border_color(hsla(c.line_soft))
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .h(px(56.))
                            .px(px(24.))
                            .text_size(px(16.))
                            .text_color(hsla(c.ink))
                            .child("Changes")
                            .child(
                                div()
                                    .id("peek-close")
                                    .rounded(px(4.))
                                    .when(self.selected.as_deref() == Some("peek-close"), |d| {
                                        d.bg(hsla(c.hover))
                                    })
                                    .cursor_pointer()
                                    .px(px(8.))
                                    .on_click(
                                        cx.listener(|this, _, window, cx| this.dismiss(window, cx)),
                                    )
                                    .child("×"),
                            ),
                    )
                    .child(
                        div()
                            .id("peek-list")
                            .track_scroll(&self.peek_scroll)
                            .overflow_y_scroll()
                            .flex_1()
                            .min_h(px(0.))
                            .px(px(24.))
                            .pb(px(24.))
                            .flex()
                            .flex_col()
                            .gap(px(8.))
                            .children(list),
                    ),
            )
            .into_any_element()
    }
}

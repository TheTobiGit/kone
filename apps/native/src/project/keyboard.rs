//! Focus traversal and keyboard behavior for the project and its overlays.
use super::*;
impl ProjectView {
    pub(super) fn lane_entries<'a>(&self, m: &'a OverviewModel, lane: Lane) -> &'a [FileEntry] {
        let entries = m.entries(lane);
        let slots = changes::card_capacity(
            self.content_width,
            !m.staged.is_empty() && !m.changed.is_empty(),
        );
        let visible = if entries.len() > slots {
            slots.saturating_sub(1)
        } else {
            entries.len()
        };
        &entries[..visible]
    }
    pub(super) fn entries(&self) -> Vec<FileEntry> {
        self.model
            .as_ref()
            .map(|m| {
                if self.peek {
                    let mut groups =
                        std::collections::BTreeMap::<(usize, String), Vec<FileEntry>>::new();
                    for entry in m.all_entries() {
                        let parent = std::path::Path::new(&entry.change.path)
                            .parent()
                            .map(|p| p.to_string_lossy().into_owned())
                            .filter(|p| !p.is_empty())
                            .unwrap_or_else(|| "/".into());
                        if !self
                            .collapsed
                            .contains(&format!("{:?}:{parent}", entry.lane))
                        {
                            groups
                                .entry((usize::from(entry.lane == Lane::Changed), parent))
                                .or_default()
                                .push(entry);
                        }
                    }
                    groups.into_values().flatten().collect()
                } else {
                    [Lane::Staged, Lane::Changed]
                        .into_iter()
                        .filter(|l| !self.folded[usize::from(*l == Lane::Changed)])
                        .flat_map(|l| self.lane_entries(m, l).to_vec())
                        .collect()
                }
            })
            .unwrap_or_default()
    }
    fn ensure_selected_visible(&self) {
        if self.peek {
            return;
        }
        if let Some(bounds) = self
            .selected
            .as_ref()
            .and_then(|key| self.card_bounds.borrow().get(key).copied())
        {
            let viewport = self.overview_scroll.bounds();
            let mut offset = self.overview_scroll.offset();
            if bounds.bottom() > viewport.bottom() {
                offset.y -= bounds.bottom() - viewport.bottom();
            } else if bounds.top() < viewport.top() {
                offset.y += viewport.top() - bounds.top();
            }
            self.overview_scroll.set_offset(offset);
        }
    }
    pub(super) fn cycle_focus(
        &mut self,
        backward: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.focus.focus(window, cx);
        if self.detail.is_some() {
            self.detail_control = if backward {
                (self.detail_control + 2) % 3
            } else {
                (self.detail_control + 1) % 3
            };
            cx.notify();
            cx.stop_propagation();
            return;
        }
        if self.peek {
            let mut rows: Vec<_> = self.peek_items.iter().collect();
            rows.sort_by_key(|(_, index)| **index);
            let mut stops = vec!["peek-close".to_string()];
            stops.extend(rows.iter().map(|(key, _)| (*key).clone()));
            let at = self
                .selected
                .as_ref()
                .and_then(|key| stops.iter().position(|s| s == key))
                .unwrap_or(0);
            let next = if backward {
                (at + stops.len() - 1) % stops.len()
            } else {
                (at + 1) % stops.len()
            };
            self.selected = Some(stops[next].clone());
            if let Some(index) = self.peek_items.get(&stops[next]) {
                self.peek_scroll.scroll_to_item(*index);
            }
            cx.notify();
            cx.stop_propagation();
            return;
        }

        let mut stops = vec!["back".to_string()];
        for lane in [Lane::Staged, Lane::Changed] {
            if self
                .model
                .as_ref()
                .is_some_and(|m| !m.entries(lane).is_empty())
            {
                stops.push(format!("lane-{lane:?}"));
                if !self.folded[usize::from(lane == Lane::Changed)] {
                    stops.extend(
                        self.lane_entries(self.model.as_ref().unwrap(), lane)
                            .iter()
                            .map(FileEntry::key),
                    );
                }
            }
        }
        if stops.len() > 1 {
            stops.push("peek".into());
        }
        let at = self
            .selected
            .as_ref()
            .and_then(|k| stops.iter().position(|s| s == k));
        let next = at
            .map(|i| {
                if backward {
                    (i + stops.len() - 1) % stops.len()
                } else {
                    (i + 1) % stops.len()
                }
            })
            .unwrap_or(0);
        self.selected = Some(stops[next].clone());
        self.ensure_selected_visible();
        cx.notify();
        cx.stop_propagation();
    }
    pub(super) fn key(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = e.keystroke.key.as_str();
        let m = e.keystroke.modifiers;
        if key == "escape" && (self.peek || self.detail.is_some()) {
            self.dismiss(window, cx);
            cx.stop_propagation();
            return;
        }
        if !self.focus.is_focused(window) {
            return;
        }
        if self.detail.is_some() {
            if key == "enter" || key == "space" {
                match self.detail_control {
                    0 => {
                        if let Some(d) = &mut self.detail {
                            d.source = !d.source;
                        }
                    }
                    1 => {
                        if let Some(d) = &mut self.detail {
                            d.wrap = !d.wrap;
                        }
                    }
                    _ => self.dismiss(window, cx),
                }
                cx.notify();
                cx.stop_propagation();
                return;
            }
            let detail = self.detail.as_mut().unwrap();
            let mut offset = detail.scroll.offset();
            match key {
                "down" => offset.y -= px(40.),
                "up" => offset.y += px(40.),
                "pagedown" => offset.y -= px(400.),
                "pageup" => offset.y += px(400.),
                "home" => offset.y = px(0.),
                "end" => offset.y = px(-1e7),
                _ => return,
            }
            detail.scroll.set_offset(offset);
            cx.notify();
            cx.stop_propagation();
            return;
        }
        if m.alt && key == "left" {
            cx.emit(Back);
            cx.stop_propagation();
            return;
        }
        if m.platform || m.control || m.alt {
            return;
        }

        if self.peek && (key == "enter" || key == "space") {
            if self.selected.as_deref() == Some("peek-close") {
                self.dismiss(window, cx);
                cx.stop_propagation();
                return;
            }
            if let Some(group) = self
                .selected
                .as_deref()
                .and_then(|s| s.strip_prefix("group:"))
                .map(str::to_string)
            {
                if !self.collapsed.remove(&group) {
                    self.collapsed.insert(group);
                }
                cx.notify();
                cx.stop_propagation();
                return;
            }
        }

        if !self.peek && (key == "enter" || key == "space") {
            match self.selected.as_deref() {
                Some("back") => {
                    cx.emit(Back);
                    cx.stop_propagation();
                    return;
                }
                Some("peek") => {
                    self.open_peek(window, cx);
                    cx.stop_propagation();
                    return;
                }
                Some("lane-Staged") => {
                    self.toggle_lane(Lane::Staged, cx);
                    cx.stop_propagation();
                    return;
                }
                Some("lane-Changed") => {
                    self.toggle_lane(Lane::Changed, cx);
                    cx.stop_propagation();
                    return;
                }
                _ => {}
            }
        }
        let entries = self.entries();
        if entries.is_empty() {
            return;
        }
        let at = self
            .selected
            .as_ref()
            .and_then(|k| entries.iter().position(|e| e.key() == *k));
        match key {
            "right" | "down" | "left" | "up" | "home" | "end" => {
                let previous = m.shift || key == "left" || key == "up";
                let next = if key == "home" {
                    0
                } else if key == "end" {
                    entries.len() - 1
                } else {
                    at.map(|i| {
                        if previous {
                            (i + entries.len() - 1) % entries.len()
                        } else {
                            (i + 1) % entries.len()
                        }
                    })
                    .unwrap_or(if previous { entries.len() - 1 } else { 0 })
                };
                self.selected = Some(entries[next].key());
                self.ensure_selected_visible();
                if self.peek
                    && let Some(i) = self.peek_items.get(&entries[next].key())
                {
                    self.peek_scroll.scroll_to_item(*i);
                }
                cx.notify();
                cx.stop_propagation();
            }
            "enter" | "space" => {
                if let Some(i) = at {
                    self.open_file(entries[i].clone(), window, cx);
                    cx.stop_propagation();
                }
            }
            _ => {}
        }
    }
}

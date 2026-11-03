//! Changes panel showing Staged and Changed lanes with responsive cards grid.
use super::*;
mod cards;
mod empty;
use gpui_kit::prelude::*;
use gpui_kit::*;
use kone_theme::{Palette, hsla};

const CARD_W: f32 = 158.0;
const CARD_H: f32 = 178.0;
const CARD_GAP: f32 = 14.0;
const MAX_DOTS: usize = 24;

impl ProjectView {
    pub(super) fn render_changes(
        &mut self,
        c: &Palette,
        width: f32,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // Never flash a clean or empty state while first git read is pending
        if self.loading || self.error.is_some() {
            return div().into_any_element();
        }

        let Some(model) = self.model.as_ref() else {
            // Non-git state (model None + loading false means non-git unless error set)
            return self.render_empty_state(c, false, None);
        };

        let has_staged = !model.staged.is_empty();
        let has_changed = !model.changed.is_empty();

        if !has_staged && !has_changed {
            // Clean working tree
            let branch = if model.snapshot.detached {
                None
            } else {
                model.snapshot.branch.as_deref()
            };
            return self.render_empty_state(c, true, branch);
        }

        // When both lanes share the panel each gets 1 row; a lone lane spreads to 2 rows
        let max_slots = card_capacity(width, has_staged && has_changed);

        let mut lanes_container = div().flex().flex_col().gap(px(30.));

        for lane in [Lane::Staged, Lane::Changed] {
            let entries = model.entries(lane);
            if entries.is_empty() {
                // Empty lanes are hidden
                continue;
            }

            let lane_idx = usize::from(lane == Lane::Changed);
            let is_folded = self.folded[lane_idx];
            let is_staged = lane == Lane::Staged;

            // Header of lane
            let title = if is_staged { "Staged" } else { "Changed" };
            let count = entries.len();

            let toggle_btn = div()
                .id(SharedString::from(format!("lane-toggle-{lane_idx}")))
                .relative()
                .child(self.track_bounds(format!("lane-{lane:?}")))
                .when(
                    self.selected.as_deref() == Some(format!("lane-{lane:?}").as_str()),
                    |d| d.bg(hsla(c.hover)),
                )
                .cursor_pointer()
                .flex()
                .items_center()
                .gap(px(7.))
                .py(px(2.))
                .px(px(2.))
                .rounded(px(7.))
                .hover(|s| s.bg(hsla(c.hover)))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.toggle_lane(lane, cx);
                }))
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(hsla(c.faint))
                        .child(if is_folded { "›" } else { "⌄" }),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(hsla(c.ink_soft))
                        .child(title),
                )
                .child(
                    div()
                        .font_family(crate::style::MONO)
                        .text_size(px(11.))
                        .text_color(hsla(c.muted))
                        .child(count.to_string()),
                );

            // Right side of lane header: Diff totals and dots summary for Changed lane
            let mut stat_cluster = div().flex().items_center().gap(px(14.));
            if !is_staged || !has_changed {
                if model.added > 0 || model.removed > 0 {
                    stat_cluster = stat_cluster.child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .font_family(crate::style::MONO)
                            .text_size(px(12.))
                            .when(model.added > 0, |d| {
                                d.child(
                                    div()
                                        .text_color(hsla(c.diff_add))
                                        .child(format!("+{}", model.added)),
                                )
                            })
                            .when(model.removed > 0, |d| {
                                d.child(
                                    div()
                                        .text_color(hsla(c.diff_del))
                                        .child(format!("−{}", model.removed)),
                                )
                            }),
                    );
                }

                let all_entries = model.all_entries();
                let dots = sample_dots(&all_entries, MAX_DOTS);
                let overflow_dots = all_entries.len().saturating_sub(dots.len());

                let mut dots_row = div().flex().items_center().gap(px(3.));
                for d in dots {
                    let color = match d {
                        DotTone::Add => c.diff_add,
                        DotTone::Del => c.diff_del,
                        DotTone::Idle => c.ink_soft.mix(0.24, c.raised_high),
                    };
                    dots_row = dots_row.child(div().size(px(7.)).rounded(px(2.)).bg(hsla(color)));
                }
                if overflow_dots > 0 {
                    dots_row = dots_row.child(
                        div()
                            .font_family(crate::style::MONO)
                            .text_size(px(10.))
                            .text_color(hsla(c.muted))
                            .child(format!("+{overflow_dots}")),
                    );
                }
                stat_cluster = stat_cluster.child(dots_row);
            }

            let lane_head = div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.))
                .px(px(2.))
                .child(toggle_btn)
                .child(stat_cluster);

            let mut lane_section = div().flex().flex_col().gap(px(10.)).child(lane_head);

            if !is_folded {
                // Determine visible entries vs overflow bundle
                let has_overflow = entries.len() > max_slots;
                let visible_count = if has_overflow {
                    max_slots.saturating_sub(1)
                } else {
                    entries.len()
                };
                let visible_entries = &entries[..visible_count];
                let overflow_count = entries.len() - visible_count;

                let mut grid = div().flex().flex_wrap().gap(px(CARD_GAP));

                for entry in visible_entries {
                    grid = grid.child(self.render_card(entry, c, cx));
                }

                if has_overflow {
                    grid = grid.child(self.render_bundle_card(overflow_count, c, cx));
                }

                lane_section = lane_section.child(grid);
            }

            lanes_container = lanes_container.child(lane_section);
        }

        lanes_container.into_any_element()
    }
}

#[derive(Clone, Copy, PartialEq)]
enum DotTone {
    Add,
    Del,
    Idle,
}

#[derive(Clone, Copy, PartialEq)]
enum CardTone {
    Context,
    Add,
    Del,
}

fn marks_for_card(name: &str, added: u32, removed: u32, deleted: bool) -> Vec<(f32, CardTone)> {
    if deleted {
        return vec![
            (40.0, CardTone::Del),
            (24.0, CardTone::Del),
            (20.0, CardTone::Context),
        ];
    }
    let seed: u32 = name.bytes().map(|b| b as u32).sum();
    let jit = |base: f32, i: u32| (base + ((seed + i * 7) % 9) as f32 - 4.0).max(12.0);

    if added > 0 && removed > 0 {
        vec![
            (jit(40.0, 0), CardTone::Context),
            (jit(24.0, 1), CardTone::Del),
            (jit(32.0, 2), CardTone::Add),
            (jit(20.0, 3), CardTone::Context),
        ]
    } else if added > 0 {
        vec![
            (jit(38.0, 0), CardTone::Add),
            (jit(26.0, 1), CardTone::Add),
            (jit(20.0, 2), CardTone::Context),
        ]
    } else if removed > 0 {
        vec![
            (jit(38.0, 0), CardTone::Del),
            (jit(22.0, 1), CardTone::Del),
            (jit(18.0, 2), CardTone::Context),
        ]
    } else {
        vec![(40.0, CardTone::Context), (24.0, CardTone::Context)]
    }
}

fn sample_dots(entries: &[FileEntry], max: usize) -> Vec<DotTone> {
    if entries.is_empty() {
        return Vec::new();
    }
    let all: Vec<DotTone> = entries
        .iter()
        .map(|e| {
            if e.change.status.eq_ignore_ascii_case("deleted") || e.change.removed > e.change.added
            {
                DotTone::Del
            } else if e.change.added > 0 {
                DotTone::Add
            } else {
                DotTone::Idle
            }
        })
        .collect();

    if all.len() <= max {
        return all;
    }

    let mut add_count = 0;
    let mut del_count = 0;
    let mut idle_count = 0;
    for &d in &all {
        match d {
            DotTone::Add => add_count += 1,
            DotTone::Del => del_count += 1,
            DotTone::Idle => idle_count += 1,
        }
    }

    let total = all.len();
    let mut add = (max * add_count) / total;
    let mut del = (max * del_count) / total;
    let mut idle = max.saturating_sub(add + del);

    if add_count > 0 && add == 0 {
        add = 1;
        idle = idle.saturating_sub(1);
    }
    if del_count > 0 && del == 0 {
        del = 1;
        idle = idle.saturating_sub(1);
    }
    if idle_count > 0 && idle == 0 {
        idle = 1;
        if add > del && add > 1 {
            add -= 1;
        } else if del > 1 {
            del -= 1;
        }
    }

    let mut result = Vec::with_capacity(max);
    for _ in 0..add {
        result.push(DotTone::Add);
    }
    for _ in 0..del {
        result.push(DotTone::Del);
    }
    for _ in 0..idle {
        result.push(DotTone::Idle);
    }
    result.truncate(max);
    result
}

/// Shared with keyboard navigation: overflow cards replace the final slot.
pub(super) fn card_capacity(width: f32, both_lanes: bool) -> usize {
    (((width + CARD_GAP) / (CARD_W + CARD_GAP)).floor() as usize).max(1)
        * if both_lanes { 1 } else { 2 }
}

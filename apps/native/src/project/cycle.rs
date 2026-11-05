//! Held-Control shelf. Draws cached folder data without mounting another project view.
use super::*;
use gpui_ce_motion::{Bezier, Easing, MotionValue, Spring, Transition};
use kone_theme::Palette;

pub(super) struct CycleCell {
    selected: bool,
    size: MotionValue,
    fade: MotionValue,
}
impl Default for CycleCell {
    fn default() -> Self {
        Self {
            selected: false,
            size: MotionValue::new(0.),
            fade: MotionValue::new(0.55),
        }
    }
}

impl ProjectView {
    pub(super) fn render_cycle(
        &mut self,
        c: &Palette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (rows, selected) = self.switcher.cycle.as_ref().expect("visible cycle");
        let slots = ((window.viewport_size().width.as_f32() - 128. + 40.) / 240.)
            .floor()
            .max(1.) as usize;
        let start = selected
            .saturating_sub(slots / 2)
            .min(rows.len().saturating_sub(slots));
        let mut dock = div().flex().items_end().gap(px(40.)).pt(px(96.));
        for (i, row) in rows.iter().enumerate().skip(start).take(slots) {
            let active = i == *selected;
            let state = self
                .switcher
                .cycle_motion
                .entry(row.path.clone())
                .or_default();
            if state.selected != active {
                state.selected = active;
                state.fade.animate(
                    if active { 1. } else { 0.55 },
                    Transition::Tween(
                        Duration::from_millis(220),
                        Easing::Bezier(Bezier::new(0.22, 1., 0.36, 1.).expect("cell fade")),
                    ),
                    self.started.elapsed(),
                );
                state.size.animate(
                    if active { 1. } else { 0. },
                    Transition::Spring(Spring::new(300., 15., 0.9).expect("cycle cell spring")),
                    self.started.elapsed(),
                );
            }
            let sample = state
                .size
                .sample(self.started.elapsed(), cx.reduce_motion());
            let fade = state
                .fade
                .sample(self.started.elapsed(), cx.reduce_motion());
            let cell_opacity = fade.value() as f32;
            if sample.is_animating() || fade.is_animating() {
                window.request_animation_frame();
            }
            let amount = sample.value() as f32;
            let scale = 0.86 + 0.24 * amount;
            let (files, branch, added, removed, repo) = if row.path == self.path {
                self.model
                    .as_ref()
                    .map(|m| {
                        (
                            m.snapshot
                                .changes
                                .iter()
                                .take(3)
                                .map(|change| FileEntry {
                                    change: change.clone(),
                                    lane: Lane::Changed,
                                })
                                .collect::<Vec<_>>(),
                            m.snapshot.branch.clone(),
                            m.added,
                            m.removed,
                            true,
                        )
                    })
                    .unwrap_or_default()
            } else if let Some(crate::recents::Tile::Repo(summary, _)) =
                self.switcher.tiles.get(&row.path)
            {
                let files = summary
                    .files
                    .iter()
                    .take(3)
                    .map(|f| FileEntry {
                        lane: Lane::Changed,
                        change: crate::git_service::GitChange {
                            path: f.name.clone(),
                            added: f.added,
                            removed: f.removed,
                            status: match f.change {
                                kone_rpc::FileChange::Added => "added",
                                kone_rpc::FileChange::Deleted => "deleted",
                                kone_rpc::FileChange::Modified => "modified",
                            }
                            .into(),
                            ..Default::default()
                        },
                    })
                    .collect();
                let branch = match &summary.branch {
                    kone_rpc::Branch::Named(b) => Some(b.clone()),
                    kone_rpc::Branch::Detached(b) => Some(b.chars().take(7).collect()),
                    _ => None,
                };
                (files, branch, summary.added, summary.removed, summary.repo)
            } else {
                (Vec::new(), None, 0, 0, false)
            };
            let folder = cycle_folder(
                CycleFolder {
                    name: row.name.clone(),
                    files,
                    branch,
                    added,
                    removed,
                    repo,
                },
                scale,
                amount,
                c,
                Theme::get(cx).is_dark(),
            );
            let reduced = cx.reduce_motion();
            dock = dock.child(
                div()
                    .relative()
                    .top(px(-10. * amount))
                    .opacity(0.55 + 0.45 * amount.clamp(0., 1.))
                    .child(folder)
                    .with_animation(
                        SharedString::from(format!("cycle-cell:{}", row.path)),
                        Animation::new(Duration::from_millis(220 + (i - start) as u64 * 30)),
                        move |el, d| {
                            let t = if reduced {
                                1.
                            } else {
                                ((d * (220. + (i - start) as f32 * 30.) - (i - start) as f32 * 30.)
                                    / 220.)
                                    .clamp(0., 1.)
                            };
                            el.mt(px(14. * (1. - crate::magnet::glide(t))))
                                .opacity(t * cell_opacity)
                        },
                    ),
            );
        }
        let reduced = cx.reduce_motion();
        div()
            .absolute()
            .bottom_0()
            .left_0()
            .right_0()
            .flex()
            .justify_center()
            .bg(hsla(c.ground))
            .px(px(64.))
            .pb(px(44.))
            .child(dock)
            .with_animation(
                "cycle-dock",
                Animation::new(Duration::from_millis(700)),
                move |el, d| {
                    let t = if reduced { 1. } else { dock_spring(d * 0.7) };
                    el.bottom(px(-28. * (1. - t)))
                        .opacity((d * 700. / 220.).min(1.))
                },
            )
            .into_any_element()
    }
}

fn dock_spring(seconds: f32) -> f32 {
    let decay: f32 = 22. / (2. * 0.9);
    let frequency = (300. / 0.9 - decay * decay).sqrt();
    1. - (-decay * seconds).exp()
        * ((frequency * seconds).cos() + decay / frequency * (frequency * seconds).sin())
}

struct CycleFolder {
    name: String,
    files: Vec<FileEntry>,
    branch: Option<String>,
    added: u32,
    removed: u32,
    repo: bool,
}

fn cycle_folder(data: CycleFolder, scale: f32, hover: f32, c: &Palette, dark: bool) -> Div {
    let CycleFolder {
        name,
        files,
        branch,
        added,
        removed,
        repo,
    } = data;
    let mix = |amount, base| hsla(c.ink.mix(amount, base));
    let colors = if dark {
        [
            mix(0.094, c.ground),
            mix(0.057, c.ground),
            mix(0.035, c.ground),
        ]
    } else {
        [
            mix(0.013, c.raised),
            mix(0.077, c.raised),
            mix(0.12, c.raised),
        ]
    };
    let mut drop_shade = hsla(c.sunken);
    drop_shade.l = 0.;
    drop_shade.a = if dark { 0.16 } else { 0.06 };
    let gh = if dark {
        c.ink.mix(0.937, c.ground)
    } else {
        c.ink_soft.mix(0.565, c.ink)
    };
    let palette = c.clone();
    let face_palette = c.clone();
    let sheet = if dark {
        [mix(0.068, c.ground), mix(0.04, c.ground)]
    } else {
        [mix(0.052, c.raised), mix(0.123, c.raised)]
    };
    div()
        .relative()
        .w(px(200. * scale))
        .h(px(116. * scale))
        .flex_shrink_0()
        .child(
            div()
                .absolute()
                .left(px(16. * scale))
                .top(px(6. * scale))
                .w(px(168. * scale))
                .h(px(44. * scale))
                .rounded_t(px(16. * scale))
                .rounded_b(px(14. * scale))
                .bg(folder::css_gradient(
                    size(px(168. * scale), px(44. * scale)),
                    Bounds::new(
                        point(px(0.), px(0.)),
                        size(px(168. * scale), px(44. * scale)),
                    ),
                    160.,
                    sheet,
                    [0., 1.],
                )),
        )
        .child(
            canvas(
                |_, _, _| (),
                move |bounds, _, window, cx| {
                    folder::paint_folder_papers(
                        bounds, &files, &palette, dark, [hover; 3], window, cx,
                    )
                },
            )
            .absolute()
            .size_full(),
        )
        .child(
            div()
                .absolute()
                .bottom_0()
                .left_0()
                .w_full()
                .h(px(92. * scale))
                .rounded(px(22. * scale))
                .child(
                    canvas(
                        |_, _, _| (),
                        move |bounds, _, window, _| {
                            let shadows = [
                                BoxShadow {
                                    color: hsla(if dark {
                                        face_palette.ink.alpha(0.07)
                                    } else {
                                        face_palette.raised_high.alpha(0.9)
                                    }),
                                    offset: point(
                                        px(0.),
                                        px(if dark { scale } else { 2. * scale }),
                                    ),
                                    blur_radius: px(0.),
                                    spread_radius: px(0.),
                                    inset: true,
                                },
                                BoxShadow {
                                    color: hsla(if dark {
                                        face_palette.sunken.alpha(0.14)
                                    } else {
                                        face_palette.ink.alpha(0.03)
                                    }),
                                    offset: point(px(0.), px(-10. * scale)),
                                    blur_radius: px(18. * scale),
                                    spread_radius: px(0.),
                                    inset: true,
                                },
                            ];
                            folder::paint_pocket(bounds, colors, window);
                            window.paint_inset_shadows(bounds, px(22. * scale).into(), &shadows);
                        },
                    )
                    .absolute()
                    .size_full(),
                )
                .shadow(vec![BoxShadow {
                    color: drop_shade,
                    offset: point(px(0.), px(4. * scale)),
                    blur_radius: px(10. * scale),
                    spread_radius: px(0.),
                    inset: false,
                }])
                .flex()
                .flex_col()
                .justify_end()
                .gap(px(7. * scale))
                .px(px(18. * scale))
                .pb(px(15. * scale))
                .child(
                    div()
                        .relative()
                        .flex()
                        .items_center()
                        .gap(px(9. * scale))
                        .when(repo, |d| {
                            d.child(
                                svg()
                                    .path("icons/gh-mark.svg")
                                    .size(px(16. * scale))
                                    .flex_shrink_0()
                                    .text_color(hsla(gh)),
                            )
                        })
                        .child(
                            div()
                                .min_w(px(0.))
                                .truncate()
                                .text_size(px(17. * scale))
                                .line_height(px(17. * scale))
                                .text_color(hsla(c.ink))
                                .child(name.to_owned()),
                        ),
                )
                .when(repo, |d| {
                    d.child(
                        div()
                            .relative()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8. * scale))
                            .h(px(12.5 * scale))
                            .line_height(px(12.5 * scale))
                            .font_family(crate::style::MONO)
                            .text_size(px(10. * scale))
                            .text_color(hsla(c.muted))
                            .child(
                                div()
                                    .flex()
                                    .min_w(px(0.))
                                    .items_center()
                                    .gap(px(4. * scale))
                                    .child(
                                        svg()
                                            .path("icons/git-branch.svg")
                                            .size(px(11. * scale))
                                            .flex_shrink_0()
                                            .text_color(hsla(c.muted)),
                                    )
                                    .child(div().truncate().child(branch.unwrap_or_default())),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_shrink_0()
                                    .gap(px(6. * scale))
                                    .text_size(px(12.5 * scale))
                                    .when(added > 0, |d| {
                                        d.child(
                                            div().text_color(hsla(c.diff_add)).child(format!(
                                                "+{}",
                                                crate::recents::group(added)
                                            )),
                                        )
                                    })
                                    .when(removed > 0, |d| {
                                        d.child(
                                            div().text_color(hsla(c.diff_del)).child(format!(
                                                "−{}",
                                                crate::recents::group(removed)
                                            )),
                                        )
                                    }),
                            ),
                    )
                }),
        )
}

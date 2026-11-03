//! Electron's ProjectFolder: physical faces, changed-file fan and hover actions.
use super::*;
use gpui_kit::prelude::*;
use gpui_kit::*;
use kone_theme::{Palette, Theme, hsla};

fn ease_out_expo(t: f64) -> f64 {
    if t >= 1. {
        1.
    } else {
        1. - 2_f64.powf(-10. * t.max(0.))
    }
}

#[derive(Default)]
pub(super) struct CountMotion {
    from: f64,
    target: u32,
    started: Duration,
}

impl CountMotion {
    fn value(&self, now: Duration) -> (f64, bool) {
        let t = (now.saturating_sub(self.started).as_secs_f64() / 1.1).min(1.);
        let value = self.from + (f64::from(self.target) - self.from) * ease_out_expo(t);
        (value, t < 1. && self.from != f64::from(self.target))
    }

    pub fn sample(&mut self, target: u32, now: Duration) -> (u32, bool) {
        if self.target != target {
            self.from = self.value(now).0;
            self.target = target;
            self.started = now;
        }
        let (value, moving) = self.value(now);
        (value.round() as u32, moving)
    }
}

/// Each paper has its own delayed spring; the folder lift and action fade are tweens.
pub(super) struct FolderMotion {
    active: bool,
    lift_active: bool,
    tile_hover: bool,
    action_hover: [bool; 2],
    action_active: [bool; 2],
    action_motion: [gpui_ce_motion::MotionValue; 2],
    action_values: [f32; 2],
    lift: gpui_ce_motion::MotionValue,
    fade: gpui_ce_motion::MotionValue,
    papers: [gpui_ce_motion::MotionValue; 3],
    counts: [CountMotion; 2],
    pub lift_value: f32,
    pub fade_value: f32,
    pub paper_values: [f32; 3],
    pub count_values: [u32; 2],
}

impl Default for FolderMotion {
    fn default() -> Self {
        Self {
            active: false,
            lift_active: false,
            tile_hover: false,
            action_hover: [false; 2],
            action_active: [false; 2],
            action_motion: std::array::from_fn(|_| gpui_ce_motion::MotionValue::new(0.)),
            action_values: [0.; 2],
            lift: gpui_ce_motion::MotionValue::new(0.),
            fade: gpui_ce_motion::MotionValue::new(0.),
            papers: std::array::from_fn(|_| gpui_ce_motion::MotionValue::new(0.)),
            counts: [CountMotion::default(), CountMotion::default()],
            lift_value: 0.,
            fade_value: 0.,
            paper_values: [0.; 3],
            count_values: [0, 0],
        }
    }
}

impl FolderMotion {
    pub fn sample(
        &mut self,
        hovered: bool,
        added: u32,
        removed: u32,
        now: Duration,
        window: &mut Window,
        cx: &App,
    ) {
        use gpui_ce_motion::{Bezier, Easing, Spring, Transition};
        if self.active != hovered {
            self.active = hovered;
            let target = if hovered { 1. } else { 0. };
            self.fade.animate(
                target,
                Transition::Tween(
                    Duration::from_millis(200),
                    Easing::Bezier(Bezier::new(0.25, 0.1, 0.25, 1.).expect("CSS ease")),
                ),
                now,
            );
            for (i, paper) in self.papers.iter_mut().enumerate() {
                paper.animate_delayed(
                    target,
                    Transition::Spring(Spring::new(340., 15., 0.7).expect("paper spring")),
                    Duration::from_millis(if hovered { i as u64 * 40 } else { 0 }),
                    now,
                );
            }
        }
        if self.lift_active != self.tile_hover {
            self.lift_active = self.tile_hover;
            let target = if self.tile_hover { 1. } else { 0. };
            self.lift.animate(
                target,
                Transition::Tween(
                    Duration::from_millis(350),
                    Easing::Bezier(Bezier::new(0.22, 1., 0.36, 1.).expect("folder lift curve")),
                ),
                now,
            );
        }
        let lift = self.lift.sample(now, cx.reduce_motion());
        let fade = self.fade.sample(now, cx.reduce_motion());
        self.lift_value = lift.value() as f32;
        self.fade_value = fade.value() as f32;
        let mut animating = lift.is_animating() || fade.is_animating();
        for (i, paper) in self.papers.iter_mut().enumerate() {
            let sample = paper.sample(now, cx.reduce_motion());
            self.paper_values[i] = sample.value() as f32;
            animating |= sample.is_animating();
        }
        for i in 0..2 {
            let active = self.action_hover[i];
            if self.action_active[i] != active {
                self.action_active[i] = active;
                self.action_motion[i].animate(
                    if active { 1. } else { 0. },
                    Transition::Tween(
                        Duration::from_millis(200),
                        Easing::Bezier(Bezier::new(0.25, 0.1, 0.25, 1.).expect("CSS ease")),
                    ),
                    now,
                );
            }
            let sample = self.action_motion[i].sample(now, cx.reduce_motion());
            self.action_values[i] = sample.value() as f32;
            animating |= sample.is_animating();
        }
        let (added_val, adding) = self.counts[0].sample(added, now);
        let (removed_val, removing) = self.counts[1].sample(removed, now);
        self.count_values = [added_val, removed_val];
        animating |= adding || removing;

        if animating {
            window.request_animation_frame();
        }
    }
}

impl ProjectView {
    pub(super) fn render_folder(
        &self,
        c: &Palette,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let vp_width = window.viewport_size().width.as_f32();
        let docked = vp_width > 1440.;
        let scale = if docked { 1.15 } else { 0.95 };
        let repo = self.model.is_some();
        let branch = self
            .model
            .as_ref()
            .and_then(|m| m.snapshot.branch.as_deref());
        let target_added = self.model.as_ref().map_or(0, |m| m.added);
        let target_removed = self.model.as_ref().map_or(0, |m| m.removed);
        let added = self.folder_motion.count_values[0];
        let removed = self.folder_motion.count_values[1];

        // ProjectView.vue uses g.changes.slice(0, 3), before lane sorting/splitting.
        let files: Vec<FileEntry> = self
            .model
            .as_ref()
            .map(|m| {
                m.snapshot
                    .changes
                    .iter()
                    .take(3)
                    .map(|change| FileEntry {
                        change: change.clone(),
                        lane: Lane::Changed,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let dark = Theme::get(cx).is_dark();
        let palette = c.clone();
        let hover = self.folder_motion.paper_values;
        let ink_mix = |amount, base| hsla(c.ink.mix(amount, base));
        let (sheet_top, sheet_bottom, pocket_top, pocket_mid, pocket_bottom) = if dark {
            (
                ink_mix(0.068, c.ground),
                ink_mix(0.04, c.ground),
                ink_mix(0.094, c.ground),
                ink_mix(0.057, c.ground),
                ink_mix(0.035, c.ground),
            )
        } else {
            (
                ink_mix(0.052, c.raised),
                ink_mix(0.123, c.raised),
                ink_mix(0.013, c.raised),
                ink_mix(0.077, c.raised),
                ink_mix(0.12, c.raised),
            )
        };
        let gh = if dark {
            c.ink.mix(0.937, c.ground)
        } else {
            c.ink_soft.mix(0.565, c.ink)
        };
        let pocket_colors = [pocket_top, pocket_mid, pocket_bottom];
        let pocket_shadows = vec![
            BoxShadow {
                color: hsla(if dark {
                    c.ink.alpha(0.07)
                } else {
                    c.raised_high.alpha(0.9)
                }),
                offset: point(px(0.), px(if dark { scale } else { 2. * scale })),
                blur_radius: px(0.),
                spread_radius: px(0.),
                inset: true,
            },
            BoxShadow {
                color: hsla(if dark {
                    c.sunken.alpha(0.14)
                } else {
                    c.ink.alpha(0.03)
                }),
                offset: point(px(0.), px(-10. * scale)),
                blur_radius: px(18. * scale),
                spread_radius: px(0.),
                inset: true,
            },
            BoxShadow {
                color: if dark {
                    hsla(c.sunken.alpha(0.16))
                } else {
                    black().opacity(0.06)
                },
                offset: point(px(0.), px(4. * scale)),
                blur_radius: px(10. * scale),
                spread_radius: px(0.),
                inset: false,
            },
        ];
        let tile = div()
            .id("folder-tile")
            .relative()
            .cursor_pointer()
            .on_hover(cx.listener(|this, over: &bool, _, cx| {
                if this.peek || this.detail.is_some() {
                    return;
                }
                if this.folder_motion.tile_hover != *over {
                    this.folder_motion.tile_hover = *over;
                    cx.notify();
                }
            }))
            .top(px(-3. * self.folder_motion.lift_value))
            .w(px(200. * scale))
            .h(px(116. * scale))
            .child(
                div()
                    .absolute()
                    .left(px(16. * scale))
                    .top(px(6. * scale))
                    .w(px(168. * scale))
                    .h(px(44. * scale))
                    .rounded_t(px(16. * scale))
                    .rounded_b(px(14. * scale))
                    .bg(css_gradient(
                        size(px(168. * scale), px(44. * scale)),
                        Bounds::new(
                            point(px(0.), px(0.)),
                            size(px(168. * scale), px(44. * scale)),
                        ),
                        160.,
                        [sheet_top, sheet_bottom],
                        [0., 1.],
                    ))
                    .shadow(vec![BoxShadow {
                        color: hsla(if dark {
                            c.ink.alpha(0.05)
                        } else {
                            c.raised_high.alpha(0.7)
                        }),
                        offset: point(px(0.), px(scale)),
                        blur_radius: px(0.),
                        spread_radius: px(0.),
                        inset: true,
                    }]),
            )
            .child(
                canvas(
                    move |_, _, _| (),
                    move |bounds, _, window, cx| {
                        paint_folder_papers(bounds, &files, &palette, dark, hover, window, cx);
                    },
                )
                .absolute()
                .size_full(),
            )
            .child(
                div()
                    .absolute()
                    .left_0()
                    .bottom_0()
                    .w(px(200. * scale))
                    .h(px(92. * scale))
                    .rounded(px(22. * scale))
                    .child(
                        canvas(
                            move |_, _, _| (),
                            move |bounds, _, window, _| {
                                let radii: Corners<Pixels> = px(22. * scale).into();
                                window.paint_drop_shadows(bounds, radii, &pocket_shadows);
                                paint_pocket(bounds, pocket_colors, window);
                                window.paint_inset_shadows(bounds, radii, &pocket_shadows);
                            },
                        )
                        .absolute()
                        .left_0()
                        .top_0()
                        .size_full(),
                    )
                    .flex()
                    .flex_col()
                    .justify_end()
                    .gap(px(7. * scale))
                    .px(px(18. * scale))
                    .pb(px(15. * scale))
                    .child(
                        div()
                            .flex()
                            .items_end()
                            .gap(px(9. * scale))
                            .min_w(px(0.))
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
                                    .id("folder-name")
                                    .min_w(px(0.))
                                    .truncate()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_size(px(17. * scale))
                                    .line_height(px(17. * scale))
                                    .text_color(hsla(c.ink))
                                    .tooltip(folder_tip(self.name.clone()))
                                    .tooltip_show_delay(Duration::from_millis(500))
                                    .child(self.name.clone()),
                            ),
                    )
                    .when(repo && branch.is_some(), |d| {
                        d.child(
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .gap(px(12. * scale))
                                .h(px(12.5 * scale))
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(6. * scale))
                                        .min_w(px(0.))
                                        .child(
                                            svg()
                                                .path("icons/branch.svg")
                                                .size(px(12. * scale))
                                                .flex_shrink_0()
                                                .text_color(hsla(c.muted)),
                                        )
                                        .child(
                                            div()
                                                .font_family(crate::style::MONO)
                                                .text_size(px(11. * scale))
                                                .line_height(px(11. * scale))
                                                .text_color(hsla(c.muted))
                                                .truncate()
                                                .child(branch.unwrap().to_string()),
                                        ),
                                )
                                .when(target_added > 0 || target_removed > 0, |d| {
                                    d.child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .flex_shrink_0()
                                            .gap(px(12. * scale))
                                            .font_family(crate::style::MONO)
                                            .text_size(px(12.5 * scale))
                                            .line_height(px(12.5 * scale))
                                            .when(target_added > 0, |d| {
                                                d.child(
                                                    div()
                                                        .text_color(hsla(if dark {
                                                            kone_theme::Rgba::hex(0x10b981)
                                                        } else {
                                                            c.diff_add
                                                        }))
                                                        .child(format!(
                                                            "+{}",
                                                            crate::recents::group(added)
                                                        )),
                                                )
                                            })
                                            .when(target_removed > 0, |d| {
                                                d.child(
                                                    div()
                                                        .text_color(hsla(c.diff_del))
                                                        .child(format!(
                                                            "−{}",
                                                            crate::recents::group(removed)
                                                        )),
                                                )
                                            }),
                                    )
                                }),
                        )
                    }),
            );

        let branch_tone = hsla(c.ink.mix(self.folder_motion.action_values[0], c.muted));
        let is_selected_reveal = self.selected.as_deref() == Some("reveal");
        let reveal_tone = hsla(c.ink.mix(
            if is_selected_reveal {
                1.
            } else {
                self.folder_motion.action_values[1]
            },
            c.muted,
        ));

        // Switch branch: styled exactly like Electron's folder action, inert (view-only).
        let switch = div()
            .id("folder-switch-branch")
            .cursor_pointer()
            .flex()
            .items_center()
            .gap(px(7.))
            .font_weight(FontWeight::NORMAL)
            .text_size(px(12.5))
            .line_height(px(18.))
            .whitespace_nowrap()
            .text_color(branch_tone)
            .on_hover(cx.listener(|this, over: &bool, _, cx| {
                if this.peek || this.detail.is_some() {
                    return;
                }
                if this.folder_motion.action_hover[0] != *over {
                    this.folder_motion.action_hover[0] = *over;
                    cx.notify();
                }
            }))
            .tooltip(folder_tip("Switch branch"))
            .tooltip_show_delay(Duration::from_millis(500))
            .child(
                svg()
                    .path("icons/git-branch.svg")
                    .size(px(if docked { 15. } else { 14. }))
                    .flex_shrink_0()
                    .text_color(branch_tone),
            )
            .child("Switch branch");

        let reveal = div()
            .id("reveal-finder")
            .relative()
            .child(self.track_bounds("reveal".into()))
            .cursor_pointer()
            .flex()
            .items_center()
            .gap(px(7.))
            .font_weight(FontWeight::NORMAL)
            .text_size(px(12.5))
            .line_height(px(18.))
            .whitespace_nowrap()
            .text_color(reveal_tone)
            .on_hover(cx.listener(|this, over: &bool, _, cx| {
                if this.peek || this.detail.is_some() {
                    return;
                }
                if this.folder_motion.action_hover[1] != *over {
                    this.folder_motion.action_hover[1] = *over;
                    cx.notify();
                }
            }))
            .tooltip(folder_tip("Reveal in Finder"))
            .tooltip_show_delay(Duration::from_millis(500))
            .on_click(cx.listener(|this, _, _, cx| {
                this.selected = Some("reveal".into());
                if this.folder_hover || this.selected.as_deref() == Some("reveal") {
                    this.reveal(cx);
                }
                cx.notify();
            }))
            .child(
                svg()
                    .path("icons/finder.svg")
                    .size(px(if docked { 15. } else { 14. }))
                    .flex_shrink_0()
                    .text_color(reveal_tone),
            )
            .child("Open in Finder");

        let actions_visible = is_selected_reveal || self.folder_motion.fade_value >= 0.01;
        let actions = div()
            .flex()
            .when(docked, |d| d.flex_col().items_start().gap(px(9.)))
            .when(!docked, |d| {
                d.flex_row()
                    .items_center()
                    .gap(px(14.))
                    .mt(px(12.))
            })
            .opacity(if is_selected_reveal {
                1.
            } else {
                self.folder_motion.fade_value
            })
            .when(!actions_visible, |d| d.invisible())
            .when(repo, |d| d.child(switch))
            .child(reveal);

        let container = div()
            .id("overview-folder")
            .flex()
            .gap(px(if docked { 24. } else { 8. }));
        let container = if docked {
            container
                .flex_col_reverse()
                .items_center()
                .child(tile)
                .child(actions)
        } else if vp_width <= 860.0 {
            container
                .flex_col()
                .items_start()
                .child(tile)
                .child(actions)
        } else {
            container
                .flex_col()
                .items_end()
                .child(tile)
                .child(actions)
        };
        container
            .on_hover(cx.listener(|this, over: &bool, _, cx| {
                if this.peek || this.detail.is_some() {
                    return;
                }
                if this.folder_hover != *over {
                    this.folder_hover = *over;
                    cx.notify();
                }
            }))
            .into_any_element()
    }
}

fn rounded_contour(x: f32, y: f32, w: f32, h: f32, radius: f32) -> Vec<(f32, f32)> {
    let mut points = Vec::with_capacity(28);
    for (cx, cy, angle) in [
        (x + w - radius, y + radius, -90.),
        (x + w - radius, y + h - radius, 0.),
        (x + radius, y + h - radius, 90.),
        (x + radius, y + radius, 180.),
    ] {
        for step in 0..=6 {
            let a = (angle + step as f32 * 15.).to_radians();
            points.push((cx + radius * a.cos(), cy + radius * a.sin()));
        }
    }
    points
}

fn marks_for_paper(change: &crate::git_service::GitChange) -> Vec<(f32, bool, bool)> {
    let seed: u32 = change
        .path
        .chars()
        .map(|ch| ch.encode_utf16(&mut [0; 2])[0] as u32)
        .sum();
    let jitter = |base: u32, i: u32| (base + (seed + i * 7) % 5 - 2).max(6) as f32;
    if change.added > 0 && change.removed > 0 {
        vec![
            (jitter(16, 0), false, false),
            (jitter(10, 1), false, true),
            (jitter(13, 2), true, false),
        ]
    } else if change.added > 0
        || change.status.eq_ignore_ascii_case("untracked")
        || change.status.eq_ignore_ascii_case("added")
    {
        vec![
            (jitter(15, 0), true, false),
            (jitter(10, 1), true, false),
            (jitter(8, 2), false, false),
        ]
    } else if change.removed > 0 {
        vec![
            (jitter(15, 0), false, true),
            (jitter(9, 1), false, true),
            (jitter(7, 2), false, false),
        ]
    } else {
        vec![(15., false, false), (10., false, false)]
    }
}

fn paint_folder_papers(
    bounds: Bounds<Pixels>,
    files: &[FileEntry],
    c: &Palette,
    is_dark: bool,
    hover: [f32; 3],
    window: &mut Window,
    cx: &mut App,
) {
    const SLOTS: [(f32, f32, f32); 3] = [(44., 54., -10.), (78., 60., 1.), (112., 54., 11.)];
    let origin = bounds.origin;
    let scale = bounds.size.width.as_f32() / 200.0;
    for (i, file) in files.iter().take(3).enumerate() {
        let (left, bottom, angle) = SLOTS[i];
        let left = left + [-14., 0., 14.][i] * hover[i];
        let bottom = bottom + [4., 5., 4.][i] * hover[i];
        let angle = angle + [-6., 0., 6.][i] * hover[i];
        let rad = angle.to_radians();
        let (sin, cos) = rad.sin_cos();
        let pivot = origin + point(px(left * scale), px((116.0 - (bottom + 62.0)) * scale));
        let transform = |(x, y): (f32, f32)| {
            pivot
                + point(
                    px((x * cos - y * sin) * scale),
                    px((x * sin + y * cos) * scale),
                )
        };
        let torn = file.change.status.eq_ignore_ascii_case("deleted");

        // Shadow penumbra
        let shadow_color = if is_dark {
            c.sunken.alpha(0.18)
        } else {
            kone_theme::Rgba::hex(0).alpha(0.07)
        };
        for spread in (0..5).rev() {
            let sp = spread as f32;
            let contour = rounded_contour(-sp, -sp, 50. + 2. * sp, 62. + 2. * sp, 6. + sp);
            let mut path = PathBuilder::fill();
            let shadow_point = |p| transform(p) + point(px(0.), px(4. * scale));
            path.move_to(shadow_point(contour[0]));
            for &p in &contour[1..] {
                path.line_to(shadow_point(p));
            }
            path.close();
            if let Ok(path) = path.build() {
                window.paint_path(
                    path,
                    hsla(shadow_color.alpha(shadow_color.a * 0.2 * if torn { 0.9 } else { 1. })),
                );
            }
        }

        // Paper body
        let paper_color = if is_dark {
            c.ink.mix(0.057, c.raised_high)
        } else {
            c.raised_high
        };
        let contour = rounded_contour(0., 0., 50., 62., 6.);
        let mut path = PathBuilder::fill();
        path.move_to(transform(contour[0]));
        for &p in &contour[1..] {
            path.line_to(transform(p));
        }
        path.close();
        if let Ok(path) = path.build() {
            window.paint_path(
                path,
                hsla(if torn {
                    paper_color.alpha(0.35 * 0.9)
                } else {
                    paper_color
                }),
            );
        }

        let dpi = window.scale_factor();
        let rotation = TransformationMatrix {
            rotation_scale: [[cos, -sin], [sin, cos]],
            translation: [
                dpi * (pivot.x.as_f32() * (1. - cos) + pivot.y.as_f32() * sin),
                dpi * (pivot.y.as_f32() * (1. - cos) - pivot.x.as_f32() * sin),
            ],
        };
        let typescript = file.change.path.ends_with(".ts") || file.change.path.ends_with(".tsx");
        // A file-type logo retains its brand pigment, just as Electron's SVG does.
        let (icon, color) = if typescript {
            let source = include_str!("../../assets/icons/folder-typescript.svg");
            let pigment = source
                .split("fill=\"")
                .nth(1)
                .and_then(|s| s.split('"').next())
                .and_then(kone_theme::Rgba::parse)
                .expect("bundled TypeScript SVG pigment");
            ("icons/folder-typescript.svg", pigment)
        } else {
            ("icons/file.svg", c.file)
        };
        let _ = window.paint_svg(
            Bounds::new(
                pivot + point(px(8. * scale), px(8. * scale)),
                size(px(10. * scale), px(10. * scale)),
            ),
            icon.into(),
            None,
            rotation,
            hsla(color.alpha(if torn { 0.9 } else { 1. })),
            cx,
        );

        if torn {
            // Dashed border for deleted file
            let mut path = PathBuilder::stroke(px(1.5 * scale));
            let mut distance: f32 = 0.;
            for edge in 0..contour.len() {
                let (x, y) = contour[edge];
                let (nx, ny) = contour[(edge + 1) % contour.len()];
                let length = (nx - x).hypot(ny - y);
                let mut along = 0.;
                while along < length {
                    let phase = distance % 7.;
                    let step = (if phase < 4. { 4. - phase } else { 7. - phase })
                        .min(length - along)
                        .max(0.001);
                    if phase < 4. {
                        path.move_to(transform((
                            x + (nx - x) * along / length,
                            y + (ny - y) * along / length,
                        )));
                        path.line_to(transform((
                            x + (nx - x) * (along + step) / length,
                            y + (ny - y) * (along + step) / length,
                        )));
                    }
                    along += step;
                    distance += step;
                }
            }
            if let Ok(path) = path.build() {
                window.paint_path(path, hsla(c.diff_del.alpha(0.9)));
            }
        } else {
            // Sketch marks
            let marks = marks_for_paper(&file.change);
            for (j, (w, is_add, is_del)) in marks.into_iter().enumerate() {
                let m_contour = rounded_contour(8., 20. + j as f32 * 6., w, 3., 1.5);
                let mut path = PathBuilder::fill();
                path.move_to(transform(m_contour[0]));
                for &p in &m_contour[1..] {
                    path.line_to(transform(p));
                }
                path.close();
                let color = if is_add {
                    if is_dark {
                        kone_theme::Rgba::hex(0x12b981)
                    } else {
                        c.diff_add
                    }
                } else if is_del {
                    c.diff_del
                } else if is_dark {
                    c.ink.mix(0.446, c.ground)
                } else {
                    c.faint.mix(0.5, c.raised_high)
                };
                if let Ok(path) = path.build() {
                    window.paint_path(path, hsla(color));
                }
            }
        }
    }
}

/// GPUI gradients have two stops. Split the rounded face at the middle stop,
/// retaining the same gradient axis in each polygon (including its clipped bounds).
fn paint_pocket(bounds: Bounds<Pixels>, colors: [Hsla; 3], window: &mut Window) {
    let w = bounds.size.width.as_f32();
    let h = bounds.size.height.as_f32();
    let contour = rounded_contour(0., 0., w, h, 22. * w / 200.);
    let (dx, dy) = (168_f32.to_radians().sin(), -168_f32.to_radians().cos());
    let length = w * dx + h * dy;
    let position = |p: (f32, f32)| (p.0 * dx + p.1 * dy) / length;
    for upper in [true, false] {
        let mut polygon = Vec::new();
        for i in 0..contour.len() {
            let a = contour[i];
            let b = contour[(i + 1) % contour.len()];
            let ta = position(a);
            let tb = position(b);
            let inside_a = (ta <= 0.55) == upper;
            let inside_b = (tb <= 0.55) == upper;
            if inside_a {
                polygon.push(a);
            }
            if inside_a != inside_b {
                let t = (0.55 - ta) / (tb - ta);
                polygon.push((a.0 + t * (b.0 - a.0), a.1 + t * (b.1 - a.1)));
            }
        }
        if polygon.is_empty() {
            continue;
        }
        let min_x = polygon.iter().map(|p| p.0).fold(f32::INFINITY, f32::min);
        let max_x = polygon
            .iter()
            .map(|p| p.0)
            .fold(f32::NEG_INFINITY, f32::max);
        let min_y = polygon.iter().map(|p| p.1).fold(f32::INFINITY, f32::min);
        let max_y = polygon
            .iter()
            .map(|p| p.1)
            .fold(f32::NEG_INFINITY, f32::max);
        let (from, to, from_t, to_t) = if upper {
            (colors[0], colors[1], 0., 0.55)
        } else {
            (colors[1], colors[2], 0.55, 1.)
        };
        let mut path = PathBuilder::fill();
        path.move_to(bounds.origin + point(px(polygon[0].0), px(polygon[0].1)));
        for p in &polygon[1..] {
            path.line_to(bounds.origin + point(px(p.0), px(p.1)));
        }
        path.close();
        if let Ok(path) = path.build() {
            window.paint_path(
                path,
                css_gradient(
                    bounds.size,
                    Bounds::new(
                        point(px(min_x), px(min_y)),
                        size(px(max_x - min_x), px(max_y - min_y)),
                    ),
                    168.,
                    [from, to],
                    [from_t, to_t],
                ),
            );
        }
    }
}

/// GPUI scales its gradient direction by aspect ratio. Compensate so the
/// visual axis and stop positions use CSS's projection through the corners.
fn css_gradient(
    full: Size<Pixels>,
    region: Bounds<Pixels>,
    angle: f32,
    colors: [Hsla; 2],
    stops: [f32; 2],
) -> Background {
    let w = region.size.width.as_f32();
    let h = region.size.height.as_f32();
    let dx = angle.to_radians().sin();
    let dy = -angle.to_radians().cos();
    let length = full.width.as_f32() * dx.abs() + full.height.as_f32() * dy.abs();
    let global_center = (full.width.as_f32() * dx + full.height.as_f32() * dy) / 2.;
    let region_center =
        (region.origin.x.as_f32() + w / 2.) * dx + (region.origin.y.as_f32() + h / 2.) * dy;
    let axis = if dx.abs() > dy.abs() { w } else { h };
    let local_stop = |t| 0.5 + (global_center + (t - 0.5) * length - region_center) / axis;
    let (gx, gy) = if w > h {
        (dx, dy * w / h)
    } else {
        (dx * h / w, dy)
    };
    let gpui_angle = gy.atan2(gx).to_degrees() + 90.;
    linear_gradient(
        gpui_angle,
        linear_color_stop(colors[0], local_stop(stops[0])),
        linear_color_stop(colors[1], local_stop(stops[1])),
    )
    .color_space(ColorSpace::Oklab)
}

struct FolderTip(SharedString);

impl Render for FolderTip {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::get(cx);
        let c = &theme.colors;
        let (background, foreground, border) = if theme.is_dark() {
            (c.sunken, c.ink, c.muted)
        } else {
            (c.ink, c.raised_high, c.line)
        };
        div().pl(px(11.)).pt(px(14.)).child(
            div()
                .font_family(".SystemUIFont")
                .px(px(4.))
                .py(px(2.))
                .bg(hsla(background))
                .border_1()
                .border_color(hsla(border))
                .text_size(px(12.))
                .font_weight(FontWeight::NORMAL)
                .text_color(hsla(foreground))
                .whitespace_nowrap()
                .child(self.0.clone()),
        )
    }
}

fn folder_tip(
    text: impl Into<SharedString>,
) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let text = text.into();
    move |_, cx| cx.new(|_| FolderTip(text.clone())).into()
}

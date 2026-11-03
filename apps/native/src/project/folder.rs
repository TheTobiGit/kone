//! Project folder visual tile with paper cards, branch/totals, and reveal action.
use super::*;
use gpui_kit::prelude::*;
use gpui_kit::*;
use kone_theme::{Palette, Theme, hsla};

const SCALE: f32 = 0.95;
const FOLDER_W: f32 = 200.0 * SCALE;
const FOLDER_H: f32 = 116.0 * SCALE;
const POCKET_H: f32 = 92.0 * SCALE;

impl ProjectView {
    pub(super) fn render_folder(&self, c: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let repo = self.model.is_some();
        let branch = self.model.as_ref().and_then(|m| {
            if m.snapshot.detached {
                m.snapshot.head.as_deref().map(|h| {
                    let end = 7.min(h.len());
                    &h[..end]
                })
            } else {
                m.snapshot.branch.as_deref()
            }
        });
        let added = self.model.as_ref().map_or(0, |m| m.added);
        let removed = self.model.as_ref().map_or(0, |m| m.removed);
        let files: Vec<FileEntry> = self
            .model
            .as_ref()
            .map(|m| {
                let mut seen = std::collections::HashSet::new();
                m.all_entries()
                    .into_iter()
                    .filter(|e| seen.insert(e.change.path.clone()))
                    .take(3)
                    .collect()
            })
            .unwrap_or_default();

        let is_dark = Theme::get(cx).is_dark();
        let palette = c.clone();
        let paper_files = files.clone();
        let hover = self.folder_lift;

        let folder_tile = div()
            .relative()
            .top(px(-6. * hover))
            .w(px(FOLDER_W))
            .h(px(FOLDER_H))
            // Back sheet peeking above pocket
            .child(
                div()
                    .absolute()
                    .left(px(16.0 * SCALE))
                    .top(px(6.0 * SCALE))
                    .w(px(168.0 * SCALE))
                    .h(px(44.0 * SCALE))
                    .rounded(px(15.0 * SCALE))
                    .bg(hsla(c.raised_high))
                    .border_1()
                    .border_color(hsla(c.line_soft)),
            )
            // Canvas painting papers
            .child(
                canvas(
                    move |_, _, _| (),
                    move |bounds, _, window, _cx| {
                        paint_folder_papers(bounds, &paper_files, &palette, is_dark, hover, window);
                    },
                )
                .absolute()
                .size_full(),
            )
            // Front pocket
            .child(
                div()
                    .absolute()
                    .left_0()
                    .bottom_0()
                    .w(px(FOLDER_W))
                    .h(px(POCKET_H))
                    .rounded(px(22.0 * SCALE))
                    .bg(hsla(c.raised))
                    .border_1()
                    .border_color(hsla(c.line_soft))
                    .flex()
                    .flex_col()
                    .justify_between()
                    .p(px(14.0 * SCALE))
                    // Name row
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0 * SCALE))
                            .when(repo, |d| {
                                d.child(
                                    svg()
                                        .path("icons/gh-mark.svg")
                                        .size(px(15.0 * SCALE))
                                        .flex_shrink_0()
                                        .text_color(hsla(c.ink_soft)),
                                )
                            })
                            .child(
                                div()
                                    .min_w(px(0.))
                                    .truncate()
                                    .text_size(px(16.0 * SCALE))
                                    .text_color(hsla(c.ink))
                                    .child(self.name.clone()),
                            ),
                    )
                    // Meta row: branch and diff totals
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(10.0 * SCALE))
                            .h(px(14.0 * SCALE))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(5.0 * SCALE))
                                    .min_w(px(0.))
                                    .when(repo && branch.is_some(), |d| {
                                        d.child(
                                            svg()
                                                .path("icons/git-branch.svg")
                                                .size(px(12.0 * SCALE))
                                                .flex_shrink_0()
                                                .text_color(hsla(c.muted)),
                                        )
                                        .child(
                                            div()
                                                .font_family(crate::style::MONO)
                                                .text_size(px(11.0 * SCALE))
                                                .text_color(hsla(c.muted))
                                                .truncate()
                                                .child(branch.unwrap().to_string()),
                                        )
                                    }),
                            )
                            .when(added > 0 || removed > 0, |d| {
                                d.child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(8.0 * SCALE))
                                        .font_family(crate::style::MONO)
                                        .text_size(px(11.5 * SCALE))
                                        .when(added > 0, |d| {
                                            d.child(
                                                div()
                                                    .text_color(hsla(c.diff_add))
                                                    .child(format!("+{added}")),
                                            )
                                        })
                                        .when(removed > 0, |d| {
                                            d.child(
                                                div()
                                                    .text_color(hsla(c.diff_del))
                                                    .child(format!("−{removed}")),
                                            )
                                        }),
                                )
                            }),
                    ),
            );

        // Action row: reveal is clickable only, branch switch is omitted
        let actions = div().flex().items_center().gap(px(12.)).child(
            div()
                .id("reveal-finder")
                .cursor_pointer()
                .px(px(8.))
                .py(px(4.))
                .rounded(px(6.))
                .flex()
                .items_center()
                .gap(px(6.))
                .text_size(px(11.))
                .text_color(hsla(c.muted))
                .hover(|s| s.bg(hsla(c.hover)).text_color(hsla(c.ink)))
                .on_click(cx.listener(|this, _, _, cx| this.reveal(cx)))
                .child(
                    svg()
                        .path("icons/finder.svg")
                        .size(px(13.))
                        .flex_shrink_0()
                        .text_color(hsla(c.muted)),
                )
                .child(if cfg!(target_os = "macos") {
                    "Open in Finder"
                } else {
                    "Open folder"
                }),
        );

        div()
            .id("overview-folder")
            .on_hover(cx.listener(|this, over: &bool, _, cx| {
                if this.folder_hover != *over {
                    this.folder_hover = *over;
                    cx.notify();
                }
            }))
            .flex()
            .flex_col()
            .items_start()
            .gap(px(8.))
            .child(folder_tile)
            .child(actions)
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
    hover: f32,
    window: &mut Window,
) {
    const SLOTS: [(f32, f32, f32); 3] = [(44., 54., -10.), (78., 60., 1.), (112., 54., 11.)];
    let origin = bounds.origin;
    let scale = bounds.size.width.as_f32() / (200.0 * SCALE);
    for (i, file) in files.iter().take(3).enumerate() {
        let (left, bottom, angle) = SLOTS[i];
        let left = left + [-14., 0., 14.][i] * hover;
        let bottom = bottom + [4., 5., 4.][i] * hover;
        let angle = angle + [-6., 0., 6.][i] * hover;
        let rad = angle.to_radians();
        let (sin, cos) = rad.sin_cos();
        let pivot = origin
            + point(
                px(left * SCALE * scale),
                px((116.0 * SCALE - (bottom + 62.0) * SCALE) * scale),
            );
        let transform = |(x, y): (f32, f32)| {
            pivot
                + point(
                    px((x * cos - y * sin) * SCALE * scale),
                    px((x * sin + y * cos) * SCALE * scale),
                )
        };
        let torn = file.change.status.eq_ignore_ascii_case("deleted");

        // Shadow penumbra
        let shadow_color = hsla(c.ink.alpha(0.06));
        for spread in (0..4).rev() {
            let sp = spread as f32;
            let contour = rounded_contour(-sp, -sp, 50. + 2. * sp, 62. + 2. * sp, 6. + sp);
            let mut path = PathBuilder::fill();
            let shadow_point = |p| transform(p) + point(px(0.), px(4. * SCALE * scale));
            path.move_to(shadow_point(contour[0]));
            for &p in &contour[1..] {
                path.line_to(shadow_point(p));
            }
            path.close();
            if let Ok(path) = path.build() {
                window.paint_path(path, shadow_color);
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
                    paper_color.alpha(0.35)
                } else {
                    paper_color
                }),
            );
        }

        if torn {
            // Dashed border for deleted file
            let mut path = PathBuilder::stroke(px(1.5 * SCALE * scale));
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
                window.paint_path(path, hsla(c.diff_del));
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
                    c.diff_add
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

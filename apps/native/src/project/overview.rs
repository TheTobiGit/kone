//! Overview screen presenting greeting, responsive folder companion, and changes lanes.
use super::*;
use gpui_kit::prelude::*;
use gpui_kit::*;
use kone_theme::{Palette, Theme, hsla};

impl ProjectView {
    pub(super) fn render_overview(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let c = Theme::get(cx).colors.clone();
        let vp_width = f32::from(window.viewport_size().width);
        // Overview max width 896, horizontal inset 64 on each side = 128
        let content_width = (vp_width - 128.0).clamp(300.0, 896.0);

        self.content_width = content_width;
        let greeting = self.render_greeting(&c);

        // Header layout: responsive based on viewport width
        // <= 860: stacked
        // <= 1440: inline folder companion
        // > 1440: docked bottom-left
        let header = if vp_width <= 860.0 {
            div()
                .flex()
                .flex_col()
                .items_start()
                .gap(px(20.))
                .child(greeting)
                .child(self.render_folder(&c, window, cx))
        } else if vp_width <= 1440.0 {
            div()
                .flex()
                .items_start()
                .justify_between()
                .gap(px(32.))
                .child(div().min_w(px(0.)).flex_1().child(greeting))
                .child(div().flex_shrink_0().child(self.render_folder(&c, window, cx)))
        } else {
            div()
                .flex()
                .items_start()
                .justify_between()
                .gap(px(32.))
                .child(div().min_w(px(0.)).flex_1().child(greeting))
        };

        let changes = self.render_changes(&c, content_width, cx);

        div()
            .relative()
            .size_full()
            .id("overview-stage")
            .track_scroll(&self.overview_scroll)
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .items_center()
            .px(px(64.))
            // Main centered column
            .child(
                div()
                    .w_full()
                    .max_w(px(896.))
                    .pt(px(if window.viewport_size().height.as_f32() < 850. {
                        26.
                    } else {
                        50.
                    }))
                    .pb(px(64.))
                    .flex()
                    .flex_col()
                    .gap(px(44.))
                    .child(header)
                    .child(changes)
                    // Chats / sessions area remains blank
                    .child(div().flex_1().min_h(px(0.))),
            )
            // When viewport > 1440, dock folder in bottom-left corner
            .when(vp_width > 1440.0, |d| {
                d.child(
                    div()
                        .absolute()
                        .bottom(px(40.))
                        .left(px(40.))
                        .child(self.render_folder(&c, window, cx)),
                )
            })
            .into_any_element()
    }

    fn render_greeting(&self, c: &Palette) -> AnyElement {
        let initial = self
            .identity
            .chars()
            .next()
            .unwrap_or('Y')
            .to_uppercase()
            .to_string();

        let who = if self.identity.trim().is_empty() {
            div()
                .text_size(px(30.))
                .text_color(hsla(c.ink))
                .child("there")
        } else {
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .child(
                    div()
                        .size(px(30.))
                        .rounded_full()
                        .bg(hsla(c.chip))
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(14.))
                        .text_color(hsla(c.ink_soft))
                        .child(initial),
                )
                .child(
                    div()
                        .text_size(px(30.))
                        .text_color(hsla(c.ink))
                        .child(self.identity.clone()),
                )
        };

        let line_hey = div()
            .flex()
            .items_center()
            .gap(px(10.))
            .line_height(px(34.))
            .child(
                div()
                    .text_size(px(30.))
                    .text_color(hsla(c.ink_soft))
                    .child("Hey,"),
            )
            .child(who);

        let body_spans = Self::build_greeting_body(
            &self.name,
            self.model.as_ref(),
            self.loading,
            self.error.is_some(),
        );

        let mut body_el = div()
            .max_w(px(620.))
            .flex()
            .flex_wrap()
            .items_baseline()
            .gap_x(px(7.))
            .gap_y(px(2.))
            .line_height(px(37.5));

        let mut occurrences = std::collections::HashMap::<String, usize>::new();
        for (rank, span) in body_spans.into_iter().enumerate() {
            let occurrence = occurrences.entry(span.text.clone()).or_default();
            let id = SharedString::from(format!("greeting-word:{}:{}", span.text, *occurrence));
            *occurrence += 1;
            let item = match span.tone {
                SpanTone::Ink => div()
                    .text_size(px(30.))
                    .text_color(hsla(c.ink))
                    .child(span.text),
                SpanTone::Muted => div()
                    .text_size(px(30.))
                    .text_color(hsla(c.ink_soft))
                    .child(span.text),
                SpanTone::Num => div()
                    .font_family(crate::style::MONO)
                    .text_size(px(26.))
                    .text_color(hsla(c.ink))
                    .child(span.text),
                SpanTone::Add => div()
                    .font_family(crate::style::MONO)
                    .text_size(px(26.))
                    .text_color(hsla(c.diff_add))
                    .child(span.text),
                SpanTone::Del => div()
                    .font_family(crate::style::MONO)
                    .text_size(px(26.))
                    .text_color(hsla(c.diff_del))
                    .child(span.text),
            };

            let item = if span.attach_prev {
                item.ml(px(-7.))
            } else {
                item
            };

            let delay = rank as f32 * 35.;
            let duration = 420. + delay;
            body_el = body_el.child(item.with_animation(
                id,
                Animation::new(Duration::from_millis(duration as u64)),
                move |el, d| {
                    let t = ((d * duration - delay) / 420.).clamp(0., 1.);
                    let t = crate::magnet::glide(t);
                    el.relative().top(px(6. * (1. - t))).opacity(t)
                },
            ));
        }

        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(line_hey)
            .child(body_el)
            .into_any_element()
    }

    fn build_greeting_body(
        name: &str,
        model: Option<&OverviewModel>,
        loading: bool,
        error: bool,
    ) -> Vec<SpanItem> {
        let repo = model.is_some();
        let has_commits = model.is_some_and(|m| m.snapshot.head.is_some());
        let clean = model.is_some_and(|m| m.staged.is_empty() && m.changed.is_empty());
        let n = model.map_or(0, |m| m.file_count);
        let s = model.map_or(0, |m| m.staged.len());
        let ahead = model.map_or(0, |m| m.snapshot.ahead);
        let behind = model.map_or(0, |m| m.snapshot.behind);
        let branch = model.and_then(|m| {
            if m.snapshot.detached {
                None
            } else {
                m.snapshot.branch.as_deref()
            }
        });
        let added = model.map_or(0, |m| m.added);
        let removed = model.map_or(0, |m| m.removed);

        let (headline_segs, subline_segs): (Vec<RawSeg>, Vec<RawSeg>) = if loading || error {
            (vec![RawSeg::ink(name)], Vec::new())
        } else if !repo {
            (
                vec![
                    RawSeg::ink(name),
                    RawSeg::mut_text(" isn't a git repository yet"),
                ],
                vec![RawSeg::mut_text(
                    "Initialize a repo to track changes, then start your first session",
                )],
            )
        } else if !has_commits {
            if clean {
                (
                    vec![
                        RawSeg::ink(name),
                        RawSeg::mut_text(" is a fresh repository"),
                    ],
                    vec![RawSeg::mut_text(
                        "Nothing committed yet — your first changes will show up here",
                    )],
                )
            } else {
                let head = vec![
                    RawSeg::ink(name),
                    RawSeg::mut_text(" is ready for its first commit"),
                ];
                let sub = if s > 0 {
                    vec![
                        RawSeg::num(s),
                        RawSeg::mut_text(" of "),
                        RawSeg::num(n),
                        RawSeg::mut_text(if n == 1 {
                            " file staged"
                        } else {
                            " files staged"
                        }),
                        RawSeg::mut_text(" — commit when you're ready"),
                    ]
                } else {
                    vec![
                        RawSeg::num(n),
                        RawSeg::mut_text(if n == 1 { " file" } else { " files" }),
                        RawSeg::mut_text(" to stage for your first commit"),
                    ]
                };
                (head, sub)
            }
        } else if clean {
            let head = vec![
                RawSeg::ink(name),
                RawSeg::mut_text(" is ready when you are"),
            ];
            let on_branch = |mut v: Vec<RawSeg>| {
                if let Some(b) = branch {
                    v.push(RawSeg::mut_text(" on "));
                    v.push(RawSeg::num(b));
                }
                v
            };
            let sub = if ahead > 0 && behind > 0 {
                on_branch(vec![
                    RawSeg::mut_text("Working tree clean — "),
                    RawSeg::num(ahead),
                    RawSeg::mut_text(" ahead, "),
                    RawSeg::num(behind),
                    RawSeg::mut_text(" behind"),
                ])
            } else if ahead > 0 {
                on_branch(vec![
                    RawSeg::mut_text("Working tree clean — you're "),
                    RawSeg::num(ahead),
                    RawSeg::mut_text(if ahead == 1 {
                        " commit ahead"
                    } else {
                        " commits ahead"
                    }),
                ])
            } else if behind > 0 {
                let mut v = on_branch(vec![
                    RawSeg::mut_text("Working tree clean — "),
                    RawSeg::num(behind),
                    RawSeg::mut_text(if behind == 1 {
                        " commit behind"
                    } else {
                        " commits behind"
                    }),
                ]);
                v.push(RawSeg::mut_text(", pull when you're ready"));
                v
            } else {
                on_branch(vec![RawSeg::mut_text(
                    "No changes — everything's committed",
                )])
            };
            (head, sub)
        } else {
            let head = vec![
                RawSeg::ink(name),
                RawSeg::mut_text(" has "),
                RawSeg::num(n),
                RawSeg::mut_text(if n == 1 {
                    " file with changes"
                } else {
                    " files with changes"
                }),
            ];
            let mut sub = Vec::new();
            if added > 0 || removed > 0 {
                sub.push(RawSeg::mut_text("You have "));
                if added > 0 {
                    sub.push(RawSeg::add(format!("+{added}")));
                }
                if removed > 0 {
                    if added > 0 {
                        sub.push(RawSeg::mut_text("\u{00A0}"));
                    }
                    sub.push(RawSeg::del(format!("−{removed}")));
                }
                sub.push(RawSeg::mut_text(" uncommitted"));
            } else {
                sub.push(RawSeg::mut_text("You have "));
                sub.push(RawSeg::num(n));
                sub.push(RawSeg::mut_text(if n == 1 {
                    " uncommitted change"
                } else {
                    " uncommitted changes"
                }));
            }
            if n > 0 {
                if s == n {
                    sub.push(RawSeg::mut_text(", all staged"));
                } else if s > 0 {
                    sub.push(RawSeg::mut_text(", "));
                    sub.push(RawSeg::num(s));
                    sub.push(RawSeg::mut_text(" staged"));
                } else {
                    sub.push(RawSeg::mut_text(" — nothing staged yet"));
                }
            }
            (head, sub)
        };

        let mut all_segs = headline_segs;
        if !subline_segs.is_empty() {
            all_segs.push(RawSeg::mut_text(". "));
            all_segs.extend(subline_segs);
        }

        // Tokenize raw segments into individual words with accurate trailing/leading attachment
        let mut spans = Vec::new();
        for seg in all_segs {
            match seg.tone {
                SpanTone::Num | SpanTone::Add | SpanTone::Del => {
                    spans.push(SpanItem {
                        text: seg.text,
                        tone: seg.tone,
                        attach_prev: false,
                    });
                }
                SpanTone::Ink | SpanTone::Muted => {
                    for word in seg.text.split_whitespace() {
                        let attach_prev = word.starts_with(',') || word.starts_with('.');
                        spans.push(SpanItem {
                            text: word.to_string(),
                            tone: seg.tone,
                            attach_prev,
                        });
                    }
                }
            }
        }

        spans
    }
}

#[derive(Clone, Copy, PartialEq)]
enum SpanTone {
    Ink,
    Muted,
    Num,
    Add,
    Del,
}

struct RawSeg {
    text: String,
    tone: SpanTone,
}

impl RawSeg {
    fn ink(t: impl Into<String>) -> Self {
        Self {
            text: t.into(),
            tone: SpanTone::Ink,
        }
    }
    fn mut_text(t: impl Into<String>) -> Self {
        Self {
            text: t.into(),
            tone: SpanTone::Muted,
        }
    }
    fn num(t: impl ToString) -> Self {
        Self {
            text: t.to_string(),
            tone: SpanTone::Num,
        }
    }
    fn add(t: impl ToString) -> Self {
        Self {
            text: t.to_string(),
            tone: SpanTone::Add,
        }
    }
    fn del(t: impl ToString) -> Self {
        Self {
            text: t.to_string(),
            tone: SpanTone::Del,
        }
    }
}

struct SpanItem {
    text: String,
    tone: SpanTone,
    attach_prev: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::prelude::v1::test;
    use crate::git_service::{GitChange, GitSnapshot};
    fn sentence(model: Option<&OverviewModel>, loading: bool, error: bool) -> String {
        let mut text = String::new();
        for span in ProjectView::build_greeting_body("project", model, loading, error) {
            if !text.is_empty() && !span.attach_prev {
                text.push(' ');
            }
            text.push_str(&span.text);
        }
        text
    }
    #[test]
    fn dirty_greeting_matches_electron_with_partial_staging() {
        let model = OverviewModel::from(GitSnapshot {
            head: Some("abc".into()),
            changes: vec![
                GitChange {
                    path: "a".into(),
                    staged: true,
                    unstaged: true,
                    added: 3,
                    removed: 2,
                    ..Default::default()
                },
                GitChange {
                    path: "b".into(),
                    unstaged: true,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });
        assert_eq!(
            sentence(Some(&model), false, false),
            "project has 2 files with changes. You have +3 −2 uncommitted, 1 staged"
        );
    }
    #[test]
    fn clean_and_tracking_greetings_match_electron() {
        let mut snapshot = GitSnapshot {
            head: Some("abc".into()),
            branch: Some("dev".into()),
            clean: true,
            ..Default::default()
        };
        assert_eq!(
            sentence(Some(&snapshot.clone().into()), false, false),
            "project is ready when you are. No changes — everything's committed on dev"
        );
        snapshot.ahead = 1;
        snapshot.behind = 2;
        assert_eq!(
            sentence(Some(&snapshot.into()), false, false),
            "project is ready when you are. Working tree clean — 1 ahead, 2 behind on dev"
        );
    }
    #[test]
    fn unborn_and_non_git_greetings_match_electron() {
        let snapshot = GitSnapshot {
            clean: true,
            ..Default::default()
        };
        assert_eq!(
            sentence(Some(&snapshot.into()), false, false),
            "project is a fresh repository. Nothing committed yet — your first changes will show up here"
        );
        assert_eq!(
            sentence(None, false, false),
            "project isn't a git repository yet. Initialize a repo to track changes, then start your first session"
        );
    }
    #[test]
    fn loading_and_failed_reads_never_claim_clean_or_non_git() {
        assert_eq!(sentence(None, true, false), "project");
        assert_eq!(sentence(None, false, true), "project");
    }
}

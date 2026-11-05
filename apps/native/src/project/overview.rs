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
        let greeting = self.render_greeting(&c, window, cx);

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
                .child(
                    div()
                        .flex_shrink_0()
                        .child(self.render_folder(&c, window, cx)),
                )
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

    fn render_greeting(
        &mut self,
        c: &Palette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let initial = self
            .identity
            .chars()
            .next()
            .unwrap_or('Y')
            .to_uppercase()
            .to_string();

        let who = if self.identity.trim().is_empty() || self.identity == "there" {
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
                        .bg(hsla(c.ink))
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(14.))
                        .text_color(hsla(c.ground))
                        .child(initial),
                )
                .child(
                    div()
                        .text_size(px(30.))
                        .text_color(hsla(c.ink))
                        .child(self.identity.clone()),
                )
        };

        let resolved = !self.identity.trim().is_empty() && self.identity != "there";
        let who = div()
            .id("greeting-profile")
            .relative()
            .px(px(7.))
            .py(px(3.))
            .mx(px(-7.))
            .my(px(-3.))
            .rounded(px(9.))
            .when(
                self.focus_visible
                    && self.focus.is_focused(window)
                    && self.selected.as_deref() == Some("greeting-profile"),
                |d| d.child(crate::recents::ring(9., 2., c.ink.alpha(0.26))),
            )
            .when(resolved, |d| {
                d.role(Role::Button)
                    .aria_label(format!("Profile: {}", self.identity))
                    .cursor_pointer()
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(ProjectAction::Profile)))
            })
            .child(who);
        let line_hey = div()
            .flex()
            .items_center()
            .gap(px(10.))
            .line_height(px(33.))
            .child(
                div()
                    .text_size(px(30.))
                    .text_color(hsla(c.ink_soft))
                    .child("Hey,"),
            )
            .child(who);

        let line_hey = if cx.reduce_motion() {
            line_hey.into_any_element()
        } else {
            line_hey
                .with_animation(
                    "greeting-welcome",
                    Animation::new(Duration::from_millis(430)),
                    |el, d| {
                        let t = crate::magnet::glide(((d * 430. - 30.) / 400.).clamp(0., 1.));
                        el.relative().top(px(10. * (1. - t))).opacity(t)
                    },
                )
                .into_any_element()
        };
        let body_spans = Self::build_greeting_body(
            &self.name,
            self.model.as_ref(),
            self.loading,
            self.error.is_some(),
        );

        // GPUI has no text tracking property. Compensate at whitespace boundaries
        // using the 7px/10px line-width deltas in the supplied raw captures.
        const SPACE: f32 = 5.25;
        let mut body_el = div()
            .mt(px(1.))
            .max_w(px(620.))
            .flex()
            .flex_wrap()
            .items_baseline()
            .gap_x(px(SPACE))
            .gap_y(px(2.))
            .line_height(px(37.5));

        let groups = greeting_groups(body_spans);
        let initial = self.switcher.greeting_keys.is_empty();
        let mut current_keys = std::collections::HashSet::new();
        let mut arrivals = 0;
        let mut occurrences = std::collections::HashMap::<String, usize>::new();
        for (rank, spans) in groups.into_iter().enumerate() {
            let key = spans
                .iter()
                .map(|s| format!("{:?}:{}", s.tone, s.text))
                .collect::<Vec<_>>()
                .join("|");
            let occurrence = occurrences.entry(key.clone()).or_default();
            let key = format!("greeting-word:{key}:{}", *occurrence);
            *occurrence += 1;
            let is_new = !self.switcher.greeting_keys.contains(&key);
            current_keys.insert(key.clone());
            let delay = if is_new {
                let delay = if initial { 30. } else { 0. } + arrivals as f32 * 35.;
                arrivals += 1;
                self.switcher.greeting_delays.insert(key.clone(), delay);
                delay
            } else {
                self.switcher
                    .greeting_delays
                    .get(&key)
                    .copied()
                    .unwrap_or(0.)
            };
            let mut item = div().flex().items_baseline().whitespace_nowrap();
            let mut previous_add = false;
            for span in spans {
                if rank == 0 && span.tone == SpanTone::Ink {
                    item = item.child(self.project_trigger(c, window, cx));
                    continue;
                }
                let mono = matches!(span.tone, SpanTone::Num | SpanTone::Add | SpanTone::Del);
                let color = match span.tone {
                    SpanTone::Ink | SpanTone::Num => c.ink,
                    SpanTone::Muted => c.ink_soft,
                    SpanTone::Add => c.diff_add,
                    SpanTone::Del => c.diff_del,
                };
                let pair = previous_add && span.tone == SpanTone::Del;
                previous_add = span.tone == SpanTone::Add;
                item = item.child(
                    div()
                        .when(pair, |d| d.ml(px(SPACE)))
                        .text_size(px(if mono { 26. } else { 30. }))
                        .when(mono, |d| {
                            d.font_family(crate::style::MONO)
                                .font_weight(FontWeight::SEMIBOLD)
                        })
                        .text_color(hsla(color))
                        .child(span.text),
                );
            }
            let duration = 420. + delay;
            body_el = body_el.child(if cx.reduce_motion() {
                item.into_any_element()
            } else {
                item.with_animation(
                    SharedString::from(key),
                    Animation::new(Duration::from_millis(duration as u64)),
                    move |el, d| {
                        let t = ((d * duration - delay) / 420.).clamp(0., 1.);
                        let t = crate::motion::bezier(0.16, 1., 0.3, 1., t);
                        el.relative().top(px(6. * (1. - t))).opacity(t)
                    },
                )
                .into_any_element()
            });
        }
        self.switcher
            .greeting_delays
            .retain(|key, _| current_keys.contains(key));
        self.switcher.greeting_keys = current_keys;

        let bounds = self.switcher.greeting_bounds.clone();
        div()
            .relative()
            .child(
                canvas(move |b, _, _| bounds.set(Some(b)), |_, _, _, _| {})
                    .absolute()
                    .size_full(),
            )
            .font_weight(FontWeight::NORMAL)
            .flex()
            .flex_col()
            .gap(px(2.))
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
        for (index, seg) in all_segs.into_iter().enumerate() {
            if index == 0 {
                spans.push(SpanItem {
                    text: seg.text,
                    tone: seg.tone,
                    attach_prev: false,
                });
                continue;
            }
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

#[derive(Clone, Copy, Debug, PartialEq)]
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

// Punctuation and a diffstat pair belong to the same unbreakable inline unit.
fn greeting_groups(spans: Vec<SpanItem>) -> Vec<Vec<SpanItem>> {
    let mut groups: Vec<Vec<SpanItem>> = Vec::new();
    for span in spans {
        let pair = span.tone == SpanTone::Del
            && groups
                .last()
                .and_then(|g| g.last())
                .is_some_and(|s| s.tone == SpanTone::Add);
        if (span.attach_prev || pair)
            && let Some(group) = groups.last_mut()
        {
            group.push(span);
        } else {
            groups.push(vec![span]);
        }
    }
    groups
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_service::{GitChange, GitSnapshot};
    use core::prelude::v1::test;
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
    fn punctuation_and_diff_pair_cannot_wrap_away() {
        let groups = greeting_groups(vec![
            SpanItem {
                text: "uncommitted".into(),
                tone: SpanTone::Muted,
                attach_prev: false,
            },
            SpanItem {
                text: ",".into(),
                tone: SpanTone::Muted,
                attach_prev: true,
            },
            SpanItem {
                text: "+52".into(),
                tone: SpanTone::Add,
                attach_prev: false,
            },
            SpanItem {
                text: "−32".into(),
                tone: SpanTone::Del,
                attach_prev: false,
            },
            SpanItem {
                text: ".".into(),
                tone: SpanTone::Muted,
                attach_prev: true,
            },
        ]);
        assert_eq!(groups.len(), 2);
        assert_eq!(
            groups[0]
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>(),
            ["uncommitted", ","]
        );
        assert_eq!(
            groups[1]
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>(),
            ["+52", "−32", "."]
        );
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

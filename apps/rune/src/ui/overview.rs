use super::empty::BACK;

use super::empty::StartPointer;
use super::projects::{folder_with_git, sessions};
use crate::{
    state::{AppState, Page},
    theme::{Palette, mix_srgb},
};
use rune::{Color, Cursor, Curve, Cx, Easing, El, Icon, Span, TextStyle, col, el, icon, row, text};

/// `.line--body { letter-spacing: -0.02em }` resolves against the paragraph's own 16 px, not
/// the 30 px spans inside it.
const BODY_TRACKING: f32 = -0.32;
/// `.line--hey { letter-spacing: -0.01em }`, likewise against 16 px.
const HEY_TRACKING: f32 = -0.16;

/// Hugeicons `ArrowDown01Icon`, drawn at 15 px with a 2.2 stroke beside the project name.
static PICKER_FOLDER: Icon = Icon {
    name: "picker-folder",
    view: 24.0,
    body: r#"<path d="M3 7C3 5 4 4 6 4H9L12 7H18C20 7 21 8 21 10V17C21 19 20 20 18 20H6C4 20 3 19 3 17Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static CHEVRON: Icon = Icon {
    name: "overview-project-chevron",
    view: 24.0,
    body: r#"<path d="M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

/// `text-wrap: pretty` as Chromium applies it to the greeting. When the greedy wrap at `max`
/// would leave the last word alone on the last line, the breaks are chosen again, Knuth–Plass
/// style: the same number of lines, at least two words on the last, and the least squared
/// slack on the others. The chosen breaks come back as newlines in place of their spaces, so
/// the span offsets still hold.
fn pretty_wrap(text: &str, spans: &[Span], style: TextStyle, max: f32) -> String {
    let slice = |from: usize, to: usize| -> Vec<Span> {
        spans
            .iter()
            .filter(|span| (span.end as usize) > from && (span.start as usize) < to)
            .map(|span| {
                let mut span = span.clone();
                span.start = (span.start as usize).max(from) as u32 - from as u32;
                span.end = (span.end as usize).min(to) as u32 - from as u32;
                span
            })
            .collect()
    };
    let height = |to: usize| rune::text::measure(&text[..to], &slice(0, to), style, Some(max)).1;
    let Some(last) = text.trim_end().rfind(' ') else {
        return text.to_owned();
    };
    let full = height(text.len());
    if height(last) >= full {
        return text.to_owned();
    }
    let lines = (full / style.line_height).round() as usize;
    // Word boundaries: the spaces a line may break at.
    let breaks: Vec<usize> = text.match_indices(' ').map(|(at, _)| at).collect();
    let words = breaks.len() + 1;
    let start = |word: usize| if word == 0 { 0 } else { breaks[word - 1] + 1 };
    let end = |word: usize| {
        if word == words - 1 {
            text.len()
        } else {
            breaks[word]
        }
    };
    let width = |first: usize, last: usize| {
        let (from, to) = (start(first), end(last));
        rune::text::content_widths(&text[from..to], &slice(from, to), style).1
    };
    // best[k][w]: least cost to set words 0..w on k lines.
    let mut best = vec![vec![(f32::INFINITY, 0usize); words + 1]; lines + 1];
    best[0][0] = (0.0, 0);
    for k in 1..lines {
        for w in 1..words {
            for from in 0..w {
                let prev = best[k - 1][from].0;
                if !prev.is_finite() {
                    continue;
                }
                let line = width(from, w - 1);
                if line > max {
                    continue;
                }
                let cost = prev + (max - line).powi(2);
                if cost < best[k][w].0 {
                    best[k][w] = (cost, from);
                }
            }
        }
    }
    let mut pick = (f32::INFINITY, 0usize);
    for (from, &(prev, _)) in best[lines - 1]
        .iter()
        .enumerate()
        .take(words.saturating_sub(1))
    {
        if prev.is_finite() && width(from, words - 1) <= max && prev < pick.0 {
            pick = (prev, from);
        }
    }
    if !pick.0.is_finite() {
        return text.to_owned();
    }
    let mut out = text.as_bytes().to_vec();
    let (mut k, mut from) = (lines - 1, pick.1);
    while k > 0 {
        out[breaks[from - 1]] = b'\n';
        from = best[k][from].1;
        k -= 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_owned())
}

/// The greeting's state sentence, assembled as tone-tagged segments like `HomeGreeting.vue`.
struct Message {
    text: String,
    spans: Vec<Span>,
    ink: Color,
}

impl Message {
    fn new(ink: Color) -> Self {
        Self {
            text: String::new(),
            spans: Vec::new(),
            ink,
        }
    }

    fn push(&mut self, value: &str, tone: &str) {
        let start = self.text.len();
        self.text.push_str(value);
        let mut span = Span::new(start, self.text.len());
        if tone == "ink" {
            span = span.color(self.ink);
        }
        if tone == "num" || tone == "add" || tone == "del" {
            span = span.mono().size(26.0).weight(700.0).color(match tone {
                "add" => rune::color::hex("#059669").unwrap(),
                "del" => rune::color::hex("#e11d48").unwrap(),
                _ => self.ink,
            });
        }
        self.spans.push(span);
    }

    /// Blank room `width` points wide, made of no-break spaces so it never wraps away from the
    /// name: whole spaces at the body size, then one sized to the remainder.
    fn gap(&mut self, width: f32) {
        let at = |size: f32| {
            rune::text::advance(
                "\u{a0}",
                TextStyle::new(size, 400.0).tracking(BODY_TRACKING),
            )
        };
        let full = at(30.0);
        let (lo, hi) = (at(10.0), full);
        let slope = (hi - lo) / 20.0;
        let mut whole = (width / full).floor() as usize;
        let mut rest = width - whole as f32 * full;
        if rest < lo && whole > 0 {
            whole -= 1;
            rest += full;
        }
        if whole > 0 {
            self.push(&"\u{a0}".repeat(whole), "muted");
        }
        if rest > 0.01 {
            let size = 10.0 + (rest - lo) / slope;
            let start = self.text.len();
            self.text.push('\u{a0}');
            self.spans
                .push(Span::new(start, self.text.len()).size(size));
        }
    }
}

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let t = Palette::new(cx.system_dark());
    let name = s
        .selected_project
        .and_then(|i| s.projects.get(i))
        .map(|p| p.name.as_str())
        .unwrap_or("");
    let elapsed = if cx.is_reduced_motion() || !s.start_actions.live {
        10.0
    } else {
        s.start_actions
            .mounted
            .map_or(0.0, |at| (s.start_actions.clock - at) as f32)
    };
    let progress = |duration: f32| {
        super::start_motion::bezier([0.22, 1.0, 0.36, 1.0], (elapsed / duration).clamp(0.0, 1.0))
    };
    let now = Curve::tween(0.0001, Easing::cubic(0.0, 0.0, 1.0, 1.0));
    let back_in = progress(0.3);
    let nav_in = progress(0.42);
    let avatar_in = progress(0.35);
    let ease = Easing::cubic(0.22, 1.0, 0.36, 1.0);
    let nav = row()
        .opacity(nav_in)
        .opacity_motion(now)
        .offset(0.0, -8.0 * (1.0 - nav_in))
        .offset_motion(now)
        .h(30.0)
        .center_y()
        .child(
            el().w(84.0)
                .h(24.0)
                .center()
                .radius(20.0)
                .fill(mix_srgb(t.ground, t.ink, 0.065))
                .role("button")
                .label("Overview")
                .focusable(true)
                .no_focus_ring()
                .child(
                    text("Overview")
                        .font(TextStyle::new(12.5, 400.0).tracking(-0.1))
                        .color(t.ink),
                ),
        )
        .child(
            el().w(84.0).h(30.0).center().child(
                text("Git")
                    .font(TextStyle::new(12.5, 400.0).tracking(-0.1))
                    .color(t.muted.alpha(0.4)),
            ),
        );
    let [dx, dy] = s.start_actions.offsets[0];
    let active = s.start_actions.active[0];
    let back = el()
        .key("overview-back-anchor")
        .size(18.0, 18.0)
        .opacity(back_in)
        .opacity_motion(now)
        .offset(-6.0 * (1.0 - back_in), 0.0)
        .offset_motion(now)
        .on_layout(|s: &mut AppState, bounds| s.start_actions.bounds[0] = bounds)
        .child(
            el().key("overview-back")
                .size(18.0, 18.0)
                .offset(
                    if cx.is_reduced_motion() { 0.0 } else { dx },
                    if cx.is_reduced_motion() { 0.0 } else { dy },
                )
                .offset_motion(Curve::tween(if active { 0.35 } else { 0.6 }, ease))
                .role("button")
                .label("Back to projects")
                .focusable(true)
                .no_focus_ring()
                .hover_group_focus()
                .cursor(Cursor::Pointer)
                .child(
                    icon(&BACK, 18.0)
                        .color(t.muted.alpha(0.7))
                        .group_color(t.ink),
                )
                .on_press(|s: &mut AppState| {
                    s.refresh_project_list();
                    s.page = if s.projects.is_empty() {
                        Page::Empty
                    } else {
                        Page::Projects
                    };
                }),
        );
    let mut avatar = el()
        .w(84.0)
        .h(30.0)
        .justify_end()
        .opacity(progress(0.3))
        .opacity_motion(now)
        .offset(0.0, -6.0 * (1.0 - avatar_in))
        .offset_motion(now);
    if let Some(name) = &s.profile.name {
        avatar = avatar.child(
            el().key("overview-profile")
                .size(30.0, 30.0)
                .radius(15.0)
                .center()
                .fill(t.ink)
                .scale(if s.profile_hover { 1.06 } else { 1.0 })
                .scale_motion(Curve::tween(0.35, ease))
                .role("button")
                .label(format!("Open profile — {name}"))
                .focusable(true)
                .focus_ring(2.0, 2.0, t.ink.alpha(0.26))
                .cursor(Cursor::Pointer)
                .help(name.clone())
                .on_hover_change(|s: &mut AppState, over, _| s.profile_hover = over)
                .child(
                    text(s.profile.initial.clone())
                        .font(TextStyle::new(13.0, 400.0).lh(13.0))
                        .color(t.ground),
                ),
        );
    }
    let top = row()
        .w_full()
        .h(52.0)
        .px(32.0)
        .pt(20.0)
        .child(el().w(84.0).child(back))
        .child(el().grow(1.0).center().child(nav))
        .child(avatar);
    let overview = &s.project_data.overview;
    let tree = &overview["workingTree"];
    let loaded = !overview.is_null();
    let repo = !overview["repository"].is_null() || !tree.is_null();
    let changes = tree["changes"].as_array();
    let count = changes.map_or(0, Vec::len);
    let clean = count == 0;
    let branch = tree["branch"].as_str().unwrap_or("");
    let body_style = TextStyle::new(30.0, 400.0).lh(38.5).tracking(BODY_TRACKING);
    // The trigger is an inline-block (`margin: 0 -4px; padding: 1px 5px`) holding "{name} " and
    // the 15 px chevron 3 px after it, so the name sits 1 px in and the sentence resumes 1 px
    // past the chevron.
    let name_space_w = rune::text::advance(&format!("{name} "), body_style);
    let name_w = rune::text::advance(name, body_style);
    let mut m = Message::new(t.ink);
    m.gap(1.0);
    m.push(name, "ink");
    m.gap(name_space_w - name_w + 3.0 + 15.0 + 1.0);
    let staged = changes.map_or(0, |c| {
        c.iter()
            .filter(|v| v["staged"].as_bool().unwrap_or(false))
            .count()
    });
    let added: i64 = changes.map_or(0, |c| {
        c.iter().map(|v| v["added"].as_i64().unwrap_or(0)).sum()
    });
    let removed: i64 = changes.map_or(0, |c| {
        c.iter().map(|v| v["removed"].as_i64().unwrap_or(0)).sum()
    });
    let ahead = tree["ahead"].as_i64().unwrap_or(0);
    let behind = tree["behind"].as_i64().unwrap_or(0);
    let plural = |singular, one, many| if singular { one } else { many };
    if !loaded {
    } else if !repo {
        m.push(
            " isn't a git repository yet. Initialize a repo to track changes, then start your first session", "muted");
    } else if !tree.is_null() && tree["head"].is_null() {
        if clean {
            m.push(
                " is a fresh repository. Nothing committed yet — your first changes will show up here", "muted");
        } else {
            m.push(" is ready for its first commit. ", "muted");
            if staged > 0 {
                m.push(&staged.to_string(), "num");
                m.push(" of ", "muted");
            }
            m.push(&count.to_string(), "num");
            m.push(plural(count == 1, " file", " files"), "muted");
            m.push(
                if staged > 0 {
                    " staged — commit when you're ready"
                } else {
                    " to stage for your first commit"
                },
                "muted",
            );
        }
    } else if clean {
        m.push(" is ready when you are. ", "muted");
        if ahead > 0 && behind > 0 {
            m.push("Working tree clean — ", "muted");
            m.push(&ahead.to_string(), "num");
            m.push(" ahead, ", "muted");
            m.push(&behind.to_string(), "num");
            m.push(" behind", "muted");
        } else if ahead > 0 {
            m.push("Working tree clean — you're ", "muted");
            m.push(&ahead.to_string(), "num");
            m.push(
                plural(ahead == 1, " commit ahead", " commits ahead"),
                "muted",
            );
        } else if behind > 0 {
            m.push("Working tree clean — ", "muted");
            m.push(&behind.to_string(), "num");
            m.push(
                plural(behind == 1, " commit behind", " commits behind"),
                "muted",
            );
        } else {
            m.push("No changes — everything's committed", "muted");
        }
        if !branch.is_empty() {
            m.push(" on ", "muted");
            m.push(branch, "num");
        }
        if behind > 0 && ahead == 0 {
            m.push(", pull when you're ready", "muted");
        }
    } else {
        m.push(" has ", "muted");
        m.push(&count.to_string(), "num");
        m.push(
            plural(
                count == 1,
                " file with changes. You have ",
                " files with changes. You have ",
            ),
            "muted",
        );
        if added > 0 || removed > 0 {
            if added > 0 {
                m.push(&format!("+{added}"), "add");
            }
            if added > 0 && removed > 0 {
                m.push(" ", "muted");
            }
            if removed > 0 {
                m.push(&format!("−{removed}"), "del");
            }
            m.push(" uncommitted", "muted");
        } else {
            m.push(&count.to_string(), "num");
            m.push(
                plural(count == 1, " uncommitted change", " uncommitted changes"),
                "muted",
            );
        }
        if count > 0 {
            if staged == count {
                m.push(", all staged", "muted");
            } else if staged > 0 {
                m.push(", ", "muted");
                m.push(&staged.to_string(), "num");
                m.push(" staged", "muted");
            } else {
                m.push(" — nothing staged yet", "muted");
            }
        }
    }
    let wrapped = pretty_wrap(&m.text, &m.spans, body_style, 620.0);
    let mut hello = row().center_y().gap(10.0).child(
        text("Hey,")
            .font(TextStyle::new(30.0, 400.0).lh(33.0).tracking(HEY_TRACKING))
            .color(t.ink_soft),
    );
    if let Some(profile) = &s.profile.name {
        hello = hello
            .child(
                el().size(30.0, 30.0)
                    .radius(15.0)
                    .fill(t.ink)
                    .center()
                    .child(
                        text(s.profile.initial.clone())
                            .font(TextStyle::new(14.0, 400.0))
                            .color(t.ground),
                    ),
            )
            .child(
                text(profile.clone())
                    .font(TextStyle::new(30.0, 400.0).lh(33.0).tracking(HEY_TRACKING))
                    .color(t.ink),
            );
    } else {
        hello = hello.child(
            text("there")
                .font(TextStyle::new(30.0, 400.0).lh(33.0).tracking(HEY_TRACKING))
                .color(t.ink),
        );
    }
    let greet_in = super::start_motion::bezier(
        [0.22, 1.0, 0.36, 1.0],
        ((elapsed - 0.03) / 0.4).clamp(0.0, 1.0),
    );
    let css_ease = Easing::cubic(0.25, 0.1, 0.25, 1.0);
    let trigger = el()
        .key("overview-project-trigger")
        .absolute(-4.0, 35.0)
        .size(5.0 + name_space_w + 3.0 + 15.0 + 5.0, 39.5)
        .radius(9.0)
        .hover(t.ink.alpha(0.06))
        .hover_motion(Curve::tween(0.18, css_ease), Curve::tween(0.18, css_ease))
        .hover_group()
        .on_hover_change(|s: &mut AppState, over, _| s.overview_name_hover = over)
        .role("button")
        .label(format!("Switch project — {name}"))
        .focusable(true)
        .focus_ring(2.0, 1.0, t.ink.alpha(0.26))
        .cursor(Cursor::Pointer)
        .on_press(|s: &mut AppState| s.overview_switcher_open = !s.overview_switcher_open)
        .child(
            icon(&CHEVRON, 15.0)
                .absolute(5.0 + name_space_w + 3.0, 13.05)
                .color(t.ink_soft)
                .group_color(t.ink)
                .offset(0.0, if s.overview_name_hover { 1.0 } else { 0.0 })
                .offset_motion(Curve::tween(0.2, css_ease)),
        );
    let greeting = col()
        .gap(2.0)
        .grow(1.0)
        .max_w(620.0)
        .opacity(greet_in)
        .opacity_motion(now)
        .offset(0.0, 10.0 * (1.0 - greet_in))
        .offset_motion(now)
        .child(hello)
        .child(
            // Chromium sets these 30 px lines (`line-height: 1.25`) with the trigger's 1 px of
            // padding raising the first line box: baselines land 39 px then 37 px apart. A
            // 38.5 px pitch nudged down half a point keeps every line within a point of them.
            text(wrapped.clone())
                .spans(m.spans.clone())
                .font(body_style)
                .color(t.ink_soft)
                .wrap()
                .pt(0.5),
        )
        .child(trigger);
    let mut picker = None;
    if s.overview_switcher_open {
        let band = mix_srgb(t.ground, t.ink, 0.02);
        let mut list = col()
            .w_full()
            .padding(4.0)
            .gap(2.0)
            .radius(18.0)
            .fill(t.raised);
        let mut projects: Vec<_> = s
            .projects
            .iter()
            .enumerate()
            .filter(|(i, _)| Some(*i) != s.selected_project)
            .collect();
        projects.sort_by_key(|(_, p)| {
            let meta = s.project_data.metadata.get(&p.path);
            (
                std::cmp::Reverse(meta.is_some_and(|m| m.pinned)),
                std::cmp::Reverse(meta.map_or(0, |m| m.last_opened_at)),
            )
        });
        let has_projects = !projects.is_empty();
        for (_, project) in projects {
            let path = project.path.clone();
            let branch = s
                .project_data
                .summaries
                .get(&path)
                .and_then(|v| v["branch"].as_str())
                .unwrap_or("")
                .to_owned();
            list = list.child(
                row()
                    .w_full()
                    .h(30.0)
                    .px(9.0)
                    .gap(7.0)
                    .center_y()
                    .radius(9.0)
                    .hover(t.hover)
                    .cursor(Cursor::Pointer)
                    .role("button")
                    .focusable(true)
                    .label(project.name.clone())
                    .child(icon(&PICKER_FOLDER, 15.0).color(t.muted))
                    .child(
                        text(project.name.clone())
                            .font(TextStyle::new(13.0, 400.0))
                            .color(t.ink)
                            .truncate(),
                    )
                    .child(
                        text(branch)
                            .font(TextStyle::new(10.0, 400.0).mono())
                            .color(t.muted)
                            .truncate(),
                    )
                    .on_press(move |s: &mut AppState| {
                        s.overview_switcher_open = false;
                        s.open_project(path.clone());
                    }),
            );
        }
        let mut actions = col().w_full().padding(4.0).radius(18.0).fill(t.raised);
        for (symbol, label, mode) in [
            (
                "+",
                "Create a new project",
                crate::launcher::LauncherMode::Create,
            ),
            (
                "▱",
                "Open from local folder",
                crate::launcher::LauncherMode::Open,
            ),
            (
                "◉",
                "Clone from GitHub",
                crate::launcher::LauncherMode::Clone,
            ),
        ] {
            actions = actions.child(
                row()
                    .w_full()
                    .h(30.0)
                    .px(9.0)
                    .gap(9.0)
                    .center_y()
                    .radius(9.0)
                    .hover(t.hover)
                    .cursor(Cursor::Pointer)
                    .role("button")
                    .focusable(true)
                    .label(label)
                    .child(
                        text(symbol)
                            .font(TextStyle::new(16.0, 400.0))
                            .color(t.ink_soft),
                    )
                    .child(text(label).font(TextStyle::new(12.5, 400.0)).color(t.ink))
                    .on_press_tx(move |s: &mut AppState, tx| {
                        if mode == crate::launcher::LauncherMode::Open {
                            crate::launcher::open_folder(s, tx);
                        } else {
                            s.launcher.open(mode);
                        }
                    }),
            );
        }
        actions = actions.child(
            row()
                .w_full()
                .h(30.0)
                .px(9.0)
                .gap(9.0)
                .center_y()
                .radius(9.0)
                .hover(t.hover)
                .cursor(Cursor::Pointer)
                .role("button")
                .focusable(true)
                .label("All projects")
                .child(
                    text("←")
                        .font(TextStyle::new(16.0, 400.0))
                        .color(t.ink_soft),
                )
                .child(
                    text("All projects")
                        .font(TextStyle::new(12.5, 400.0))
                        .color(t.ink),
                )
                .on_press(|s: &mut AppState| {
                    s.overview_switcher_open = false;
                    s.refresh_project_list();
                    s.page = Page::Projects;
                }),
        );
        let mut menu = col()
            .w(300.0)
            .gap(5.0)
            .pb(1.0)
            .px(1.0)
            .radius(20.0)
            .fill(band)
            .border(1.0, t.line)
            .shadow(0.0, 16.0, t.ink.alpha(0.2));
        menu = menu.child(
            row()
                .w_full()
                .h(34.0)
                .px(12.0)
                .center_y()
                .justify_between()
                .child(
                    text("Switch project")
                        .font(TextStyle::new(12.5, 400.0))
                        .color(t.ink_soft),
                )
                .child(
                    el().cursor(Cursor::Pointer)
                        .role("button")
                        .focusable(true)
                        .label("Cancel")
                        .child(
                            text("Cancel")
                                .font(TextStyle::new(13.0, 400.0))
                                .color(t.muted),
                        )
                        .on_press(|s: &mut AppState| s.overview_switcher_open = false),
                ),
        );
        if has_projects {
            menu = menu.child(list);
        }
        picker = Some(menu.child(actions));
    }
    let mut changes_panel = col().w_full().gap(20.0);
    if loaded {
        let label = if !repo {
            "Not a git repository"
        } else if clean {
            "Working tree clean"
        } else {
            "Changes"
        };
        let caption = if !repo {
            "NOT TRACKED"
        } else if clean {
            "ALL CLEAR"
        } else {
            "WORKING TREE"
        };
        changes_panel = changes_panel.child(
            row()
                .w_full()
                .justify_between()
                .center_y()
                .child(text(label).font(TextStyle::new(12.0, 500.0)).color(t.muted))
                .child(
                    text(caption)
                        .font(
                            TextStyle::new(10.0, 500.0)
                                .family(rune::Family::Mono)
                                .tracking(1.2),
                        )
                        .color(t.faint),
                ),
        );
        if !repo || clean {
            let paper = el()
                .size(76.0, 92.0)
                .radius(12.0)
                .border(1.0, t.line)
                .fill(t.raised_high)
                .shadow(0.0, 3.0, t.line)
                .center()
                .child(el().size(14.0, 6.0).radius(3.0).fill(t.hover));
            changes_panel = changes_panel.child(
                col()
                    .w_full()
                    .h(230.0)
                    .center()
                    .gap(24.0)
                    .child(paper)
                    .child(
                        text(if repo {
                            "Working tree clean"
                        } else {
                            "Not tracked yet"
                        })
                        .font(TextStyle::new(14.0, 400.0))
                        .color(t.ink_soft),
                    ),
            );
        } else if let Some(changes) = changes {
            let mut cards = row().gap(12.0);
            for change in changes.iter().take(4) {
                let path = change["path"].as_str().unwrap_or("");
                cards = cards.child(
                    col()
                        .w(150.0)
                        .h(116.0)
                        .padding(14.0)
                        .gap(12.0)
                        .radius(12.0)
                        .border(1.0, t.line)
                        .fill(t.raised_high)
                        .child(
                            text(path.to_owned())
                                .font(TextStyle::new(12.0, 500.0))
                                .color(t.ink)
                                .truncate(),
                        ),
                );
            }
            changes_panel = changes_panel.child(cards);
        }
    }
    let mut dock = row().gap(40.0).center_y();
    for (i, path) in s.cycle_paths.iter().enumerate() {
        if let Some(project) = s.projects.iter().find(|p| &p.path == path) {
            let tree = s
                .project_data
                .summaries
                .get(path)
                .unwrap_or(&serde_json::Value::Null);
            dock = dock.child(
                folder_with_git(&project.name, t, tree)
                    .opacity(if i == s.cycle_index { 1.0 } else { 0.55 })
                    .offset(0.0, if i == s.cycle_index { -10.0 } else { 0.0 }),
            );
        }
    }
    let dock = el()
        .pin(Some(0.0), None, Some(0.0), Some(0.0))
        .h(180.0)
        .fill(t.ground)
        .center()
        .child(dock);
    let root = col()
        .w_full()
        .h_full()
        .fill(t.ground)
        .apply_start_pointer(cx.is_reduced_motion())
        .child(top)
        .child(
            row().w_full().justify_center().pt(44.0).px(64.0).child(
                col()
                    .w(896.0)
                    .gap(44.0)
                    .child(
                        row()
                            .w_full()
                            .justify_between()
                            .gap(32.0)
                            .child(greeting)
                            .child(folder_with_git(name, t, tree)),
                    )
                    .child(changes_panel)
                    .child(sessions(s, &s.project_data.sessions, t, false)),
            ),
        );
    let root = if let Some(menu) = picker {
        let menu_top = 100.0
            + 33.0
            + 2.0
            + rune::text::measure(&wrapped, &m.spans, body_style, Some(620.0)).1
            + 8.0;
        root.child(
            el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .on_press(|s: &mut AppState| s.overview_switcher_open = false),
        )
        .child(
            row()
                .pin(Some(0.0), Some(menu_top), Some(0.0), None)
                .justify_center()
                .child(el().w(896.0).child(menu)),
        )
    } else {
        root
    };
    if s.cycle_paths.is_empty() {
        root
    } else {
        root.child(dock)
    }
}

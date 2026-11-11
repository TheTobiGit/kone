use super::empty::BACK;

use super::empty::StartPointer;
use super::projects::{folder_with_git, folder_with_git_hover, session_head, sessions};
use crate::{
    state::{AppState, Page},
    theme::{Palette, mix_srgb},
};
use rune::{
    Color, Cursor, Curve, Cx, Easing, El, Icon, ScrollSpec, Span, TextStyle, col, el, icon, row,
    text,
};

/// `.line--body { letter-spacing: -0.02em }` resolves against the paragraph's own 16 px, not
/// the 30 px spans inside it.
const BODY_TRACKING: f32 = -0.32;
/// `.line--hey { letter-spacing: -0.01em }`, likewise against 16 px.
const HEY_TRACKING: f32 = -0.16;

/// Hugeicons `ArrowDown01Icon`, drawn at 15 px with a 2.2 stroke beside the project name.
static PICKER_FOLDER: Icon = Icon {
    name: "picker-folder",
    view: 24.0,
    body: r#"<path d="M8 7H16.75C18.8567 7 19.91 7 20.6667 7.50559C20.9943 7.72447 21.2755 8.00572 21.4944 8.33329C22 9.08996 22 10.1433 22 12.25C22 15.7612 22 17.5167 21.1573 18.7779C20.7926 19.3238 20.3238 19.7926 19.7779 20.1573C18.5167 21 16.7612 21 13.25 21H12C7.28595 21 4.92893 21 3.46447 19.5355C2 18.0711 2 15.714 2 11V7.94427C2 6.1278 2 5.21956 2.38032 4.53806C2.65142 4.05227 3.05227 3.65142 3.53806 3.38032C4.21956 3 5.1278 3 6.94427 3C8.10802 3 8.6899 3 9.19926 3.19101C10.3622 3.62712 10.8418 4.68358 11.3666 5.73313L12 7" stroke="currentColor" stroke-linecap="round" fill="none" stroke-width="1.7"/>"#,
};

static PICKER_PLUS: Icon = Icon {
    name: "picker-plus",
    view: 24.0,
    body: r#"<path d="M12 4V20M20 12H4" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" fill="none" stroke-width="1.7"/>"#,
};
static PICKER_OPEN: Icon = Icon {
    name: "picker-open",
    view: 24.0,
    body: r#"<path d="M2.5 20V8.87695C2.5 7.58945 2.5 6.9457 2.78533 6.47048C2.9541 6.18939 3.18939 5.9541 3.47048 5.78533C3.9457 5.5 4.59449 5.5 5.89206 5.5C6.52339 5.5 6.83906 5.5 7.12612 5.58819C7.31759 5.64702 7.49914 5.73428 7.66469 5.84705C7.91289 6.01611 8.10859 6.26074 8.5 6.75C8.89141 7.23926 9.08711 7.48389 9.33531 7.65295C9.50086 7.76572 9.68241 7.85298 9.87388 7.91181C10.1609 8 10.4742 8 11.1008 8H15C16.4045 8 17.1067 8 17.6111 8.33706C17.8295 8.48298 18.017 8.67048 18.1629 8.88886C18.5 9.39331 18.5 10.0955 18.5 11.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" fill="none" stroke-width="1.7"/><path d="M4.42028 14.0144L3.63368 16.0144C2.65618 18.4998 2.16743 19.7425 2.7524 20.6213C3.33737 21.5 4.65337 21.5 7.28537 21.5H15.1903C16.4249 21.5 17.0422 21.5 17.5295 21.1795C18.0169 20.859 18.2702 20.2865 18.7769 19.1415L19.6618 17.1415C20.7866 14.5992 21.349 13.3281 20.7679 12.4141C20.1868 11.5 18.8163 11.5 16.0752 11.5H8.07196C6.78232 11.5 6.1375 11.5 5.63811 11.8439C5.13872 12.1877 4.89924 12.7966 4.42028 14.0144Z" stroke="currentColor" fill="none" stroke-width="1.7"/><path d="M11.5 4.51456C12.4151 3.28409 13.6662 2.55594 15.5125 2.50161C16.1155 2.48386 16.7152 2.61395 17.2682 2.85544C18.5748 3.42601 19.4185 4.15644 20 5.5L21.5 3" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" fill="none" stroke-width="1.7"/>"#,
};
static PICKER_GITHUB: Icon = Icon {
    name: "picker-github",
    view: 24.0,
    body: r#"<path d="M10 20.5675C6.57143 21.7248 3.71429 20.5675 2 17" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" fill="none" stroke-width="1.7"/><path d="M10 22V18.7579C10 18.1596 10.1839 17.6396 10.4804 17.1699C10.6838 16.8476 10.5445 16.3904 10.1771 16.2894C7.13394 15.4528 5 14.1077 5 9.64606C5 8.48611 5.38005 7.39556 6.04811 6.4464C6.21437 6.21018 6.29749 6.09208 6.31748 5.9851C6.33746 5.87813 6.30272 5.73852 6.23322 5.45932C5.95038 4.32292 5.96871 3.11619 6.39322 2.02823C6.39322 2.02823 7.27042 1.74242 9.26698 2.98969C9.72282 3.27447 9.95075 3.41686 10.1515 3.44871C10.3522 3.48056 10.6206 3.41384 11.1573 3.28041C11.8913 3.09795 12.6476 3 13.5 3C14.3524 3 15.1087 3.09795 15.8427 3.28041C16.3794 3.41384 16.6478 3.48056 16.8485 3.44871C17.0493 3.41686 17.2772 3.27447 17.733 2.98969C19.7296 1.74242 20.6068 2.02823 20.6068 2.02823C21.0313 3.11619 21.0496 4.32292 20.7668 5.45932C20.6973 5.73852 20.6625 5.87813 20.6825 5.9851C20.7025 6.09207 20.7856 6.21019 20.9519 6.4464C21.6199 7.39556 22 8.48611 22 9.64606C22 14.1077 19.8661 15.4528 16.8229 16.2894C16.4555 16.3904 16.3162 16.8476 16.5196 17.1699C16.8161 17.6396 17 18.1596 17 18.7579V22" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" fill="none" stroke-width="1.7"/>"#,
};
static PICKER_ARROW: Icon = Icon {
    name: "picker-arrow",
    view: 24.0,
    body: r#"<path d="M9.00005 6C9.00005 6 15 10.4189 15 12C15 13.5812 9 18 9 18" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" fill="none" stroke-width="2"/>"#,
};

static PICKER_BRANCH: Icon = Icon {
    name: "picker-branch",
    view: 24.0,
    body: r#"<path d="M7 19H13C15.8284 19 17.2426 19 18.1213 18.1213C19 17.2426 19 15.8284 19 13V10M19 10C19.7002 10 21.0085 11.9943 21.5 12.5M19 10C18.2998 10 16.9915 11.9943 16.5 12.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" fill="none" stroke-width="1.8"/><path d="M5 7L5 17" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" fill="none" stroke-width="1.8"/><circle cx="5" cy="5" r="2" stroke="currentColor" fill="none" stroke-width="1.8"/><circle cx="19" cy="5" r="2" stroke="currentColor" fill="none" stroke-width="1.8"/><circle cx="5" cy="19" r="2" stroke="currentColor" fill="none" stroke-width="1.8"/>"#,
};

static CHEVRON: Icon = Icon {
    name: "overview-project-chevron",
    view: 24.0,
    body: r#"<path d="M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static FOLDER_BRANCH: Icon = Icon {
    name: "overview-folder-branch",
    view: 24.0,
    body: r#"<circle cx="6" cy="18" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="18" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M6 15V3m12 6a9 9 0 0 1-9 9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>"#,
};
static FOLDER_FINDER: Icon = Icon {
    name: "overview-folder-finder",
    view: 24.0,
    body: r#"<path d="M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12ZM12.9896 2.5C12.1238 3.78525 10.5163 7.71349 10.0737 11.5798C9.98097 12.3899 9.9346 12.795 10.1905 13.1176C10.2151 13.1486 10.2474 13.1843 10.2757 13.212C10.5708 13.5 11.0149 13.5 11.9031 13.5C12.3889 13.5 12.6317 13.5 12.7766 13.6314C12.7923 13.6457 12.8051 13.6588 12.819 13.6748C12.9468 13.8225 12.9383 14.072 12.9212 14.5709C12.8685 16.1156 12.9401 19.0524 14 21.5M7 8v2m10-2v2M7 16.5C10.5 18.5 13.5 18.5 17 16.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

fn overview_folder(
    s: &AppState,
    name: &str,
    tree: &serde_json::Value,
    repo: bool,
    t: Palette,
    inline: bool,
    elapsed: f32,
) -> El {
    let over = s.overview_folder_hover;
    let scale = if inline { 0.95 } else { 1.15 };
    let size = if inline { 14.0 } else { 15.0 };
    let path = s
        .selected_project
        .and_then(|i| s.projects.get(i))
        .map(|p| p.path.clone())
        .unwrap_or_default();
    let action = |label: &'static str, glyph: &'static Icon| {
        row()
            .center_y()
            .gap(7.0)
            .cursor(Cursor::Pointer)
            .hover_group()
            .child(icon(glyph, size).color(t.muted).group_color(t.ink))
            .child(
                text(label)
                    .font(TextStyle::new(12.5, 400.0).tracking(-0.125))
                    .color(t.muted)
                    .group_color(t.ink),
            )
    };
    let finder = action("Open in Finder", &FOLDER_FINDER)
        .role("button")
        .label("Reveal in Finder")
        .focusable(true)
        .on_press(move |s: &mut AppState| s.reveal_project(path.clone()));
    let actions = if inline {
        let mut a = row().gap(14.0).center_y();
        if repo {
            a = a.child(
                action("Switch branch", &FOLDER_BRANCH)
                    .role("button")
                    .label("Switch branch")
                    .focusable(true),
            );
        }
        a.child(finder)
    } else {
        let mut a = col().gap(9.0);
        if repo {
            a = a.child(
                action("Switch branch", &FOLDER_BRANCH)
                    .role("button")
                    .label("Switch branch")
                    .focusable(true),
            );
        }
        a.child(finder)
    }
    .hover_group_focus()
    .on_hover_focus_change(|s: &mut AppState, active, _| s.overview_folder_actions_focus = active)
    .opacity(if over || s.overview_folder_actions_focus {
        1.0
    } else {
        0.001
    })
    .opacity_motion(Curve::tween(0.2, Easing::cubic(0.25, 0.1, 0.25, 1.0)));
    let tile = el()
        .size(200.0 * scale, 116.0 * scale)
        .cursor(Cursor::Pointer)
        .child(
            folder_with_git_hover(name, t, tree, over)
                .origin(0.0, 0.0)
                .scale(scale)
                .offset(0.0, if over { -3.0 } else { 0.0 })
                .offset_motion(Curve::tween(0.35, Easing::cubic(0.22, 1.0, 0.36, 1.0))),
        );
    let progress = if inline {
        super::start_motion::bezier(
            [0.22, 1.0, 0.36, 1.0],
            ((elapsed - 0.12) / 0.4).clamp(0.0, 1.0),
        )
    } else {
        let x = (elapsed - 0.33).max(0.0);
        let d = 24.0_f32 / 1.8;
        let w = (260.0_f32 / 0.9 - d * d).sqrt();
        if elapsed < 0.33 {
            0.0
        } else {
            1.0 - (-d * x).exp() * ((w * x).cos() + d / w * (w * x).sin())
        }
    };
    let mut content = col()
        .key("overview-folder")
        .gap(if inline { 10.0 } else { 24.0 })
        .on_hover_change(|s: &mut AppState, over, _| s.overview_folder_hover = over)
        .opacity(progress.clamp(0.0, 1.0))
        .offset(0.0, (if inline { 10.0 } else { 44.0 }) * (1.0 - progress))
        .scale((if inline { 0.97 } else { 0.94 }) + (if inline { 0.03 } else { 0.06 }) * progress);
    if inline {
        if s.overview_viewport.0 > 860.0 {
            content = content.items_end();
        }
        content = content.child(tile).child(actions);
    } else {
        content = content.items_center().child(actions).child(tile);
    }
    content
}

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

trait WordRanges {
    fn split_word_ranges(&self, offset: usize) -> Vec<std::ops::Range<usize>>;
}
impl WordRanges for str {
    fn split_word_ranges(&self, offset: usize) -> Vec<std::ops::Range<usize>> {
        let mut result = Vec::new();
        let mut start = None;
        for (i, ch) in self.char_indices() {
            if ch.is_whitespace() {
                if let Some(from) = start.take() {
                    result.push(offset + from..offset + i);
                }
            } else if start.is_none() {
                start = Some(i);
            }
        }
        if let Some(from) = start {
            result.push(offset + from..offset + self.len());
        }
        result
    }
}

#[derive(Default)]
pub(crate) struct GreetingMotion {
    project: String,
    last_elapsed: f32,
    segments: std::collections::HashMap<String, (f64, usize)>,
}

/// The greeting's state sentence, assembled as tone-tagged segments like `HomeGreeting.vue`.
struct Message {
    text: String,
    spans: Vec<Span>,
    ink: Color,
    segments: Vec<(String, usize, usize)>,
}

impl Message {
    fn new(ink: Color) -> Self {
        Self {
            text: String::new(),
            spans: Vec::new(),
            ink,
            segments: Vec::new(),
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
        self.segments
            .push((format!("{tone}:{value}"), start, self.text.len()));
    }

    /// Blank room `width` points wide, made of no-break spaces so it never wraps away from the
    /// name: whole spaces at the body size, then one sized to the remainder.
    fn gap(&mut self, width: f32) {
        let segment_count = self.segments.len();
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
        self.segments.truncate(segment_count);
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
                text("Space")
                    .font(TextStyle::new(12.5, 400.0).tracking(-0.1))
                    .color(t.muted),
            ),
        )
        .child(
            el().w(84.0).h(30.0).center().child(
                text("Files")
                    .font(TextStyle::new(12.5, 400.0).tracking(-0.1))
                    .color(t.muted),
            ),
        )
        .child(
            el().w(84.0).h(30.0).center().child(
                text("Git")
                    .font(TextStyle::new(12.5, 400.0).tracking(-0.1))
                    .color(
                        if !s.project_data.overview["repository"].is_null()
                            || !s.project_data.overview["workingTree"].is_null()
                        {
                            t.muted
                        } else {
                            t.muted.alpha(0.4)
                        },
                    ),
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
    // A card mounts again after removal or a project switch, restarting CountUp.
    {
        let project = s
            .selected_project
            .and_then(|i| s.projects.get(i))
            .map_or("", |p| p.path.as_str());
        let mut state = s.card_count_starts.borrow_mut();
        if state.0 != project {
            state.0 = project.to_owned();
            state.1.clear();
        }
        state.1.retain(|key, _| {
            changes.is_some_and(|items| {
                items.iter().any(|item| {
                    format!(
                        "card:{}:{}",
                        item["path"].as_str().unwrap_or(""),
                        item["staged"]
                    ) == *key
                })
            })
        });
    }
    let count = changes.map_or(0, Vec::len);
    let clean = count == 0;
    let branch = tree["branch"].as_str().unwrap_or("");
    let body_style = TextStyle::new(30.0, 400.0).lh(37.5).tracking(BODY_TRACKING);
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
        m.push(" isn't a git repository yet", "muted");
        m.push(". ", "muted");
        m.push(
            "Initialize a repo to track changes, then start your first session",
            "muted",
        );
    } else if !tree.is_null() && tree["head"].is_null() {
        if clean {
            m.push(" is a fresh repository", "muted");
            m.push(". ", "muted");
            m.push(
                "Nothing committed yet — your first changes will show up here",
                "muted",
            );
        } else {
            m.push(" is ready for its first commit", "muted");
            m.push(". ", "muted");
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
        m.push(" is ready when you are", "muted");
        m.push(". ", "muted");
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
            plural(count == 1, " file with changes", " files with changes"),
            "muted",
        );
        m.push(". ", "muted");
        m.push("You have ", "muted");
        if added > 0 || removed > 0 {
            if added > 0 {
                m.push(&format!("+{added}"), "add");
            }
            if added > 0 && removed > 0 {
                m.push(" ", "muted");
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
    let viewport_width = if s.overview_viewport.0 > 0.0 {
        s.overview_viewport.0
    } else {
        1280.0
    };
    let content_width = (viewport_width - 128.0).clamp(0.0, 896.0);
    let greeting_width = if viewport_width > 860.0 && viewport_width <= 1440.0 {
        (content_width - 222.0).clamp(0.0, 620.0)
    } else {
        content_width.min(620.0)
    };
    let wrapped = pretty_wrap(&m.text, &m.spans, body_style, greeting_width);
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
    // Keep content-keyed segments alive across status updates. Newly introduced segments
    // start immediately; only the first page reveal carries the entrance delay.
    let clock = s.start_actions.clock;
    let mut motion = s.greeting_motion.borrow_mut();
    let initial =
        motion.project != name || motion.segments.is_empty() || elapsed < motion.last_elapsed;
    motion.last_elapsed = elapsed;
    if initial {
        motion.project = name.to_owned();
        motion.segments.clear();
    }
    let mut occurrences = std::collections::HashMap::<String, usize>::new();
    let mut active = std::collections::HashSet::new();
    let mut rank = 0usize;
    let mut words = Vec::new();
    for (base, start, end) in &m.segments {
        let occurrence = occurrences.entry(base.clone()).or_default();
        let key = format!("{base}#{}", *occurrence);
        *occurrence += 1;
        active.insert(key.clone());
        let ranges: Vec<_> = if base.starts_with("ink:") && *start <= 4 {
            std::iter::once(*start..*end).collect()
        } else {
            m.text[*start..*end].split_word_ranges(*start)
        };
        let is_new = !motion.segments.contains_key(&key);
        let entry = *motion.segments.entry(key).or_insert((
            if initial {
                clock - f64::from(elapsed) + 0.03
            } else {
                clock
            },
            rank,
        ));
        for (index, range) in ranges.into_iter().enumerate() {
            words.push((range, entry.0, entry.1 + index));
            if is_new {
                rank += 1;
            }
        }
    }
    motion.segments.retain(|key, _| active.contains(key));
    drop(motion);
    let word_progress = |at: f64, rank: usize| {
        if cx.is_reduced_motion() || !s.start_actions.live {
            return 1.0;
        }
        super::start_motion::bezier(
            [0.16, 1.0, 0.3, 1.0],
            ((clock - at - rank as f64 * 0.035) as f32 / 0.42).clamp(0.0, 1.0),
        )
    };
    let trigger_in = words
        .first()
        .map_or(1.0, |(_, at, rank)| word_progress(*at, *rank));
    let css_ease = Easing::cubic(0.25, 0.1, 0.25, 1.0);
    let trigger = el()
        .key("overview-project-trigger")
        .opacity(trigger_in)
        .opacity_motion(now)
        .offset(0.0, 6.0 * (1.0 - trigger_in))
        .offset_motion(now)
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
    let settled = words
        .iter()
        .all(|(_, at, rank)| word_progress(*at, *rank) >= 1.0);
    let mut base_spans = m.spans.clone();
    if !settled {
        base_spans.push(Span::new(0, wrapped.len()).color(t.ink_soft.alpha(0.0)));
    }
    let mut body = el().w(greeting_width).child(
        text(wrapped.clone())
            .spans(base_spans)
            .font(body_style)
            .w(greeting_width)
            .color(if settled {
                t.ink_soft
            } else {
                t.ink_soft.alpha(0.0)
            })
            .wrap()
            .pt(0.5),
    );
    for (range, at, rank) in words.into_iter().filter(|_| !settled) {
        let progress = word_progress(at, rank);
        let mut spans = m.spans.clone();
        spans.push(Span::new(0, wrapped.len()).color(t.ink_soft.alpha(0.0)));
        let color = m
            .spans
            .iter()
            .find(|span| span.start as usize <= range.start && span.end as usize >= range.end)
            .and_then(|span| span.color)
            .unwrap_or(t.ink_soft);
        spans.push(Span::new(range.start, range.end).color(color));
        body = body.child(
            text(wrapped.clone())
                .spans(spans)
                .font(body_style)
                .w(greeting_width)
                .color(t.ink_soft)
                .wrap()
                .pt(0.5)
                .absolute(0.0, 0.0)
                .opacity(progress)
                .opacity_motion(now)
                .offset(0.0, 6.0 * (1.0 - progress))
                .offset_motion(now),
        );
    }
    let greeting = col()
        .on_layout(|s: &mut AppState, bounds| s.overview_greeting_bounds = bounds)
        .gap(2.0)
        .grow(1.0)
        .max_w(620.0)
        .child(
            hello
                .opacity(greet_in)
                .opacity_motion(now)
                .offset(0.0, 10.0 * (1.0 - greet_in))
                .offset_motion(now),
        )
        .child(body)
        .child(trigger);
    let mut picker = None;
    if s.overview_switcher_open {
        let band = mix_srgb(t.ground, t.ink, 0.02);
        let mut list = col().w_full().padding(4.0).gap(2.0);
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
        let list_height =
            (projects.len() as f32 * 32.0 + 6.0).min(s.overview_viewport.1.max(1.0) * 0.35);
        for (_, project) in projects {
            let path = project.path.clone();
            let branch = s
                .project_data
                .summaries
                .get(&path)
                .and_then(|v| v["branch"].as_str())
                .unwrap_or("")
                .to_owned();
            let branch_icon = if branch.is_empty() {
                el().w(0.0)
            } else {
                icon(&PICKER_BRANCH, 11.0).color(t.muted)
            };
            list = list.child(
                row()
                    .w_full()
                    .h(30.0)
                    .px(9.0)
                    .gap(7.0)
                    .center_y()
                    .radius(9.0)
                    .hover(t.hover)
                    .focus_highlight(t.hover)
                    .hover_motion(Curve::tween(0.16, css_ease), Curve::tween(0.16, css_ease))
                    .hover_group()
                    .cursor(Cursor::Pointer)
                    .role("button")
                    .focusable(true)
                    .label(project.name.clone())
                    .child(
                        icon(&PICKER_FOLDER, 15.0)
                            .color(t.muted)
                            .group_color(t.ink_soft),
                    )
                    .child(
                        text(project.name.clone())
                            .font(TextStyle::new(13.0, 400.0))
                            .color(t.ink)
                            .truncate(),
                    )
                    .child(branch_icon)
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
        list = col()
            .w_full()
            .h(list_height)
            .radius(18.0)
            .fill(t.raised)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .child(list);
        let mut actions = col().w_full().padding(4.0).radius(18.0).fill(t.raised);
        for (symbol, label, mode) in [
            (
                &PICKER_PLUS,
                "Create a new project",
                crate::launcher::LauncherMode::Create,
            ),
            (
                &PICKER_OPEN,
                "Open from local folder",
                crate::launcher::LauncherMode::Open,
            ),
            (
                &PICKER_GITHUB,
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
                    .focus_highlight(t.hover)
                    .hover_motion(Curve::tween(0.16, css_ease), Curve::tween(0.16, css_ease))
                    .hover_group()
                    .cursor(Cursor::Pointer)
                    .role("button")
                    .focusable(true)
                    .label(label)
                    .child(icon(symbol, 16.0).color(t.ink_soft).group_color(t.ink))
                    .child(
                        el().grow(1.0)
                            .child(text(label).font(TextStyle::new(12.5, 500.0)).color(t.ink)),
                    )
                    .child(
                        icon(&PICKER_ARROW, 13.0)
                            .color(t.muted)
                            .group_opacity(0.0, 1.0),
                    )
                    .on_press_tx(move |s: &mut AppState, tx| {
                        if mode == crate::launcher::LauncherMode::Open {
                            crate::launcher::open_folder(s, tx);
                        } else {
                            s.launcher.open(mode);
                        }
                    }),
            );
        }
        let mut menu = col()
            .w(300.0)
            .gap(5.0)
            .pb(1.0)
            .px(1.0)
            .radius(20.0)
            .fill(band)
            .border(1.0, t.ink.alpha(0.08))
            .shadow(10.0, 16.0, Color::BLACK.alpha(0.16));
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
    let changes_in = super::start_motion::bezier(
        [0.22, 1.0, 0.36, 1.0],
        ((elapsed - 0.13) / 0.34).clamp(0.0, 1.0),
    );
    let sessions_in = super::start_motion::bezier(
        [0.22, 1.0, 0.36, 1.0],
        ((elapsed - 0.23) / 0.32).clamp(0.0, 1.0),
    );
    let changes_panel = changes_panel(s, tree, loaded, repo, t, content_width, elapsed)
        .opacity(changes_in)
        .offset(0.0, 9.0 * (1.0 - changes_in));
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
    let width = viewport_width;
    let inline = width <= 1440.0;
    let narrow = width <= 860.0;
    let folder = overview_folder(s, name, tree, repo, t, inline, elapsed);
    let header = if narrow {
        col().w_full().gap(20.0).child(greeting).child(folder)
    } else if inline {
        row()
            .w_full()
            .justify_between()
            .gap(32.0)
            .child(greeting)
            .child(folder)
    } else {
        row().w_full().child(greeting)
    };
    let root = col()
        .on_layout(|s: &mut AppState, [_, _, w, h]| s.overview_viewport = (w, h))
        .w_full()
        .h_full()
        .fill(t.ground)
        .apply_start_pointer(cx.is_reduced_motion())
        .child(top)
        .child(
            row()
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .justify_center()
                .pt(44.0)
                .px(64.0)
                .child({
                    s.project_data.lazy.reduced.set(cx.is_reduced_motion());
                    let scroll = s.project_data.lazy.scroll.clone();
                    let offset = scroll.get().0;
                    let pinned_count = s.project_data.sessions.iter().filter(|v| v.pinned).count();
                    let has_recent = s.project_data.sessions.iter().any(|v| !v.pinned);
                    let boundary = 34.0
                        + pinned_count as f32 * 40.0
                        + pinned_count.saturating_sub(1) as f32 * 22.0
                        + 40.0;
                    let mut viewport = el()
                        .w_full()
                        .grow(1.0)
                        .min_h(0.0)
                        .opacity(sessions_in)
                        .offset(0.0, 9.0 * (1.0 - sessions_in))
                        .child(
                            col()
                                .key("overview-sessions")
                                .w_full()
                                .h_full()
                                .scroll(ScrollSpec {
                                    stick_bottom: false,
                                })
                                .on_scroll_offset(move |at| scroll.set((at.offset[1], at.max[1])))
                                .clip_fade_linear(0.0, 0.0, 0.0, 44.0)
                                .child(sessions(s, &s.project_data.sessions, t, false).pb(24.0)),
                        );
                    if offset > 0.0 && !s.project_data.sessions.is_empty() {
                        let pinned = pinned_count > 0 && (!has_recent || offset < boundary);
                        let push = if pinned && has_recent {
                            (boundary - offset - 34.0).min(0.0)
                        } else {
                            0.0
                        };
                        viewport = viewport.child(
                            el().pin(Some(0.0), Some(push), Some(0.0), None)
                                .h(34.0)
                                .fill(t.ground)
                                .clip_fade_linear(0.0, 0.0, 0.0, 12.0)
                                .child(session_head(s, t, pinned, pinned || pinned_count == 0)),
                        );
                    }
                    col()
                        .w(content_width)
                        .h_full()
                        .gap(44.0)
                        .child(header)
                        .child(changes_panel)
                        .child(viewport)
                }),
        );
    let root = if !inline {
        root.child(
            el().pin(Some(40.0), None, None, Some(48.0))
                .child(overview_folder(s, name, tree, repo, t, false, elapsed)),
        )
    } else {
        root
    };
    let root = if let Some(menu) = picker {
        let [menu_left, menu_y, _, menu_h] = s.overview_greeting_bounds;
        let menu_top = menu_y + menu_h + 8.0;
        root.child(
            el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .on_press(|s: &mut AppState| s.overview_switcher_open = false),
        )
        .child(
            el().pin(Some(menu_left), Some(menu_top), None, None)
                .child(menu),
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

fn changes_panel(
    s: &AppState,
    tree: &serde_json::Value,
    loaded: bool,
    repo: bool,
    t: Palette,
    width: f32,
    elapsed: f32,
) -> El {
    let mut panel = col().w_full();
    if !loaded {
        return panel;
    }
    let mut changes: Vec<_> = tree["changes"].as_array().into_iter().flatten().collect();
    changes.sort_by(|a, b| {
        let time = |v: &serde_json::Value| v["modifiedAt"].as_f64().unwrap_or(f64::NEG_INFINITY);
        time(b).total_cmp(&time(a)).then_with(|| {
            a["path"]
                .as_str()
                .unwrap_or("")
                .cmp(b["path"].as_str().unwrap_or(""))
        })
    });
    if changes.is_empty() {
        let label = if repo {
            "Working tree clean"
        } else {
            "Not a git repository"
        };
        let caption = if repo { "UP TO DATE" } else { "NOT TRACKED" };
        let paper = |angle: f32| {
            el().size(76.0, 92.0)
                .radius(12.0)
                .border(1.0, t.line)
                .fill(t.raised_high)
                .rotate(angle)
                .shadow(
                    0.0,
                    4.0,
                    Color::BLACK.alpha(if t.dark { 0.08 } else { 0.04 }),
                )
        };
        return panel
            .gap(14.0)
            .child(
                row()
                    .w_full()
                    .justify_between()
                    .center_y()
                    .child(text(label).font(TextStyle::new(12.5, 400.0)).color(t.muted))
                    .child(
                        text(caption)
                            .font(
                                TextStyle::new(11.0, 400.0)
                                    .family(rune::Family::Mono)
                                    .tracking(1.5),
                            )
                            .color(t.faint),
                    ),
            )
            .child(
                col()
                    .w_full()
                    .h(236.0)
                    .center()
                    .gap(20.0)
                    .child(
                        row()
                            .center_y()
                            .child(paper(-0.157))
                            .child(paper(0.0).offset(-32.0, -5.0))
                            .child(paper(0.157).offset(-64.0, 0.0))
                            .w(180.0),
                    )
                    .child(
                        text(if repo {
                            "No changes"
                        } else {
                            "Not tracked yet"
                        })
                        .font(TextStyle::new(13.5, 400.0))
                        .color(t.ink_soft),
                    ),
            );
    }
    let staged: Vec<_> = changes
        .iter()
        .copied()
        .filter(|v| v["staged"].as_bool().unwrap_or(false))
        .collect();
    let changed: Vec<_> = changes
        .iter()
        .copied()
        .filter(|v| !v["staged"].as_bool().unwrap_or(false))
        .collect();
    let both = !staged.is_empty() && !changed.is_empty();
    panel = panel.gap(30.0);
    for (is_staged, items) in [(true, &staged), (false, &changed)] {
        if items.is_empty() {
            continue;
        }
        let path = s
            .selected_project
            .and_then(|i| s.projects.get(i))
            .map(|p| p.path.clone())
            .unwrap_or_default();
        let key = format!("{}:{}", path, is_staged);
        let open = !s.changes_folded.contains(&key);
        let hover = s.changes_hover == Some(is_staged);
        let title = if is_staged { "Staged" } else { "Changed" };
        let toggle = row()
            .center_y()
            .gap(7.0)
            .padding(2.0)
            .radius(7.0)
            .cursor(Cursor::Pointer)
            .focusable(true)
            .focus_ring(2.0, 0.0, t.ink.alpha(0.55))
            .role("button")
            .label(format!("Toggle {title}"))
            .on_press(move |s: &mut AppState| {
                s.toggle_changes(key.clone());
            })
            .child(
                text(if open { "⌄" } else { "›" })
                    .font(TextStyle::new(14.0, 400.0))
                    .color(t.faint),
            )
            .child(
                text(title)
                    .font(TextStyle::new(12.0, 400.0).tracking(0.2))
                    .color(t.ink_soft),
            )
            .child(
                text(items.len().to_string())
                    .font(TextStyle::new(11.0, 400.0).family(rune::Family::Mono))
                    .color(t.muted),
            );
        let mut lead = row().center_y().gap(10.0).child(toggle);
        if !is_staged {
            lead = lead.child(
                text("View changes")
                    .font(TextStyle::new(11.0, 400.0))
                    .color(t.muted),
            );
        }
        let mut tail = row().center_y().gap(14.0);
        if hover {
            tail = tail.child(
                text(if is_staged {
                    "−  Unstage all"
                } else {
                    "+  Stage all     ↶  Discard"
                })
                .font(TextStyle::new(11.0, 400.0))
                .color(t.muted),
            );
        }
        if is_staged {
            tail = tail.child(
                el().radius(8.0).fill(t.ink).px(11.0).py(7.0).child(
                    text("⊙  Commit")
                        .font(TextStyle::new(11.0, 400.0))
                        .color(t.ground),
                ),
            );
        } else {
            let added: i64 = changes
                .iter()
                .map(|c| c["added"].as_i64().unwrap_or(0))
                .sum();
            let removed: i64 = changes
                .iter()
                .map(|c| c["removed"].as_i64().unwrap_or(0))
                .sum();
            let mut stat = row().gap(8.0).center_y();
            if added > 0 {
                stat = stat.child(
                    text(format!("+{}", count_up(added, elapsed, 1.1)))
                        .font(TextStyle::new(12.0, 400.0).family(rune::Family::Mono))
                        .color(rune::color::hex("#059669").unwrap()),
                );
            }
            if removed > 0 {
                stat = stat.child(
                    text(format!("−{}", count_up(removed, elapsed, 1.1)))
                        .font(TextStyle::new(12.0, 400.0).family(rune::Family::Mono))
                        .color(rune::color::hex("#e11d48").unwrap()),
                );
            }
            let mut dots = row().gap(3.0);
            for c in changes.iter().take(24) {
                let a = c["added"].as_i64().unwrap_or(0);
                let d = c["removed"].as_i64().unwrap_or(0);
                let color = if c["status"] == "deleted" || d > a {
                    rune::color::hex("#e11d48").unwrap()
                } else if a > 0 {
                    rune::color::hex("#059669").unwrap()
                } else {
                    t.faint
                };
                dots = dots.child(el().size(7.0, 7.0).radius(2.0).fill(color));
            }
            tail = tail.child(stat).child(dots);
        }
        let head = row()
            .w_full()
            .justify_between()
            .center_y()
            .px(2.0)
            .child(lead)
            .child(tail);
        let mut lane = col()
            .w_full()
            .on_hover_change(move |s: &mut AppState, over, _| {
                s.changes_hover = if over { Some(is_staged) } else { None };
            })
            .child(head);
        if open {
            let cols = ((width + 14.0) / 172.0).floor().max(1.0) as usize;
            let cap = cols * if both { 1 } else { 2 };
            let visible = if items.len() > cap {
                cap.saturating_sub(1)
            } else {
                items.len()
            };
            let mut grid = col().gap(14.0).pt(15.0).pb(6.0);
            let slots = visible + usize::from(visible < items.len());
            for start in (0..slots).step_by(cols) {
                let mut r = row().gap(14.0);
                for index in start..(start + cols).min(slots) {
                    if index < visible {
                        r = r.child(change_card(items[index], t, elapsed, s));
                    } else {
                        r = r.child(change_bundle(items.len() - visible, t, s, is_staged));
                    }
                }
                grid = grid.child(r);
            }
            lane = lane.child(grid);
        }
        panel = panel.child(lane);
    }
    panel
}

fn change_card(item: &serde_json::Value, t: Palette, elapsed: f32, s: &AppState) -> El {
    let path = item["path"].as_str().unwrap_or("");
    let name = path.rsplit('/').next().unwrap_or(path);
    let added = item["added"].as_i64().unwrap_or(0);
    let removed = item["removed"].as_i64().unwrap_or(0);
    let status = item["status"].as_str().unwrap_or("");
    let is_new =
        matches!(status, "added" | "untracked") || item["isNew"].as_bool().unwrap_or(false);
    let deleted = status == "deleted" || item["deleted"].as_bool().unwrap_or(false);
    let empty = is_new && added == 0 && removed == 0;
    let key = format!("card:{path}:{}", item["staged"]);
    let elapsed = if !s.start_actions.live {
        elapsed
    } else {
        let mut starts = s.card_count_starts.borrow_mut();
        let start = *starts.1.entry(key.clone()).or_insert(s.start_actions.clock);
        (s.start_actions.clock - start) as f32
    };
    let hovered = s.change_tile_hover.as_deref() == Some(&key);
    let green = rune::color::hex("#059669").unwrap();
    let red = rune::color::hex("#e11d48").unwrap();
    let seed: usize = name.encode_utf16().map(usize::from).sum();
    let marks: Vec<(i32, Color)> = if deleted {
        vec![(40, red), (24, red), (20, t.muted)]
    } else if added > 0 && removed > 0 {
        vec![(40, t.muted), (24, red), (32, green), (20, t.muted)]
    } else if added > 0 {
        vec![(38, green), (26, green), (20, t.muted)]
    } else if removed > 0 {
        vec![(38, red), (22, red), (18, t.muted)]
    } else {
        vec![(40, t.muted), (24, t.muted)]
    };
    let mut sketch = col().gap(4.5);
    for (i, (w, c)) in marks.iter().enumerate() {
        sketch = sketch.child(
            el().size(
                (*w + if deleted {
                    0
                } else {
                    ((seed + i * 7) % 9) as i32 - 4
                }) as f32,
                3.5,
            )
            .radius(2.0)
            .fill(*c),
        );
    }
    let mut foot = row().gap(7.0);
    if added > 0 {
        foot = foot.child(
            text(format!("+{}", count_up(added, elapsed, 0.7)))
                .font(TextStyle::new(10.5, 400.0).family(rune::Family::Mono))
                .color(green),
        );
    }
    if removed > 0 {
        foot = foot.child(
            text(format!("−{}", count_up(removed, elapsed, 0.7)))
                .font(TextStyle::new(10.5, 400.0).family(rune::Family::Mono))
                .color(red),
        );
    }
    if empty {
        foot = foot.child(
            text("empty")
                .font(TextStyle::new(10.5, 400.0).family(rune::Family::Mono))
                .color(t.faint),
        );
        sketch = row().gap(3.0);
        for _ in 0..7 {
            sketch = sketch.child(el().size(3.5, 1.5).fill(t.line_soft));
        }
    }
    let mut footer = row().w_full().justify_between().child(foot);
    if is_new && !empty {
        footer = footer.child(
            text("new")
                .font(
                    TextStyle::new(10.0, 400.0)
                        .family(rune::Family::Mono)
                        .tracking(0.3),
                )
                .color(t.muted),
        );
    }
    let mut card = col()
        .w(158.0)
        .h(178.0)
        .padding(15.0)
        .radius(12.0)
        .border(
            if deleted { 1.5 } else { 1.0 },
            if deleted {
                Color::TRANSPARENT
            } else {
                t.line_soft
            },
        )
        .fill(if deleted {
            t.raised_high.alpha(0.45)
        } else {
            t.raised_high
        })
        .shadow(
            if hovered { 3.0 } else { 1.0 },
            if hovered { 8.0 } else { 3.0 },
            Color::BLACK.alpha(if hovered { 0.05 } else { 0.03 }),
        )
        .offset(0.0, if hovered { -6.0 } else { 0.0 })
        .cursor(Cursor::Pointer)
        .focusable(true)
        .focus_ring(2.0, 2.0, t.ink.alpha(0.34))
        .role("button")
        .label(name.to_owned())
        .on_hover_change(move |s: &mut AppState, over, _| {
            s.change_tile_hover = if over { Some(key.clone()) } else { None };
        })
        .justify_between()
        .child(
            col()
                .gap(14.0)
                .child(icon(super::file_icons::for_path(name), 18.0))
                .child(sketch),
        )
        .child(
            col()
                .gap(9.0)
                .child(
                    text(name.to_owned())
                        .font(
                            TextStyle::new(11.0, 400.0)
                                .lh(11.0)
                                .family(rune::Family::Mono),
                        )
                        .color(if deleted { t.muted } else { t.ink })
                        .truncate(),
                )
                .child(footer),
        );
    if deleted {
        for i in 0..24 {
            let x = 7.0 + i as f32 * 6.0;
            card = card.child(el().size(3.0, 1.5).fill(red).absolute(x, 0.0));
            card = card.child(el().size(3.0, 1.5).fill(red).absolute(x, 176.5));
        }
        for i in 0..27 {
            let y = 8.0 + i as f32 * 6.0;
            card = card.child(el().size(1.5, 3.0).fill(red).absolute(0.0, y));
            card = card.child(el().size(1.5, 3.0).fill(red).absolute(156.5, y));
        }
        card = card.child(
            el().size((name.chars().count() as f32 * 6.6).min(126.0), 1.0)
                .fill(t.muted)
                .absolute(16.0, 134.0),
        );
    }
    card
}

fn change_bundle(count: usize, t: Palette, s: &AppState, staged: bool) -> El {
    let key = format!("bundle:{staged}");
    let hovered = s.change_tile_hover.as_deref() == Some(&key);
    let green = rune::color::hex("#059669").unwrap();
    let red = rune::color::hex("#e11d48").unwrap();
    let cards = [
        (
            "TS",
            "#3178c6",
            "#ffffff",
            10.0,
            4.0,
            -13.0,
            [42.0, 30.0, 36.0],
            [t.faint, green, t.faint],
        ),
        (
            "JS",
            "#f7df1e",
            "#1a1a1a",
            24.0,
            0.0,
            -4.0,
            [40.0, 28.0, 34.0],
            [t.faint, red, t.faint],
        ),
        (
            "MD",
            "#64748b",
            "#ffffff",
            38.0,
            0.0,
            5.0,
            [44.0, 32.0, 38.0],
            [green, green, green.alpha(0.6)],
        ),
        (
            "CSS",
            "#1572b6",
            "#ffffff",
            34.0,
            6.0,
            14.0,
            [42.0, 30.0, 36.0],
            [t.faint, t.faint, t.faint],
        ),
    ];
    let mut inner = el().size(132.0, 138.0);
    for (i, (badge, bg, fg, x, y, angle, widths, colors)) in cards.into_iter().enumerate() {
        let mut lines = col().gap(4.0);
        for j in 0..3 {
            lines = lines.child(el().size(widths[j], 3.0).radius(2.0).fill(colors[j]));
        }
        let theta: f32 = angle * if hovered { 1.7 } else { 1.0 } * std::f32::consts::PI / 180.0;
        let paper = col()
            .size(80.0, 100.0)
            .padding(11.0)
            .gap(9.0)
            .radius(10.0)
            .border(1.0, t.line_soft)
            .fill(t.raised_high)
            .shadow(
                if i == 3 { 2.0 } else { 1.0 },
                if i == 3 { 6.0 } else { 4.0 },
                Color::BLACK.alpha(if i == 3 { 0.05 } else { 0.03 }),
            )
            .child(
                el().size(14.0, 14.0)
                    .radius(4.0)
                    .fill(rune::color::hex(bg).unwrap())
                    .center()
                    .child(
                        text(badge)
                            .font(TextStyle::new(if i == 3 { 6.0 } else { 7.0 }, 400.0))
                            .color(rune::color::hex(fg).unwrap()),
                    ),
            )
            .child(lines)
            .rotate(theta)
            .offset(50.0 * theta.sin(), 50.0 * (1.0 - theta.cos()))
            .absolute(x, y);
        inner = inner.child(paper);
    }
    inner = inner.child(
        row()
            .center_y()
            .gap(5.0)
            .px(10.0)
            .h(22.0)
            .radius(11.0)
            .fill(t.ink)
            .shadow(2.0, 6.0, Color::BLACK.alpha(0.16))
            .child(
                text(format!("+{count}"))
                    .font(TextStyle::new(11.0, 400.0).family(rune::Family::Mono))
                    .color(t.ground),
            )
            .child(
                text("more")
                    .font(TextStyle::new(10.0, 400.0))
                    .color(t.ground.alpha(0.78)),
            )
            .absolute(
                (132.0 - (52.0 + count.to_string().len() as f32 * 6.6)) / 2.0,
                112.0,
            ),
    );
    el().size(158.0, 178.0)
        .center()
        .cursor(Cursor::Pointer)
        .focusable(true)
        .focus_ring(2.0, 0.0, t.ink.alpha(0.28))
        .role("button")
        .label(format!("{count} more"))
        .on_hover_change(move |s: &mut AppState, over, _| {
            s.change_tile_hover = if over { Some(key.clone()) } else { None };
        })
        .child(inner)
}

fn count_up(value: i64, elapsed: f32, duration: f32) -> i64 {
    let x = (elapsed / duration).clamp(0.0, 1.0);
    let eased = if x >= 1.0 {
        1.0
    } else {
        1.0 - 2.0_f32.powf(-10.0 * x)
    };
    (value as f32 * eased).round() as i64
}

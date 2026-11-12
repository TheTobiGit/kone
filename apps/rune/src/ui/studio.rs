use rune::{Cx, El, Icon, ScrollSpec, TextStyle, col, el, icon, row, text, text_input};

use crate::{
    state::{AppState, StudioState},
    theme::Palette,
};

static EXPAND: Icon = Icon {
    name: "studio-expand",
    view: 24.0,
    body: r#"<path d="M16.4999 3.26621C17.3443 3.25421 20.1408 2.67328 20.7337 3.26621C21.3266 3.85913 20.7457 6.65559 20.7337 7.5M20.5059 3.49097L13.5021 10.4961M3.26636 16.5001C3.25436 17.3445 2.67343 20.141 3.26636 20.7339C3.85928 21.3268 6.65574 20.7459 7.50015 20.7339M10.502 13.4976L3.49824 20.5027" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static SHRINK: Icon = Icon {
    name: "studio-shrink",
    view: 24.0,
    body: r#"<path d="M6.5023 10.7365C7.34671 10.7485 10.1432 11.3294 10.7361 10.7365C11.329 10.1436 10.7481 7.34708 10.7361 6.50267M13.2685 17.5027C13.2565 16.6583 12.6756 13.8618 13.2685 13.2689C13.8614 12.676 16.6579 13.2569 17.5023 13.2689M20.9991 21.001L13.6102 13.6188M10.3691 10.3763L2.99998 2.99902" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static CLOSE: Icon = Icon {
    name: "studio-close",
    view: 24.0,
    body: r#"<path d="M18 6L6.00081 17.9992M17.9992 18L6 6.00085" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>"#,
};

static SIDE_CHAT: Icon = Icon {
    name: "studio-side-chat",
    view: 24.0,
    body: r#"<path d="M8 10.5h8M8 14h5.5M17 3.338A9.95 9.95 0 0 0 12 2C6.477 2 2 6.477 2 12c0 1.6.376 3.112 1.043 4.453c.178.356.237.763.134 1.148l-.595 2.226a1.3 1.3 0 0 0 1.591 1.592l2.226-.596a1.63 1.63 0 0 1 1.149.133A9.96 9.96 0 0 0 12 22c5.523 0 10-4.477 10-10c0-1.821-.487-3.53-1.338-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static HANDOFF: Icon = Icon {
    name: "studio-handoff",
    view: 24.0,
    body: r#"<path d="M16.9767 19.5C19.4017 17.8876 21 15.1305 21 12C21 7.02944 16.9706 3 12 3C11.3126 3 10.6432 3.07706 10 3.22302M16.9767 19.5V16M16.9767 19.5H20.5M7 4.51555C4.58803 6.13007 3 8.87958 3 12C3 16.9706 7.02944 21 12 21C12.6874 21 13.3568 20.9229 14 20.777M7 4.51555V8M7 4.51555H3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static ARCHIVE: Icon = Icon {
    name: "studio-archive",
    view: 24.0,
    body: r#"<path d="M7 21H17C19.357 21 20.535 21 21.268 20.268C22 19.535 22 18.357 22 16S22 12.465 21.268 11.732C20.535 11 19.357 11 17 11H7C4.643 11 3.465 11 2.732 11.732C2 12.465 2 13.643 2 16S2 19.535 2.732 20.268C3.465 21 4.643 21 7 21ZM4 11C4 9.6 4 8.9 4.273 8.365C4.512 7.895 4.895 7.512 5.365 7.273C5.9 7 6.6 7 8 7H16C17.4 7 18.1 7 18.635 7.273C19.105 7.512 19.488 7.895 19.727 8.365C20 8.9 20 9.6 20 11M6 7C6 5.6 6 4.9 6.273 4.365C6.512 3.895 6.895 3.512 7.365 3.273C7.9 3 8.6 3 10 3H14C15.4 3 16.1 3 16.635 3.273C17.105 3.512 17.488 3.895 17.727 4.365C18 4.9 18 5.6 18 7M16 15L15.7 15.4C15.111 16.185 14.817 16.578 14.394 16.789C13.972 17 13.481 17 12.5 17H11.5C10.519 17 10.028 17 9.606 16.789C9.183 16.578 8.889 16.185 8.3 15.4L8 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static TERMINAL: Icon = Icon {
    name: "studio-terminal",
    view: 24.0,
    body: r#"<path d="M7.5 7.5L8.72654 8.55719C9.24218 9.00163 9.5 9.22386 9.5 9.5C9.5 9.77614 9.24218 9.99836 8.72654 10.4428L7.5 11.5M11.5 12.5H15.5M12 21C15.7497 21 17.6246 21 18.9389 20.0451C19.3634 19.7367 19.7367 19.3634 20.0451 18.9389C21 17.6246 21 15.7497 21 12C21 8.25027 21 6.3754 20.0451 5.06107C19.7367 4.6366 19.3634 4.26331 18.9389 3.95491C17.6246 3 15.7497 3 12 3C8.25027 3 6.3754 3 5.06107 3.95491C4.6366 4.26331 4.26331 4.6366 3.95491 5.06107C3 6.3754 3 8.25027 3 12C3 15.7497 3 17.6246 3.95491 18.9389C4.26331 19.3634 4.6366 19.7367 5.06107 20.0451C6.3754 21 8.25027 21 12 21Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static REFRESH: Icon = Icon {
    name: "studio-refresh",
    view: 24.0,
    body: r#"<path d="M20.0092 2V5.13219C20.0092 5.42605 19.6418 5.55908 19.4537 5.33333C17.6226 3.2875 14.9617 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

static WORKTREE: Icon = Icon {
    name: "studio-worktree",
    view: 10.0,
    body: r#"<path d="M8.854 7.146a.5.5 0 0 0-.707.707l.146.146H5.75a.75.75 0 0 1-.75-.75v-3.5a.75.75 0 0 1 .75-.75h2.543l-.146.146a.5.5 0 0 0 .708.707l1-1a.5.5 0 0 0 0-.707l-1-1a.5.5 0 0 0-.707.707l.146.146H5.751c-.965 0-1.75.785-1.75 1.75v1.25H.5a.5.5 0 0 0 0 1H4v1.25c0 .965.785 1.75 1.75 1.75h2.543l-.146.146a.5.5 0 0 0 .708.707l1-1a.5.5 0 0 0 0-.707l-1-1z" fill="currentColor"/>"#,
};

static STUDIO_PROVIDER_CODEX: Icon = Icon {
    name: "studio-provider-codex",
    view: 24.0,
    body: r#"<path d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z" fill="currentColor" fill-rule="evenodd"/>"#,
};
static STUDIO_PROVIDER_GPT: Icon = Icon {
    name: "studio-provider-gpt",
    view: 24.0,
    body: r#"<path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.998-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.142-.08 4.778-2.758a.795.795 0 0 0 .393-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.495 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.677l5.815 3.354-2.02 1.169a.076.076 0 0 1-.071 0l-4.83-2.787A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.856-5.833-3.388L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.666zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.062l4.83-2.786a4.5 4.5 0 0 1 6.68 4.66zM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.057V6.074a4.5 4.5 0 0 1 7.376-3.454l-.142.08L8.704 5.46a.795.795 0 0 0-.393.68zm1.098-2.366 2.602-1.5 2.607 1.5v3l-2.597 1.5-2.607-1.5z" fill="currentColor" fill-rule="evenodd"/>"#,
};
static STUDIO_PROVIDER_CURSOR: Icon = Icon {
    name: "studio-provider-cursor",
    view: 24.0,
    body: r#"<path d="M22.07 5.7L12.5 0.18C12.19 0 11.81 0 11.5 0.18L1.93 5.7C1.67 5.85 1.51 6.13 1.51 6.43V17.57C1.51 17.87 1.67 18.15 1.93 18.3L11.5 23.82C11.81 24 12.19 24 12.5 23.82L22.07 18.3C22.33 18.15 22.49 17.87 22.49 17.57V6.43C22.49 6.13 22.33 5.85 22.07 5.7H22.07ZM21.47 6.87L12.23 22.88C12.16 22.99 12 22.94 12 22.82V12.34C12 12.13 11.89 11.94 11.71 11.83L2.63 6.59C2.52 6.53 2.57 6.36 2.69 6.36H21.17C21.44 6.36 21.6 6.65 21.47 6.88H21.47Z" fill="currentColor" fill-rule="evenodd"/>"#,
};
static STUDIO_PROVIDER_OPENCODE: Icon = Icon {
    name: "studio-provider-opencode",
    view: 24.0,
    body: r#"<path d="M22 24H2V0h20zM17 4.8H7v14.4h10z" fill="currentColor" fill-rule="evenodd"/>"#,
};
static STUDIO_PROVIDER_CLAUDE: Icon = Icon {
    name: "studio-provider-claude",
    view: 256.0,
    body: r#"<path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z" fill="currentColor" fill-rule="evenodd"/>"#,
};

fn brand_mark(provider: &str, t: Palette) -> El {
    let mark = match provider {
        "claudeAgent" => &STUDIO_PROVIDER_CLAUDE,
        "cursor" => &STUDIO_PROVIDER_CURSOR,
        "opencode" => &STUDIO_PROVIDER_OPENCODE,
        "gpt" | "openai" => &STUDIO_PROVIDER_GPT,
        _ => &STUDIO_PROVIDER_CODEX,
    };
    icon(mark, 15.0).color(if provider == "claudeAgent" {
        t.accent
    } else {
        t.ink_soft
    })
}

pub(super) fn provider_mark(state: Option<&StudioState>, t: Palette) -> El {
    let provider = state
        .and_then(|s| s.providers.get(s.provider_index))
        .map(|p| p.id.as_str())
        .unwrap_or("codex");
    let mut marks = row().center_y().gap(4.0);
    if let Some(state) = state {
        if let Some(source) = &state.handoff_source {
            marks = marks
                .child(brand_mark(source, t).opacity(0.55))
                .child(label("→", 10.0, 400.0, t.muted).opacity(0.8));
        } else {
            for past in &state.past_providers {
                marks = marks.child(brand_mark(past, t).opacity(0.45));
            }
        }
    }
    marks = marks.child(brand_mark(provider, t));
    if state.is_some_and(|s| s.side_chat) {
        marks = marks.child(
            icon(&SIDE_CHAT, 11.0).color(crate::theme::mix_srgb(t.ink_soft, t.accent, 0.72)),
        );
    }
    marks
}

fn connected_avatar() -> El {
    use std::sync::{Arc, OnceLock};
    static IMAGE: OnceLock<rune::Image> = OnceLock::new();
    let image = IMAGE.get_or_init(|| {
        let cache = rune::ImageCache::new(Arc::new(|| {}));
        let image = cache.svg(
            Arc::<[u8]>::from(crate::review::fixture_avatar().as_bytes()),
            15.0,
            2.0,
        );
        let _ = image.wait();
        image
    });
    el().w(15.0)
        .h(15.0)
        .radius(7.5)
        .pixels_fit(image.pixels(), rune::SurfaceFit::Fill)
}

fn fork_tool(
    glyph: &'static Icon,
    tip: &'static str,
    state: Option<&StudioState>,
    t: Palette,
) -> El {
    let shown = state.and_then(|s| s.head_tooltip.as_deref()) == Some(tip);
    let mut button = el()
        .w(20.0)
        .h(20.0)
        .center()
        .radius(6.0)
        .hover(t.hover)
        .child(icon(glyph, 13.0).color(t.muted))
        .on_hover_change(move |s: &mut AppState, over, _| {
            s.studio.head_tooltip = if over { Some(tip.into()) } else { None };
        });
    if shown {
        button = button.child(
            el().absolute(-75.0, -26.0)
                .w(170.0)
                .px(7.0)
                .h(20.0)
                .center()
                .radius(6.0)
                .fill(t.ink)
                .child(label(tip, 11.0, 500.0, t.ground)),
        );
    }
    button
}

static METER_TRACK: Icon = Icon {
    name: "studio-meter-track",
    view: 20.0,
    body: r#"<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="2.25"/>"#,
};

fn meter_arc(percent: usize) -> &'static Icon {
    static ARCS: std::sync::OnceLock<Vec<Icon>> = std::sync::OnceLock::new();
    &ARCS.get_or_init(|| {
        (0..=100).map(|p| {
            if p == 100 {
                return Icon {
                    name: "studio-meter-100",
                    view: 20.0,
                    body: r#"<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="2.25"/>"#,
                };
            }
            let angle = std::f32::consts::TAU * (p.min(99) as f32 / 100.0);
            let x = 10.0 + 7.0 * angle.sin();
            let y = 10.0 - 7.0 * angle.cos();
            Icon {
                name: Box::leak(format!("studio-meter-{p}").into_boxed_str()),
                view: 20.0,
                body: Box::leak(format!(r#"<path d="M10 3 A7 7 0 {} 1 {x:.4} {y:.4}" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"/>"#, if p > 50 { 1 } else { 0 }).into_boxed_str()),
            }
        }).collect()
    })[percent.min(100)]
}

fn context_meter(state: &StudioState, t: Palette) -> El {
    let Some((used, window)) = state.context_usage.filter(|(_, window)| *window > 0) else {
        return el().w(0.0);
    };
    let fraction = (used as f64 / window as f64 * 100.0).min(100.0);
    let percent = fraction.round() as usize;
    let color = if fraction >= 90.0 {
        rune::Color::from_oklab([0.6, 0.16, 0.08, 1.0])
    } else if fraction >= 70.0 {
        t.accent
    } else {
        crate::theme::mix_srgb(t.muted, t.accent, 0.52)
    };
    let mut meter = el()
        .w(15.0)
        .h(15.0)
        .center()
        .child(icon(&METER_TRACK, 15.0).color(t.muted.alpha(0.22)))
        .child(
            icon(meter_arc(percent), 15.0)
                .opacity(if percent == 0 { 0.0 } else { 1.0 })
                .color(color)
                .absolute(0.0, 0.0),
        )
        .on_press(|s: &mut AppState| s.studio.context_open = !s.studio.context_open);
    if state.context_open {
        let data_row = |name: &str, value: String| {
            row()
                .w_full()
                .justify_between()
                .child(label(name, 11.0, 400.0, t.muted).font(TextStyle::new(11.0, 400.0).mono()))
                .child(label(value, 11.0, 400.0, t.ink).font(TextStyle::new(11.0, 400.0).mono()))
        };
        let mut data = col()
            .w_full()
            .padding(12.0)
            .gap(3.0)
            .radius(18.0)
            .fill(t.raised)
            .child(data_row(
                "Used",
                format!("{} · {}", format_percent(fraction), format_tokens(used)),
            ));
        if used < window {
            data = data.child(data_row("Remaining", format_tokens(window - used)));
        }
        for (name, value) in [
            ("Input", state.context_input),
            ("Output", state.context_output),
            ("Total", state.context_total),
        ] {
            if let Some(value) = value {
                data = data.child(data_row(name, format_tokens(value)));
            }
        }
        data = data.child(data_row("Window", format_tokens(window)));
        if state.context_auto_compact {
            data = data
                .child(el().w_full().h(1.0).fill(t.line).my(5.0))
                .child(label(
                    format!("Auto-compacts at ~{}.", format_tokens(window)),
                    11.0,
                    400.0,
                    t.muted,
                ));
        }
        let mut card = col()
            .w(260.0)
            .radius(20.0)
            .border(1.0, t.line)
            .fill(t.ground)
            .shadow(10.0, 28.0, rune::Color::BLACK.alpha(0.18))
            .child(
                row()
                    .w_full()
                    .h(36.0)
                    .px(13.0)
                    .center_y()
                    .justify_between()
                    .child(label("Context window", 12.5, 600.0, t.ink_soft))
                    .child(
                        el().child(label("Cancel", 13.0, 600.0, t.muted))
                            .on_press(|s: &mut AppState| s.studio.context_open = false),
                    ),
            )
            .child(data);
        if state
            .providers
            .get(state.provider_index)
            .is_some_and(|p| p.supports_compaction)
        {
            let ready = state.started
                && !state.busy
                && state.compact_request.is_none()
                && state.items.iter().any(|item| item.kind == "user");
            let mut action = el()
                .w_full()
                .h(34.0)
                .px(12.0)
                .center_y()
                .radius(12.0)
                .child(label(
                    if state.compact_request.is_some() {
                        "Compacting…"
                    } else {
                        "Compact context"
                    },
                    12.0,
                    400.0,
                    t.ink_soft,
                ))
                .opacity(if ready { 1.0 } else { 0.45 });
            if ready {
                action = action.hover(t.hover).on_press(|s: &mut AppState| {
                    s.studio.compact_error = None;
                    s.studio.compact_request = s.request(
                        "agent.compact",
                        serde_json::json!({"threadId": s.studio.thread_id}),
                    );
                });
            }
            let mut actions = col()
                .w_full()
                .padding(6.0)
                .radius(18.0)
                .fill(t.raised)
                .child(action);
            if let Some(error) = &state.compact_error {
                actions = actions.child(label(error.clone(), 11.0, 400.0, t.muted));
            }
            card = card.child(actions);
        }
        meter = meter.child(card.absolute(-245.0, 23.0));
    }
    meter
}

fn format_tokens(value: u64) -> String {
    if value < 1_000 {
        return value.to_string();
    }
    if value < 10_000 {
        return format_decimal(value as f64 / 1_000.0, "k");
    }
    if value < 1_000_000 {
        return format!("{:.0}k", value as f64 / 1_000.0);
    }
    format_decimal(value as f64 / 1_000_000.0, "m")
}

fn format_decimal(value: f64, suffix: &str) -> String {
    let number = format!("{value:.1}");
    format!("{}{suffix}", number.strip_suffix(".0").unwrap_or(&number))
}

fn format_percent(value: f64) -> String {
    if value < 10.0 {
        format_decimal(value, "%")
    } else {
        format!("{value:.0}%")
    }
}

fn title_of(state: &StudioState) -> String {
    if !state.title.is_empty() {
        return state.title.clone();
    }
    state
        .items
        .iter()
        .find(|item| item.kind == "user" && !item.text.is_empty())
        .map(|item| item.text.lines().next().unwrap_or("New thread").into())
        .unwrap_or_else(|| "New thread".into())
}

fn column_title(state: Option<&StudioState>, focused: bool, t: Palette) -> El {
    let (label, side_chat) = state
        .map(|state| (title_of(state), state.side_chat))
        .unwrap_or_else(|| ("New thread".into(), false));
    let base = if focused {
        t.ink
    } else if side_chat {
        crate::theme::mix_srgb(t.accent, t.muted, 0.58)
    } else {
        t.muted
    };
    let hover = if side_chat {
        crate::theme::mix_srgb(t.accent, t.ink, 0.66)
    } else {
        t.ink
    };
    let mut style = TextStyle::new(13.5, 400.0).lh(16.2).tracking(-0.2025);
    if side_chat {
        style = style.italic();
    }
    el().hover_group().min_w(0.0).child(
        text(label)
            .font(style)
            .color(base)
            .group_color(hover)
            .truncate(),
    )
}

fn label(value: impl Into<String>, size: f32, weight: f32, color: rune::Color) -> El {
    text(value).font(TextStyle::new(size, weight)).color(color)
}

fn project_nav(s: &AppState, t: Palette) -> El {
    let mut nav = row().center_y().gap(4.0);
    for (index, project) in s.projects.iter().enumerate() {
        let has_row = s.studio_layout["rows"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|r| r["projectPath"] == project.path));
        if !has_row && Some(index) != s.selected_project {
            continue;
        }
        let path = project.path.clone();
        nav = nav.child(
            el().key(format!("studio-row-{index}"))
                .px(8.0)
                .h(26.0)
                .center()
                .radius(8.0)
                .hover(t.hover)
                .child(label(
                    project.name.clone(),
                    12.0,
                    500.0,
                    if Some(index) == s.selected_project {
                        t.ink
                    } else {
                        t.muted
                    },
                ))
                .on_press_tx(move |s: &mut AppState, tx| {
                    s.select_studio_project(index);
                    tx.scroll_into_view(format!("studio-row-slot-{path}"));
                }),
        );
    }
    nav
}

pub fn view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let t = Palette::new(cx.system_dark());
    if s.selected_project.is_none() {
        let mut choices = col().w(300.0).gap(4.0);
        for (index, project) in s.projects.iter().enumerate() {
            choices = choices.child(
                row()
                    .key(format!("studio-project-{index}"))
                    .w_full()
                    .h(44.0)
                    .px(12.0)
                    .center_y()
                    .radius(10.0)
                    .hover(t.hover)
                    .child(label(project.name.clone(), 14.0, 600.0, t.ink).grow(1.0))
                    .child(label("→", 15.0, 400.0, t.muted))
                    .on_press(move |s: &mut AppState| s.select_studio_project(index)),
            );
        }
        return col().w_full().h_full().fill(t.ground).center().child(
            col()
                .items_center()
                .gap(18.0)
                .child(label("Choose a project", 16.0, 600.0, t.ink))
                .child(choices),
        );
    }
    let (viewport_w, viewport_h) = if s.studio_viewport.0 > 0.0 {
        s.studio_viewport
    } else {
        (1280.0, 840.0)
    };
    let mut plane = col().w_full();
    let rows = s.studio_layout["rows"].as_array();
    let mut selected_present = false;
    if let Some(rows) = rows {
        for saved in rows {
            let Some(path) = saved["projectPath"].as_str() else {
                continue;
            };
            let Some(index) = s.projects.iter().position(|p| p.path == path) else {
                continue;
            };
            let selected = Some(index) == s.selected_project;
            selected_present |= selected;
            plane = plane.child(studio_row(
                s,
                saved,
                index,
                selected,
                (viewport_w, viewport_h),
                t,
                cx,
            ));
        }
    }
    if !selected_present && let Some(index) = s.selected_project {
        let empty = serde_json::json!({"projectPath":s.projects[index].path,"panes":[]});
        plane = plane.child(studio_row(
            s,
            &empty,
            index,
            true,
            (viewport_w, viewport_h),
            t,
            cx,
        ));
    }
    let plane = col()
        .key("studio-plane")
        .w_full()
        .h_full()
        .fill(t.ground)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .on_layout_tx(|s: &mut AppState, [_, _, w, h], tx| {
            s.studio_viewport = (w, h);
            if let Some(path) = s.studio_scroll_row.take() {
                tx.scroll_into_view(format!("studio-row-slot-{path}"));
                if !s.studio.thread_id.is_empty() {
                    s.center_studio_column(tx);
                }
            }
        })
        .child(plane);
    if s.studio_refusal.is_some() {
        plane.child(el().pin(None, Some(0.0), Some(34.0), Some(0.0)).center().child(
            label("A column can’t cross the vertical axis — a row is a project, and a thread is bound to its repo.", 12.5, 400.0, t.muted)
        ))
    } else {
        plane
    }
}

fn studio_row(
    s: &AppState,
    saved: &serde_json::Value,
    project_index: usize,
    selected_row: bool,
    viewport: (f32, f32),
    t: Palette,
    cx: &Cx<AppState>,
) -> El {
    let (viewport_w, viewport_h) = viewport;
    let project = &s.projects[project_index];
    let path = project.path.clone();
    let panes = saved["panes"].as_array();
    let mut rail = row().h_full();
    let count = panes.map_or(0, Vec::len);
    if count == 1 {
        let pane = &panes.unwrap()[0];
        let width = [840.0_f32, 960.0, 1120.0, 1240.0]
            [(pane["width"].as_u64().unwrap_or(0) as usize).min(3)]
        .min(viewport_w);
        let width = if pane["zen"].as_bool().unwrap_or(false) {
            viewport_w
        } else {
            width
        };
        rail = rail.child(
            el().w(((viewport_w - width) / 2.0 - 14.0).max(0.0))
                .h_full(),
        );
    }
    if let Some(panes) = panes {
        for (i, pane) in panes.iter().enumerate() {
            let Some(thread) = pane["anchor"]["threadId"].as_str() else {
                continue;
            };
            let focused = selected_row && thread == s.studio.thread_id;
            let state = if focused {
                Some(&s.studio)
            } else {
                s.studio_threads.get(thread)
            };
            let width = [840.0_f32, 960.0, 1120.0, 1240.0]
                [(pane["width"].as_u64().unwrap_or(0) as usize).min(3)]
            .min(viewport_w);
            let zen = focused && pane["zen"].as_bool().unwrap_or(false);
            let width = if zen { viewport_w } else { width };
            let id = thread.to_owned();
            let focus_id = id.clone();
            let width_id = id.clone();
            let zen_id = id.clone();
            let close_id = id.clone();
            let project_path = path.clone();
            let hover_id = id.clone();
            let show_tools = s.studio_column_hover.as_deref() == Some(id.as_str());
            let has_thread = state.is_some_and(|s| {
                !s.dormant && s.terminal_command.is_none() && (!s.items.is_empty() || s.busy)
            });
            let side_chat = state.is_some_and(|s| s.side_chat);
            let head = row()
                .offset(0.0, -5.0)
                .w_full()
                .h(38.0)
                .center_y()
                .justify_between()
                .child(
                    row()
                        .w(100.0)
                        .center_y()
                        .gap(2.0)
                        .opacity(if show_tools { 1.0 } else { 0.0 })
                        .child(if has_thread && !side_chat {
                            fork_tool(&SIDE_CHAT, "Open a side chat", state, t)
                        } else {
                            el().w(0.0)
                        })
                        .child(if has_thread && !side_chat {
                            fork_tool(&HANDOFF, "Hand off to another provider", state, t)
                        } else {
                            el().w(0.0)
                        })
                        .child(if has_thread {
                            fork_tool(&ARCHIVE, "Archive conversation", state, t).on_press({
                                let id = id.clone();
                                let path = path.clone();
                                move |s: &mut AppState| {
                                    s.archive_studio_thread(path.clone(), id.clone());
                                }
                            })
                        } else {
                            el().w(0.0)
                        }),
                )
                .child(
                    row()
                        .gap(8.0)
                        .center_y()
                        .child(if state.is_some_and(|s| s.terminal_command.is_some()) {
                            icon(&TERMINAL, 15.0).color(t.muted)
                        } else if state.is_some_and(|s| s.dormant) {
                            icon(&SIDE_CHAT, 15.0).color(t.muted)
                        } else {
                            provider_mark(state, t)
                        })
                        .child(
                            if state.is_some_and(|state| {
                                state.worktree_path.is_some()
                                    && !state.dormant
                                    && state.terminal_command.is_none()
                            }) {
                                el().w(8.0).child(icon(&WORKTREE, 12.0).color(t.muted))
                            } else {
                                el().w(0.0)
                            },
                        )
                        .child(if state.is_some_and(|s| s.dormant) {
                            label("New thread", 13.5, 400.0, t.ink)
                        } else if state.is_some_and(|s| s.terminal_command.is_some()) {
                            label("Terminal", 13.5, 400.0, t.ink)
                        } else {
                            column_title(state, focused, t)
                        })
                        .child(
                            if let Some(command) = state.and_then(|s| s.terminal_command.as_ref()) {
                                row()
                                    .center_y()
                                    .gap(5.0)
                                    .px(8.0)
                                    .h(18.0)
                                    .radius(999.0)
                                    .fill(t.ink.alpha(0.05))
                                    .child(el().w(5.0).h(5.0).radius(3.0).fill(t.muted))
                                    .child(label(command.clone(), 10.0, 620.0, t.muted))
                            } else if let Some(state) = state {
                                context_meter(state, t)
                            } else {
                                el().w(0.0)
                            },
                        ),
                )
                .child(
                    row()
                        .opacity(if show_tools { 1.0 } else { 0.0 })
                        .w(100.0)
                        .justify_end()
                        .center_y()
                        .gap(2.0)
                        .child(
                            el().key(format!("studio-width-{id}"))
                                .px(4.0)
                                .h(20.0)
                                .min_w(20.0)
                                .opacity(if zen { 0.4 } else { 1.0 })
                                .center()
                                .radius(6.0)
                                .hover(t.hover)
                                .child(label(
                                    if zen {
                                        "max".into()
                                    } else {
                                        format!("{width:.0}")
                                    },
                                    10.0,
                                    650.0,
                                    t.muted,
                                ))
                                .on_press_tx(move |s: &mut AppState, tx| {
                                    if zen {
                                        return;
                                    }
                                    s.select_studio_project(project_index);
                                    s.open_studio_thread(width_id.clone());
                                    s.cycle_studio_width(&width_id);
                                    s.center_studio_column(tx);
                                }),
                        )
                        .child(if state.is_some_and(|s| s.terminal_command.is_some()) {
                            el().w(20.0)
                                .h(20.0)
                                .center()
                                .radius(6.0)
                                .hover(t.hover)
                                .child(icon(&REFRESH, 13.0).color(t.muted))
                        } else {
                            el().w(0.0)
                        })
                        .child(
                            el().key(format!("studio-zen-{id}"))
                                .w(20.0)
                                .h(20.0)
                                .center()
                                .radius(6.0)
                                .hover(t.hover)
                                .child(
                                    icon(if zen { &SHRINK } else { &EXPAND }, 13.0).color(t.muted),
                                )
                                .on_press_tx(move |s: &mut AppState, tx| {
                                    s.select_studio_project(project_index);
                                    s.open_studio_thread(zen_id.clone());
                                    s.toggle_studio_zen(&zen_id);
                                    s.center_studio_column(tx);
                                }),
                        )
                        .child(
                            el().key(format!("studio-close-{id}"))
                                .w(20.0)
                                .h(20.0)
                                .center()
                                .radius(6.0)
                                .hover(t.hover)
                                .child(icon(&CLOSE, 13.0).color(t.muted))
                                .on_press(move |s: &mut AppState| {
                                    s.select_studio_project(project_index);
                                    s.close_studio_thread(&close_id);
                                }),
                        ),
                );
            let body = if state.is_some_and(|s| s.dormant) {
                col()
                    .w_full()
                    .grow(1.0)
                    .items_center()
                    .pt(40.0)
                    .child(label("Opening…", 12.5, 400.0, t.muted).opacity(0.7))
            } else if state.is_some_and(|s| s.terminal_command.is_some()) {
                col().w_full().grow(1.0)
            } else if focused {
                focused_body(
                    s,
                    &project.name,
                    t,
                    crate::codegolf::MARK_BASE + (project_index * 256 + i) as u32,
                )
            } else if let Some(state) = state {
                parked_body(
                    state,
                    &id,
                    t,
                    crate::codegolf::MARK_BASE + (project_index * 256 + i) as u32,
                )
            } else {
                col().w_full().grow(1.0)
            };
            if i == 0 {
                let seam_key = format!("{path}-0");
                let hovered = s.studio_seam_hover.as_deref() == Some(seam_key.as_str());
                let layout_key = seam_key.clone();
                let press_key = seam_key.clone();
                let menu_path = path.clone();
                rail = rail.child(
                    el().key(format!("studio-seam-{path}-0"))
                        .w(14.0)
                        .h(28.0)
                        .self_center()
                        .center()
                        .on_layout(move |s: &mut AppState, bounds| {
                            s.studio_seam_bounds.insert(layout_key.clone(), bounds);
                        })
                        .on_hover_change(move |s: &mut AppState, over, _| {
                            if over {
                                s.studio_seam_hover = Some(seam_key.clone());
                            } else if s.studio_seam_hover.as_deref() == Some(seam_key.as_str()) {
                                s.studio_seam_hover = None;
                            }
                        })
                        .child(
                            el().w(5.0)
                                .offset(0.0, -17.0)
                                .h(if hovered { 19.44 } else { 18.0 })
                                .radius(3.0)
                                .fill(t.ink.alpha(if hovered { 0.48 } else { 0.32 })),
                        )
                        .on_press(move |s: &mut AppState| {
                            s.studio_insert_menu = s
                                .studio_seam_bounds
                                .get(&press_key)
                                .copied()
                                .map(|b| (menu_path.clone(), 0, b));
                        }),
                );
            }
            rail = rail.child(
                col()
                    .key(format!("studio-pane-{id}"))
                    .w(width)
                    .h_full()
                    .opacity(if focused {
                        1.0
                    } else if show_tools {
                        0.52
                    } else {
                        0.34
                    })
                    .scale(if focused { 1.0 } else { 0.985 })
                    .pt(24.0)
                    .on_hover_focus_change(move |s: &mut AppState, over, _| {
                        if over {
                            s.studio_column_hover = Some(hover_id.clone());
                        } else if s.studio_column_hover.as_deref() == Some(hover_id.as_str()) {
                            s.studio_column_hover = None;
                        }
                    })
                    .on_press_tx(move |s: &mut AppState, tx| {
                        s.select_studio_project(project_index);
                        s.open_studio_thread(focus_id.clone());
                        tx.scroll_into_view(format!("studio-row-slot-{project_path}"));
                        s.center_studio_column(tx);
                    })
                    .child(head)
                    .child(body),
            );
            let seam_key = format!("{path}-{}", i + 1);
            let hovered = s.studio_seam_hover.as_deref() == Some(seam_key.as_str());
            let layout_key = seam_key.clone();
            let press_key = seam_key.clone();
            let menu_path = path.clone();
            rail = rail.child(
                el().key(format!("studio-seam-{path}-{}", i + 1))
                    .w(14.0)
                    .h(28.0)
                    .self_center()
                    .center()
                    .on_layout(move |s: &mut AppState, bounds| {
                        s.studio_seam_bounds.insert(layout_key.clone(), bounds);
                    })
                    .on_hover_change(move |s: &mut AppState, over, _| {
                        if over {
                            s.studio_seam_hover = Some(seam_key.clone());
                        } else if s.studio_seam_hover.as_deref() == Some(seam_key.as_str()) {
                            s.studio_seam_hover = None;
                        }
                    })
                    .child(
                        el().w(5.0)
                            .offset(0.0, -17.0)
                            .h(if hovered { 19.44 } else { 18.0 })
                            .radius(3.0)
                            .fill(t.ink.alpha(if hovered { 0.48 } else { 0.32 })),
                    )
                    .on_press(move |s: &mut AppState| {
                        s.studio_insert_menu = s
                            .studio_seam_bounds
                            .get(&press_key)
                            .copied()
                            .map(|b| (menu_path.clone(), i + 1, b));
                    }),
            );
        }
        if count > 1 {
            rail = rail.child(el().w(viewport_w / 2.0).h_full());
        }
    }
    let mut bar = row().w_full().h(32.0).px(32.0).justify_between().center_y();
    if count > 1 {
        let mut dashes = row().gap(6.0).center_y();
        for pane in panes.into_iter().flatten() {
            if let Some(thread) = pane["anchor"]["threadId"].as_str() {
                let id = thread.to_owned();
                let project_path = path.clone();
                dashes = dashes.child(
                    el().key(format!("studio-index-{id}"))
                        .w(if selected_row && id == s.studio.thread_id {
                            24.0
                        } else {
                            13.0
                        })
                        .h(20.0)
                        .center()
                        .child(el().w_full().h(2.0).radius(1.0).fill(
                            if selected_row && id == s.studio.thread_id {
                                t.ink
                            } else {
                                t.ink.alpha(0.16)
                            },
                        ))
                        .on_press_tx(move |s: &mut AppState, tx| {
                            s.select_studio_project(project_index);
                            s.open_studio_thread(id.clone());
                            tx.scroll_into_view(format!("studio-row-slot-{project_path}"));
                            s.center_studio_column(tx);
                        }),
                );
            }
        }
        bar = bar.child(
            el().pin(Some(17.0), Some(0.0), None, Some(0.0))
                .h(20.0)
                .center()
                .child(dashes),
        );
    } else {
        bar = bar.child(el().w(24.0));
    }
    if count > 0 {
        bar = bar.child(project_nav(s, t));
    }
    let content = if count == 0 {
        let parent = project.path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        let summary = s
            .project_data
            .summaries
            .get(&project.path)
            .cloned()
            .unwrap_or_default();
        let mut actions = col().w_full().gap(2.0);
        for (index, (symbol, title, keys)) in [
            ("◯", "New thread", "Ctrl N"),
            ("›_", "Terminal", "Ctrl Shift T"),
            ("▤", "Scratchpad", "Ctrl Shift N"),
        ]
        .into_iter()
        .enumerate()
        {
            let mut chips = row().gap(3.0).center_y();
            for key in keys.split_whitespace() {
                chips = chips.child(
                    el().px(4.0)
                        .min_w(17.0)
                        .h(17.0)
                        .center()
                        .radius(5.0)
                        .fill(t.ink.alpha(0.07))
                        .child(label(key, 11.0, 400.0, t.muted)),
                );
            }
            let mut action = row()
                .key(format!("studio-chooser-{index}"))
                .w_full()
                .h(38.0)
                .px(11.0)
                .gap(10.0)
                .center_y()
                .radius(10.0)
                .hover(t.hover)
                .child(label(symbol, 16.0, 400.0, t.muted))
                .child(label(title, 13.5, 400.0, t.ink_soft).grow(1.0))
                .child(chips);
            if index == 0 {
                action = action.on_press_tx(move |s: &mut AppState, tx| {
                    s.select_studio_project(project_index);
                    s.new_studio_thread();
                    s.center_studio_column(tx);
                });
            }
            let offset = s.chooser_magnet.offsets[index];
            let active = s.chooser_magnet.active[index];
            actions =
                actions.child(
                    el().w_full()
                        .on_layout(move |s: &mut AppState, bounds| {
                            s.chooser_magnet.bounds[index] = bounds
                        })
                        .child(action.offset(offset[0], offset[1]).offset_motion(
                            rune::Curve::tween(if active { 0.35 } else { 0.6 }, super::empty::EASE),
                        )),
                );
        }
        el().w_full()
            .grow(1.0)
            .on_pointer_move_local(|s: &mut AppState, p, tx| {
                if !s.chooser_magnet.pointer_move(p.window_x, p.window_y, false) {
                    tx.live_only();
                }
            })
            .child(crate::plasma::slot(s, cx, 1.0))
            .child(
                col().w_full().h_full().center().child(
                    col()
                        .w(256.0)
                        .items_center()
                        .child(
                            super::projects::folder_with_git(&project.name, t, &summary).scale(0.9),
                        )
                        .child(el().h(9.6))
                        .child(label(parent.to_owned(), 12.0, 400.0, t.muted))
                        .child(el().h(20.0))
                        .child(actions),
                ),
            )
    } else {
        col()
            .key(format!("studio-rail-{path}"))
            .w_full()
            .grow(1.0)
            .shrink()
            .scroll_x()
            .child(rail)
    };
    let mut result = col()
        .key(format!("studio-row-slot-{path}"))
        .w_full()
        .h(viewport_h)
        .fill(t.ground)
        .child(bar)
        .child(content);
    if let Some((menu_path, index, bounds)) = &s.studio_insert_menu
        && *menu_path == path
    {
        let index = *index;
        let x = if index == 0 {
            bounds[0] + bounds[2] + 8.0
        } else {
            bounds[0] - 192.0
        };
        let y = bounds[1] + bounds[3] / 2.0 - 75.0;
        let mut menu = col().w(184.0).radius(18.0).fill(t.raised).child(
            el().w_full()
                .h(38.0)
                .px(16.0)
                .center_y()
                .fill(t.sunken)
                .child(label("Insert", 13.0, 400.0, t.ink_soft)),
        );
        for (row_index, (symbol, title)) in
            [("◯", "New thread"), ("›_", "Terminal"), ("▤", "Scratchpad")]
                .into_iter()
                .enumerate()
        {
            let mut action = row()
                .w_full()
                .h(32.0)
                .px(12.0)
                .gap(8.0)
                .center_y()
                .child(label(symbol, 14.0, 400.0, t.muted))
                .child(label(title, 13.0, 400.0, t.ink_soft).grow(1.0))
                .child(label("›", 14.0, 400.0, t.muted));
            if row_index == 0 && !(count == 1 && s.studio.items.is_empty()) {
                action = action
                    .hover(t.hover)
                    .on_press_tx(move |s: &mut AppState, tx| {
                        s.studio_insert_menu = None;
                        s.select_studio_project(project_index);
                        s.insert_studio_thread(index);
                        s.center_studio_column(tx);
                    });
            } else {
                action = action.opacity(0.38);
            }
            menu = menu.child(action);
        }
        result = result.child(menu.absolute(x.max(0.0), y.max(0.0)));
    }
    result
}

fn parked_body(state: &StudioState, id: &str, t: Palette, mark: u32) -> El {
    let mut transcript = col().w_full().max_w(680.0).gap(34.0).self_center().py(34.0);
    for item in &state.items {
        if item.kind == "connected" || (item.text.is_empty() && item.name.is_empty()) {
            continue;
        }
        let value = if item.kind == "tool_call" {
            format!("{}  {}", item.name, item.text)
        } else {
            item.text.clone()
        };
        let mut line = label(value, 14.0, 400.0, t.muted).w_full();
        if item.kind == "user" {
            line = line.padding(14.0).radius(14.0).fill(t.hover);
        }
        transcript = transcript.child(line);
    }
    if state.items.is_empty() {
        transcript = transcript.child(el().w_full().h(580.0).child(crate::codegolf::slot(
            mark,
            false,
            [0.851, 0.475, 0.341, 0.06],
        )));
    }
    col()
        .key(format!("studio-parked-{id}"))
        .w_full()
        .grow(1.0)
        .shrink()
        .child(transcript)
}

fn resting_orb(t: Palette) -> El {
    el().w(55.0)
        .h(55.0)
        .radius(27.5)
        .fill(t.ink)
        .child(
            el().w(5.0)
                .h(11.0)
                .radius(2.5)
                .fill(t.ground)
                .rotate(-0.43)
                .absolute(30.0, 11.0),
        )
        .child(
            el().w(4.0)
                .h(9.0)
                .radius(2.0)
                .fill(t.ground)
                .rotate(-0.43)
                .absolute(41.0, 8.0),
        )
}

fn focused_body(s: &AppState, name: &str, t: Palette, mark: u32) -> El {
    let dock =
        if let Some(approval) = &s.studio.approval {
            col()
                .w_full()
                .max_w(680.0)
                .padding(18.0)
                .gap(12.0)
                .radius(20.0)
                .border(1.0, t.line)
                .fill(t.raised_high)
                .child(label("Approval requested", 12.0, 600.0, t.muted))
                .child(label(approval.title.clone(), 14.0, 600.0, t.ink))
                .child(label(approval.detail.clone(), 13.0, 400.0, t.ink_soft))
                .child(
                    row()
                        .gap(8.0)
                        .child(
                            el().key("approval-reject")
                                .px(14.0)
                                .h(32.0)
                                .center()
                                .radius(9.0)
                                .hover(t.hover)
                                .child(label("Decline", 12.5, 500.0, t.ink_soft))
                                .on_press(|s: &mut AppState| s.answer_approval("reject-once")),
                        )
                        .child(
                            el().key("approval-allow")
                                .px(14.0)
                                .h(32.0)
                                .center()
                                .radius(9.0)
                                .fill(t.accent)
                                .child(label("Allow once", 12.5, 500.0, t.accent_ink))
                                .on_press(|s: &mut AppState| s.answer_approval("allow-once")),
                        ),
                )
        } else if let Some(request) = &s.studio.question {
            let question = &request.questions[request.index];
            let mut card = col()
                .w_full()
                .max_w(680.0)
                .padding(18.0)
                .gap(12.0)
                .radius(20.0)
                .border(1.0, t.line)
                .fill(t.raised_high)
                .child(label(question.prompt.clone(), 14.0, 600.0, t.ink));
            for (index, option) in question.options.iter().enumerate() {
                let answer = option.clone();
                let multi = question.multi;
                let prefix = if multi {
                    if request.selected.contains(option) {
                        "☑  "
                    } else {
                        "□  "
                    }
                } else {
                    ""
                };
                card = card.child(
                    el().key(format!("question-option-{index}"))
                        .w_full()
                        .h(32.0)
                        .px(8.0)
                        .center_y()
                        .radius(8.0)
                        .hover(t.hover)
                        .child(label(format!("{prefix}{option}"), 13.0, 500.0, t.ink_soft))
                        .on_press(move |s: &mut AppState| {
                            if multi {
                                s.toggle_question_option(answer.clone());
                            } else {
                                s.answer_question(answer.clone().into());
                            }
                        }),
                );
            }
            if question.multi {
                card.child(
                    el().key("question-submit")
                        .h(32.0)
                        .px(12.0)
                        .center()
                        .radius(9.0)
                        .fill(t.accent)
                        .child(label("Continue", 12.5, 500.0, t.accent_ink))
                        .on_press(|s: &mut AppState| {
                            let selected = s
                                .studio
                                .question
                                .as_ref()
                                .map(|q| q.selected.clone())
                                .unwrap_or_default();
                            s.answer_question(serde_json::json!(selected));
                        }),
                )
            } else {
                card.child(
                    text_input(&s.studio.answer, TextStyle::new(14.0, 400.0))
                        .key("studio-answer")
                        .w_full()
                        .h(38.0)
                        .placeholder("Your answer…", t.placeholder)
                        .color(t.ink)
                        .on_edit(|s: &mut AppState| &mut s.studio.answer)
                        .on_submit(|s: &mut AppState, _: &mut rune::Tx| {
                            let answer = s.studio.answer.text.clone();
                            s.answer_question(answer.into());
                        }),
                )
            }
        } else if s.studio.composer_open {
            let input = text_input(&s.composer, TextStyle::new(14.0, 400.0))
                .key("studio-composer")
                .placeholder("Ask anything…", t.placeholder)
                .color(t.ink)
                .w_full()
                .h(54.0)
                .on_edit(|s: &mut AppState| &mut s.composer)
                .on_submit(AppState::send_studio);
            let bar = row()
                .w_full()
                .h(39.0)
                .center_y()
                .gap(8.0)
                .child(label("+", 21.0, 400.0, t.muted))
                .child(
                    el().key("studio-mode-picker")
                        .px(7.0)
                        .h(30.0)
                        .center()
                        .radius(9.0)
                        .hover(t.hover)
                        .child(label(
                            if s.studio.mode.is_empty() {
                                "Ask"
                            } else {
                                &s.studio.mode
                            },
                            12.0,
                            500.0,
                            t.ink_soft,
                        ))
                        .on_press(|s: &mut AppState| {
                            s.studio.mode_picker_open = !s.studio.mode_picker_open;
                            s.studio.effort_picker_open = false;
                            s.studio.picker_open = false;
                        }),
                )
                .child(el().grow(1.0))
                .child(
                    el().key("studio-model-picker")
                        .px(7.0)
                        .h(30.0)
                        .center()
                        .radius(9.0)
                        .hover(t.hover)
                        .child(label(
                            format!(
                                "{}  {}",
                                s.studio
                                    .providers
                                    .get(s.studio.provider_index)
                                    .map(|p| p.label.as_str())
                                    .unwrap_or("Select provider"),
                                s.studio
                                    .models
                                    .get(s.studio.model_index)
                                    .map(|m| m.label.as_str())
                                    .unwrap_or("")
                            ),
                            12.5,
                            500.0,
                            t.ink_soft,
                        ))
                        .on_press(|s: &mut AppState| s.studio.picker_open = !s.studio.picker_open),
                )
                .child(
                    el().key("studio-effort-picker")
                        .px(7.0)
                        .h(30.0)
                        .center()
                        .radius(9.0)
                        .hover(t.hover)
                        .child(label(
                            if s.studio.effort.is_empty() {
                                "Effort"
                            } else {
                                &s.studio.effort
                            },
                            12.0,
                            500.0,
                            t.ink_soft,
                        ))
                        .on_press(|s: &mut AppState| {
                            s.studio.effort_picker_open = !s.studio.effort_picker_open;
                            s.studio.mode_picker_open = false;
                            s.studio.picker_open = false;
                        }),
                )
                .child(
                    el().w(32.0)
                        .h(32.0)
                        .center()
                        .radius(16.0)
                        .fill(t.accent)
                        .child(label(
                            if s.studio.busy { "■" } else { "↑" },
                            18.0,
                            600.0,
                            t.accent_ink,
                        ))
                        .on_press_tx(|s: &mut AppState, tx| {
                            if s.studio.busy {
                                s.interrupt_studio();
                            } else {
                                s.send_studio(tx);
                            }
                        }),
                );
            let mut picker = col()
                .w_full()
                .max_w(360.0)
                .padding(6.0)
                .gap(2.0)
                .radius(14.0)
                .border(1.0, t.line)
                .fill(t.raised_high);
            if s.studio.picker_open {
                picker = picker.child(label("PROVIDER", 10.0, 600.0, t.muted).px(8.0).py(4.0));
                for (index, provider) in s.studio.providers.iter().enumerate() {
                    picker = picker.child(
                        el().key(format!("provider-{index}"))
                            .w_full()
                            .h(32.0)
                            .px(8.0)
                            .center_y()
                            .radius(8.0)
                            .hover(t.hover)
                            .child(label(
                                format!(
                                    "{}{}",
                                    if index == s.studio.provider_index {
                                        "✓  "
                                    } else {
                                        "    "
                                    },
                                    provider.label
                                ),
                                12.5,
                                500.0,
                                t.ink,
                            ))
                            .on_press(move |s: &mut AppState| s.select_provider(index)),
                    );
                }
                picker = picker.child(label("MODEL", 10.0, 600.0, t.muted).px(8.0).py(4.0));
                for (index, model) in s.studio.models.iter().enumerate() {
                    picker = picker.child(
                        el().key(format!("model-{index}"))
                            .w_full()
                            .h(32.0)
                            .px(8.0)
                            .center_y()
                            .radius(8.0)
                            .hover(t.hover)
                            .child(label(
                                format!(
                                    "{}{}",
                                    if index == s.studio.model_index {
                                        "✓  "
                                    } else {
                                        "    "
                                    },
                                    model.label
                                ),
                                12.5,
                                500.0,
                                t.ink,
                            ))
                            .on_press(move |s: &mut AppState| {
                                s.studio.model_index = index;
                                s.studio.effort = s.studio.models[index]
                                    .default_effort
                                    .clone()
                                    .unwrap_or_default();
                                s.studio.picker_open = false;
                            }),
                    );
                }
            }
            let mut dock = col().w_full().max_w(680.0).items_center();
            if s.studio.picker_open {
                dock = dock.child(picker);
            }
            if s.studio.mode_picker_open {
                let mut menu = col()
                    .w_full()
                    .max_w(240.0)
                    .padding(6.0)
                    .radius(14.0)
                    .border(1.0, t.line)
                    .fill(t.raised_high);
                for (value, title) in [
                    ("ask", "Ask"),
                    ("accept-edits", "Accept edits"),
                    ("full-access", "Full access"),
                ] {
                    menu = menu.child(
                        el().key(format!("mode-{value}"))
                            .w_full()
                            .h(32.0)
                            .px(8.0)
                            .center_y()
                            .hover(t.hover)
                            .child(label(title, 12.5, 500.0, t.ink))
                            .on_press(move |s: &mut AppState| {
                                s.studio.mode = value.into();
                                s.studio.mode_picker_open = false;
                            }),
                    );
                }
                dock = dock.child(menu);
            }
            if s.studio.effort_picker_open {
                let mut menu = col()
                    .w_full()
                    .max_w(240.0)
                    .padding(6.0)
                    .radius(14.0)
                    .border(1.0, t.line)
                    .fill(t.raised_high);
                if let Some(model) = s.studio.models.get(s.studio.model_index) {
                    for effort in &model.efforts {
                        let value = effort.clone();
                        menu = menu.child(
                            el().key(format!("effort-{effort}"))
                                .w_full()
                                .h(32.0)
                                .px(8.0)
                                .center_y()
                                .hover(t.hover)
                                .child(label(effort.clone(), 12.5, 500.0, t.ink))
                                .on_press(move |s: &mut AppState| {
                                    s.studio.effort = value.clone();
                                    s.studio.effort_picker_open = false;
                                }),
                        );
                    }
                }
                dock = dock.child(menu);
            }
            dock.child(
                col()
                    .w_full()
                    .padding(14.0)
                    .radius(26.0)
                    .border(1.0, t.line)
                    .fill(t.raised_high)
                    .child(input)
                    .child(bar),
            )
            .child(
                row()
                    .w_full()
                    .h(26.0)
                    .px(20.0)
                    .gap(16.0)
                    .center_y()
                    .child(label("ϟ  Guest", 11.5, 500.0, t.ink_soft))
                    .child(label(format!("▱  {name}"), 11.5, 500.0, t.ink_soft))
                    .child(el().grow(1.0))
                    .child(label("New thread", 11.5, 500.0, t.muted)),
            )
        } else {
            col().w_full().items_center().child(
                resting_orb(t)
                    .key("studio-wake-composer")
                    .on_press(|s: &mut AppState| {
                        s.studio.composer_open = true;
                        s.composer.focused = true;
                    }),
            )
        };
    let mut transcript = col().w_full().max_w(680.0).gap(34.0).self_center().py(34.0);
    for item in &s.studio.items {
        if item.kind == "connected" || (item.text.is_empty() && item.name.is_empty()) {
            continue;
        }
        let value = if item.kind == "tool_call" {
            format!("{}  {}", item.name, item.text)
        } else {
            item.text.clone()
        };
        let item_color = if item.kind == "reasoning_text" || item.kind == "tool_call" {
            t.muted
        } else {
            t.ink
        };
        let mut line = label(
            value,
            if item.kind == "tool_call" { 12.5 } else { 14.0 },
            400.0,
            item_color,
        )
        .w_full();
        if item.kind == "user" {
            line = line.padding(14.0).radius(14.0).fill(t.hover);
        }
        transcript = transcript.child(line);
    }
    if let Some(error) = &s.studio.error {
        transcript = transcript.child(label(error.clone(), 12.5, 400.0, t.accent));
    }
    let art = if let Some(item) = s.studio.items.iter().find(|item| item.kind == "connected") {
        el().w_full().h(560.0).center().child(
            col()
                .items_center()
                .gap(12.0)
                .child(label("Today", 11.0, 400.0, t.muted))
                .child(
                    row()
                        .center_y()
                        .gap(6.0)
                        .child(connected_avatar())
                        .child(label(
                            format!("{} connected", item.text),
                            12.0,
                            400.0,
                            t.muted,
                        )),
                )
                .child(if let Some(source) = &s.studio.handoff_source {
                    row()
                        .center_y()
                        .gap(5.0)
                        .child(label("Handed from", 12.0, 400.0, t.muted))
                        .child(brand_mark(source, t))
                        .child(label(
                            if source == "claudeAgent" {
                                "Claude"
                            } else {
                                source
                            },
                            12.0,
                            400.0,
                            t.ink_soft,
                        ))
                } else {
                    el().h(0.0)
                }),
        )
    } else if s.studio.items.is_empty() {
        el().w_full().h(580.0).center().child(crate::codegolf::slot(
            mark,
            s.art_focused,
            [0.851, 0.475, 0.341, 0.06],
        ))
    } else {
        el()
    };
    col()
        .w_full()
        .grow(1.0)
        .shrink()
        .child(
            col()
                .key("studio-transcript")
                .w_full()
                .grow(1.0)
                .shrink()
                .scroll(ScrollSpec { stick_bottom: true })
                .child(art)
                .child(transcript),
        )
        .child(row().w_full().px(16.0).justify_center().child(dock))
        .child(el().h(32.0))
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use crate::state::{Page, Project, StudioItem};
    use rune::{Env, Runtime};
    use serde_json::json;

    #[test]
    fn saved_project_rows_are_mounted_and_clicking_a_row_changes_focus() {
        let mut s = AppState {
            page: Page::Studio,
            studio_layout_ready: true,
            ..Default::default()
        };
        s.projects = vec![
            Project {
                name: "first".into(),
                path: "/first".into(),
            },
            Project {
                name: "second".into(),
                path: "/second".into(),
            },
        ];
        s.selected_project = Some(0);
        s.studio.project_path = "/first".into();
        s.studio.thread_id = "a".into();
        s.studio.thread_open = true;
        s.studio_layout = json!({"version":2,"rows":[
            {"projectPath":"/first","focusedId":"a","panes":[{"id":"a","anchor":{"threadId":"a"}}]},
            {"projectPath":"/second","focusedId":"b","panes":[{"id":"b","anchor":{"threadId":"b"}}]}
        ]});
        s.studio_threads.insert(
            "b".into(),
            StudioState {
                thread_id: "b".into(),
                project_path: "/second".into(),
                thread_open: true,
                ..Default::default()
            },
        );
        let mut rt = Runtime::new(s, view, (1280.0, 840.0), Env::new(false, 1.0));
        rt.frame(0.0);
        assert!(rt.find("studio-row-slot-/first").is_some());
        assert!(rt.find("studio-row-slot-/second").is_some());
        let (x, y) = rt.find("studio-row-1").unwrap();
        rt.pointer_move(x, y);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);
        assert_eq!(rt.state.studio.project_path, "/second");
        assert_eq!(rt.state.studio.thread_id, "b");
        assert_eq!(rt.state.studio_layout["focusedRow"], "/second");
    }

    #[test]
    fn rail_renders_and_focuses_a_streaming_background_thread() {
        let mut s = AppState::default();
        s.page = Page::Studio;
        s.projects.push(Project {
            name: "demo".into(),
            path: "/demo".into(),
        });
        s.selected_project = Some(0);
        s.studio_layout_ready = true;
        s.studio_layout = json!({"version": 2, "focusedRow": "/demo", "rows": [{"projectPath":"/demo", "focusedId":"a", "panes":[
            {"id":"a", "anchor":{"threadId":"a"}, "width":0},
            {"id":"b", "anchor":{"threadId":"b"}, "width":0}
        ]}]});
        s.studio.thread_open = true;
        s.studio.thread_id = "a".into();
        s.studio.project_path = "/demo".into();
        s.studio.items.push(StudioItem {
            id: "one".into(),
            kind: "assistant_text".into(),
            text: "first response".into(),
            name: String::new(),
            ..Default::default()
        });
        s.studio_threads.insert(
            "b".into(),
            StudioState {
                thread_open: true,
                thread_id: "b".into(),
                project_path: "/demo".into(),
                items: vec![StudioItem {
                    id: "two".into(),
                    kind: "assistant_text".into(),
                    text: "background response".into(),
                    name: String::new(),
                    ..Default::default()
                }],
                ..Default::default()
            },
        );
        for (thread, content) in [("a", "foreground streaming"), ("b", "background streaming")] {
            s.studio_message(json!({"method":"agent.event", "params":{"threadId":thread, "type":"item.updated", "item":{"itemId":if thread == "a" { "one" } else { "two" }, "kind":"assistant_text", "text":content}}}));
        }
        let mut rt = Runtime::new(s, view, (1900.0, 800.0), Env::new(false, 1.0));
        rt.frame(0.0);
        assert!(rt.find("studio-pane-a").is_some());
        assert!(rt.find("studio-pane-b").is_some());
        assert!(
            rt.elements()
                .iter()
                .any(|e| e.text.as_deref() == Some("background streaming"))
        );
        let (x, y) = rt.find("studio-parked-b").unwrap();
        rt.pointer_move(x, y);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);
        assert_eq!(rt.state.studio.thread_id, "b");
        assert_eq!(rt.state.studio.items[0].text, "background streaming");
        assert_eq!(
            rt.state.studio_threads["a"].items[0].text,
            "foreground streaming"
        );
    }
}

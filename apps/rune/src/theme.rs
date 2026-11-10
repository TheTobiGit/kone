use rune::{Color, color::hex};

#[allow(dead_code)]
#[derive(Clone, Copy)]
pub struct Palette {
    pub dark: bool,
    pub ground: Color,
    pub raised: Color,
    pub sunken: Color,
    pub raised_high: Color,
    pub ink: Color,
    pub ink_soft: Color,
    pub muted: Color,
    pub faint: Color,
    pub placeholder: Color,
    pub line: Color,
    pub line_soft: Color,
    pub hover: Color,
    pub press: Color,
    pub accent: Color,
    pub accent_ink: Color,
    pub accent_wash: Color,
    pub folder: Color,
    pub warn: Color,
}

fn c(value: &str) -> Color {
    hex(value).expect("valid theme color")
}

impl Palette {
    pub fn new(dark: bool) -> Self {
        let ink = c(if dark { "#f4f4f5" } else { "#27272a" });
        let accent = c("#d97757");
        Self {
            dark,
            ground: c(if dark { "#070708" } else { "#f6f5f3" }),
            sunken: c(if dark { "#000000" } else { "#e9e8e5" }),
            raised: c(if dark { "#18181a" } else { "#fffefb" }),
            raised_high: c(if dark { "#212124" } else { "#ffffff" }),
            ink,
            ink_soft: c(if dark { "#f4f4f5" } else { "#52525b" }),
            muted: c(if dark { "#8a8a90" } else { "#9c9a94" }),
            faint: c(if dark { "#6b6b70" } else { "#b0afaa" }),
            placeholder: c(if dark { "#6b6b72" } else { "#b7b4ae" }),
            line: ink.alpha(0.1),
            line_soft: ink.alpha(0.06),
            hover: ink.alpha(if dark { 0.06 } else { 0.04 }),
            press: ink.alpha(if dark { 0.1 } else { 0.08 }),
            accent,
            accent_ink: c(if dark { "#1b0f0a" } else { "#ffffff" }),
            accent_wash: accent.alpha(0.1),
            folder: c("#c4a44a"),
            warn: c(if dark { "#c99b45" } else { "#a57c2b" }),
        }
    }
}

pub fn mix_srgb(a: Color, b: Color, fraction: f32) -> Color {
    let channel = |left: f32, right: f32| {
        rune::color::srgb_decode(
            rune::color::srgb_encode(left) * (1.0 - fraction)
                + rune::color::srgb_encode(right) * fraction,
        )
    };
    Color {
        r: channel(a.r, b.r),
        g: channel(a.g, b.g),
        b: channel(a.b, b.b),
        a: a.a * (1.0 - fraction) + b.a * fraction,
    }
}

//! kone's colour roles as data.
//!
//! A theme file holds the literal values a scheme was authored with; the roles
//! the web build writes as `color-mix(...)` are derived here, once, when the
//! scheme is resolved. The resolved [`Theme`] lives in a GPUI global, so
//! replacing it and refreshing the windows repaints everything that reads it.

mod color;

pub use color::Rgba;

use anyhow::{Context as _, Result};
use gpui_kit::{App, Global, Hsla, WindowAppearance};
use serde::Deserialize;

/// The built-in theme, compiled in so the app always has one to fall back to.
pub const KONE_JSON: &str = include_str!("../themes/kone.json");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scheme {
    Light,
    Dark,
}

impl From<WindowAppearance> for Scheme {
    fn from(a: WindowAppearance) -> Self {
        match a {
            WindowAppearance::Dark | WindowAppearance::VibrantDark => Scheme::Dark,
            WindowAppearance::Light | WindowAppearance::VibrantLight => Scheme::Light,
        }
    }
}

/// One appearance exactly as a theme file spells it.
#[derive(Clone, Debug, Deserialize)]
pub struct SchemeSpec {
    pub sunken: Rgba,
    pub ground: Rgba,
    pub raised: Rgba,
    pub raised_high: Rgba,
    pub overlay: Rgba,
    /// Absent means the rail sits on the ground.
    pub strip: Option<Rgba>,
    /// Absent means docked panes sit on the raised surface.
    pub panel: Option<Rgba>,
    pub field: Rgba,
    pub chip: Rgba,
    pub ink: Rgba,
    pub ink_soft: Rgba,
    pub muted: Rgba,
    pub faint: Rgba,
    pub placeholder: Rgba,
    pub line: Rgba,
    pub line_soft: Rgba,
    pub hover: Rgba,
    pub press: Rgba,
    pub accent: Rgba,
    pub accent_ink: Rgba,
    pub accent_secondary: Rgba,
    pub accent_secondary_ink: Rgba,
    pub highlight: Rgba,
    pub folder: Rgba,
    pub file: Rgba,
    pub ok: Rgba,
    pub warn: Rgba,
    pub danger: Rgba,
    pub diff_add: Rgba,
    /// Optional physical-folder pigments fall back to the shared addition role.
    #[serde(default)]
    pub folder_diff_add: Option<Rgba>,
    #[serde(default)]
    pub folder_mark_add: Option<Rgba>,
    pub diff_del: Rgba,
    pub diff_add_soft: Rgba,
    pub diff_del_soft: Rgba,
    /// How much ink tints the raised surface behind code.
    pub code_bg_mix: f32,
    pub plasma: [Rgba; 3],
}

#[derive(Clone, Debug, Deserialize)]
pub struct ThemeFile {
    pub id: String,
    pub label: String,
    pub light: SchemeSpec,
    /// A single-appearance theme omits the other scheme.
    pub dark: Option<SchemeSpec>,
}

impl ThemeFile {
    pub fn parse(json: &str) -> Result<Self> {
        serde_json::from_str(json).context("theme file is not valid kone theme JSON")
    }
}

/// Every role, resolved to a colour GPUI can paint.
#[derive(Clone, Debug)]
pub struct Palette {
    pub sunken: Rgba,
    pub ground: Rgba,
    pub band: Rgba,
    pub raised: Rgba,
    pub raised_high: Rgba,
    pub overlay: Rgba,
    pub strip: Rgba,
    pub panel: Rgba,
    pub field: Rgba,
    pub chip: Rgba,
    pub ink: Rgba,
    pub ink_soft: Rgba,
    pub muted: Rgba,
    pub faint: Rgba,
    pub placeholder: Rgba,
    pub line: Rgba,
    pub line_soft: Rgba,
    pub hover: Rgba,
    pub press: Rgba,
    pub selected: Rgba,
    pub focus: Rgba,
    pub accent: Rgba,
    pub accent_ink: Rgba,
    pub accent_wash: Rgba,
    pub accent_secondary: Rgba,
    pub accent_secondary_ink: Rgba,
    pub accent_secondary_wash: Rgba,
    pub highlight: Rgba,
    pub highlight_wash: Rgba,
    pub folder: Rgba,
    pub file: Rgba,
    pub agent: Rgba,
    pub ok: Rgba,
    pub warn: Rgba,
    pub danger: Rgba,
    pub diff_add: Rgba,
    pub folder_diff_add: Rgba,
    pub folder_mark_add: Rgba,
    pub diff_del: Rgba,
    pub diff_add_soft: Rgba,
    pub diff_del_soft: Rgba,
    pub code_bg: Rgba,
    pub plasma: [Rgba; 3],
}

impl Palette {
    pub fn resolve(s: &SchemeSpec) -> Self {
        Palette {
            sunken: s.sunken,
            ground: s.ground,
            band: s.ink.mix(0.02, s.ground),
            raised: s.raised,
            raised_high: s.raised_high,
            overlay: s.overlay,
            strip: s.strip.unwrap_or(s.ground),
            panel: s.panel.unwrap_or(s.raised),
            field: s.field,
            chip: s.chip,
            ink: s.ink,
            ink_soft: s.ink_soft,
            muted: s.muted,
            faint: s.faint,
            placeholder: s.placeholder,
            line: s.line,
            line_soft: s.line_soft,
            hover: s.hover,
            press: s.press,
            // `color-mix(in oklab, X p%, transparent)` keeps X's colour and
            // scales only its alpha, so these are plain alpha washes.
            selected: s.accent.alpha(0.12),
            focus: s.accent,
            accent: s.accent,
            accent_ink: s.accent_ink,
            accent_wash: s.accent.alpha(0.10),
            accent_secondary: s.accent_secondary,
            accent_secondary_ink: s.accent_secondary_ink,
            accent_secondary_wash: s.accent_secondary.alpha(0.10),
            highlight: s.highlight,
            highlight_wash: s.highlight.alpha(0.22),
            folder: s.folder,
            file: s.file,
            agent: s.accent,
            ok: s.ok,
            warn: s.warn,
            danger: s.danger,
            diff_add: s.diff_add,
            folder_diff_add: s.folder_diff_add.unwrap_or(s.diff_add),
            folder_mark_add: s.folder_mark_add.unwrap_or(s.diff_add),
            diff_del: s.diff_del,
            diff_add_soft: s.diff_add_soft,
            diff_del_soft: s.diff_del_soft,
            code_bg: s.ink.mix(s.code_bg_mix, s.raised),
            plasma: s.plasma,
        }
    }
}

/// The active theme: which file, which scheme, and its resolved palette.
#[derive(Clone, Debug)]
pub struct Theme {
    pub id: String,
    pub label: String,
    pub scheme: Scheme,
    pub colors: Palette,
    file: ThemeFile,
}

impl Global for Theme {}

impl Theme {
    pub fn from_file(file: ThemeFile, scheme: Scheme) -> Self {
        let spec = match scheme {
            Scheme::Dark => file.dark.as_ref().unwrap_or(&file.light),
            Scheme::Light => &file.light,
        };
        // A light-only theme asked for dark still reports what it paints.
        let scheme = if scheme == Scheme::Dark && file.dark.is_none() { Scheme::Light } else { scheme };
        Theme { id: file.id.clone(), label: file.label.clone(), scheme, colors: Palette::resolve(spec), file }
    }

    pub fn kone(scheme: Scheme) -> Self {
        let file = ThemeFile::parse(KONE_JSON).expect("the built-in theme parses");
        Self::from_file(file, scheme)
    }

    pub fn is_dark(&self) -> bool {
        self.scheme == Scheme::Dark
    }

    pub fn get(cx: &App) -> &Theme {
        cx.global::<Theme>()
    }

    /// Install the kone theme for the system's current appearance.
    pub fn init(cx: &mut App) {
        let scheme = Scheme::from(cx.window_appearance());
        cx.set_global(Theme::kone(scheme));
    }

    /// Swap in another theme file, keeping the current scheme, and repaint.
    pub fn load(json: &str, cx: &mut App) -> Result<()> {
        let file = ThemeFile::parse(json)?;
        let scheme = cx.global::<Theme>().scheme;
        cx.set_global(Theme::from_file(file, scheme));
        cx.refresh_windows();
        Ok(())
    }

    /// Re-resolve the same theme for another appearance, and repaint.
    pub fn set_scheme(scheme: Scheme, cx: &mut App) {
        let current = cx.global::<Theme>();
        if current.scheme == scheme {
            return;
        }
        let next = Theme::from_file(current.file.clone(), scheme);
        cx.set_global(next);
        cx.refresh_windows();
    }
}

/// Shorthand for turning a role into a GPUI colour at a call site.
pub fn hsla(c: Rgba) -> Hsla {
    c.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kone_parses_both_schemes() {
        let light = Theme::kone(Scheme::Light);
        let dark = Theme::kone(Scheme::Dark);
        assert_eq!(light.colors.ground, Rgba::hex(0xf6f5f3));
        assert_eq!(dark.colors.ground, Rgba::hex(0x070708));
        assert_eq!(light.colors.strip, light.colors.ground);
        assert_eq!(dark.colors.panel, dark.colors.raised);
    }

    #[test]
    fn light_only_theme_falls_back() {
        let mut file = ThemeFile::parse(KONE_JSON).unwrap();
        file.dark = None;
        let t = Theme::from_file(file, Scheme::Dark);
        assert_eq!(t.scheme, Scheme::Light);
    }
}

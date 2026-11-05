//! Shared modal surfaces, dimensions and input styling.
use gpui_kit::base::input::InputEditorStyle;
use gpui_kit::*;
use kone_theme::{Palette, hsla};

#[cfg(target_os = "linux")]
pub(crate) const MONO: &str = "DejaVu Sans Mono";
#[cfg(not(target_os = "linux"))]
pub(crate) const MONO: &str = "Menlo";
/// The card's fixed frame pieces. The browser's body carries the rest.
pub(crate) const HEADER_H: f32 = 37.;
pub(crate) const FOOTER_H: f32 = 37.;
/// The concave corner radius where a band meets a side wall.
pub(crate) const BAND_ARC: f32 = 14.;
/// The browser's breathing room between the bands and the list.
pub(crate) const BAND_GAP: f32 = 16.;
pub(crate) const CARD_WIDTH: f32 = 448.;
pub(crate) fn input_style(colors: &Palette, focused: bool) -> InputEditorStyle {
    let ink = if focused { colors.ink } else { colors.muted };
    InputEditorStyle {
        foreground: hsla(ink),
        muted_foreground: hsla(colors.muted),
        // A hair of alpha keeps the editor from treating the field as unset
        // and painting a host surface behind the text. The band stays visible.
        background: hsla(colors.band.alpha(0.001)),
        border: hsla(colors.line_soft),
        selection: hsla(colors.accent.alpha(0.24)),
        caret: hsla(ink),
        ..Default::default()
    }
}

/// Paints the header band and its two concave scoops. The path starts along the
/// top edge, comes down the right wall into a quarter-circle bite, crosses the
/// band's lower edge, and mirrors back up the left wall.
pub(crate) fn paint_header_band(bounds: Bounds<Pixels>, color: Hsla, window: &mut Window) {
    paint_header_band_height(bounds, color, HEADER_H, window);
}

pub(crate) fn paint_header_band_height(
    bounds: Bounds<Pixels>,
    color: Hsla,
    band: f32,
    window: &mut Window,
) {
    let (x, y) = (f32::from(bounds.origin.x), f32::from(bounds.origin.y));
    let width = f32::from(bounds.size.width);
    let arc = BAND_ARC;

    let k = 0.552_284_8 * arc;
    let mut path = PathBuilder::fill();
    path.move_to(point(px(x), px(y)));
    path.line_to(point(px(x + width), px(y)));
    path.line_to(point(px(x + width), px(y + band + arc)));
    path.cubic_bezier_to(
        point(px(x + width - arc), px(y + band)),
        point(px(x + width), px(y + band + arc - k)),
        point(px(x + width - arc + k), px(y + band)),
    );
    path.line_to(point(px(x + arc), px(y + band)));
    path.cubic_bezier_to(
        point(px(x), px(y + band + arc)),
        point(px(x + arc - k), px(y + band)),
        point(px(x), px(y + band + arc - k)),
    );
    path.close();
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
}

/// Paints the footer band and its scoops, which bite upward into the list so
/// the two bands read as facing each other.
pub(crate) fn paint_footer_band(bounds: Bounds<Pixels>, color: Hsla, window: &mut Window) {
    let (x, y) = (f32::from(bounds.origin.x), f32::from(bounds.origin.y));
    let width = f32::from(bounds.size.width);
    let arc = BAND_ARC;
    let band = FOOTER_H;
    let k = 0.552_284_8 * arc;
    let mut path = PathBuilder::fill();
    path.move_to(point(px(x), px(y)));
    path.line_to(point(px(x), px(y + arc + band)));
    path.line_to(point(px(x + width), px(y + arc + band)));
    path.line_to(point(px(x + width), px(y)));
    path.cubic_bezier_to(
        point(px(x + width - arc), px(y + arc)),
        point(px(x + width), px(y + k)),
        point(px(x + width - arc + k), px(y + arc)),
    );
    path.line_to(point(px(x + arc), px(y + arc)));
    path.cubic_bezier_to(
        point(px(x), px(y)),
        point(px(x + arc - k), px(y + arc)),
        point(px(x), px(y + arc - k)),
    );
    path.close();
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
}

//! The rich-text model's value types: inline marks, paragraph blocks and their palette.

use std::ops::Range;

use crate::color::{oklch, oklcha, Color};

/// Maximum nesting level (`0..=MAX_LIST_LEVEL`) for [`Block::Bullet`] and [`Block::Numbered`].
pub const MAX_LIST_LEVEL: u8 = 3;

/// An inline formatting mark stored alongside [`TextEdit::text`]. More marks may come, so a
/// `match` needs a `_` arm.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Mark {
    Bold,
    Italic,
    Underline,
    Strike,
    Code,
    Link(String),
    /// A named, theme-aware highlight wash.
    Highlight(String),
    /// A named, theme-aware foreground pen.
    TextColor(String),
    /// An atomic inline object (an `@file` or `@agent` mention, an attachment) carrying the
    /// app's id; its text is the label. The caret steps over it, deleting takes it whole, a
    /// selection that touches it covers it, and typing never extends it. A field draws it as a
    /// chip ([`El::pill_style`](crate::El::pill_style), [`El::pill_colors`](crate::El::pill_colors),
    /// [`El::pill_icon`](crate::El::pill_icon)). Insert one with [`TextEdit::insert_pill`].
    Pill(String),
}

impl Mark {
    /// Whether `self` and `other` are the same kind of mark (`Link(_)` matches any `Link(_)`).
    pub fn same_kind(&self, other: &Mark) -> bool {
        match (self, other) {
            (Mark::Bold, Mark::Bold)
            | (Mark::Italic, Mark::Italic)
            | (Mark::Underline, Mark::Underline)
            | (Mark::Strike, Mark::Strike)
            | (Mark::Code, Mark::Code)
            | (Mark::Link(_), Mark::Link(_))
            | (Mark::Pill(_), Mark::Pill(_))
            | (Mark::Highlight(_), Mark::Highlight(_))
            | (Mark::TextColor(_), Mark::TextColor(_)) => true,
            _ => false,
        }
    }

    /// The URL when `self` is [`Mark::Link`].
    pub fn link_url(&self) -> Option<&str> {
        match self {
            Mark::Link(url) => Some(url),
            _ => None,
        }
    }

    /// The app's id when `self` is [`Mark::Pill`].
    pub fn pill_id(&self) -> Option<&str> {
        match self {
            Mark::Pill(id) => Some(id),
            _ => None,
        }
    }

    pub(crate) fn is_pill(&self) -> bool {
        matches!(self, Mark::Pill(_))
    }

    pub(crate) fn kind_order(&self) -> u8 {
        match self {
            Mark::Bold => 0,
            Mark::Italic => 1,
            Mark::Underline => 2,
            Mark::Strike => 3,
            Mark::Code => 4,
            Mark::Link(_) => 5,
            Mark::Pill(_) => 6,
            Mark::Highlight(_) => 7,
            Mark::TextColor(_) => 8,
        }
    }
}

/// A non-empty byte range `[start, end)` in [`TextEdit::text`] carrying an inline [`Mark`].
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct MarkRange {
    pub start: usize,
    pub end: usize,
    pub mark: Mark,
}

impl MarkRange {
    pub fn new(range: Range<usize>, mark: Mark) -> Self {
        Self { start: range.start, end: range.end, mark }
    }

    pub fn range(&self) -> Range<usize> {
        self.start..self.end
    }
}

/// Paragraph-level block attribute for a `\n`-delimited line in [`TextEdit`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Block {
    #[default]
    Paragraph,
    /// Heading level, clamped to one through six when displayed.
    Heading(u8),
    /// A task list item and its checked state.
    Task(bool),
    /// Bullet list item (`•`, `◦`, `▪`) at nesting level `0..=MAX_LIST_LEVEL`.
    Bullet(u8),
    /// Numbered list item (`1.`, `2.`, …) at nesting level `0..=MAX_LIST_LEVEL`.
    Numbered(u8),
    /// Indented quote paragraph with a vertical left bar.
    Quote,
    /// Monospace code block line with a background fill; inline marks do not apply.
    Code,
}

impl Block {
    pub fn is_list(self) -> bool {
        matches!(self, Block::Bullet(_) | Block::Numbered(_) | Block::Task(_))
    }

    pub fn list_level(self) -> Option<u8> {
        match self {
            Block::Bullet(l) | Block::Numbered(l) => Some(l),
            _ => None,
        }
    }

    pub fn with_level(self, level: u8) -> Self {
        let l = level.min(MAX_LIST_LEVEL);
        match self {
            Block::Bullet(_) => Block::Bullet(l),
            Block::Numbered(_) => Block::Numbered(l),
            other => other,
        }
    }

    /// Whether `self` and `other` share the same block kind (ignoring list nesting level).
    pub fn same_kind(self, other: Block) -> bool {
        matches!(
            (self, other),
            (Block::Paragraph, Block::Paragraph)
                | (Block::Bullet(_), Block::Bullet(_))
                | (Block::Numbered(_), Block::Numbered(_))
                | (Block::Quote, Block::Quote)
                | (Block::Code, Block::Code)
                | (Block::Heading(_), Block::Heading(_))
                | (Block::Task(_), Block::Task(_))
        )
    }

    /// This block's kind as one bit, for [`TextEdit::allow_blocks`].
    pub(super) fn kind_bit(self) -> u8 {
        1 << match self {
            Block::Paragraph => 0,
            Block::Bullet(_) => 1,
            Block::Numbered(_) => 2,
            Block::Quote => 3,
            Block::Code => 4,
            Block::Heading(_) => 5,
            Block::Task(_) => 6,
        }
    }

    /// Left indentation in points (before scale) for this block type.
    pub(crate) fn indent_pt(self, font_size: f32) -> f32 {
        let unit = (font_size * 1.45).round().max(18.0);
        match self {
            Block::Paragraph | Block::Heading(_) => 0.0,
            Block::Task(_) => font_size * 1.25,
            Block::Bullet(l) | Block::Numbered(l) => unit * (l.min(MAX_LIST_LEVEL) as f32 + 1.0),
            Block::Quote => (font_size * 1.1).round().max(14.0),
            Block::Code => (font_size * 0.75).round().max(10.0),
        }
    }
}

/// A paragraph slice of [`TextEdit`], returned by [`TextEdit::paragraphs`].
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct ParagraphInfo {
    pub index: usize,
    pub range: Range<usize>,
    pub block: Block,
    /// True when this line was split from the previous line by `Shift+Return` (`<br>`).
    pub soft_break: bool,
}

/// Visual palette for rich marks and block attributes inside [`text_input`](crate::text_input).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RichStyle {
    /// Resolve named pens with the dark document palette.
    pub dark: bool,
    /// CSS-like document paragraph margins and block typography.
    pub document_spacing: bool,
    /// Transient padding at a browser-generated code caret spacer; never serialized.
    pub code_caret_spacer: Option<usize>,
    pub code_fg: Option<Color>,
    pub code_bg: Color,
    pub code_block_bg: Color,
    pub link: Color,
    pub quote_bar: Color,
    pub marker: Option<Color>,
}

impl Default for RichStyle {
    fn default() -> Self {
        Self {
            dark: false,
            document_spacing: false,
            code_caret_spacer: None,
            code_fg: None,
            code_bg: oklcha(0.55, 0.02, 260.0, 0.16),
            code_block_bg: oklcha(0.5, 0.02, 260.0, 0.12),
            link: oklch(0.68, 0.16, 250.0),
            quote_bar: oklcha(0.6, 0.04, 255.0, 0.45),
            marker: None,
        }
    }
}

impl RichStyle {
    /// Resolve a stored pen name without baking the current theme into document HTML.
    pub fn pen_color(self, name: &str, highlight: bool) -> Color {
        use crate::color::hex;
        let (rgb, alpha) = if highlight {
            match (name, self.dark) {
                ("amber", _) => ("#eab308", 0.32),
                ("moss", false) => ("#10b981", 0.26),
                ("moss", true) => ("#10b981", 0.30),
                ("sky", false) => ("#3884ff", 0.22),
                ("sky", true) => ("#5698ff", 0.32),
                ("orchid", false) => ("#a76af0", 0.24),
                ("orchid", true) => ("#b27cf5", 0.32),
                (_, false) => ("#d97757", 0.30),
                (_, true) => ("#d97757", 0.36),
            }
        } else {
            (match (name, self.dark) {
                ("moss", false) => "#3f9e6f", ("moss", true) => "#5fc294",
                ("sky", false) => "#4d86d8", ("sky", true) => "#7fa9f0",
                ("orchid", false) => "#9268c9", ("orchid", true) => "#b58ae0",
                ("ash", false) => "#8a8a90", ("ash", true) => "#9c9ca4",
                (_, false) => "#c1613f", (_, true) => "#e8907a",
            }, 1.0)
        };
        hex(rgb).unwrap_or(Color::TRANSPARENT).alpha(alpha)
    }
}

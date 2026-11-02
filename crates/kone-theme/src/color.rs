use gpui_kit::Hsla;
use serde::{Deserialize, Deserializer, de::Error as _};

/// A straight sRGB colour, the space every theme value is authored in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Rgba {
    pub const fn hex(h: u32) -> Self {
        Rgba {
            r: ((h >> 16) & 255) as f32 / 255.,
            g: ((h >> 8) & 255) as f32 / 255.,
            b: (h & 255) as f32 / 255.,
            a: 1.,
        }
    }

    /// `#rgb`, `#rrggbb` or `#rrggbbaa`.
    pub fn parse(s: &str) -> Option<Self> {
        let h = s.strip_prefix('#')?;
        let byte = |i: usize| u8::from_str_radix(h.get(i..i + 2)?, 16).ok().map(|v| v as f32 / 255.);
        match h.len() {
            3 => {
                let n = |i: usize| u8::from_str_radix(&h[i..i + 1], 16).ok().map(|v| (v * 17) as f32 / 255.);
                Some(Rgba { r: n(0)?, g: n(1)?, b: n(2)?, a: 1. })
            }
            6 => Some(Rgba { r: byte(0)?, g: byte(2)?, b: byte(4)?, a: 1. }),
            8 => Some(Rgba { r: byte(0)?, g: byte(2)?, b: byte(4)?, a: byte(6)? }),
            _ => None,
        }
    }

    /// `color-mix(in srgb, self p, other)`, with `p` in 0..=1.
    pub fn mix(self, p: f32, other: Rgba) -> Rgba {
        let q = 1. - p;
        Rgba {
            r: self.r * p + other.r * q,
            g: self.g * p + other.g * q,
            b: self.b * p + other.b * q,
            a: self.a * p + other.a * q,
        }
    }

    /// The same colour at a new opacity.
    pub fn alpha(self, a: f32) -> Rgba {
        Rgba { a, ..self }
    }
}

impl From<Rgba> for Hsla {
    fn from(c: Rgba) -> Hsla {
        gpui_kit::Rgba { r: c.r, g: c.g, b: c.b, a: c.a }.into()
    }
}

impl<'de> Deserialize<'de> for Rgba {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Rgba::parse(&s).ok_or_else(|| D::Error::custom(format!("not a hex colour: {s}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_alpha_hex() {
        let c = Rgba::parse("#27272a1a").unwrap();
        assert!((c.a - 0.102).abs() < 0.01);
        assert_eq!(Rgba::parse("#fff"), Some(Rgba::hex(0xffffff)));
    }
}

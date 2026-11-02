use std::borrow::Cow;

use anyhow::Result;
use gpui_kit::{App, AssetSource, SharedString};

/// Icons are compiled in so the binary runs from anywhere.
pub struct Assets;

macro_rules! icons {
    ($($name:literal),* $(,)?) => {
        &[$(($name, include_bytes!(concat!("../assets/icons/", $name)) as &[u8])),*]
    };
}

const ICONS: &[(&str, &[u8])] = icons![
    "arrow-down.svg",
    "branch.svg",
    "cancel.svg",
    "finder.svg",
    "folder-open.svg",
    "gh-mark.svg",
    "github.svg",
    "pin.svg",
    "plus.svg",
    "search.svg",
    "settings.svg",
];

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        let name = path.strip_prefix("icons/").unwrap_or(path);
        if let Some((_, bytes)) = ICONS.iter().find(|(n, _)| *n == name) {
            return Ok(Some(Cow::Borrowed(bytes)));
        }
        // Kit's own icons still resolve through its bundled set.
        gpui_kit::assets::Assets.load(path)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        gpui_kit::assets::Assets.list(path)
    }
}

pub fn load_fonts(cx: &mut App) -> Result<()> {
    cx.text_system().add_fonts(vec![
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-Regular.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-Medium.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-SemiBold.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-Bold.ttf")),
    ])
}

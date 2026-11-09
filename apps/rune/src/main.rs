mod state;
mod theme;
mod ui;

use rune::{App, AppSpec, FontSmoothing};
use state::{AppState, Page};

const FONTS: &[&[u8]] = &[
    include_bytes!("../assets/fonts/Geist-Regular.ttf"),
    include_bytes!("../assets/fonts/Geist-Medium.ttf"),
    include_bytes!("../assets/fonts/Geist-SemiBold.ttf"),
    include_bytes!("../assets/fonts/Geist-Bold.ttf"),
];

fn main() {
    let spec: AppSpec<AppState> = AppSpec {
        min_size: Some((960.0, 640.0)),
        fonts: FONTS,
        families: ("Geist", "ui-monospace"),
        scenes: &[
            ("empty", |s| s.page = Page::Empty),
            ("projects", |s| {
                s.example_project();
                s.page = Page::Projects;
            }),
            ("overview", |s| {
                s.example_project();
                s.page = Page::Overview;
            }),
            ("studio", |s| {
                s.example_project();
                s.page = Page::Studio;
            }),
        ],
        ..AppSpec::new("kone", (1280.0, 840.0), AppState::default, ui::view)
    };
    App::new(spec).font_smoothing(FontSmoothing::Off).run();
}

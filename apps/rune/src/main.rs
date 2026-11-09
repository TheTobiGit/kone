mod bridge;
#[allow(dead_code)]
#[path = "art/codegolf.rs"]
mod codegolf;
mod launcher;
mod plasma;
mod project_state;
mod review;
mod state;
mod theme;
mod ui;

use rune::{App, AppSpec, FontSmoothing};
use state::{AppState, Page};

const FONTS: &[&[u8]] = &[
    include_bytes!("../assets/fonts/GeistMono-Variable.ttf"),
    include_bytes!("../assets/fonts/Fraunces-Variable.ttf"),
    include_bytes!("../assets/fonts/Geist-Regular.ttf"),
    include_bytes!("../assets/fonts/Geist-Medium.ttf"),
    include_bytes!("../assets/fonts/Geist-SemiBold.ttf"),
    include_bytes!("../assets/fonts/Geist-Bold.ttf"),
];

fn main() {
    let spec: AppSpec<AppState> = AppSpec {
        min_size: Some((960.0, 640.0)),
        fonts: FONTS,
        setup: Some(app_setup),
        poll: Some(AppState::poll),
        on_key: Some(app_key),
        families: ("Geist", "Geist Mono"),
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
            ("studio-review", studio_review),
            ("projects-review", |s| review::populate(s, Page::Projects)),
            ("overview-review", |s| review::populate(s, Page::Overview)),
            ("studio", |s| {
                s.example_project();
                s.page = Page::Studio;
            }),
        ],
        ..AppSpec::new("kone", (1280.0, 840.0), AppState::default, ui::view)
    };
    App::new(spec)
        .chrome(rune::Chrome {
            full_size_content: true,
            traffic_lights: None,
            drag_regions: true,
        })
        .window_options(rune::WindowOptions {
            transparent: true,
            ..Default::default()
        })
        .standard_menus()
        .on_focus(|s, focused, _| s.art_focused = focused)
        .font_smoothing(FontSmoothing::Off)
        .compositor(plasma::Plasma::default())
        .run();
}

fn studio_review(s: &mut AppState) {
    use state::{Project, StudioModel, StudioProvider, StudioState};
    s.projects = vec![Project {
        name: "kone".into(),
        path: "/demo".into(),
    }];
    s.selected_project = Some(0);
    s.page = Page::Studio;
    s.studio_layout_ready = true;
    s.studio_layout = serde_json::json!({"version":2,"rows":[{"projectPath":"/demo","focusedId":"review-one","panes":[
        {"id":"review-one","kind":"thread","width":0,"anchor":{"kind":"thread","threadId":"review-one"}},
        {"id":"review-two","kind":"thread","width":0,"anchor":{"kind":"thread","threadId":"review-two"}}
    ]}]});
    s.studio.thread_open = true;
    s.studio.composer_open = true;
    s.studio.thread_id = "review-one".into();
    s.studio.project_path = "/demo".into();
    s.studio.providers = vec![StudioProvider {
        id: "codex".into(),
        label: "Codex".into(),
    }];
    s.studio.models = vec![StudioModel {
        id: "gpt-6.1-terra".into(),
        label: "GPT-6.1 Terra".into(),
        efforts: vec!["low".into(), "medium".into(), "high".into()],
        default_effort: Some("medium".into()),
    }];
    let second = StudioState {
        thread_open: true,
        composer_open: true,
        thread_id: "review-two".into(),
        project_path: "/demo".into(),
        ..StudioState::default()
    };
    s.studio_threads.insert("review-two".into(), second);
}

fn app_key(s: &mut AppState, event: &rune::KeyEvent, tx: &mut rune::Tx) -> bool {
    for (key, action) in [('q', 0), ('w', 1), ('m', 2)] {
        if event.is_command(key) {
            match action {
                0 => tx.quit(),
                1 => tx.close_window(),
                _ => tx.minimize(),
            }
            return true;
        }
    }
    if s.launcher.mode.is_some() {
        return false;
    }
    if event.is_command('b') || (s.page == Page::Studio && event.key == rune::Key::Escape) {
        if s.page == Page::Studio {
            s.page = if s.selected_project.is_some() {
                Page::Overview
            } else if s.projects.is_empty() {
                Page::Empty
            } else {
                Page::Projects
            };
        } else {
            s.enter_studio();
        }
        return true;
    }
    if s.page == Page::Projects && event.is_command('k') {
        s.search.focused = true;
        return true;
    }
    AppState::studio_key(s, event, tx)
}

fn app_setup(s: &mut AppState, wake: rune::Waker) {
    if std::env::args().any(|arg| arg == "--scene" || arg.starts_with("--scene=")) {
        return;
    }
    AppState::setup(s, wake);
}

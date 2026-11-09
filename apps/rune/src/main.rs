mod bridge;
mod launcher;
mod plasma;
mod project_state;
mod state;
mod theme;
mod ui;

use rune::{App, AppSpec, FontSmoothing};
use state::{AppState, Page};

const FONTS: &[&[u8]] = &[
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
        setup: Some(AppState::setup),
        poll: Some(AppState::poll),
        on_key: Some(AppState::studio_key),
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
            ("studio-review", studio_review),
            ("studio", |s| {
                s.example_project();
                s.page = Page::Studio;
            }),
        ],
        ..AppSpec::new("kone", (1280.0, 840.0), AppState::default, ui::view)
    };
    App::new(spec).chrome(rune::Chrome { full_size_content: true, traffic_lights: Some((16.0, 6.0)), drag_regions: true }).on_focus(|s, focused, _| s.art_focused = focused).font_smoothing(FontSmoothing::Off).compositor(plasma::Plasma::default()).run();
}

fn studio_review(s: &mut AppState) {
    use state::{Project, StudioState, StudioProvider, StudioModel};
    s.projects = vec![Project { name: "kone".into(), path: "/demo".into() }];
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
    s.studio.providers = vec![StudioProvider { id:"codex".into(), label:"Codex".into() }];
    s.studio.models = vec![StudioModel { id:"gpt-6.1-terra".into(), label:"GPT-6.1 Terra".into(), efforts:vec!["low".into(),"medium".into(),"high".into()], default_effort:Some("medium".into()) }];
    let mut second = StudioState::default();
    second.thread_open = true;
    second.composer_open = true;
    second.thread_id = "review-two".into();
    second.project_path = "/demo".into();
    s.studio_threads.insert("review-two".into(), second);
}

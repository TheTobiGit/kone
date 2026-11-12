mod bridge;
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
    include_bytes!("../assets/fonts/Fraunces-Regular.ttf"),
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
            // The start screen with its wordmark on the brand word, `make it kone.`.
            ("empty-brand", |s| {
                s.page = Page::Empty;
                s.start_actions.word = 4;
            }),
            ("launcher-create", |s| {
                s.page = Page::Empty;
                s.start_actions.word = 4;
                s.launcher.fixture(crate::launcher::LauncherMode::Create);
            }),
            ("launcher-open", |s| {
                s.page = Page::Empty;
                s.start_actions.word = 4;
                s.launcher.fixture(crate::launcher::LauncherMode::Open);
            }),
            ("launcher-create-browser", |s| {
                s.page = Page::Empty;
                s.start_actions.word = 4;
                s.launcher.fixture_create_browser();
            }),
            ("launcher-create-progress", |s| {
                s.page = Page::Empty;
                s.start_actions.word = 4;
                s.launcher.fixture_create_progress();
            }),
            ("launcher-clone", |s| {
                s.page = Page::Empty;
                s.start_actions.word = 4;
                s.launcher.fixture(crate::launcher::LauncherMode::Clone);
            }),
            ("launcher-more", |s| {
                s.page = Page::Empty;
                s.start_actions.word = 4;
                s.launcher.fixture_more();
            }),
            ("launcher-more-remote", |s| {
                s.page = Page::Empty;
                s.start_actions.word = 4;
                s.launcher.fixture_more_remote();
            }),
            ("launcher-clone-progress", |s| {
                s.page = Page::Empty;
                s.start_actions.word = 4;
                // Where Electron's mock ramp was caught, so the bar and readout agree.
                let progress = std::env::var("KONE_SCENE_PROGRESS")
                    .ok()
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(0.37);
                s.launcher
                    .fixture_clone_progress(progress, "Compressing objects…");
            }),
            ("projects", |s| {
                s.example_project();
                s.page = Page::Projects;
            }),
            ("overview", |s| {
                s.example_project();
                s.page = Page::Overview;
            }),
            ("studio-review", studio_review),
            ("studio-column-head", studio_column_head),
            ("studio-column-head-hover", |s| {
                studio_column_head(s);
                s.studio_column_hover = Some("review-one".into());
            }),
            ("studio-column-head-tooltip", |s| {
                studio_column_head(s);
                s.studio_column_hover = Some("review-one".into());
                s.studio.head_tooltip = Some("Hand off to another provider".into());
            }),
            ("studio-column-head-meter-calm", |s| {
                studio_column_head(s);
                s.studio.context_usage = Some((40_000, 200_000));
            }),
            ("studio-column-head-meter-warm", |s| {
                studio_column_head(s);
                s.studio.context_usage = Some((150_000, 200_000));
            }),
            ("studio-column-head-meter-full", |s| {
                studio_column_head(s);
                s.studio.context_usage = Some((190_000, 200_000));
            }),
            ("studio-column-head-meter-open", |s| {
                studio_column_head(s);
                s.studio.context_usage = Some((40_000, 200_000));
                s.studio.context_open = true;
                s.studio.context_auto_compact = true;
                s.studio.providers[0].supports_compaction = false;
                s.studio_column_hover = Some("review-one".into());
            }),
            ("studio-column-head-dormant", |s| {
                studio_column_head(s);
                s.studio.dormant = true;
                s.studio.context_usage = None;
            }),
            ("studio-column-head-terminal-live", |s| {
                studio_column_head(s);
                s.studio.terminal_command = Some("npm run dev".into());
            }),
            ("studio-column-head-handoff", |s| {
                studio_column_head(s);
                s.studio.handoff_source = Some("claudeAgent".into());
            }),
            ("studio-three-review", |s| {
                studio_review(s);
                s.studio.composer_open = false;
                s.studio_layout["rows"][0]["panes"].as_array_mut().unwrap().push(serde_json::json!({"id":"review-three","kind":"thread","width":0,"anchor":{"kind":"thread","threadId":"review-three"}}));
            }),
            ("studio-bare-board", |s| {
                studio_review(s);
                s.projects[0].path = "/review/kone".into();
                s.studio_layout["rows"][0]["projectPath"] = serde_json::json!("/review/kone");
                s.studio_layout["rows"][0]["panes"] = serde_json::json!([]);
            }),
            ("studio-solo-review", |s| {
                studio_review(s);
                s.studio.composer_open = false;
                if let Some(panes) = s.studio_layout["rows"][0]["panes"].as_array_mut() {
                    panes.truncate(1);
                }
            }),
            ("projects-review", |s| review::populate(s, Page::Projects)),
            ("projects-skeletons", |s| {
                review::populate(s, Page::Projects);
                s.project_data.lazy.ready = 0;
                s.project_data.lazy.reveal = Some(0.0);
            }),
            ("projects-repo", |s| {
                review::populate(s, Page::Projects);
                s.projects = vec![state::Project {
                    name: "nxui".into(),
                    path: "/Users/you/Developer/nxui".into(),
                }];
                s.project_data.summaries.insert(
                    "/Users/you/Developer/nxui".into(),
                    serde_json::json!({"branch":"main", "changes":[]}),
                );
            }),
            ("projects-changed", |s| {
                review::populate(s, Page::Projects);
                s.projects = vec![state::Project {
                    name: "kone".into(),
                    path: "/Users/you/Developer/kone".into(),
                }];
                s.project_data.summaries.insert(
                    "/Users/you/Developer/kone".into(),
                    serde_json::from_str(include_str!("../assets/fixtures/project-status.json"))
                        .expect("valid status fixture"),
                );
            }),
            ("projects-grid", |s| {
                review::populate(s, Page::Projects);
                s.projects.push(state::Project {
                    name: "nova".into(),
                    path: "/review/nova".into(),
                });
                s.projects.push(state::Project {
                    name: "atlas".into(),
                    path: "/review/atlas".into(),
                });
            }),
            ("overview-review", |s| review::populate(s, Page::Overview)),
            ("overview-pills", |s| review::overview_pills(s)),
            ("overview-skeletons", |s| {
                review::populate(s, Page::Overview);
                s.project_data.sessions.retain(|row| !row.pinned);
                s.project_data.lazy.ready = 0;
                s.project_data.lazy.reveal = Some(0.0);
            }),
            ("overview-loading", |s| {
                review::overview_greeting(s, "loading")
            }),
            ("overview-nonrepo", |s| {
                review::overview_greeting(s, "nonrepo")
            }),
            ("overview-fresh", |s| review::overview_greeting(s, "fresh")),
            ("overview-fresh-dirty", |s| {
                review::overview_greeting(s, "fresh-dirty")
            }),
            ("overview-fresh-unstaged", |s| {
                review::overview_greeting(s, "fresh-unstaged")
            }),
            ("overview-switcher", |s| {
                review::overview_greeting(s, "nonrepo");
                s.projects.push(state::Project {
                    name: "nova".into(),
                    path: "/review/nova".into(),
                });
                s.projects.push(state::Project {
                    name: "atlas".into(),
                    path: "/review/atlas".into(),
                });
                s.overview_switcher_open = true;
            }),
            ("overview-cycle", |s| {
                review::overview_greeting(s, "nonrepo");
                s.projects.push(state::Project {
                    name: "nova".into(),
                    path: "/review/nova".into(),
                });
                s.projects.push(state::Project {
                    name: "atlas".into(),
                    path: "/review/atlas".into(),
                });
                s.cycle_paths = s.projects.iter().map(|p| p.path.clone()).collect();
                s.cycle_index = 1;
            }),
            ("overview-clean", |s| review::overview_greeting(s, "clean")),
            ("overview-dirty", |s| review::overview_greeting(s, "dirty")),
            ("overview-cards", |s| review::overview_greeting(s, "cards")),
            ("overview-staged", |s| {
                review::overview_greeting(s, "staged")
            }),
            ("overview-dirty-no-stat", |s| {
                review::overview_greeting(s, "dirty-no-stat")
            }),
            ("overview-ahead", |s| review::overview_greeting(s, "ahead")),
            ("overview-behind", |s| {
                review::overview_greeting(s, "behind")
            }),
            ("overview-diverged", |s| {
                review::overview_greeting(s, "diverged")
            }),
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
            hide_traffic_lights: true,
            resize_border: 3.0,
        })
        .window_options(rune::WindowOptions {
            transparent: true,
            borderless: cfg!(target_os = "linux"),
            ..Default::default()
        })
        .modifier_keys()
        .standard_menus()
        .on_focus(|s, focused, _| {
            s.art_focused = focused;
            if !focused {
                s.cycle_paths.clear();
            }
        })
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
        supports_compaction: true,
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

fn studio_column_head(s: &mut AppState) {
    studio_review(s);
    s.studio_layout["rows"][0]["panes"]
        .as_array_mut()
        .unwrap()
        .truncate(1);
    s.studio.composer_open = false;
    s.studio.context_usage = Some((40_000, 200_000));
    s.studio.providers[0].id = "gpt".into();
    s.studio.items.push(state::StudioItem {
        kind: "connected".into(),
        text: "Cinder".into(),
        ..Default::default()
    });
    s.studio.title = "Review thread".into();
    s.studio.worktree_path = Some("/tmp/kone-review-worktree".into());
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
    if s.page == Page::Overview {
        if event.key == rune::Key::Escape && (!s.cycle_paths.is_empty() || s.overview_switcher_open)
        {
            s.cycle_paths.clear();
            s.overview_switcher_open = false;
            return true;
        }
        if event.key == rune::Key::Tab && event.mods.ctrl {
            if s.cycle_paths.is_empty()
                && let Some(current) = s.selected_project.and_then(|i| s.projects.get(i))
            {
                let mut others: Vec<_> = s
                    .projects
                    .iter()
                    .filter(|p| p.path != current.path)
                    .collect();
                others.sort_by_key(|p| {
                    std::cmp::Reverse(
                        s.project_data
                            .metadata
                            .get(&p.path)
                            .map_or(0, |m| m.last_opened_at),
                    )
                });
                s.cycle_paths = std::iter::once(current.path.clone())
                    .chain(others.into_iter().map(|p| p.path.clone()))
                    .collect();
                if s.cycle_paths.len() < 2 {
                    s.cycle_paths.clear();
                    return true;
                }
                s.cycle_index = 0;
            }
            if !s.cycle_paths.is_empty() {
                let n = s.cycle_paths.len();
                s.cycle_index = (s.cycle_index + if event.mods.shift { n - 1 } else { 1 }) % n;
            }
            return true;
        }
        if matches!(
            event.key,
            rune::Key::Modifier {
                modifier: rune::Modifier::ControlLeft | rune::Modifier::ControlRight,
                pressed: false
            }
        ) && !event.mods.ctrl
            && !s.cycle_paths.is_empty()
        {
            let path = s.cycle_paths.get(s.cycle_index).cloned();
            let current = s
                .selected_project
                .and_then(|i| s.projects.get(i))
                .map(|p| p.path.clone());
            s.cycle_paths.clear();
            if let Some(path) = path
                && Some(&path) != current.as_ref()
            {
                s.open_project(path);
            }
            return true;
        }
    }
    if s.page == Page::Studio
        && event.key == rune::Key::Escape
        && AppState::studio_key(s, event, tx)
    {
        return true;
    }
    if event.is_command('b') || (s.page == Page::Studio && event.key == rune::Key::Escape) {
        if s.page == Page::Studio {
            s.page = s.studio_under_page;
            s.studio_fade = Some((std::time::Instant::now(), false));
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

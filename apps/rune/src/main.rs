mod bridge;
#[path = "art/codegolf.rs"]
mod codegolf;
mod launcher;
mod plasma;
mod project_state;
mod review;
mod state;
mod terminal;
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
            ("studio-scratchpad-empty", |s| studio_scratchpad(s, "empty")),
            ("studio-scratchpad-idle", |s| studio_scratchpad(s, "idle")),
            ("studio-scratchpad-footer-hover", |s| {
                studio_scratchpad(s, "footer-hover")
            }),
            ("studio-scratchpad-copy-hover", |s| {
                studio_scratchpad(s, "copy-hover")
            }),
            ("studio-scratchpad-export-hover", |s| {
                studio_scratchpad(s, "export-hover")
            }),
            ("studio-scratchpad-clear-hover", |s| {
                studio_scratchpad(s, "clear-hover")
            }),
            ("studio-scratchpad-saving", |s| {
                studio_scratchpad(s, "saving")
            }),
            ("studio-scratchpad-not-saved", |s| {
                studio_scratchpad(s, "not-saved")
            }),
            ("studio-scratchpad-toolbar", |s| {
                studio_scratchpad(s, "toolbar")
            }),
            ("studio-scratchpad-block-menu", |s| {
                studio_scratchpad(s, "block-menu")
            }),
            ("studio-scratchpad-block-p", |s| {
                studio_scratchpad(s, "block-p")
            }),
            ("studio-scratchpad-block-h1", |s| {
                studio_scratchpad(s, "block-h1")
            }),
            ("studio-scratchpad-block-h2", |s| {
                studio_scratchpad(s, "block-h2")
            }),
            ("studio-scratchpad-block-h3", |s| {
                studio_scratchpad(s, "block-h3")
            }),
            ("studio-scratchpad-block-ul", |s| {
                studio_scratchpad(s, "block-ul")
            }),
            ("studio-scratchpad-block-ol", |s| {
                studio_scratchpad(s, "block-ol")
            }),
            ("studio-scratchpad-block-task", |s| {
                studio_scratchpad(s, "block-task")
            }),
            ("studio-scratchpad-block-quote", |s| {
                studio_scratchpad(s, "block-quote")
            }),
            ("studio-scratchpad-mark-bold", |s| {
                studio_scratchpad(s, "mark-bold")
            }),
            ("studio-scratchpad-mark-italic", |s| {
                studio_scratchpad(s, "mark-italic")
            }),
            ("studio-scratchpad-mark-strike", |s| {
                studio_scratchpad(s, "mark-strike")
            }),
            ("studio-scratchpad-mark-code", |s| {
                studio_scratchpad(s, "mark-code")
            }),
            ("studio-scratchpad-mark-combined", |s| {
                studio_scratchpad(s, "mark-combined")
            }),
            ("studio-scratchpad-highlight-palette", |s| {
                studio_scratchpad(s, "highlight-palette")
            }),
            ("studio-scratchpad-highlight-copper", |s| {
                studio_scratchpad(s, "highlight-copper")
            }),
            ("studio-scratchpad-highlight-amber", |s| {
                studio_scratchpad(s, "highlight-amber")
            }),
            ("studio-scratchpad-highlight-moss", |s| {
                studio_scratchpad(s, "highlight-moss")
            }),
            ("studio-scratchpad-highlight-sky", |s| {
                studio_scratchpad(s, "highlight-sky")
            }),
            ("studio-scratchpad-highlight-orchid", |s| {
                studio_scratchpad(s, "highlight-orchid")
            }),
            ("studio-scratchpad-text-palette", |s| {
                studio_scratchpad(s, "text-palette")
            }),
            ("studio-scratchpad-text-default", |s| {
                studio_scratchpad(s, "text-default")
            }),
            ("studio-scratchpad-text-copper", |s| {
                studio_scratchpad(s, "text-copper")
            }),
            ("studio-scratchpad-text-moss", |s| {
                studio_scratchpad(s, "text-moss")
            }),
            ("studio-scratchpad-text-sky", |s| {
                studio_scratchpad(s, "text-sky")
            }),
            ("studio-scratchpad-text-orchid", |s| {
                studio_scratchpad(s, "text-orchid")
            }),
            ("studio-scratchpad-text-ash", |s| {
                studio_scratchpad(s, "text-ash")
            }),
            ("studio-scratchpad-below", |s| studio_scratchpad(s, "below")),
            ("studio-scratchpad-edge-left", |s| {
                studio_scratchpad(s, "edge-left")
            }),
            ("studio-scratchpad-edge-right", |s| {
                studio_scratchpad(s, "edge-right")
            }),
            ("studio-scratchpad-clear-progress", |s| {
                studio_scratchpad(s, "clear-progress")
            }),
            ("studio-scratchpad-clear-cancel", |s| {
                studio_scratchpad(s, "clear-cancel")
            }),
            ("studio-scratchpad-clear-complete", |s| {
                studio_scratchpad(s, "clear-complete")
            }),
            ("studio-review", studio_review),
            ("studio-column-head", studio_column_head),
            ("studio-insert-menu", |s| {
                studio_menus(s);
                s.studio.composer_open = false;
                s.studio_insert_menu =
                    Some(("/demo".into(), usize::MAX, [1065.5, 412.75, 14.0, 28.0]));
            }),
            ("studio-project-switch", |s| {
                studio_menus(s);
                s.studio_column_hover = Some(s.studio.thread_id.clone());
                s.studio_project_selection = usize::MAX;
                s.projects.push(state::Project {
                    name: "nova".into(),
                    path: "/review/nova".into(),
                });
                s.studio_project_menu_open = true;
            }),
            ("studio-thread-info", |s| {
                studio_menus(s);
                s.studio.title_info_open = true;
            }),
            ("studio-thread-info-rename", |s| {
                studio_menus(s);
                s.studio.title_info_open = true;
                s.studio.title_editing = true;
                s.studio.title_draft = rune::TextEdit::new(s.studio.title.clone());
                s.studio.title_draft.anchor = 0;
                s.studio.title_draft.focused = true;
            }),
            ("studio-conversation-search", |s| {
                studio_menus(s);
                s.conversation_search_open = true;
            }),
            ("studio-convo-mid", |s| studio_conversation(s, "mid")),
            ("studio-convo-scrolled", |s| {
                studio_conversation(s, "scrolled")
            }),
            ("studio-convo-compaction", |s| {
                studio_conversation(s, "compaction")
            }),
            ("studio-convo-marks", |s| studio_conversation(s, "marks")),
            ("studio-convo-code", |s| studio_conversation(s, "code")),
            ("studio-activity-running", |s| studio_activity(s, "running")),
            ("studio-activity-folded", |s| studio_activity(s, "folded")),
            ("studio-activity-expanded", |s| {
                studio_activity(s, "expanded")
            }),
            ("studio-activity-diff", |s| studio_activity(s, "diff")),
            ("studio-activity-hover", |s| studio_activity(s, "hover")),
            ("studio-activity-plan", |s| studio_activity(s, "plan")),
            ("studio-composer-orb", |s| studio_composer(s, "orb")),
            ("studio-composer-orb-hover", |s| {
                studio_composer(s, "orb-hover")
            }),
            ("studio-composer-open", |s| studio_composer(s, "open")),
            ("studio-composer-text", |s| studio_composer(s, "text")),
            ("studio-composer-running", |s| studio_composer(s, "running")),
            ("studio-dock-approval", |s| {
                studio_composer(s, "dock-approval");
                s.studio.busy = true;
                s.studio.approval = Some(state::StudioApproval {
                    id: "approval-dock-1".into(),
                    title: "Apply patch to src/main.rs".into(),
                    detail: "The agent wants to update the Studio dock rendering and add keyboard handling.".into(),
                });
            }),
            ("studio-dock-question", |s| {
                studio_composer(s, "dock-question");
                s.studio.busy = true;
                s.studio.question = Some(state::StudioQuestion {
                    id: "question-dock-1".into(),
                    questions: vec![state::StudioQuestionEntry {
                        id: "scope".into(),
                        header: "Which files should I include?".into(),
                        prompt: "Choose the files to include in the change.".into(),
                        options: vec!["Only the Rune UI".into(), "Rune UI and fixtures".into()],
                        multi: false,
                    }],
                    index: 0,
                    answers: Default::default(),
                    selected: Vec::new(),
                });
            }),
            ("studio-dock-subagent", |s| {
                studio_composer(s, "dock-subagent");
                s.studio.busy = false;
                s.studio.subagents = vec![
                    (
                        "delegate-running".into(),
                        "Inspect dock implementation".into(),
                        "running".into(),
                    ),
                    (
                        "delegate-done".into(),
                        "Measure composer alignment".into(),
                        "completed".into(),
                    ),
                ];
                s.studio.subagents_expanded = true;
            }),
            ("studio-dock-queue", |s| {
                studio_composer(s, "dock-queue");
                s.studio.busy = true;
                s.studio.queued_turns = vec![
                    (
                        "queued-1".into(),
                        "Add keyboard shortcuts for approval.".into(),
                    ),
                    ("queued-2".into(), "Then verify the overlay stack.".into()),
                ];
            }),
            ("studio-dock-selection", |s| {
                studio_composer(s, "dock-selection");
                s.studio.composer_open = false;
                s.studio.archive_notice =
                    Some("This thread is still working and cannot be archived.".into());
                s.studio.selection_fixture_pending = true;
            }),
            ("studio-picker-model", |s| {
                studio_composer(s, "picker-model");
                s.studio.picker_open = true;
            }),
            ("studio-picker-effort", |s| {
                studio_composer(s, "picker-effort");
                s.studio.effort = "high".into();
            }),
            ("studio-picker-slash", |s| {
                studio_composer(s, "picker-slash");
                s.composer.text = "/".into();
                s.studio.composer_menu_marker = Some('/');
            }),
            ("studio-picker-mention", |s| {
                studio_composer(s, "picker-mention");
                s.composer.text = "@".into();
                s.studio.composer_menu_marker = Some('@');
            }),
            ("studio-picker-mention-chip", |s| {
                studio_composer(s, "picker-mention-chip");
                s.composer.text = "@main.ts".into();
            }),
            ("studio-picker-handoff", |s| {
                use state::{StudioModel, StudioProvider};
                studio_composer(s, "picker-handoff");
                s.studio.composer_open = false;
                s.studio_column_hover = Some(s.studio.thread_id.clone());
                s.studio.providers = [
                    ("codex", "Codex"),
                    ("claudeAgent", "Claude"),
                    ("opencode", "OpenCode"),
                    ("cursor", "Cursor"),
                ]
                .into_iter()
                .map(|(id, label)| StudioProvider {
                    id: id.into(),
                    label: label.into(),
                    supports_compaction: false,
                })
                .collect();
                s.studio.models = ["GPT-5.6-Terra", "GPT-5.6-Luna", "GPT-5.5", "GPT-5.4-Mini"]
                    .into_iter()
                    .map(|name| {
                        let default_effort = if name.ends_with("Mini") {
                            "low"
                        } else {
                            "medium"
                        };
                        StudioModel {
                            id: name.to_lowercase(),
                            label: name.into(),
                            efforts: vec!["low".into(), "medium".into(), "high".into()],
                            default_effort: Some(default_effort.into()),
                        }
                    })
                    .collect();
                s.open_handoff_picker();
                if let Some((_, models, _, _)) = &mut s.studio.handoff_selection {
                    models[0].id = "default".into();
                    models[0].label = "default model".into();
                }
            }),
            ("studio-column-head-info", |s| {
                studio_column_head(s);
                s.studio.title_info_open = true;
            }),
            ("studio-column-head-handoff-picker", |s| {
                use state::{StudioModel, StudioProvider};
                studio_column_head(s);
                s.studio.providers = [
                    ("codex", "Codex"),
                    ("claudeAgent", "Claude"),
                    ("opencode", "OpenCode"),
                    ("cursor", "Cursor"),
                ]
                .into_iter()
                .map(|(id, label)| StudioProvider {
                    id: id.into(),
                    label: label.into(),
                    supports_compaction: false,
                })
                .collect();
                s.studio.models = ["GPT-5.6-Terra", "GPT-5.6-Luna", "GPT-5.5", "GPT-5.4-Mini"]
                    .into_iter()
                    .map(|name| StudioModel {
                        id: name.to_lowercase(),
                        label: name.into(),
                        efforts: vec!["medium".into()],
                        default_effort: Some("medium".into()),
                    })
                    .collect();
                s.open_handoff_picker();
                s.studio.connected_identity = None;
                if let Some((_, models, _, _)) = &mut s.studio.handoff_selection {
                    models[0].id = "default".into();
                    models[0].label = "default model".into();
                }
            }),
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
                s.studio_layout["rows"][0]["panes"].as_array_mut().unwrap().push(serde_json::json!({"id":"review-two","kind":"thread","width":0,"anchor":{"kind":"thread","threadId":"review-two"}}));
                if let Some(dormant) = s.studio_threads.get_mut("review-two") {
                    dormant.dormant = true;
                }
            }),
            ("studio-column-head-terminal-live", |s| {
                studio_column_head(s);
                studio_terminal_fixture(s, true);
            }),
            ("studio-column-head-terminal-idle", |s| {
                studio_column_head(s);
                studio_terminal_fixture(s, false);
            }),
            ("studio-column-head-terminal-idle-hover", |s| {
                studio_column_head(s);
                studio_terminal_fixture(s, false);
            }),
            ("studio-column-head-terminal-hover", |s| {
                studio_column_head(s);
                studio_terminal_fixture(s, true);
            }),
            ("studio-column-head-terminal-selection", |s| {
                studio_column_head(s);
                studio_terminal_fixture(s, false);
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
    s.studio.connected_identity = Some(state::StudioIdentity {
        name: "Cinder".into(),
        svg: review::fixture_avatar(),
        avatar: None,
    });
    s.studio.items.push(state::StudioItem {
        kind: "connected".into(),
        text: "Cinder".into(),
        ..Default::default()
    });
    s.studio.title = "Review thread".into();
    s.studio.worktree_path = Some("/tmp/kone-review-worktree".into());
}

fn studio_menus(s: &mut AppState) {
    studio_column_head(s);
    // The browser reference keeps ClosingPlasma animating while Studio is open.
    s.art_focused = true;
    s.studio.title = "Studio menus review".into();
    s.studio.project_path = "/Users/you/Developer/kone".into();
    s.studio.worktree_path = None;
    s.studio.connected_identity = None;
    s.studio.items.clear();
    s.studio.models.clear();
    s.studio.model_index = 0;
    s.studio.effort = "Medium".into();
    s.studio.info_status = Some("Working".into());
    s.studio.context_usage = None;
    s.studio.thread_id = "87e83c63reviewseedcee5f4".into();
    s.studio_layout["rows"][0]["focusedId"] = serde_json::json!(s.studio.thread_id);
    s.studio_layout["rows"][0]["panes"][0]["id"] = serde_json::json!(s.studio.thread_id);
    s.studio_layout["rows"][0]["panes"][0]["anchor"]["threadId"] =
        serde_json::json!(s.studio.thread_id);
}

fn studio_scratchpad(s: &mut AppState, scene: &str) {
    use rune::{Block, Mark, TextEdit};
    studio_menus(s);
    s.studio.composer_open = false;
    s.studio.title = "Scratchpad".into();
    s.studio.thread_id = "studio-review-pad".into();
    s.studio.context_usage = None;
    s.studio.info_status = None;
    s.projects[0].path = "/review/kone".into();
    s.studio.project_path = "/review/kone".into();
    s.studio_layout["rows"][0]["projectPath"] = serde_json::json!("/review/kone");
    s.studio_layout["rows"][0]["focusedId"] = serde_json::json!(s.studio.thread_id);
    let pane = &mut s.studio_layout["rows"][0]["panes"][0];
    pane["id"] = serde_json::json!(s.studio.thread_id);
    pane["kind"] = serde_json::json!("scratchpad");
    pane["anchor"] = serde_json::json!({"kind":"scratchpad","threadId":s.studio.thread_id});
    let mut edit =
        TextEdit::from_html("<p>Notes, snippets, drafts.</p><p>Keep the useful pieces close.</p>")
            .rich();
    if scene == "empty" || scene == "clear-complete" {
        edit.clear();
    }
    if scene == "below" {
        edit = TextEdit::new(format!(
            "Notes, snippets, drafts.\n{}",
            "Keep the useful pieces close.\n".repeat(30)
        ))
        .rich();
    }
    if scene.starts_with("edge-") {
        edit = TextEdit::new("Keep the useful pieces close. ".repeat(5)).rich();
    }
    let selected = !(matches!(
        scene,
        "empty"
            | "idle"
            | "footer-hover"
            | "copy-hover"
            | "export-hover"
            | "clear-hover"
            | "saving"
            | "not-saved"
    ) || scene.starts_with("clear-"));
    if selected {
        edit.focused = true;
        let end = if scene == "edge-right" {
            edit.text.len()
        } else {
            21
        };
        edit.set_selection(if scene == "edge-right" { end - 4 } else { 0 }, end);
    }
    if let Some(block) = match scene {
        "block-h1" => Some(Block::Heading(1)),
        "block-h2" => Some(Block::Heading(2)),
        "block-h3" => Some(Block::Heading(3)),
        "block-ul" => Some(Block::Bullet(0)),
        "block-ol" => Some(Block::Numbered(0)),
        "block-task" => Some(Block::Task(false)),
        "block-quote" => Some(Block::Quote),
        _ => None,
    } {
        edit.set_block(block);
    }
    for (name, mark) in [
        ("bold", Mark::Bold),
        ("italic", Mark::Italic),
        ("strike", Mark::Strike),
        ("code", Mark::Code),
    ] {
        if scene == format!("mark-{name}") || scene == "mark-combined" {
            edit.toggle_mark(mark);
        }
    }
    use ui::scratchpad_toolbar::Popover;
    if scene == "block-menu" {
        s.studio.scratchpad_toolbar.open = Some(Popover::Block);
    }
    if let Some(id) = scene.strip_prefix("highlight-") {
        s.studio.scratchpad_toolbar.open = Some(Popover::Highlight);
        if id != "palette" {
            edit.toggle_mark(Mark::Highlight(id.into()));
            s.studio.scratchpad_toolbar.highlight = id.into();
        }
    }
    if let Some(id) = scene.strip_prefix("text-") {
        s.studio.scratchpad_toolbar.open = Some(Popover::Text);
        if id != "palette" && id != "default" {
            edit.toggle_mark(Mark::TextColor(id.into()));
            s.studio.scratchpad_toolbar.text = id.into();
        }
    }
    s.studio.scratchpad_saved = edit.to_html();
    s.studio.scratchpad_saved_at = (scene != "not-saved").then(|| "10:24 AM".into());
    if scene == "saving" {
        s.studio.scratchpad_save_request = Some(u64::MAX);
    }
    s.studio.scratchpad_toolbar.selection = Some(edit.range());
    s.studio.scratchpad = Some(edit);
    s.studio.scratchpad_revision = 2;
    s.studio.scratchpad_id = "studio-review-pad".into();
    if scene.ends_with("hover") || scene.starts_with("clear-") {
        s.studio_column_hover = Some(s.studio.thread_id.clone());
    }
}

fn studio_terminal_fixture(s: &mut AppState, running: bool) {
    s.studio.terminal_command = Some(if running {
        "npm run dev".into()
    } else {
        String::new()
    });
    s.studio.terminal_running = running;
    s.studio.terminal_child = running.then(|| "npm run dev".into());
    s.studio.terminal_cursor_visible = false;
    s.studio.terminal_output = "kone terminal (dev mock)\r\n$ ".into();
    if let Some(pane) = s.studio_threads.get_mut("review-one") {
        pane.terminal_command = s.studio.terminal_command.clone();
        pane.terminal_running = s.studio.terminal_running;
        pane.terminal_child = s.studio.terminal_child.clone();
        pane.terminal_cursor_visible = false;
        pane.terminal_output = s.studio.terminal_output.clone();
    }
}

/// Conversation captures share the exact block text used by the Electron fixture.
fn studio_conversation(s: &mut AppState, scene: &str) {
    studio_column_head(s);
    // The reference captures park the pointer inside the column, so its head
    // tools show.
    s.studio_column_hover = Some(s.studio.thread_id.clone());
    s.projects[0].path = "/review/kone".into();
    s.studio_layout["rows"][0]["projectPath"] = serde_json::json!("/review/kone");
    s.studio.project_path = "/review/kone".into();
    s.studio.title = "Conversation review".into();
    s.studio.worktree_path = None;
    s.studio.context_usage = None;
    s.studio.items.clear();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../assets/fixtures/studio-conversation.json"))
            .expect("valid Studio conversation fixture");
    s.studio.conversation_fixture = Some(scene.into());
    for (index, block) in fixture["blocks"].as_array().unwrap().iter().enumerate() {
        if index == 2 {
            if scene == "compaction" {
                s.studio.items.push(state::StudioItem {
                    kind: "compaction".into(),
                    text: "Context compacted · 120k → 32k".into(),
                    ..Default::default()
                });
            }
            if scene == "marks" {
                s.studio.handoff_source = Some("codex".into());
                s.studio.items.push(state::StudioItem {
                    kind: "handoff_mark".into(),
                    text: "Handed from GPT 5.4".into(),
                    ..Default::default()
                });
            }
            s.studio.items.push(state::StudioItem {
                kind: "setting_mark".into(),
                text: "Medium › High".into(),
                ..Default::default()
            });
        }
        if block["role"] == "user" {
            s.studio.items.push(state::StudioItem {
                id: block["id"].as_str().unwrap_or_default().into(),
                kind: "user".into(),
                text: block["text"].as_str().unwrap_or_default().into(),
                ..Default::default()
            });
        } else {
            for item in block["items"].as_array().into_iter().flatten() {
                s.studio.items.push(state::StudioItem {
                    id: item["itemId"].as_str().unwrap_or_default().into(),
                    block_id: block["id"].as_str().map(str::to_owned),
                    kind: item["kind"].as_str().unwrap_or_default().into(),
                    text: item["text"].as_str().unwrap_or_default().into(),
                    status: item["status"].as_str().unwrap_or_default().into(),
                    ..Default::default()
                });
            }
        }
    }
    // Anchors match the Electron captures' scroll offsets (see
    // /tmp/studio5-measure.json); the user bubble carries its 10pt top padding,
    // so its anchor sits 10pt higher than the text's measured position.
    s.studio.conversation_scroll = match scene {
        "scrolled" => Some(("studio-speaker-2".into(), 20.25)),
        "compaction" => Some(("md-h-release-checklist".into(), 160.0)),
        "marks" => Some(("studio-user-text-2".into(), 150.17)),
        "code" => Some(("md-h-example-implementation".into(), 35.0)),
        _ => None,
    };
    s.studio.conversation_scroll_deadline = None;
    // The reference capture parks the pointer at the folder button (rest
    // position, ~336,213 logical) right before shooting; the code block under
    // it races the 0.2s Copy fade-out, so only those scenes show a Copy button
    // — on the second block (0-based) in each.
    s.studio.fixture_cb_copy = if matches!(scene, "scrolled" | "code") {
        Some(1)
    } else {
        None
    };
}

fn studio_activity(s: &mut AppState, scene: &str) {
    studio_conversation(s, "mid");
    s.studio.conversation_fixture = Some(format!("activity-{scene}"));
    s.studio.title = "Studio activity reference".into();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../assets/fixtures/studio-activity.json"))
            .expect("valid activity fixture");
    s.studio.items.clear();
    s.studio.items.push(state::StudioItem {
        kind: "user".into(),
        text: fixture["blocks"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .into(),
        ..Default::default()
    });
    for item in fixture["blocks"][1]["items"].as_array().unwrap() {
        s.studio.items.push(state::StudioItem {
            id: item["itemId"].as_str().unwrap_or_default().into(),
            kind: item["kind"].as_str().unwrap_or_default().into(),
            text: item["text"].as_str().unwrap_or_default().into(),
            name: item["name"].as_str().unwrap_or_default().into(),
            status: item["status"].as_str().unwrap_or_default().into(),
            detail: item["detail"].as_str().unwrap_or_default().into(),
            tasks: item["tasks"].as_array().cloned().unwrap_or_default(),
            ..Default::default()
        });
    }
    s.studio.busy = scene == "running";
    s.studio.activity_open = matches!(scene, "running" | "expanded" | "diff" | "hover");
    s.studio.activity_expanded = match scene {
        "expanded" => vec!["activity-command".into(), "activity-edit".into()],
        "diff" | "hover" => vec!["activity-edit".into()],
        _ => Vec::new(),
    };
    s.studio.turn_started = Some(std::time::SystemTime::now() - std::time::Duration::from_secs(17));
    s.studio.turn_title = "Review the Studio activity".into();
    s.studio.conversation_scroll = None;
}

fn studio_composer(s: &mut AppState, scene: &str) {
    studio_conversation(s, "mid");
    s.studio.conversation_fixture = Some(format!("composer-{scene}"));
    s.studio.title = "Composer review".into();
    s.studio.turn_title = "Composer review".into();
    s.studio.models = [
        ("gpt-5.6-terra", "GPT-5.6-Terra", "medium"),
        ("gpt-5.6-luna", "GPT-5.6-Luna", "medium"),
        ("gpt-5.5", "GPT-5.5", "medium"),
        ("gpt-5.4-mini", "GPT-5.4-Mini", "low"),
    ]
    .into_iter()
    .map(|(id, label, effort)| state::StudioModel {
        id: id.into(),
        label: label.into(),
        efforts: vec!["low".into(), "medium".into(), "high".into(), "xhigh".into()],
        default_effort: Some(effort.into()),
    })
    .collect();
    if scene.starts_with("picker-") || scene.starts_with("dock-") {
        s.studio.providers = [
            ("codex", "Codex"),
            ("claudeAgent", "Claude"),
            ("opencode", "OpenCode"),
            ("cursor", "Cursor"),
        ]
        .into_iter()
        .map(|(id, label)| state::StudioProvider {
            id: id.into(),
            label: label.into(),
            supports_compaction: false,
        })
        .collect();
        s.studio.provider_index = 0;
        s.studio.model_index = 0;
        s.studio.context_branch = Some("calm-agent-ui-continuation".into());
    }
    s.studio.mode = "accept-edits".into();
    s.studio.effort = "medium".into();
    s.studio.fast_tier = true;
    s.studio.fast_mode = false;
    s.studio_column_hover = if scene == "orb-hover" || scene.starts_with("dock-") {
        Some(s.studio.thread_id.clone())
    } else {
        None
    };
    s.studio.orb_live = false;
    s.studio.orb_clock = Some(0.9);
    s.studio.orb_hover = scene == "orb-hover";
    s.studio.orb_aim = if scene == "orb-hover" {
        Some((0.0, 0.0, 1.0))
    } else {
        None
    };
    s.studio.composer_open = matches!(scene, "open" | "text" | "running")
        || scene.starts_with("picker-")
        || scene.starts_with("dock-");
    s.studio.composer_opened_at = None;
    s.studio.composer_closing_at = None;
    s.studio.busy = scene == "running";
    s.studio.items.clear();
    s.studio.connected_identity = Some(state::StudioIdentity {
        name: "Harbor".into(),
        svg: review::fixture_avatar(),
        avatar: None,
    });
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../assets/fixtures/studio-composer.json"))
            .expect("valid composer fixture");
    s.studio.items.push(state::StudioItem {
        id: fixture["blocks"][0]["id"]
            .as_str()
            .unwrap_or_default()
            .into(),
        kind: "user".into(),
        text: fixture["blocks"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .into(),
        ..Default::default()
    });
    if scene == "running" {
        s.studio.turn_started =
            Some(std::time::SystemTime::now() - std::time::Duration::from_secs(6));
        s.studio.items.push(state::StudioItem {
            id: "composer-running-read".into(),
            kind: "tool_call".into(),
            status: "in-progress".into(),
            name: "read_file".into(),
            text: "app/components/agent/AgentComposer.vue".into(),
            ..Default::default()
        });
    } else {
        let reply = &fixture["blocks"][1]["items"][0];
        s.studio.items.push(state::StudioItem {
            id: reply["itemId"].as_str().unwrap_or_default().into(),
            block_id: fixture["blocks"][1]["id"].as_str().map(str::to_owned),
            kind: reply["kind"].as_str().unwrap_or_default().into(),
            text: reply["text"].as_str().unwrap_or_default().into(),
            status: reply["status"].as_str().unwrap_or_default().into(),
            ..Default::default()
        });
    }
    if (scene.starts_with("picker-") || scene.starts_with("dock-"))
        && let Some(user) = s.studio.items.iter_mut().find(|item| item.kind == "user")
    {
        user.text =
            "Inspect model, commands, project files, and hand-off choices in the composer.".into();
    }
    if scene == "text" {
        s.composer.text = "Line one: check the composer card geometry and spacing.\nLine two: verify provider, model, and effort controls stay aligned.\nLine three: confirm Escape collapses back to the resting orb.".into();
    } else {
        s.composer.clear();
    }
    s.studio.conversation_scroll = None;
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
    if s.page == Page::Studio && event.is_command('f') {
        s.conversation_search_open = !s.conversation_search_open;
        s.conversation_search.clear();
        s.conversation_search_selection = 0;
        return true;
    }
    if s.page == Page::Studio && ui::scratchpad_toolbar::key(&mut s.studio, event) {
        return true;
    }
    if s.page == Page::Studio && AppState::studio_key(s, event, tx) {
        return true;
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

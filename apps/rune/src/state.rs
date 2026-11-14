use rune::TextEdit;

type MentionFiles = Vec<(String, String)>;
type MentionFileCache = std::sync::Mutex<
    std::collections::HashMap<std::path::PathBuf, (std::time::Instant, MentionFiles)>,
>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Page {
    #[default]
    Empty,
    Projects,
    Overview,
    Studio,
}

#[derive(Clone, Debug)]
pub struct Project {
    pub name: String,
    pub path: String,
}

/// The machine's signed-in user, resolved the way Electron's `useUser` does: the
/// OS account name, split into words and capitalised, with its first letter as
/// the avatar initial. Electron shows the profile chip only once a name resolves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Profile {
    pub name: Option<String>,
    pub initial: String,
}

impl Default for Profile {
    fn default() -> Self {
        Self::system()
    }
}

impl Profile {
    pub fn system() -> Self {
        let username = ["USER", "USERNAME", "LOGNAME"]
            .into_iter()
            .find_map(|key| std::env::var(key).ok())
            .map(|user| user.trim().to_owned())
            .filter(|user| !user.is_empty());
        let name = username.map(|user| {
            user.split(['.', '_', '-', ' '])
                .filter(|part| !part.is_empty())
                .map(|part| {
                    let mut chars = part.chars();
                    chars.next().map_or_else(String::new, |first| {
                        first.to_uppercase().collect::<String>() + chars.as_str()
                    })
                })
                .collect::<Vec<_>>()
                .join(" ")
        });
        let initial = name
            .as_deref()
            .and_then(|name| name.chars().next())
            .map(|first| first.to_uppercase().collect())
            .unwrap_or_default();
        Self { name, initial }
    }
}

#[derive(Default)]
pub struct AppState {
    pub art_focused: bool,
    pub(crate) chooser_magnet: StartActionsState,
    pub profile: Profile,
    pub profile_hover: bool,
    pub overview_switcher_open: bool,
    pub overview_name_hover: bool,
    pub overview_folder_hover: bool,
    pub overview_folder_actions_focus: bool,
    pub changes_folded: std::collections::HashSet<String>,
    pub changes_hover: Option<bool>,
    pub change_tile_hover: Option<String>,
    pub card_count_starts: std::cell::RefCell<(String, std::collections::HashMap<String, f64>)>,
    pub overview_viewport: (f32, f32),
    pub overview_greeting_bounds: [f32; 4],
    pub greeting_motion: std::cell::RefCell<crate::ui::overview::GreetingMotion>,
    pub cycle_paths: Vec<String>,
    pub cycle_index: usize,
    pub start_actions: StartActionsState,
    pub project_data: crate::project_state::ProjectState,
    pub page: Page,
    pub projects: Vec<Project>,
    pub selected_project: Option<usize>,
    pub search: TextEdit,
    pub composer: TextEdit,
    pub studio: StudioState,
    pub pill_hover: Option<String>,
    pub studio_threads: std::collections::HashMap<String, StudioState>,
    pub bridge: Option<crate::bridge::Bridge>,
    pub launcher: crate::launcher::LauncherState,
    pub project_list_request: Option<u64>,
    pub project_remember_request: Option<u64>,
    pub pending_project_path: Option<String>,
    pub studio_layout: serde_json::Value,
    pub studio_load_request: Option<u64>,
    pub studio_layout_ready: bool,
    pub studio_viewport: (f32, f32),
    pub studio_scroll_row: Option<String>,
    pub studio_column_hover: Option<String>,
    pub studio_header_hover: bool,
    pub studio_seam_hover: Option<String>,
    pub studio_seam_bounds: std::collections::HashMap<String, [f32; 4]>,
    pub studio_insert_menu: Option<(String, usize, [f32; 4])>,
    pub studio_insert_selection: usize,
    pub studio_project_menu_open: bool,
    pub studio_project_selection: usize,
    pub conversation_search_open: bool,
    pub conversation_search: TextEdit,
    pub conversation_search_selection: usize,
    pub studio_under_page: Page,
    pub studio_fade: Option<(std::time::Instant, bool)>,
    pub studio_refusal: Option<std::time::Instant>,
}

impl AppState {
    fn studio_overview_scroll_x(&self, index: usize) -> f32 {
        let width = |pane: &serde_json::Value| {
            let preset = pane["width"].as_u64().unwrap_or(0).min(3) as usize;
            [840.0_f32, 960.0, 1120.0, 1240.0][preset]
        };
        let panes = self.studio_layout["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["projectPath"] == self.studio.project_path)
            .and_then(|row| row["panes"].as_array());
        let Some(panes) = panes else { return 0.0 };
        let before: f32 = panes.iter().take(index).map(width).sum();
        let selected = panes.get(index).map(width).unwrap_or(0.0);
        let center = before + index as f32 * 28.0 + selected / 2.0;
        let viewport = if self.studio_viewport.0 > 0.0 {
            self.studio_viewport.0
        } else {
            1292.0
        };
        (48.0 + center * 0.58 - viewport / 2.0).max(0.0)
    }

    fn changes_preferences_path() -> std::path::PathBuf {
        std::env::var_os("KONE_RUNE_DATA_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var_os("HOME")
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(std::env::temp_dir)
                    .join("Library/Application Support/kone-rune")
            })
            .join("changes-folded.json")
    }

    pub fn toggle_changes(&mut self, key: String) {
        let staged = key.ends_with(":true");
        let suffix = format!(":{staged}");
        self.card_count_starts
            .borrow_mut()
            .1
            .retain(|card, _| !card.ends_with(&suffix));
        if !self.changes_folded.remove(&key) {
            self.changes_folded.insert(key);
        }
        if self.bridge.is_some() {
            let path = Self::changes_preferences_path();
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(data) = serde_json::to_vec(&self.changes_folded) {
                let _ = std::fs::write(path, data);
            }
        }
    }

    pub fn example_project(&mut self) {
        if self.projects.is_empty() {
            self.projects.push(Project {
                name: "kone".into(),
                path: "~/Developer/kone".into(),
            });
        }
        self.selected_project = Some(0);
    }
}

#[derive(Default)]
pub struct StudioState {
    /// Bird's-eye overview of the current row's thread columns.
    pub overview: bool,
    pub overview_selection: usize,
    pub overview_hovered: Option<String>,
    pub scratchpad: Option<TextEdit>,
    pub scratchpad_toolbar: crate::ui::scratchpad_toolbar::ToolbarState,
    pub scratchpad_saved_at: Option<String>,
    pub scratchpad_footer_hover: bool,
    pub scratchpad_tool_hover: Option<&'static str>,
    pub scratchpad_clear_started: Option<std::time::Instant>,
    pub scratchpad_clear_cancelled: Option<(std::time::Instant, f32)>,
    pub scratchpad_clear_progress: f32,
    pub scratchpad_clear_hover: bool,
    pub scratchpad_clear_key_held: bool,
    pub scratchpad_saved: String,
    pub scratchpad_saving: String,
    pub scratchpad_load_request: Option<u64>,
    pub scratchpad_save_request: Option<u64>,
    pub scratchpad_id: String,
    /// Stored revision + 1; zero means the shared document has not loaded yet.
    pub scratchpad_revision: u64,
    pub scratchpad_conflict: bool,
    /// Initial positioning for deterministic conversation comparison captures.
    pub conversation_fixture: Option<String>,
    pub activity_open: bool,
    pub activity_expanded: Vec<String>,
    /// Fixture-only scroll anchor (element key, top offset below the viewport
    /// top): `poll` issues it for the first second of the scene clock, then
    /// releases so the capture frame draws settled.
    pub conversation_scroll: Option<(String, f32)>,
    /// Virtual-clock deadline for the fixture scroll anchor, set on first poll.
    pub conversation_scroll_deadline: Option<f64>,
    /// Fixture-only forced Copy visibility: 0-based global code-block index.
    /// The reference captures park the pointer over one block, so its Copy
    /// button is frozen visible there (see the per-scene setup in `main`).
    pub fixture_cb_copy: Option<usize>,
    pub title: String,
    pub info_status: Option<String>,
    pub connected_identity: Option<StudioIdentity>,
    pub side_chat: bool,
    pub head_tooltip: Option<String>,
    pub head_tooltip_pending: Option<(String, std::time::Instant)>,
    pub context_usage: Option<(u64, u64)>,
    pub context_input: Option<u64>,
    pub context_output: Option<u64>,
    pub context_total: Option<u64>,
    pub context_auto_compact: bool,
    pub context_open: bool,
    pub title_info_open: bool,
    pub title_editing: bool,
    pub title_draft: TextEdit,
    pub title_rename_request: Option<(u64, String)>,
    pub export_json: bool,
    pub export_request: Option<u64>,
    pub export_status: Option<String>,
    pub continuation_request: Option<u64>,
    pub handoff_picker: bool,
    /// Reply anchor for a branch created through the continuation picker.
    pub branch_block_id: Option<String>,
    pub handoff_staged: bool,
    pub handoff_query: TextEdit,
    pub handoff_selection: Option<(usize, Vec<StudioModel>, usize, String)>,
    pub compact_request: Option<u64>,
    pub compact_error: Option<String>,
    pub dormant: bool,
    pub terminal_command: Option<String>,
    pub terminal_session_id: Option<String>,
    pub terminal_output: String,
    pub terminal_input: TextEdit,
    pub terminal_cursor_visible: bool,
    pub terminal_cursor_blink_at: Option<std::time::Instant>,
    pub terminal_running: bool,
    pub terminal_child: Option<String>,
    pub terminal_exit_code: Option<i64>,
    pub terminal_error: Option<String>,
    pub terminal_cols: u16,
    pub terminal_rows: u16,
    pub worktree_path: Option<String>,
    pub handoff_source: Option<String>,
    pub past_providers: Vec<String>,
    pub draft: TextEdit,
    pub thread_open: bool,
    pub project_path: String,
    pub context_branch: Option<String>,
    pub composer_open: bool,
    pub composer_opened_at: Option<std::time::Instant>,
    pub composer_closing_at: Option<std::time::Instant>,
    pub orb_clock: Option<f64>,
    pub orb_last_tick: Option<f64>,
    pub orb_aim: Option<(f32, f32, f32)>,
    pub orb_hover: bool,
    pub orb_live: bool,
    pub fast_mode: bool,
    pub fast_tier: bool,
    pub context_window: Option<String>,
    pub blocked_reason: Option<(String, bool, Option<String>)>,
    pub workspace_steps: Vec<(String, String, String)>,
    pub workspace_heading: String,
    pub workspace_tray_open: bool,
    pub picker_open: bool,
    pub picker_opened_at: Option<std::time::Instant>,
    pub composer_menu_marker: Option<char>,
    pub composer_menu_index: usize,
    pub effort_picker_open: bool,
    pub mode_picker_open: bool,
    pub effort: String,
    pub mode: String,
    pub thread_id: String,
    pub resume: Option<String>,
    pub history_request: Option<u64>,
    pub started: bool,
    pub busy: bool,
    pub turn_started: Option<std::time::SystemTime>,
    pub turn_dismissed: bool,
    pub turn_seen: bool,
    pub turn_interrupted: bool,
    pub turn_title: String,
    pub pending_send: Option<String>,
    pub queued_turns: Vec<(String, String)>,
    pub subagents: Vec<(String, String, String)>,
    pub subagents_expanded: bool,
    pub archive_notice: Option<String>,
    /// Text selected in the focused thread, shown in the selection actions toolbar.
    pub selection_text: Option<String>,
    /// Fixture-only request to select a stable excerpt on first layout.
    pub selection_fixture_pending: bool,
    pub start_request: Option<u64>,
    pub send_request: Option<u64>,
    pub discover_request: Option<u64>,
    pub models_request: Option<u64>,
    pub restore_model: Option<String>,
    pub providers: Vec<StudioProvider>,
    pub provider_index: usize,
    pub models: Vec<StudioModel>,
    pub model_catalog: std::collections::HashMap<String, Vec<StudioModel>>,
    pub model_catalog_requests: std::collections::HashMap<u64, String>,
    pub model_index: usize,
    pub items: Vec<StudioItem>,
    pub error: Option<String>,
    pub approval: Option<StudioApproval>,
    pub question: Option<StudioQuestion>,
    pub answer: TextEdit,
}

#[derive(Clone, Default)]
pub struct StudioIdentity {
    pub name: String,
    pub svg: String,
    pub avatar: Option<String>,
}

impl StudioIdentity {
    fn from_value(value: &serde_json::Value) -> Option<Self> {
        Some(Self {
            name: value["name"].as_str()?.to_owned(),
            svg: value["svg"].as_str().unwrap_or("").to_owned(),
            avatar: value["avatar"].as_str().map(str::to_owned),
        })
    }
}

#[derive(Clone)]
pub struct StudioApproval {
    pub id: String,
    pub title: String,
    pub detail: String,
}

#[derive(Clone)]
pub struct StudioQuestion {
    pub id: String,
    pub questions: Vec<StudioQuestionEntry>,
    pub index: usize,
    pub answers: serde_json::Map<String, serde_json::Value>,
    pub selected: Vec<String>,
}
#[derive(Clone)]
pub struct StudioQuestionEntry {
    pub id: String,
    pub header: String,
    pub prompt: String,
    pub options: Vec<String>,
    pub multi: bool,
}

#[derive(Clone, Default)]
pub struct StudioItem {
    pub id: String,
    pub block_id: Option<String>,
    pub at: Option<u64>,
    pub kind: String,
    pub text: String,
    pub name: String,
    pub status: String,
    pub tasks: Vec<serde_json::Value>,
    pub detail: String,
}

#[derive(Clone)]
pub struct StudioProvider {
    pub id: String,
    pub label: String,
    pub supports_compaction: bool,
}

#[derive(Clone)]
pub struct StudioModel {
    pub id: String,
    pub label: String,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
}

fn studio_models(value: &serde_json::Value) -> Vec<StudioModel> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| {
            Some(StudioModel {
                id: model["id"].as_str()?.to_owned(),
                label: model["label"].as_str()?.to_owned(),
                efforts: model["reasoningEfforts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|effort| effort.as_str().map(str::to_owned))
                    .collect(),
                default_effort: model["defaultReasoningEffort"].as_str().map(str::to_owned),
            })
        })
        .collect()
}

fn token_count(n: u64) -> String {
    if n < 1_000 {
        return n.to_string();
    }
    if n < 10_000 {
        return format!("{:.1}", n as f64 / 1_000.0)
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_owned()
            + "k";
    }
    if n < 1_000_000 {
        return format!("{:.0}k", n as f64 / 1_000.0);
    }
    format!("{:.1}", n as f64 / 1_000_000.0)
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_owned()
        + "m"
}

fn compaction_item(value: &serde_json::Value) -> StudioItem {
    let mut text = "Context compacted".to_owned();
    if let (Some(before), Some(after)) = (
        value["beforeTokens"].as_u64(),
        value["afterTokens"].as_u64(),
    ) {
        text.push_str(&format!(
            " · {} → {}",
            token_count(before),
            token_count(after)
        ));
    }
    StudioItem {
        kind: "compaction".into(),
        text,
        at: value["at"].as_u64(),
        ..Default::default()
    }
}

fn history_items(result: &serde_json::Value) -> Vec<StudioItem> {
    let mut marks: Vec<StudioItem> = result["compactions"]
        .as_array()
        .into_iter()
        .flatten()
        .map(compaction_item)
        .collect();
    let fork = &result["forkContext"];
    if matches!(fork["forkKind"].as_str(), Some("branch" | "handoff")) {
        let verb = if fork["forkKind"] == "branch" {
            "Forked from"
        } else {
            "Handed from"
        };
        let provider = fork["sourceProvider"].as_str().unwrap_or("");
        let label = fork["sourceModel"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(if provider.is_empty() {
                "another provider"
            } else {
                provider
            });
        marks.push(StudioItem {
            kind: "handoff_mark".into(),
            text: format!("{verb} {label}"),
            name: provider.into(),
            status: fork["sourceThreadId"].as_str().unwrap_or("").into(),
            at: fork["importedAt"].as_u64(),
            ..Default::default()
        });
    }
    for link in result["continuations"].as_array().into_iter().flatten() {
        let provider = link["provider"].as_str().unwrap_or("");
        let label = link["model"].as_str().unwrap_or(provider);
        let verb = if link["kind"] == "branch" {
            "Forked to"
        } else {
            "Handed to"
        };
        marks.push(StudioItem {
            kind: "handoff_mark".into(),
            text: format!("{verb} {label}"),
            name: provider.into(),
            status: link["threadId"].as_str().unwrap_or("").into(),
            at: link["handedAt"].as_u64(),
            ..Default::default()
        });
    }
    marks.sort_by_key(|m| m.at.unwrap_or(u64::MAX));
    let mut marks = marks.into_iter().peekable();
    let mut out = Vec::new();
    let (mut effort, mut model): (Option<String>, Option<String>) = (None, None);
    for block in result["blocks"].as_array().into_iter().flatten() {
        let at = block["at"].as_u64();
        // Markers attach to the next request (exchange), never split a reply.
        if block["role"] == "user" {
            while marks
                .peek()
                .is_some_and(|m| m.at.unwrap_or(u64::MAX) <= at.unwrap_or(u64::MAX))
            {
                out.push(marks.next().unwrap());
            }
            let next_effort = block["effort"].as_str().filter(|s| !s.is_empty());
            let next_model = block["model"]
                .as_str()
                .filter(|s| !s.is_empty() && *s != "default");
            let mut from = Vec::new();
            let mut to = Vec::new();
            if let (Some(old), Some(new)) = (&model, next_model)
                && old != new
            {
                from.push(old.clone());
                to.push(new.to_owned());
            }
            if let (Some(old), Some(new)) = (&effort, next_effort)
                && old != new
            {
                from.push(old.clone());
                to.push(new.to_owned());
            }
            if !from.is_empty() {
                out.push(StudioItem {
                    kind: "setting_mark".into(),
                    text: format!("{} › {}", from.join(" · "), to.join(" · ")),
                    at,
                    ..Default::default()
                });
            }
            if let Some(v) = next_effort {
                effort = Some(v.to_owned());
            }
            if let Some(v) = next_model {
                model = Some(v.to_owned());
            }
            out.push(StudioItem {
                id: block["id"].as_str().unwrap_or("").into(),
                kind: "user".into(),
                text: block["text"].as_str().unwrap_or("").into(),
                at,
                ..Default::default()
            });
        } else {
            for item in block["items"].as_array().into_iter().flatten() {
                out.push(StudioItem {
                    id: item["itemId"].as_str().unwrap_or("").into(),
                    block_id: block["id"].as_str().map(str::to_owned),
                    at,
                    kind: item["kind"].as_str().unwrap_or("").into(),
                    text: item["text"].as_str().unwrap_or("").into(),
                    name: item["name"].as_str().unwrap_or("").into(),
                    status: item["status"].as_str().unwrap_or("").into(),
                    tasks: item["tasks"].as_array().cloned().unwrap_or_default(),
                    detail: item["detail"].as_str().unwrap_or("").to_owned(),
                });
            }
        }
    }
    out.extend(marks);
    out
}

impl AppState {
    pub fn composer_mention_files(&self) -> Vec<(String, String)> {
        if self
            .studio
            .conversation_fixture
            .as_deref()
            .is_some_and(|fixture| fixture.starts_with("composer-picker-mention"))
        {
            return [
                ("main.ts", "apps/desktop/src"),
                ("main.css", "apps/web/app/assets/css"),
                ("AgentComposer.vue", "apps/web/app/components"),
                ("ConversationThread.vue", "apps/web/app/components"),
                ("useAgent.ts", "apps/web/app/composables"),
                ("useGit.ts", "apps/web/app/composables"),
                ("index.vue", "apps/web/app/pages"),
                ("package.json", ""),
            ]
            .into_iter()
            .map(|(name, parent)| (name.into(), parent.into()))
            .collect();
        }
        let root = std::path::Path::new(&self.studio.project_path);
        if !root.is_dir() {
            return Vec::new();
        }
        static FILE_CACHE: std::sync::OnceLock<MentionFileCache> = std::sync::OnceLock::new();
        let cache = FILE_CACHE.get_or_init(Default::default);
        if let Ok(cache) = cache.lock()
            && let Some((at, files)) = cache.get(root)
            && at.elapsed() < std::time::Duration::from_secs(1)
        {
            return files.clone();
        }
        let ignored = [".git", "target", "node_modules", ".next", ".nuxt", "dist"];
        let mut pending = vec![(root.to_path_buf(), 0usize)];
        let mut paths = Vec::new();
        let mut visited = 0usize;
        while let Some((directory, depth)) = pending.pop() {
            if depth > 7 || visited >= 2500 {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&directory) else {
                continue;
            };
            let mut entries: Vec<_> = entries.flatten().collect();
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                visited += 1;
                if visited >= 2500 {
                    break;
                }
                let path = entry.path();
                let file_type = match entry.file_type() {
                    Ok(file_type) => file_type,
                    Err(_) => continue,
                };
                if file_type.is_symlink() {
                    continue;
                }
                if file_type.is_dir() {
                    if !ignored.contains(&entry.file_name().to_string_lossy().as_ref()) {
                        pending.push((path, depth + 1));
                    }
                } else if file_type.is_file() {
                    paths.push(path);
                }
            }
        }
        paths.sort();
        let files: Vec<_> = paths
            .into_iter()
            .take(120)
            .filter_map(|path| {
                let relative = path.strip_prefix(root).ok()?;
                let name = relative.file_name()?.to_string_lossy().into_owned();
                let parent = relative
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                    .map(|parent| parent.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                Some((name, parent))
            })
            .collect();
        if let Ok(mut cache) = cache.lock() {
            cache.insert(
                root.to_path_buf(),
                (std::time::Instant::now(), files.clone()),
            );
        }
        files
    }

    pub fn request(&mut self, method: &str, params: serde_json::Value) -> Option<u64> {
        match self
            .bridge
            .as_mut()
            .map(|bridge| bridge.request(method, params))
        {
            Some(Ok(id)) => Some(id),
            Some(Err(error)) => {
                self.studio.error = Some(error.to_string());
                None
            }
            None => {
                self.studio.error = Some("Agent service is unavailable".into());
                None
            }
        }
    }

    pub fn setup(s: &mut Self, wake: rune::Waker) {
        s.start_actions.live = true;
        s.studio.orb_live = true;
        if s.studio.mode.is_empty() {
            s.studio.mode = "accept-edits".into();
        }
        if let Ok(data) = std::fs::read(Self::changes_preferences_path()) {
            s.changes_folded = serde_json::from_slice(&data).unwrap_or_default();
        }
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let data = std::env::var_os("KONE_RUNE_DATA_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join("Library/Application Support/kone-rune"));
        let script = std::env::var_os("KONE_RUNE_SIDECAR_SCRIPT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("sidecar/dist/index.mjs")
            });
        let script = script.to_string_lossy();
        let node = std::env::var("KONE_RUNE_SIDECAR_NODE").unwrap_or_else(|_| "node".into());
        match crate::bridge::Bridge::start(&node, &[&script], &data, wake) {
            Ok(bridge) => {
                s.bridge = Some(bridge);
                s.studio.discover_request = s.request("agent.discover", serde_json::json!({}));
                s.project_list_request = s.request("projects.list", serde_json::json!({}));
                s.studio_load_request = s.request("studio.load", serde_json::json!({}));
            }
            Err(error) => s.studio.error = Some(format!("Could not start agent service: {error}")),
        }
    }

    pub fn poll(s: &mut Self, clock: f64, tx: &mut rune::Tx) -> bool {
        let toolbar_changed = crate::ui::scratchpad_toolbar::sync(&mut s.studio, tx);
        let mut scratchpad_motion =
            crate::ui::scratchpad_footer::poll(&mut s.studio, tx) || toolbar_changed;
        s.persist_scratchpad();
        let parked_pads: Vec<String> = s
            .studio_threads
            .iter()
            .filter(|(_, state)| state.scratchpad.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        for id in parked_pads {
            let parked = s.studio_threads.remove(&id).unwrap();
            let focused = std::mem::replace(&mut s.studio, parked);
            crate::ui::scratchpad_toolbar::sync(&mut s.studio, tx);
            scratchpad_motion |= crate::ui::scratchpad_footer::poll(&mut s.studio, tx);
            s.persist_scratchpad();
            let parked = std::mem::replace(&mut s.studio, focused);
            s.studio_threads.insert(id, parked);
        }
        if let Some((key, at)) = s.studio.conversation_scroll.clone() {
            let deadline = *s
                .studio
                .conversation_scroll_deadline
                .get_or_insert(clock + 1.0);
            if clock < deadline {
                tx.scroll_to_y(key, at);
                tx.wake_after(std::time::Duration::ZERO);
            } else {
                s.studio.conversation_scroll = None;
                s.studio.conversation_scroll_deadline = None;
            }
        }
        let title_blurred = s.studio.title_editing && !s.studio.title_draft.focused;
        if title_blurred {
            s.commit_studio_title();
        }
        let mut tooltip_changed = false;
        if let Some((tip, at)) = &s.studio.head_tooltip_pending {
            let elapsed = at.elapsed();
            if elapsed >= std::time::Duration::from_millis(300) {
                s.studio.head_tooltip = Some(tip.clone());
                s.studio.head_tooltip_pending = None;
                tooltip_changed = true;
            } else {
                tx.wake_after(std::time::Duration::from_millis(300) - elapsed);
            }
        }
        let animating = s
            .studio_fade
            .is_some_and(|(at, _)| at.elapsed().as_secs_f32() < 0.22)
            || s.studio_refusal
                .is_some_and(|at| at.elapsed().as_secs_f32() < 2.8);
        let activity_motion = s.page == Page::Studio && s.studio.busy;
        if activity_motion {
            tx.wake_after(std::time::Duration::from_millis(33));
        }
        let terminal_focused = s.page == Page::Studio && s.studio.terminal_input.focused;
        let mut terminal_cursor_changed = false;
        if terminal_focused {
            let now = std::time::Instant::now();
            let due = s
                .studio
                .terminal_cursor_blink_at
                .is_none_or(|at| now.duration_since(at) >= std::time::Duration::from_millis(500));
            if due {
                s.studio.terminal_cursor_visible = !s.studio.terminal_cursor_visible;
                s.studio.terminal_cursor_blink_at = Some(now);
                terminal_cursor_changed = true;
            }
            tx.wake_after(std::time::Duration::from_millis(500));
        } else {
            terminal_cursor_changed = !s.studio.terminal_cursor_visible;
            s.studio.terminal_cursor_visible = true;
            s.studio.terminal_cursor_blink_at = None;
        }
        if s.studio
            .composer_closing_at
            .is_some_and(|at| at.elapsed().as_secs_f32() >= 0.20)
        {
            s.studio.composer_closing_at = None;
        }
        if s.studio
            .composer_opened_at
            .is_some_and(|at| at.elapsed().as_secs_f32() >= 0.56)
        {
            s.studio.composer_opened_at = None;
        }
        let composer_motion = s.page == Page::Studio
            && (s.studio.composer_closing_at.is_some() || s.studio.composer_opened_at.is_some());
        if composer_motion {
            tx.wake_after(std::time::Duration::from_millis(16));
        }
        let orb_animating = s.page == Page::Studio
            && s.studio.orb_live
            && !s.studio.composer_open
            && s.studio.approval.is_none()
            && s.studio.question.is_none();
        if orb_animating {
            let dt = s
                .studio
                .orb_last_tick
                .map_or(0.0, |prev| (clock - prev).clamp(0.0, 0.05));
            s.studio.orb_last_tick = Some(clock);
            s.studio.orb_clock = Some(s.studio.orb_clock.unwrap_or(0.9) + dt);
            tx.wake_after(std::time::Duration::from_millis(33));
        } else {
            s.studio.orb_last_tick = None;
        }
        if s.studio_fade
            .is_some_and(|(at, _)| at.elapsed().as_secs_f32() >= 0.22)
        {
            s.studio_fade = None;
        }
        if s.studio_refusal
            .is_some_and(|at| at.elapsed().as_secs_f32() >= 2.8)
        {
            s.studio_refusal = None;
        }
        let recent_sessions = if s.page == Page::Overview {
            &s.project_data.sessions
        } else {
            &s.project_data.home_sessions
        };
        let recent_count = recent_sessions.iter().filter(|row| !row.pinned).count();
        let lazy = if matches!(s.page, Page::Projects | Page::Overview) {
            s.project_data.lazy.tick(recent_count, clock, tx)
        } else {
            s.project_data.lazy = Default::default();
            false
        };
        let icons = if s.page == Page::Projects {
            s.project_data.icons.tick(clock)
        } else {
            s.project_data.icons = Default::default();
            false
        };
        let holding = s.project_data.delete_hold.is_some();
        if s.project_data
            .delete_hold
            .as_ref()
            .is_some_and(|(at, _, _)| at.elapsed().as_secs_f32() >= 0.85)
        {
            if let Some((_, path, id)) = s.project_data.delete_hold.take() {
                s.session_action(path, id, "delete", false);
            }
        } else if holding {
            tx.wake_after(std::time::Duration::ZERO);
        }
        let metric_motion = s
            .project_data
            .metric_swap
            .is_some_and(|(at, _)| clock - at < 0.36);
        if metric_motion {
            tx.wake_after(std::time::Duration::ZERO);
        }
        let session_motion = s
            .project_data
            .session_hover_motion
            .values()
            .any(|(at, _, _)| clock - at < 0.34);
        if session_motion {
            tx.wake_after(std::time::Duration::ZERO);
        }
        let start = crate::ui::start_tick(s, clock, tx);
        let launcher = crate::launcher::tick(s, clock, tx);
        let mut messages = Vec::new();
        if let Some(bridge) = &s.bridge {
            while let Some(message) = bridge.try_recv() {
                messages.push(message);
            }
        }
        let changed = !messages.is_empty();
        for message in messages {
            if !s.project_message(&message) {
                s.studio_message(message);
            }
        }
        s.sync_project_watches();
        changed
            || scratchpad_motion
            || title_blurred
            || tooltip_changed
            || animating
            || activity_motion
            || terminal_cursor_changed
            || session_motion
            || metric_motion
            || holding
            || start
            || launcher
            || lazy
            || icons
            || (s.page == Page::Overview
                && (s.studio.busy || s.studio_threads.values().any(|t| t.busy)))
    }

    pub fn commit_studio_title(&mut self) {
        if !self.studio.title_editing {
            return;
        }
        let title: String = self
            .studio
            .title_draft
            .text
            .trim()
            .chars()
            .take(120)
            .collect();
        self.studio.title_editing = false;
        self.studio.title_draft.focused = false;
        if !title.is_empty() && title != self.studio.title {
            let previous = std::mem::replace(&mut self.studio.title, title.clone());
            if !self.studio.thread_id.is_empty() {
                self.studio.title_rename_request = self
                    .request(
                        "history.rename",
                        serde_json::json!({"threadId": self.studio.thread_id, "title": title}),
                    )
                    .map(|id| (id, previous));
            }
        }
    }

    fn park_studio_thread(&mut self) {
        self.persist_scratchpad();
        if self.studio.thread_id.is_empty() {
            return;
        }
        let next = StudioState {
            providers: self.studio.providers.clone(),
            provider_index: self.studio.provider_index,
            models: self.studio.models.clone(),
            model_index: self.studio.model_index,
            ..Default::default()
        };
        let mut previous = std::mem::replace(&mut self.studio, next);
        previous.draft = std::mem::take(&mut self.composer);
        self.studio_threads
            .insert(previous.thread_id.clone(), previous);
    }

    fn restore_studio_thread(&mut self, thread: &str) -> bool {
        if let Some(state) = self.studio_threads.remove(thread) {
            self.studio = state;
            self.composer = std::mem::take(&mut self.studio.draft);
            true
        } else {
            false
        }
    }

    pub fn select_studio_project(&mut self, index: usize) {
        if index >= self.projects.len() {
            return;
        }
        self.selected_project = Some(index);
        self.enter_studio();
        let path = self.projects[index].path.clone();
        self.studio_scroll_row = Some(path.clone());
        if self.studio_layout_ready {
            self.studio_layout["focusedRow"] = path.into();
            self.persist_studio_layout();
        }
    }

    pub fn enter_studio(&mut self) {
        let opening = self.page != Page::Studio;
        let saved_paths: Vec<String> = self.studio_layout["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| r["projectPath"].as_str().map(str::to_owned))
            .collect();
        for path in saved_paths {
            if !self.projects.iter().any(|project| project.path == path) {
                let name = path
                    .rsplit('/')
                    .find(|part| !part.is_empty())
                    .unwrap_or(&path)
                    .to_owned();
                self.projects.push(Project { name, path });
            }
        }
        if self.selected_project.is_none() {
            self.selected_project = self.studio_layout["focusedRow"].as_str().and_then(|path| {
                self.projects
                    .iter()
                    .position(|project| project.path == path)
            });
            if self.selected_project.is_none() && !self.projects.is_empty() {
                self.selected_project = Some(0);
            }
        }
        let Some(path) = self
            .selected_project
            .and_then(|i| self.projects.get(i))
            .map(|p| p.path.clone())
        else {
            return;
        };
        if opening {
            self.studio_under_page = self.page;
            self.studio_fade = Some((std::time::Instant::now(), true));
            self.studio_scroll_row = Some(path.clone());
        }
        self.page = Page::Studio;
        if self.studio.project_path != path {
            self.park_studio_thread();
            self.studio.project_path = path.clone();
            self.studio.thread_id.clear();
            self.studio.items.clear();
            self.studio.started = false;
            self.studio.busy = false;
            self.studio.resume = None;
        }
        let row = self.studio_layout["rows"]
            .as_array()
            .and_then(|rows| rows.iter().find(|r| r["projectPath"] == path));
        let thread = row
            .and_then(|r| {
                let panes = r["panes"].as_array()?;
                let focused = r["focusedId"].as_str();
                panes
                    .iter()
                    .find(|p| p["id"].as_str() == focused)
                    .and_then(|p| p["anchor"]["threadId"].as_str())
                    .or_else(|| panes.iter().find_map(|p| p["anchor"]["threadId"].as_str()))
            })
            .map(str::to_owned);
        if let Some(thread) = thread {
            if self.studio.thread_id != thread {
                self.open_studio_thread(thread);
            }
        } else if self.studio.thread_id.is_empty() {
            self.studio.thread_open = false;
        }
        self.load_visible_studio_threads();
    }

    fn load_visible_studio_threads(&mut self) {
        let threads: Vec<(String, String)> = self.studio_layout["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|r| {
                let path = r["projectPath"].as_str().unwrap_or("").to_owned();
                r["panes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(move |p| {
                        p["anchor"]["threadId"]
                            .as_str()
                            .map(|id| (id.to_owned(), path.clone()))
                    })
            })
            .filter(|(id, _)| id != &self.studio.thread_id && !self.studio_threads.contains_key(id))
            .collect();
        for (thread, path) in threads {
            if thread.starts_with("scratchpad:") {
                let mut state = StudioState {
                    thread_id: thread.clone(),
                    project_path: path,
                    thread_open: true,
                    ..Default::default()
                };
                Self::load_scratchpad(&mut state);
                self.studio_threads.insert(thread, state);
                continue;
            }
            if thread.starts_with("terminal:") {
                self.studio_threads.insert(
                    thread.clone(),
                    StudioState {
                        thread_id: thread,
                        project_path: path,
                        thread_open: true,
                        terminal_command: Some(String::new()),
                        ..Default::default()
                    },
                );
                continue;
            }
            let request = self.request("history.thread", serde_json::json!({"threadId": thread}));
            self.studio_threads.insert(
                thread.clone(),
                StudioState {
                    thread_id: thread,
                    project_path: path,
                    thread_open: true,
                    composer_open: true,
                    history_request: request,
                    providers: self.studio.providers.clone(),
                    provider_index: self.studio.provider_index,
                    models: self.studio.models.clone(),
                    model_index: self.studio.model_index,
                    ..Default::default()
                },
            );
        }
    }

    /// Center the focused column using the same seam and width geometry as the rail.
    pub fn center_studio_column(&self, tx: &mut rune::Tx) {
        let Some(row) = self.studio_layout["rows"].as_array().and_then(|rows| {
            rows.iter()
                .find(|row| row["projectPath"] == self.studio.project_path)
        }) else {
            return;
        };
        let Some(panes) = row["panes"].as_array() else {
            return;
        };
        if panes.len() < 2 {
            return;
        }
        let viewport = self.studio_viewport.0;
        let first_width = [840.0_f32, 960.0, 1120.0, 1240.0]
            [(panes[0]["width"].as_u64().unwrap_or(0) as usize).min(3)]
        .min(viewport);
        let mut left = 14.0 + ((viewport - first_width) / 2.0 - 14.0).max(0.0);
        for pane in panes {
            let focused = pane["anchor"]["threadId"] == self.studio.thread_id;
            let mut width = [840.0_f32, 960.0, 1120.0, 1240.0]
                [(pane["width"].as_u64().unwrap_or(0) as usize).min(3)]
            .min(viewport);
            if focused && pane["zen"].as_bool().unwrap_or(false) {
                width = viewport;
            }
            if focused {
                tx.scroll_to_x(
                    format!("studio-rail-{}", self.studio.project_path),
                    (left + width / 2.0 - viewport / 2.0).max(0.0),
                );
                break;
            }
            left += width + 14.0;
        }
    }

    pub fn studio_key(s: &mut Self, event: &rune::KeyEvent, tx: &mut rune::Tx) -> bool {
        if s.page != Page::Studio {
            return false;
        }
        if event.is_command('o') && event.mods.shift {
            let panes = s.studio_layout["rows"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|row| row["projectPath"] == s.studio.project_path)
                .and_then(|row| row["panes"].as_array());
            if s.studio_layout["rows"].as_array().is_some_and(|rows| {
                rows.iter().any(|row| {
                    row["panes"]
                        .as_array()
                        .is_some_and(|panes| !panes.is_empty())
                })
            }) {
                if s.studio.overview {
                    s.studio.overview = false;
                    s.center_studio_column(tx);
                } else {
                    s.studio.overview_selection = panes
                        .into_iter()
                        .flatten()
                        .position(|pane| pane["anchor"]["threadId"] == s.studio.thread_id)
                        .unwrap_or(0);
                    s.studio.overview = true;
                    let path = s.studio.project_path.clone();
                    tx.scroll_to_x(
                        format!("studio-rail-{path}"),
                        s.studio_overview_scroll_x(s.studio.overview_selection),
                    );
                }
            }
            return true;
        }
        if s.studio.overview {
            if matches!(event.key, rune::Key::Up | rune::Key::Down) {
                let step = if event.key == rune::Key::Up { -1 } else { 1 };
                let path = s.studio_layout["rows"].as_array().and_then(|rows| {
                    let rows: Vec<_> = rows
                        .iter()
                        .filter(|row| {
                            row["panes"]
                                .as_array()
                                .is_some_and(|panes| !panes.is_empty())
                        })
                        .collect();
                    let index = rows
                        .iter()
                        .position(|row| row["projectPath"] == s.studio.project_path)?;
                    rows.get(index.checked_add_signed(step)?)?["projectPath"]
                        .as_str()
                        .map(str::to_owned)
                });
                if let Some(path) = path
                    && let Some(index) = s.projects.iter().position(|project| project.path == path)
                {
                    s.select_studio_project(index);
                    s.studio.overview = true;
                    s.studio.overview_selection = s.studio_layout["rows"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|row| row["projectPath"] == path)
                        .and_then(|row| row["panes"].as_array())
                        .and_then(|panes| {
                            panes
                                .iter()
                                .position(|pane| pane["anchor"]["threadId"] == s.studio.thread_id)
                        })
                        .unwrap_or(0);
                    tx.scroll_into_view(format!("studio-row-slot-{path}"));
                }
                return true;
            }
            if event.key == rune::Key::Text(" ".into()) {
                s.studio.overview = false;
                s.center_studio_column(tx);
                return true;
            }
            let count = s.studio_layout["rows"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|row| row["projectPath"] == s.studio.project_path)
                .and_then(|row| row["panes"].as_array())
                .map_or(0, Vec::len);
            match event.key {
                rune::Key::Left | rune::Key::Right => {
                    let selection = if event.key == rune::Key::Left {
                        s.studio.overview_selection.saturating_sub(1)
                    } else {
                        (s.studio.overview_selection + 1).min(count.saturating_sub(1))
                    };
                    let id = s.studio_layout["rows"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|row| row["projectPath"] == s.studio.project_path)
                        .and_then(|row| row["panes"].as_array())
                        .and_then(|panes| panes.get(selection))
                        .and_then(|pane| pane["anchor"]["threadId"].as_str())
                        .map(str::to_owned);
                    if let Some(id) = id {
                        s.open_studio_thread(id);
                        s.studio.overview = true;
                    }
                    s.studio.overview_selection = selection;
                    let path = s.studio.project_path.clone();
                    tx.scroll_to_x(
                        format!("studio-rail-{path}"),
                        s.studio_overview_scroll_x(selection),
                    );
                    return true;
                }
                rune::Key::Enter => {
                    let id = s.studio_layout["rows"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|row| row["projectPath"] == s.studio.project_path)
                        .and_then(|row| row["panes"].as_array())
                        .and_then(|panes| panes.get(s.studio.overview_selection))
                        .and_then(|pane| pane["anchor"]["threadId"].as_str())
                        .map(str::to_owned);
                    if let Some(id) = id {
                        s.studio.overview = false;
                        s.open_studio_thread(id);
                        s.center_studio_column(tx);
                    }
                    return true;
                }
                _ => {}
            }
        }
        if s.studio.approval.is_some() {
            if event.key == rune::Key::Enter {
                s.answer_approval("allow-once");
                return true;
            }
            if event.key == rune::Key::Escape {
                s.answer_approval("reject-once");
                return true;
            }
        }
        if event.key == rune::Key::Escape && s.studio.selection_text.is_some() {
            s.studio.selection_text = None;
            tx.clear_text_selection();
            return true;
        }
        if s.conversation_search_open {
            match event.key {
                rune::Key::Escape => {
                    s.conversation_search_open = false;
                    s.conversation_search.clear();
                    return true;
                }
                rune::Key::Up | rune::Key::Down => {
                    let delta = if event.key == rune::Key::Down { 1 } else { -1 };
                    s.conversation_search_selection = s
                        .conversation_search_selection
                        .saturating_add_signed(delta)
                        .min(4);
                    return true;
                }
                rune::Key::Enter => {
                    let query = s.conversation_search.text.trim().to_lowercase();
                    let selected = std::iter::once((&s.studio.thread_id, &s.studio))
                        .chain(s.studio_threads.iter())
                        .flat_map(|(id, thread)| {
                            thread
                                .items
                                .iter()
                                .filter(|item| {
                                    !item.text.is_empty()
                                        && item.text.to_lowercase().contains(&query)
                                })
                                .map(move |_| id.clone())
                        })
                        .nth(s.conversation_search_selection);
                    if let Some(thread) = selected {
                        s.open_studio_thread(thread);
                    }
                    s.conversation_search_open = false;
                    return true;
                }
                _ => return false,
            }
        }
        if s.studio_project_menu_open {
            match event.key {
                rune::Key::Escape => {
                    s.studio_project_menu_open = false;
                    return true;
                }
                rune::Key::Up | rune::Key::Down => {
                    let len = s.projects.len().saturating_sub(1);
                    if len > 0 {
                        s.studio_project_selection = if event.key == rune::Key::Down {
                            (s.studio_project_selection + 1) % len
                        } else {
                            (s.studio_project_selection + len - 1) % len
                        };
                    }
                    return true;
                }
                rune::Key::Enter => {
                    let current = s.selected_project.unwrap_or(0);
                    let target = (0..s.projects.len())
                        .filter(|index| *index != current)
                        .nth(s.studio_project_selection);
                    s.studio_project_menu_open = false;
                    if let Some(index) = target {
                        s.select_studio_project(index);
                    }
                    return true;
                }
                _ => {}
            }
        }
        if s.studio_insert_menu.is_some() {
            match event.key {
                rune::Key::Up | rune::Key::Down => {
                    s.studio_insert_selection = if event.key == rune::Key::Down {
                        (s.studio_insert_selection + 1) % 3
                    } else {
                        (s.studio_insert_selection + 2) % 3
                    };
                    return true;
                }
                rune::Key::Enter => {
                    if let Some((_, index, _)) = s.studio_insert_menu.take() {
                        let blank_thread_open =
                            s.studio_layout["rows"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .find(|row| row["projectPath"] == s.studio.project_path)
                                .and_then(|row| row["panes"].as_array())
                                .is_some_and(|panes| panes.len() == 1)
                                && !s.studio.items.iter().any(|item| {
                                    item.kind == "user" && !item.text.trim().is_empty()
                                });
                        match s.studio_insert_selection {
                            0 if !blank_thread_open => s.insert_studio_thread(index),
                            1 => s.insert_studio_terminal(index),
                            2 => s.insert_studio_scratchpad(index),
                            _ => {}
                        }
                    }
                    s.studio_insert_selection = 0;
                    return true;
                }
                _ => {}
            }
        }
        if s.studio.handoff_picker
            && matches!(
                event.key,
                rune::Key::Down | rune::Key::Up | rune::Key::Enter
            )
        {
            let query = s.studio.handoff_query.text.trim().to_lowercase();
            let mut visible = Vec::new();
            for (provider_index, provider) in s.studio.providers.iter().enumerate() {
                let models = s.studio.model_catalog.get(&provider.id).or_else(|| {
                    (provider_index == s.studio.provider_index).then_some(&s.studio.models)
                });
                for (model_index, model) in models.into_iter().flatten().enumerate() {
                    if query.is_empty()
                        || format!("{} {} {}", model.label, model.id, provider.label)
                            .to_lowercase()
                            .contains(&query)
                    {
                        visible.push((provider_index, model_index));
                    }
                }
            }
            if !visible.is_empty() {
                let current = visible
                    .iter()
                    .position(|item| *item == (s.studio.provider_index, s.studio.model_index))
                    .unwrap_or(0);
                let selected = if event.key == rune::Key::Enter {
                    current
                } else if event.key == rune::Key::Down {
                    (current + 1) % visible.len()
                } else {
                    (current + visible.len() - 1) % visible.len()
                };
                let (provider_index, model_index) = visible[selected];
                let Some(provider) = s.studio.providers.get(provider_index) else {
                    return true;
                };
                let models = s
                    .studio
                    .model_catalog
                    .get(&provider.id)
                    .cloned()
                    .unwrap_or_else(|| {
                        if provider_index == s.studio.provider_index {
                            s.studio.models.clone()
                        } else {
                            Vec::new()
                        }
                    });
                if let Some(model) = models.get(model_index) {
                    let effort = model.default_effort.clone().unwrap_or_default();
                    s.studio.provider_index = provider_index;
                    s.studio.models = models;
                    s.studio.model_index = model_index;
                    s.studio.effort = effort;
                    s.studio.handoff_staged = true;
                }
            }
            return true;
        }
        if s.studio.picker_open {
            let query = s.studio.handoff_query.text.trim().to_lowercase();
            let mut visible = Vec::new();
            for (provider_index, provider) in s.studio.providers.iter().enumerate() {
                if query.is_empty() && provider_index != s.studio.provider_index {
                    continue;
                }
                let models = s.studio.model_catalog.get(&provider.id).or_else(|| {
                    (provider_index == s.studio.provider_index).then_some(&s.studio.models)
                });
                for (model_index, model) in models.into_iter().flatten().enumerate() {
                    if query.is_empty()
                        || format!("{} {} {}", model.label, model.id, provider.label)
                            .to_lowercase()
                            .contains(&query)
                    {
                        visible.push((provider_index, model_index));
                    }
                }
            }
            if matches!(event.key, rune::Key::Down | rune::Key::Up) && !visible.is_empty() {
                let current = visible
                    .iter()
                    .position(|(provider, model)| {
                        *provider == s.studio.provider_index && *model == s.studio.model_index
                    })
                    .unwrap_or(0);
                let next = if event.key == rune::Key::Down {
                    (current + 1) % visible.len()
                } else {
                    (current + visible.len() - 1) % visible.len()
                };
                let (provider, model) = visible[next];
                if provider != s.studio.provider_index {
                    s.studio.provider_index = provider;
                    s.studio.models = s
                        .studio
                        .providers
                        .get(provider)
                        .and_then(|provider| s.studio.model_catalog.get(&provider.id))
                        .cloned()
                        .unwrap_or_default();
                }
                s.studio.model_index = model;
                return true;
            }
            if event.key == rune::Key::Enter {
                let selected = visible
                    .contains(&(s.studio.provider_index, s.studio.model_index))
                    .then_some((s.studio.provider_index, s.studio.model_index))
                    .or_else(|| visible.first().copied());
                if let Some((provider, model)) = selected {
                    s.choose_studio_model(provider, model);
                }
                return true;
            }
        }
        if s.studio.composer_menu_marker.is_some() {
            match event.key {
                rune::Key::Escape => {
                    s.studio.composer_menu_marker = None;
                    s.studio.composer_menu_index = 0;
                    return true;
                }
                rune::Key::Down | rune::Key::Up => {
                    let marker = s.studio.composer_menu_marker.unwrap_or('/');
                    let query = s
                        .composer
                        .text
                        .trim_start_matches(marker)
                        .trim()
                        .to_lowercase();
                    let count = if marker == '/' {
                        [
                            ("/model", "Open model picker"),
                            ("/new", "Start a new thread"),
                        ]
                        .iter()
                        .filter(|(name, detail)| {
                            query.is_empty()
                                || name.contains(&query)
                                || detail.to_lowercase().contains(&query)
                        })
                        .count()
                    } else {
                        [
                            "main.ts",
                            "main.css",
                            "AgentComposer.vue",
                            "ConversationThread.vue",
                            "useAgent.ts",
                            "useGit.ts",
                            "index.vue",
                            "package.json",
                        ]
                        .iter()
                        .filter(|name| query.is_empty() || name.to_lowercase().contains(&query))
                        .count()
                    };
                    if count > 0 {
                        s.studio.composer_menu_index = if event.key == rune::Key::Down {
                            (s.studio.composer_menu_index + 1) % count
                        } else {
                            (s.studio.composer_menu_index + count - 1) % count
                        };
                    }
                    return true;
                }
                rune::Key::Enter | rune::Key::Tab => {
                    let marker = s.studio.composer_menu_marker.take();
                    let query = marker.map_or_else(String::new, |marker| {
                        s.composer
                            .text
                            .trim_start_matches(marker)
                            .trim()
                            .to_lowercase()
                    });
                    let selected_command = if marker == Some('/') {
                        ["/model", "/new"]
                            .iter()
                            .filter(|command| {
                                let detail = if **command == "/model" {
                                    "open model picker"
                                } else {
                                    "start a new thread"
                                };
                                query.is_empty()
                                    || command.contains(query.as_str())
                                    || detail.contains(query.as_str())
                            })
                            .nth(s.studio.composer_menu_index)
                            .copied()
                    } else {
                        None
                    };
                    s.studio.composer_menu_index = 0;
                    match marker {
                        Some('/') if selected_command == Some("/model") => {
                            s.composer.clear();
                            s.studio.picker_open = true;
                            s.studio.picker_opened_at = Some(std::time::Instant::now());
                            s.studio.handoff_query.text.clear();
                        }
                        Some('/') if selected_command == Some("/new") => {
                            s.composer.clear();
                            s.new_studio_thread();
                        }
                        Some('@') => {
                            let query = s
                                .composer
                                .text
                                .trim_start_matches('@')
                                .trim()
                                .to_lowercase();
                            let selected = s
                                .composer_mention_files()
                                .into_iter()
                                .filter(|(name, parent)| {
                                    query.is_empty()
                                        || name.to_lowercase().contains(&query)
                                        || parent.to_lowercase().contains(&query)
                                })
                                .nth(s.studio.composer_menu_index);
                            if let Some((file, parent)) = selected {
                                let path = if parent.is_empty() {
                                    file
                                } else {
                                    format!("{parent}/{file}")
                                };
                                s.composer.text = format!("@{path} ");
                                s.composer.focus = s.composer.text.len();
                                s.composer.anchor = s.composer.focus;
                            }
                        }
                        _ => {}
                    }
                    return true;
                }
                rune::Key::Backspace if s.composer.text.len() <= 1 => {
                    s.studio.composer_menu_marker = None;
                    s.studio.composer_menu_index = 0;
                }
                _ => {}
            }
        }
        if event.key == rune::Key::Escape {
            if s.studio.handoff_picker {
                s.cancel_handoff_picker();
                return true;
            }
            if s.studio.title_info_open {
                if s.studio.title_editing {
                    s.studio.title_editing = false;
                    return true;
                }
                s.studio.title_info_open = false;
                return true;
            }
            if s.studio.context_open {
                s.studio.context_open = false;
                return true;
            }
            if s.conversation_search_open {
                s.conversation_search_open = false;
                s.conversation_search.clear();
                return true;
            }
            if s.studio_project_menu_open {
                s.studio_project_menu_open = false;
                return true;
            }
            if s.studio_insert_menu.take().is_some() {
                return true;
            }
            if s.studio.picker_open || s.studio.mode_picker_open || s.studio.effort_picker_open {
                s.cancel_handoff_picker();
                s.studio.picker_open = false;
                s.studio.picker_opened_at = None;
                s.studio.mode_picker_open = false;
                s.studio.effort_picker_open = false;
                return true;
            }
            // The strip's Escape handler runs after popovers and menus in
            // Electron. Keep an open overview below those layers here too.
            if s.studio.overview {
                s.studio.overview = false;
                s.center_studio_column(tx);
                return true;
            }
            if s.studio.composer_open {
                s.close_composer();
                return true;
            }
        }
        if !event.mods.cmd {
            return false;
        }
        if event.mods.alt
            && event.mods.shift
            && matches!(event.key, rune::Key::Up | rune::Key::Down)
        {
            s.studio_refusal = Some(std::time::Instant::now());
            return true;
        }
        if event.key == rune::Key::Command('n') && !event.mods.shift && !event.mods.alt {
            s.new_studio_thread();
            s.center_studio_column(tx);
            return true;
        }
        if event.key == rune::Key::Command('r') && event.mods.shift && !event.mods.alt {
            let id = s.studio.thread_id.clone();
            s.cycle_studio_width(&id);
            s.center_studio_column(tx);
            return true;
        }
        if event.mods.alt && event.key == rune::Key::Enter && !event.mods.shift {
            let id = s.studio.thread_id.clone();
            s.toggle_studio_zen(&id);
            s.center_studio_column(tx);
            return true;
        }
        if event.mods.alt
            && event.mods.shift
            && matches!(event.key, rune::Key::Left | rune::Key::Right)
        {
            let delta = if event.key == rune::Key::Left { -1 } else { 1 };
            s.move_studio_thread(delta);
            s.center_studio_column(tx);
            return true;
        }
        if event.mods.alt
            && !event.mods.shift
            && matches!(event.key, rune::Key::Up | rune::Key::Down)
        {
            let step: isize = if event.key == rune::Key::Up { -1 } else { 1 };
            let path = s.studio_layout["rows"].as_array().and_then(|rows| {
                let index = rows
                    .iter()
                    .position(|r| r["projectPath"] == s.studio.project_path)?;
                rows.get(index.checked_add_signed(step)?)?["projectPath"]
                    .as_str()
                    .map(str::to_owned)
            });
            if let Some(path) = path
                && let Some(index) = s.projects.iter().position(|p| p.path == path)
            {
                s.select_studio_project(index);
                tx.scroll_into_view(format!("studio-row-slot-{path}"));
            }
            return true;
        }
        if event.mods.alt && !event.mods.shift {
            let step: isize = match event.key {
                rune::Key::Left => -1,
                rune::Key::Right => 1,
                _ => return false,
            };
            let panes = s.studio_layout["rows"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|r| r["projectPath"] == s.studio.project_path)
                .and_then(|r| r["panes"].as_array());
            let next = panes.and_then(|panes| {
                let index = panes
                    .iter()
                    .position(|p| p["anchor"]["threadId"] == s.studio.thread_id)?;
                let index = index.checked_add_signed(step)?;
                panes.get(index)?["anchor"]["threadId"]
                    .as_str()
                    .map(str::to_owned)
            });
            if let Some(id) = next {
                s.open_studio_thread(id.clone());
                s.center_studio_column(tx);
            }
            return true;
        }
        false
    }

    pub fn close_studio_thread(&mut self, thread: &str) {
        let path = self.studio.project_path.clone();
        let terminal_id = self
            .studio_threads
            .get(thread)
            .and_then(|s| s.terminal_session_id.clone())
            .or_else(|| {
                (self.studio.thread_id == thread)
                    .then(|| self.studio.terminal_session_id.clone())
                    .flatten()
            });
        if let Some(terminal_id) = terminal_id {
            self.request(
                "terminal.close",
                serde_json::json!({"terminalId": terminal_id}),
            );
        }
        let mut next = None;
        if let Some(row) = self.studio_layout["rows"]
            .as_array_mut()
            .and_then(|rows| rows.iter_mut().find(|r| r["projectPath"] == path))
            && let Some(panes) = row["panes"].as_array_mut()
        {
            let index = panes.iter().position(|p| p["anchor"]["threadId"] == thread);
            if let Some(index) = index {
                panes.remove(index);
            }
            next = panes
                .get(index.unwrap_or(0).min(panes.len().saturating_sub(1)))
                .and_then(|p| p["anchor"]["threadId"].as_str())
                .map(str::to_owned);
        }
        if self.studio.thread_id == thread {
            if let Some(next) = next {
                self.open_studio_thread(next);
            } else {
                self.park_studio_thread();
                self.studio.project_path = path;
                self.studio.thread_open = false;
            }
        }
        self.persist_studio_layout();
    }

    pub fn move_studio_thread(&mut self, delta: isize) {
        let path = self.studio.project_path.clone();
        if let Some(panes) = self.studio_layout["rows"]
            .as_array_mut()
            .and_then(|rows| rows.iter_mut().find(|r| r["projectPath"] == path))
            .and_then(|r| r["panes"].as_array_mut())
            && let Some(index) = panes
                .iter()
                .position(|p| p["anchor"]["threadId"] == self.studio.thread_id)
            && let Some(target) = index.checked_add_signed(delta).filter(|i| *i < panes.len())
        {
            panes.swap(index, target);
        }
        self.persist_studio_layout();
    }

    pub fn toggle_studio_zen(&mut self, thread: &str) {
        let path = self.studio.project_path.clone();
        if let Some(pane) = self.studio_layout["rows"]
            .as_array_mut()
            .and_then(|rows| rows.iter_mut().find(|r| r["projectPath"] == path))
            .and_then(|r| r["panes"].as_array_mut())
            .and_then(|panes| panes.iter_mut().find(|p| p["anchor"]["threadId"] == thread))
        {
            pane["zen"] = (!pane["zen"].as_bool().unwrap_or(false)).into();
        }
        self.persist_studio_layout();
    }

    pub fn cycle_studio_width(&mut self, thread: &str) {
        let path = self.studio.project_path.clone();
        if let Some(pane) = self.studio_layout["rows"]
            .as_array_mut()
            .and_then(|rows| rows.iter_mut().find(|r| r["projectPath"] == path))
            .and_then(|r| r["panes"].as_array_mut())
            .and_then(|panes| panes.iter_mut().find(|p| p["anchor"]["threadId"] == thread))
            && !pane["zen"].as_bool().unwrap_or(false)
        {
            pane["width"] = ((pane["width"].as_u64().unwrap_or(0) + 1) % 4).into();
        }
        self.persist_studio_layout();
    }

    fn persist_studio_layout(&mut self) {
        if self.studio_layout_ready {
            self.request(
                "studio.save",
                serde_json::json!({"layout": self.studio_layout}),
            );
        }
    }

    pub fn open_studio_thread(&mut self, thread: String) {
        if self.studio.thread_id == thread {
            return;
        }
        let project_path = self.studio.project_path.clone();
        self.park_studio_thread();
        if !self.restore_studio_thread(&thread) {
            self.studio.thread_id = thread.clone();
            self.studio.project_path = project_path;
            self.studio.thread_open = true;
            if thread.starts_with("scratchpad:") {
                Self::load_scratchpad(&mut self.studio);
                self.studio.composer_open = false;
            } else if thread.starts_with("terminal:") {
                self.studio.terminal_command = Some(String::new());
                self.studio.composer_open = false;
            } else {
                self.studio.composer_open = true;
                self.studio.history_request =
                    self.request("history.thread", serde_json::json!({"threadId": thread}));
            }
        }
        self.ensure_terminal_open(&thread);
        self.save_studio_layout();
    }

    fn ensure_terminal_open(&mut self, thread: &str) {
        let Some(terminal_id) = thread.strip_prefix("terminal:") else {
            return;
        };
        if self.studio.terminal_session_id.as_deref() == Some(terminal_id) {
            return;
        }
        self.studio.terminal_command = Some(String::new());
        self.studio.terminal_session_id = Some(terminal_id.to_owned());
        self.studio.terminal_input.focused = true;
        self.studio.terminal_error = None;
        let cwd = self.studio.project_path.clone();
        self.request(
            "terminal.open",
            serde_json::json!({"terminalId": terminal_id, "cwd": cwd, "cols": 80, "rows": 24}),
        );
    }

    pub fn new_studio_thread(&mut self) {
        if !self.studio_layout_ready {
            self.studio.error =
                Some("Studio is still loading or its saved layout could not be read.".into());
            return;
        }
        let project_path = self.studio.project_path.clone();
        self.park_studio_thread();
        self.studio.project_path = project_path;
        let time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        self.studio.thread_id = format!("rune-{}-{time}", std::process::id());
        self.studio.thread_open = true;
        self.studio.composer_open = false;
        self.studio.composer_opened_at = None;
        self.studio.composer_closing_at = None;
        self.studio.error = None;
        self.composer.clear();
        self.save_studio_layout();
    }

    pub fn open_composer(&mut self) {
        self.studio.composer_closing_at = None;
        if !self.studio.composer_open {
            self.studio.composer_opened_at = Some(std::time::Instant::now());
        }
        self.studio.composer_open = true;
        self.composer.focused = true;
    }

    pub fn close_composer(&mut self) {
        self.studio.composer_opened_at = None;
        if self.studio.composer_open {
            self.studio.composer_closing_at = Some(std::time::Instant::now());
        }
        self.studio.composer_open = false;
        self.composer.focused = false;
    }

    pub fn cycle_studio_mode(&mut self) {
        const ORDER: [&str; 3] = ["ask", "accept-edits", "full-access"];
        let current = if self.studio.mode.is_empty() {
            "accept-edits"
        } else {
            self.studio.mode.as_str()
        };
        let next = match ORDER.iter().position(|m| *m == current) {
            Some(i) => ORDER[(i + 1) % ORDER.len()],
            None => ORDER[1],
        };
        self.studio.mode = next.into();
    }

    pub fn cycle_studio_effort(&mut self) {
        let fallback = [
            "low".to_owned(),
            "medium".to_owned(),
            "high".to_owned(),
            "xhigh".to_owned(),
        ];
        let list: &[String] = self
            .studio
            .models
            .get(self.studio.model_index)
            .filter(|m| !m.efforts.is_empty())
            .map(|m| m.efforts.as_slice())
            .unwrap_or(&fallback);
        let cur = if self.studio.effort.is_empty() {
            "medium"
        } else {
            self.studio.effort.as_str()
        };
        let next = match list.iter().position(|e| e == cur) {
            Some(i) => &list[(i + 1) % list.len()],
            None => &list[0],
        };
        self.studio.effort = next.clone();
    }

    pub fn insert_studio_thread(&mut self, at: usize) {
        self.new_studio_thread();
        let path = self.studio.project_path.clone();
        if let Some(panes) = self.studio_layout["rows"]
            .as_array_mut()
            .and_then(|rows| rows.iter_mut().find(|r| r["projectPath"] == path))
            .and_then(|r| r["panes"].as_array_mut())
            && let Some(index) = panes
                .iter()
                .position(|p| p["anchor"]["threadId"] == self.studio.thread_id)
        {
            let pane = panes.remove(index);
            panes.insert(at.min(panes.len()), pane);
            self.persist_studio_layout();
        }
    }

    fn scratchpad_path(project: &str) -> std::path::PathBuf {
        let mut path = Self::changes_preferences_path();
        path.pop();
        path.push("scratchpads");
        // Encode losslessly, split below filesystem component limits.
        let encoded = project
            .as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        for chunk in encoded.as_bytes().chunks(80) {
            path.push(std::str::from_utf8(chunk).expect("hex is ASCII"));
        }
        path.push("document.html");
        path
    }

    fn load_scratchpad(state: &mut StudioState) {
        state.scratchpad_id = state.thread_id.clone();
        let text =
            std::fs::read_to_string(Self::scratchpad_path(&state.project_path)).unwrap_or_default();
        state.scratchpad_saved = text.clone();
        state.scratchpad_saved_at = std::fs::metadata(Self::scratchpad_path(&state.project_path))
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|at| crate::ui::scratchpad_footer::saved_time(at.as_millis() as u64));
        let mut edit = TextEdit::from_html(&text).rich();
        edit.focused = true;
        state.scratchpad = Some(edit);
    }

    pub fn retry_scratchpad_save(&mut self) {
        self.studio.scratchpad_conflict = false;
        self.studio.error = None;
        self.persist_scratchpad();
    }

    fn persist_scratchpad(&mut self) {
        if self.studio.scratchpad_conflict {
            return;
        }
        if self.studio.scratchpad.is_some()
            && self.bridge.is_some()
            && self.studio.scratchpad_revision == 0
        {
            if self.studio.scratchpad_load_request.is_none() {
                self.studio.scratchpad_load_request = self.request(
                    "scratchpad.list",
                    serde_json::json!({"projectPath":self.studio.project_path}),
                );
            }
            return;
        }
        let Some(edit) = self.studio.scratchpad.as_ref() else {
            return;
        };
        if self.studio.scratchpad_conflict {
            return;
        }
        if self.studio.scratchpad_load_request.is_some()
            || self.studio.scratchpad_save_request.is_some()
        {
            return;
        }
        let body = edit.to_html();
        if body == self.studio.scratchpad_saved {
            return;
        }
        if self.bridge.is_some() {
            self.studio.scratchpad_saving = body.clone();
            self.studio.scratchpad_save_request = self.request("scratchpad.save", serde_json::json!({"scratchpadId":self.studio.scratchpad_id,"projectPath":self.studio.project_path,"body":body,"expectedRevision":self.studio.scratchpad_revision.saturating_sub(1)}));
            return;
        }
        let path = Self::scratchpad_path(&self.studio.project_path);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::write(path, &body).is_ok() {
            self.studio.scratchpad_saved = body;
            self.studio.scratchpad_saved_at = Some(crate::ui::scratchpad_footer::saved_time_now());
        }
    }

    pub fn studio_scratchpad_open(&self) -> bool {
        self.studio_layout["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|r| r["projectPath"] == self.studio.project_path)
            .and_then(|r| r["panes"].as_array())
            .is_some_and(|panes| panes.iter().any(|p| p["kind"] == "scratchpad"))
    }

    pub fn insert_studio_scratchpad(&mut self, at: usize) {
        if !self.studio_layout_ready || self.studio_scratchpad_open() {
            return;
        }
        self.persist_scratchpad();
        let path = self.studio.project_path.clone();
        let id = format!("scratchpad:{path}");
        self.park_studio_thread();
        if let Some(row) = self.studio_layout["rows"]
            .as_array_mut()
            .and_then(|rows| rows.iter_mut().find(|r| r["projectPath"] == path))
        {
            if let Some(panes) = row["panes"].as_array_mut() {
                panes.insert(at.min(panes.len()), serde_json::json!({"id":id, "kind":"scratchpad", "anchor":{"kind":"scratchpad", "scratchpadId":id, "threadId":id}, "width":0}));
            }
            row["focusedId"] = id.clone().into();
        }
        self.studio.thread_id = id;
        self.studio.project_path = path;
        self.studio.thread_open = true;
        Self::load_scratchpad(&mut self.studio);
        self.persist_studio_layout();
    }

    pub fn insert_studio_terminal(&mut self, at: usize) {
        if !self.studio_layout_ready {
            return;
        }
        let path = self.studio.project_path.clone();
        let time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let terminal_id = format!("{}-{time}", std::process::id());
        let thread = format!("terminal:{terminal_id}");
        self.park_studio_thread();
        if let Some(panes) = self.studio_layout["rows"]
            .as_array_mut()
            .and_then(|rows| rows.iter_mut().find(|r| r["projectPath"] == path))
            .and_then(|r| r["panes"].as_array_mut())
        {
            panes.insert(at.min(panes.len()), serde_json::json!({"id": thread, "kind":"terminal", "anchor":{"kind":"thread","threadId":thread}, "width":0}));
        }
        if let Some(row) = self.studio_layout["rows"]
            .as_array_mut()
            .and_then(|rows| rows.iter_mut().find(|r| r["projectPath"] == path))
        {
            row["focusedId"] = thread.clone().into();
        }
        self.studio.thread_id = thread.clone();
        self.studio.project_path = path;
        self.studio.thread_open = true;
        self.studio.terminal_command = Some(String::new());
        self.studio.terminal_input.focused = true;
        self.studio.composer_open = false;
        self.ensure_terminal_open(&thread);
        self.persist_studio_layout();
    }

    pub fn terminal_write(&mut self, input: String) {
        let Some(terminal_id) = self.studio.terminal_session_id.clone() else {
            return;
        };
        self.request(
            "terminal.write",
            serde_json::json!({"terminalId": terminal_id, "data": input}),
        );
    }

    pub fn resize_terminal(&mut self, cols: u16, rows: u16) {
        let Some(terminal_id) = self.studio.terminal_session_id.clone() else {
            return;
        };
        let cols = cols.clamp(2, 1000);
        let rows = rows.clamp(1, 500);
        if self.studio.terminal_cols == cols && self.studio.terminal_rows == rows {
            return;
        }
        self.studio.terminal_cols = cols;
        self.studio.terminal_rows = rows;
        self.request(
            "terminal.resize",
            serde_json::json!({"terminalId": terminal_id, "cols": cols, "rows": rows}),
        );
    }

    pub fn submit_terminal_input(&mut self, tx: &mut rune::Tx) {
        let input = self.studio.terminal_input.text.clone();
        self.studio.terminal_input.clear();
        self.studio.terminal_input.focused = true;
        if !input.is_empty() {
            self.terminal_write(input);
        }
        self.terminal_write("\r".into());
        tx.wake_after(std::time::Duration::ZERO);
    }

    fn save_studio_layout(&mut self) {
        if !self.studio_layout_ready {
            return;
        }
        let Some(path) = self
            .selected_project
            .and_then(|i| self.projects.get(i))
            .map(|p| p.path.clone())
        else {
            return;
        };
        let mut rows = self.studio_layout["rows"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let pane = serde_json::json!({"id": self.studio.thread_id, "kind": "thread", "anchor": {"kind": "thread", "threadId": self.studio.thread_id}, "width": 0});
        if let Some(existing) = rows.iter_mut().find(|r| r["projectPath"] == path) {
            let mut focused_id = self.studio.thread_id.clone();
            if let Some(panes) = existing["panes"].as_array_mut() {
                if let Some(pane) = panes
                    .iter()
                    .find(|p| p["anchor"]["threadId"] == self.studio.thread_id)
                {
                    if let Some(id) = pane["id"].as_str() {
                        focused_id = id.to_owned();
                    }
                } else {
                    panes.push(pane);
                }
            }
            existing["focusedId"] = focused_id.into();
        } else {
            rows.push(serde_json::json!({"projectPath": path, "panes": [pane], "focusedId": self.studio.thread_id}));
        }
        self.studio_layout = serde_json::json!({"version": 2, "rows": rows, "focusedRow": path});
        self.request(
            "studio.save",
            serde_json::json!({"layout": self.studio_layout}),
        );
    }

    pub fn select_provider(&mut self, index: usize) {
        if index >= self.studio.providers.len()
            || (self.studio.started && !self.studio.handoff_picker && !self.studio.picker_open)
        {
            return;
        }
        self.studio.provider_index = index;
        let provider = self.studio.providers[index].id.clone();
        self.studio.models = self
            .studio
            .model_catalog
            .get(&provider)
            .cloned()
            .unwrap_or_default();
        self.studio.model_index = 0;
        self.studio.models_request =
            self.request("agent.models", serde_json::json!({"provider": provider}));
        if let Some(request) = self.studio.models_request {
            self.studio.model_catalog_requests.insert(request, provider);
        }
    }

    pub fn choose_studio_model(&mut self, provider_index: usize, model_index: usize) {
        let Some(provider) = self.studio.providers.get(provider_index) else {
            return;
        };
        let models = self
            .studio
            .model_catalog
            .get(&provider.id)
            .cloned()
            .unwrap_or_else(|| {
                if provider_index == self.studio.provider_index {
                    self.studio.models.clone()
                } else {
                    Vec::new()
                }
            });
        let Some(model) = models.get(model_index) else {
            return;
        };
        let effort = model.default_effort.clone().unwrap_or_default();
        self.studio.provider_index = provider_index;
        self.studio.models = models;
        self.studio.model_index = model_index;
        self.studio.effort = effort;
        self.studio.picker_open = false;
        self.studio.picker_opened_at = None;
    }

    pub fn open_handoff_picker(&mut self) {
        self.open_continuation_picker(None);
    }

    pub fn open_branch_picker(&mut self, block_id: String) {
        self.open_continuation_picker(Some(block_id));
    }

    fn open_continuation_picker(&mut self, block_id: Option<String>) {
        if self.studio.busy {
            self.studio.error = Some(
                if block_id.is_some() {
                    "This thread is still working — let it finish (or stop it) before forking."
                } else {
                    "This thread is still working — let it finish (or stop it) before handing off."
                }
                .into(),
            );
            return;
        }
        self.studio.branch_block_id = block_id;
        self.studio.handoff_selection = Some((
            self.studio.provider_index,
            self.studio.models.clone(),
            self.studio.model_index,
            self.studio.effort.clone(),
        ));
        self.studio.handoff_picker = true;
        self.studio.handoff_staged = false;
        self.studio.handoff_query = TextEdit::default();
        self.studio.picker_open = false;
    }

    pub fn cancel_handoff_picker(&mut self) {
        if let Some((provider, models, model, effort)) = self.studio.handoff_selection.take() {
            self.studio.provider_index = provider;
            self.studio.models = models;
            self.studio.model_index = model;
            self.studio.effort = effort;
            self.studio.models_request = None;
        }
        self.studio.handoff_picker = false;
        self.studio.branch_block_id = None;
        self.studio.handoff_staged = false;
    }

    pub fn create_continuation(&mut self, handoff: bool) {
        if self.studio.continuation_request.is_some() || self.studio.thread_id.is_empty() {
            return;
        }
        if handoff && self.studio.busy {
            self.studio.error = Some(
                "This thread is still working — let it finish (or stop it) before handing off."
                    .into(),
            );
            return;
        }
        let mut params = serde_json::json!({"sourceThreadId": self.studio.thread_id});
        if handoff {
            let Some(provider) = self.studio.providers.get(self.studio.provider_index) else {
                return;
            };
            let mut target = serde_json::json!({"provider": provider.id});
            if let Some(model) = self.studio.models.get(self.studio.model_index) {
                target["model"] = model.id.clone().into();
            }
            if !self.studio.effort.is_empty() {
                target["effort"] = self.studio.effort.clone().into();
            }
            params["target"] = target;
        }
        if handoff && let Some(block_id) = self.studio.branch_block_id.as_ref() {
            params["throughBlockId"] = block_id.clone().into();
        }
        self.cancel_handoff_picker();
        self.studio.picker_open = false;
        self.studio.continuation_request = self.request(
            if handoff {
                "agent.handoff"
            } else {
                "agent.sideChat"
            },
            params,
        );
    }

    pub fn send_studio(&mut self, tx: &mut rune::Tx) {
        let input = self.composer.text.trim().to_owned();
        if input.is_empty() {
            return;
        }
        if self.studio.busy {
            if self.studio.started {
                self.dispatch_studio_send(input);
                self.composer.clear();
            }
            return;
        }
        if !self.studio_layout_ready {
            self.studio.error =
                Some("Studio is still loading or its saved layout could not be read.".into());
            return;
        }
        let Some(project) = self.selected_project.and_then(|i| self.projects.get(i)) else {
            return;
        };
        let cwd = project.path.clone();
        let Some(provider) = self
            .studio
            .providers
            .get(self.studio.provider_index)
            .map(|p| p.id.clone())
        else {
            self.studio.error = Some(
                "No available agent provider. Install and sign in to a provider first.".into(),
            );
            return;
        };
        if self.studio.thread_id.is_empty() {
            let time = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            self.studio.thread_id = format!("rune-{}-{time}", std::process::id());
        }
        self.studio.error = None;
        self.studio.busy = true;
        self.studio.turn_started = Some(std::time::SystemTime::now());
        self.studio.turn_dismissed = false;
        self.studio.turn_seen = false;
        self.studio.turn_interrupted = false;
        if self.studio.turn_title.is_empty() {
            self.studio.turn_title = input.clone();
        }
        self.composer.clear();
        self.studio.items.push(StudioItem {
            id: format!("user-{}", self.studio.items.len()),
            kind: "user".into(),
            text: input.clone(),
            name: String::new(),
            ..Default::default()
        });
        tx.scroll_to_bottom("studio-transcript");
        if self.studio.started {
            self.dispatch_studio_send(input);
        } else {
            self.studio.pending_send = Some(input);
            let model = self
                .studio
                .models
                .get(self.studio.model_index)
                .map(|m| m.id.clone());
            let mut params = serde_json::json!({"threadId": self.studio.thread_id, "provider": provider, "cwd": cwd});
            if let Some(model) = model {
                params["model"] = model.into();
            }
            if !self.studio.effort.is_empty() {
                params["effort"] = self.studio.effort.clone().into();
            }
            if !self.studio.mode.is_empty() {
                params["mode"] = self.studio.mode.clone().into();
            }
            if let Some(resume) = &self.studio.resume {
                params["resume"] = resume.clone().into();
            }
            self.studio.start_request = self.request("agent.start", params);
            if self.studio.start_request.is_none() {
                self.studio.busy = false;
            }
        }
    }

    fn dispatch_studio_send(&mut self, input: String) {
        let model = self
            .studio
            .models
            .get(self.studio.model_index)
            .map(|m| m.id.clone());
        let mut params = serde_json::json!({"threadId": self.studio.thread_id, "input": input});
        if let Some(model) = model {
            params["model"] = model.into();
        }
        if !self.studio.effort.is_empty() {
            params["effort"] = self.studio.effort.clone().into();
        }
        if !self.studio.mode.is_empty() {
            params["mode"] = self.studio.mode.clone().into();
        }
        self.studio.send_request = self.request("agent.send", params);
        if self.studio.send_request.is_none() {
            self.studio.busy = false;
        }
    }

    pub fn interrupt_studio(&mut self) {
        self.request(
            "agent.interrupt",
            serde_json::json!({"threadId": self.studio.thread_id}),
        );
    }

    pub fn answer_approval(&mut self, decision: &str) {
        if let Some(approval) = self.studio.approval.take() {
            self.request("agent.approval", serde_json::json!({"threadId": self.studio.thread_id, "requestId": approval.id, "decision": decision}));
        }
    }

    pub fn answer_question(&mut self, answer: serde_json::Value) {
        let Some(mut request) = self.studio.question.take() else {
            return;
        };
        let Some(question) = request.questions.get(request.index) else {
            return;
        };
        request.answers.insert(question.id.clone(), answer);
        request.index += 1;
        request.selected.clear();
        self.studio.answer.clear();
        if request.index < request.questions.len() {
            self.studio.question = Some(request);
        } else {
            self.request("agent.userInput", serde_json::json!({"threadId": self.studio.thread_id, "requestId": request.id, "answers": request.answers}));
        }
    }

    pub fn toggle_question_option(&mut self, option: String) {
        let Some(request) = self.studio.question.as_mut() else {
            return;
        };
        if let Some(index) = request.selected.iter().position(|value| value == &option) {
            request.selected.remove(index);
        } else {
            request.selected.push(option);
        }
    }

    pub(crate) fn studio_message(&mut self, message: serde_json::Value) {
        if let Some(method) = message["method"]
            .as_str()
            .filter(|method| method.starts_with("terminal."))
        {
            let params = &message["params"];
            let id = params["terminalId"].as_str();
            let update = |state: &mut StudioState| {
                if state.terminal_session_id.as_deref() != id {
                    return;
                }
                match method {
                    "terminal.output" => {
                        if let Some(data) = params["data"].as_str() {
                            state.terminal_output.push_str(data);
                            if state.terminal_output.len() > 512 * 1024 {
                                let mut cut = state.terminal_output.len() - 512 * 1024;
                                while !state.terminal_output.is_char_boundary(cut) {
                                    cut += 1;
                                }
                                state.terminal_output.drain(..cut);
                            }
                        }
                    }
                    "terminal.activity" => {
                        state.terminal_running =
                            params["hasRunningSubprocess"].as_bool().unwrap_or(false);
                        state.terminal_child =
                            params["childCommandLabel"].as_str().map(str::to_owned);
                    }
                    "terminal.exited" => {
                        state.terminal_running = false;
                        state.terminal_child = None;
                        state.terminal_exit_code = params["exitCode"].as_i64();
                    }
                    "terminal.error" => {
                        state.terminal_error = params["error"].as_str().map(str::to_owned);
                    }
                    _ => {}
                }
            };
            update(&mut self.studio);
            for state in self.studio_threads.values_mut() {
                update(state);
            }
            return;
        }
        if message["method"] == "projects.cloneProgress" {
            crate::launcher::progress(self, &message["params"]);
            return;
        }
        let response_id = message.get("id").and_then(|v| v.as_u64());
        let event_thread = if message["method"] == "agent.event" {
            message["params"]["threadId"].as_str()
        } else {
            None
        };
        let target = self
            .studio_threads
            .iter()
            .find(|(thread, state)| {
                event_thread == Some(thread.as_str())
                    || response_id.is_some_and(|id| {
                        [
                            state.scratchpad_load_request,
                            state.scratchpad_save_request,
                            state.title_rename_request.as_ref().map(|(id, _)| *id),
                            state.export_request,
                            state.continuation_request,
                            state.compact_request,
                            state.history_request,
                            state.start_request,
                            state.send_request,
                            state.models_request,
                            state.discover_request,
                        ]
                        .contains(&Some(id))
                    })
            })
            .map(|(thread, _)| thread.clone());
        if let Some(thread) = target {
            // A successful continuation opens and focuses its child beside the
            // source, even if the user focused another pane while it ran.
            // Process it in the foreground: the usual temporary background swap
            // would otherwise discard the newly focused child on return.
            if message["result"]["threadId"].is_string()
                && response_id
                    .is_some_and(|id| self.studio_threads[&thread].continuation_request == Some(id))
            {
                let path = self.studio_threads[&thread].project_path.clone();
                self.park_studio_thread();
                self.restore_studio_thread(&thread);
                if let Some(index) = self.projects.iter().position(|p| p.path == path) {
                    self.selected_project = Some(index);
                    self.studio_scroll_row = Some(path);
                }
                self.studio_message(message);
                return;
            }
            let background = self.studio_threads.remove(&thread).unwrap();
            let foreground = std::mem::replace(&mut self.studio, background);
            self.studio_message(message);
            let background = std::mem::replace(&mut self.studio, foreground);
            self.studio_threads.insert(thread, background);
            return;
        }
        if let Some(id) = message.get("id").and_then(|v| v.as_u64()) {
            if self.studio.scratchpad_load_request == Some(id) {
                self.studio.scratchpad_load_request = None;
                if message.get("error").is_some() {
                    self.studio.scratchpad_conflict = true;
                    self.studio.error = Some(
                        "Could not load the saved Scratchpad. Your edits are preserved.".into(),
                    );
                    return;
                }
                if let Some(record) = message["result"]
                    .as_array()
                    .and_then(|records| records.first())
                {
                    self.studio.scratchpad_id = record["id"]
                        .as_str()
                        .unwrap_or(&self.studio.thread_id)
                        .to_owned();
                    let text = record["body"].as_str().unwrap_or_default().to_owned();
                    let changed = self.studio.scratchpad.as_ref().is_some_and(|edit| {
                        edit.to_html()
                            != TextEdit::from_html(&self.studio.scratchpad_saved).to_html()
                    });
                    if changed && !text.is_empty() {
                        self.studio.scratchpad_conflict = true;
                        self.studio.error = Some("Scratchpad loaded after editing began; your unsaved text is preserved.".into());
                    } else if !changed && let Some(edit) = self.studio.scratchpad.as_mut() {
                        *edit = TextEdit::from_html(&text).rich();
                    }
                    self.studio.scratchpad_saved = text;
                    self.studio.scratchpad_saved_at = record["updatedAt"]
                        .as_u64()
                        .map(crate::ui::scratchpad_footer::saved_time);
                    self.studio.scratchpad_revision = record["revision"].as_u64().unwrap_or(0) + 1;
                } else {
                    self.studio.scratchpad_revision = 1;
                }
                return;
            }
            if self.studio.scratchpad_save_request == Some(id) {
                self.studio.scratchpad_save_request = None;
                if let Some(revision) = message["result"]["revision"].as_u64() {
                    self.studio.scratchpad_revision = revision + 1;
                    self.studio.scratchpad_saved = self.studio.scratchpad_saving.clone();
                    self.studio.scratchpad_saved_at = Some(
                        message["result"]["savedAt"]
                            .as_u64()
                            .map(crate::ui::scratchpad_footer::saved_time)
                            .unwrap_or_else(crate::ui::scratchpad_footer::saved_time_now),
                    );
                } else if message["result"]["conflict"].is_number() {
                    self.studio.scratchpad_conflict = true;
                    self.studio.scratchpad_revision =
                        message["result"]["conflict"].as_u64().unwrap_or(0) + 1;
                    self.studio.error = Some(
                        "Scratchpad changed elsewhere; your unsaved text is preserved.".into(),
                    );
                }
                return;
            }
            if self.studio_load_request == Some(id) {
                self.studio_load_request = None;
                if message.get("error").is_some() {
                    self.studio.error = Some("Could not load the saved Studio layout.".into());
                    return;
                }
                self.studio_layout = if message["result"]["version"] == 2 {
                    message["result"].clone()
                } else {
                    serde_json::json!({"version": 2, "rows": [], "focusedRow": null})
                };
                self.studio_layout_ready = true;
                if self.page == Page::Studio {
                    self.enter_studio();
                }
                return;
            }
            if self.studio.continuation_request == Some(id) {
                self.studio.continuation_request = None;
                if let Some(error) = message["error"]["message"].as_str() {
                    self.studio.error = Some(error.to_owned());
                    return;
                }
                if let Some(thread) = message["result"]["threadId"].as_str() {
                    let source = self.studio.thread_id.clone();
                    let path = self.studio.project_path.clone();
                    let position = self.studio_layout["rows"]
                        .as_array()
                        .and_then(|rows| rows.iter().find(|r| r["projectPath"] == path))
                        .and_then(|row| row["panes"].as_array())
                        .and_then(|panes| {
                            panes.iter().position(|p| p["anchor"]["threadId"] == source)
                        })
                        .map(|i| i + 1);
                    self.open_studio_thread(thread.to_owned());
                    if let Some(at) = position {
                        if let Some(panes) = self.studio_layout["rows"]
                            .as_array_mut()
                            .and_then(|rows| rows.iter_mut().find(|r| r["projectPath"] == path))
                            .and_then(|r| r["panes"].as_array_mut())
                            && let Some(index) =
                                panes.iter().position(|p| p["anchor"]["threadId"] == thread)
                        {
                            let pane = panes.remove(index);
                            panes.insert(at.min(panes.len()), pane);
                        }
                        self.persist_studio_layout();
                    }
                }
                return;
            }
            if self.studio.history_request == Some(id) {
                self.studio.history_request = None;
                let result = &message["result"];
                self.studio.connected_identity = StudioIdentity::from_value(&result["identity"]);
                self.studio.resume = result["conversationId"].as_str().map(str::to_owned);
                self.studio.restore_model = result["model"].as_str().map(str::to_owned);
                self.studio.title = result["title"].as_str().unwrap_or("").to_owned();
                self.studio.worktree_path = result["worktreePath"].as_str().map(str::to_owned);
                let fork = &result["forkContext"];
                let kind = fork["forkKind"].as_str();
                self.studio.side_chat = result["relationshipToParent"] == "side_chat"
                    || (fork.is_object() && !matches!(kind, Some("edit" | "handoff")));
                self.studio.handoff_source = if matches!(kind, Some("handoff")) {
                    fork["sourceProvider"].as_str().map(str::to_owned)
                } else {
                    None
                };
                self.studio.context_usage = result["contextUsed"]
                    .as_u64()
                    .zip(result["contextWindow"].as_u64());
                self.studio.context_auto_compact =
                    result["compactsAutomatically"].as_bool().unwrap_or(false);
                if let Some(provider) = result["provider"].as_str()
                    && let Some(index) = self.studio.providers.iter().position(|p| p.id == provider)
                {
                    self.select_provider(index);
                }
                self.studio.items = history_items(result);
                return;
            }
            if self.launcher.completion_request_id == Some(id) {
                self.launcher.completion_request_id = None;
                if message.get("error").is_none() {
                    crate::launcher::completion_completed(self, &message["result"]);
                }
                return;
            }
            if self.launcher.browser_request_id == Some(id) {
                self.launcher.browser_request_id = None;
                if self.studio.compact_request == Some(id) {
                    self.studio.compact_request = None;
                    self.studio.compact_error =
                        message["error"]["message"].as_str().map(str::to_owned);
                    return;
                }
                if let Some(error) = message.get("error") {
                    crate::launcher::browser_failed(
                        self,
                        error["message"]
                            .as_str()
                            .unwrap_or("Directory listing failed"),
                    );
                } else {
                    crate::launcher::browser_completed(self, &message["result"]);
                }
                return;
            }
            if self.launcher.request_id == Some(id) {
                self.launcher.request_id = None;
                if self.studio.compact_request == Some(id) {
                    self.studio.compact_request = None;
                    self.studio.compact_error =
                        message["error"]["message"].as_str().map(str::to_owned);
                    return;
                }
                if let Some(error) = message.get("error") {
                    crate::launcher::failed(
                        self,
                        error["message"]
                            .as_str()
                            .unwrap_or("Project creation failed"),
                    );
                } else {
                    crate::launcher::completed(self, &message["result"]);
                }
                return;
            }
            if self.project_list_request == Some(id) || self.project_remember_request == Some(id) {
                let remember = self.project_remember_request == Some(id);
                self.project_list_request = None;
                self.project_remember_request = None;
                if let Some(projects) = message["result"].as_array() {
                    self.projects = projects
                        .iter()
                        .filter_map(|p| {
                            Some(Project {
                                name: p["name"].as_str()?.to_owned(),
                                path: p["path"].as_str()?.to_owned(),
                            })
                        })
                        .collect();
                    if !remember && self.page == Page::Empty && !self.projects.is_empty() {
                        self.page = Page::Projects;
                    }
                    if remember {
                        self.selected_project = self
                            .pending_project_path
                            .take()
                            .and_then(|path| self.projects.iter().position(|p| p.path == path));
                        if self.selected_project.is_some() {
                            self.page = Page::Overview;
                        }
                    }
                } else if let Some(error) = message["error"]["message"].as_str() {
                    self.studio.error = Some(error.to_owned());
                }
                return;
            }
            if self
                .studio
                .title_rename_request
                .as_ref()
                .is_some_and(|(request, _)| *request == id)
            {
                let (_, previous) = self.studio.title_rename_request.take().unwrap();
                if message.get("error").is_some() || message["result"] != true {
                    self.studio.title = previous;
                    self.studio.error = Some("Could not rename thread.".into());
                }
                return;
            }
            if self.studio.export_request == Some(id) {
                self.studio.export_request = None;
                self.studio.export_status = Some(if message.get("error").is_some() {
                    message["error"]["message"]
                        .as_str()
                        .unwrap_or("Export failed")
                        .to_owned()
                } else if message["result"]["ok"] == true {
                    "Thread exported.".into()
                } else {
                    message["result"]["message"]
                        .as_str()
                        .unwrap_or("Export failed")
                        .to_owned()
                });
                return;
            }
            if self.studio.compact_request == Some(id) {
                self.studio.compact_request = None;
                self.studio.compact_error = message["error"]["message"].as_str().map(str::to_owned);
                return;
            }
            if let Some(error) = message.get("error") {
                self.studio.model_catalog_requests.remove(&id);
                if self.studio.models_request == Some(id) {
                    self.studio.models_request = None;
                }
                self.studio.error = Some(
                    error
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Agent request failed")
                        .to_owned(),
                );
                if self.studio.start_request == Some(id) {
                    self.studio.pending_send = None;
                    self.studio.busy = false;
                    self.studio.start_request = None;
                }
                if self.studio.send_request == Some(id) {
                    self.studio.busy = false;
                    self.studio.send_request = None;
                }
                return;
            }
            if self.studio.send_request == Some(id) {
                self.studio.send_request = None;
            }
            let result = &message["result"];
            if self.studio.discover_request == Some(id) {
                self.studio.discover_request = None;
                self.studio.providers = result
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|p| p["available"].as_bool() == Some(true))
                    .filter_map(|p| {
                        Some(StudioProvider {
                            id: p["provider"].as_str()?.to_owned(),
                            label: p["label"].as_str()?.to_owned(),
                            supports_compaction: p["supportsThreadCompaction"]
                                .as_bool()
                                .unwrap_or(false),
                        })
                    })
                    .collect();
                if !self.studio.providers.is_empty() {
                    self.studio.provider_index = 0;
                    let providers: Vec<String> = self
                        .studio
                        .providers
                        .iter()
                        .map(|provider| provider.id.clone())
                        .collect();
                    for (index, provider) in providers.into_iter().enumerate() {
                        if let Some(request) =
                            self.request("agent.models", serde_json::json!({"provider": &provider}))
                        {
                            self.studio
                                .model_catalog_requests
                                .insert(request, provider.clone());
                            if index == 0 {
                                self.studio.models_request = Some(request);
                            }
                        }
                    }
                }
            } else if let Some(provider) = self.studio.model_catalog_requests.remove(&id) {
                let models = studio_models(result);
                self.studio
                    .model_catalog
                    .insert(provider.clone(), models.clone());
                if self.studio.models_request == Some(id) {
                    self.studio.models_request = None;
                    if self
                        .studio
                        .providers
                        .get(self.studio.provider_index)
                        .is_some_and(|active| active.id == provider)
                    {
                        self.studio.models = models;
                        self.studio.model_index = 0;
                    }
                }
            } else if self.studio.models_request == Some(id) {
                self.studio.models_request = None;
                self.studio.models = studio_models(result);
                if let Some(model) = self.studio.restore_model.take()
                    && let Some(index) = self.studio.models.iter().position(|m| m.id == model)
                {
                    self.studio.model_index = index;
                }
            } else if self.studio.start_request == Some(id) {
                self.studio.start_request = None;
                self.studio.started = true;
                self.studio.connected_identity = StudioIdentity::from_value(&result["identity"]);
                self.studio.worktree_path = result["worktreePath"].as_str().map(str::to_owned);
                if let Some(input) = self.studio.pending_send.take() {
                    self.dispatch_studio_send(input);
                }
            }
            return;
        }
        if message["method"] == "sidecar.exited" {
            let detail = message["params"]["error"]
                .as_str()
                .unwrap_or("Agent service exited")
                .to_owned();
            self.bridge.take();
            self.studio.error = Some(detail.clone());
            self.studio.busy = false;
            self.studio.pending_send = None;
            self.studio.start_request = None;
            self.studio.send_request = None;
            for state in self.studio_threads.values_mut() {
                state.error = Some(detail.clone());
                state.busy = false;
                state.pending_send = None;
                state.start_request = None;
                state.send_request = None;
            }
            self.launcher.completion_request_id = None;
            if self.launcher.browser_request_id.take().is_some() {
                crate::launcher::browser_failed(self, &detail);
            }
            if self.launcher.request_id.is_some() {
                crate::launcher::failed(self, &detail);
            }
            return;
        }
        if message["method"] != "agent.event" {
            return;
        }
        let event = &message["params"];
        if event["threadId"].as_str() != Some(&self.studio.thread_id) {
            return;
        }
        match event["type"].as_str().unwrap_or("") {
            "subagent.started" | "subagent.updated" | "subagent.completed" => {
                let run = &event["subagent"];
                if let Some(id) = run["toolUseId"].as_str() {
                    let title = run["description"]
                        .as_str()
                        .or_else(|| run["agentType"].as_str())
                        .unwrap_or("Subagent")
                        .to_owned();
                    let status = run["status"].as_str().unwrap_or("running").to_owned();
                    if let Some(row) = self.studio.subagents.iter_mut().find(|row| row.0 == id) {
                        *row = (id.to_owned(), title, status);
                    } else {
                        self.studio.subagents.push((id.to_owned(), title, status));
                        self.studio.subagents_expanded = true;
                    }
                }
            }
            "turn.queued" => {
                if let Some(id) = event["queueId"].as_str() {
                    self.studio.queued_turns.retain(|row| row.0 != id);
                    self.studio.queued_turns.push((
                        id.to_owned(),
                        event["input"]
                            .as_str()
                            .unwrap_or("Queued message")
                            .to_owned(),
                    ));
                }
            }
            "turn.promoted" | "turn.queued-cancelled" => {
                if let Some(id) = event["queueId"].as_str() {
                    self.studio.queued_turns.retain(|row| row.0 != id);
                }
            }
            "thread.state.changed" if event["state"] == "compacted" => {
                self.studio.context_usage = None;
                self.studio.context_input = None;
                self.studio.context_output = None;
                self.studio.context_total = None;
                self.studio.items.push(compaction_item(event));
            }
            "thread.token-usage.updated" => {
                let usage = &event["usage"];
                self.studio.context_usage = usage["contextUsed"]
                    .as_u64()
                    .zip(usage["contextWindow"].as_u64());
                self.studio.context_input = usage["input"].as_u64();
                self.studio.context_output = usage["output"].as_u64();
                self.studio.context_total = usage["total"].as_u64();
                self.studio.context_auto_compact =
                    usage["compactsAutomatically"].as_bool().unwrap_or(false);
            }
            "item.started" | "item.updated" | "item.completed" => {
                let item = &event["item"];
                let id = item["itemId"].as_str().unwrap_or("").to_owned();
                if id.is_empty() {
                    return;
                }
                let value = StudioItem {
                    id: id.clone(),
                    block_id: event["turnId"]
                        .as_str()
                        .map(|turn| format!("{}::{turn}", self.studio.thread_id)),
                    at: event["at"].as_u64(),
                    kind: item["kind"].as_str().unwrap_or("").to_owned(),
                    text: item["text"].as_str().unwrap_or("").to_owned(),
                    name: item["name"].as_str().unwrap_or("").to_owned(),
                    status: item["status"]
                        .as_str()
                        .unwrap_or(if event["type"] == "item.completed" {
                            "completed"
                        } else {
                            "in-progress"
                        })
                        .to_owned(),
                    tasks: item["tasks"].as_array().cloned().unwrap_or_default(),
                    detail: item["detail"].as_str().unwrap_or("").to_owned(),
                };
                if let Some(existing) = self.studio.items.iter_mut().find(|i| i.id == id) {
                    let at = existing.at.or(value.at);
                    *existing = value;
                    existing.at = at;
                } else {
                    self.studio.items.push(value);
                }
            }
            "approval.requested" => {
                self.studio.approval = Some(StudioApproval {
                    id: event["requestId"].as_str().unwrap_or("").to_owned(),
                    title: event["approval"]["title"]
                        .as_str()
                        .unwrap_or("Approval requested")
                        .to_owned(),
                    detail: event["approval"]["detail"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned(),
                });
            }
            "approval.resolved" => self.studio.approval = None,
            "user-input.requested" => {
                let questions: Vec<StudioQuestionEntry> = event["questions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|q| StudioQuestionEntry {
                        id: q["id"].as_str().unwrap_or("").to_owned(),
                        header: q["header"].as_str().unwrap_or("").to_owned(),
                        prompt: q["question"].as_str().unwrap_or("").to_owned(),
                        options: q["options"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|o| o["label"].as_str().map(str::to_owned))
                            .collect(),
                        multi: q["multiSelect"].as_bool().unwrap_or(false),
                    })
                    .collect();
                if !questions.is_empty() {
                    self.studio.question = Some(StudioQuestion {
                        id: event["requestId"].as_str().unwrap_or("").to_owned(),
                        questions,
                        index: 0,
                        answers: serde_json::Map::new(),
                        selected: Vec::new(),
                    });
                }
            }
            "user-input.resolved" => self.studio.question = None,
            "turn.completed" | "turn.aborted" | "session.exited" => {
                self.studio.turn_interrupted = event["type"] == "turn.aborted";
                self.studio.busy = false;
                if self.page == Page::Studio {
                    self.studio.turn_seen = true;
                }
            }
            "session.warning" => self.studio.error = event["message"].as_str().map(str::to_owned),
            _ => {}
        }
    }
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn continuation_focuses_child_beside_source_after_focus_changes() {
        let mut s = AppState::default();
        s.projects = vec![Project {
            name: "Project".into(),
            path: "/p".into(),
        }];
        s.selected_project = Some(0);
        s.studio_layout_ready = true;
        s.studio_layout = json!({"version":2,"focusedRow":"/p","rows":[{
            "projectPath":"/p","focusedId":"other","panes":[
                {"id":"source","kind":"thread","anchor":{"kind":"thread","threadId":"source"}},
                {"id":"other","kind":"thread","anchor":{"kind":"thread","threadId":"other"}}
            ]
        }]});
        s.studio.thread_id = "other".into();
        s.studio.project_path = "/p".into();
        s.studio_threads.insert(
            "source".into(),
            StudioState {
                thread_id: "source".into(),
                project_path: "/p".into(),
                continuation_request: Some(42),
                ..Default::default()
            },
        );

        s.studio_message(json!({"id":42,"result":{"threadId":"child"}}));

        assert_eq!(s.studio.thread_id, "child");
        assert!(s.studio_threads.contains_key("other"));
        assert!(s.studio_threads.contains_key("source"));
        let row = &s.studio_layout["rows"][0];
        assert_eq!(row["focusedId"], "child");
        let ids: Vec<_> = row["panes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pane| pane["anchor"]["threadId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["source", "child", "other"]);
    }

    #[test]
    fn restored_terminal_columns_stay_dormant_until_focused() {
        let mut s = AppState::default();
        s.projects = vec![Project {
            name: "Project".into(),
            path: "/p".into(),
        }];
        s.selected_project = Some(0);
        s.studio_layout_ready = true;
        s.studio.project_path = "/p".into();
        s.studio.thread_id = "thread-one".into();
        s.studio_layout = json!({"version":2,"focusedRow":"/p","rows":[{"projectPath":"/p","focusedId":"thread-one","panes":[
            {"id":"thread-one","kind":"thread","anchor":{"kind":"thread","threadId":"thread-one"}},
            {"id":"terminal:pty-one","kind":"terminal","anchor":{"kind":"thread","threadId":"terminal:pty-one"}}
        ]}]});

        s.load_visible_studio_threads();
        let terminal = &s.studio_threads["terminal:pty-one"];
        assert!(terminal.terminal_command.is_some());
        assert!(terminal.terminal_session_id.is_none());

        s.open_studio_thread("terminal:pty-one".into());
        assert_eq!(s.studio.terminal_session_id.as_deref(), Some("pty-one"));
    }

    #[test]
    fn restored_thread_recovers_header_metadata_and_zero_usage() {
        let mut s = AppState::default();
        s.studio.history_request = Some(42);
        s.studio_message(json!({"id":42,"result":{
            "title":"Review", "worktreePath":"/worktree", "relationshipToParent":"side_chat",
            "contextUsed":0, "contextWindow":200000, "compactsAutomatically":true, "blocks":[]
        }}));
        assert_eq!(s.studio.title, "Review");
        assert_eq!(s.studio.worktree_path.as_deref(), Some("/worktree"));
        assert!(s.studio.side_chat);
        assert_eq!(s.studio.context_usage, Some((0, 200000)));
        assert!(s.studio.context_auto_compact);
    }

    #[test]
    fn restored_handoff_and_side_chat_use_fork_context() {
        let mut s = AppState::default();
        s.studio.history_request = Some(1);
        s.studio_message(json!({"id":1,"result":{"forkContext":{
            "forkKind":"handoff", "sourceProvider":"claudeAgent"
        },"blocks":[]}}));
        assert_eq!(s.studio.handoff_source.as_deref(), Some("claudeAgent"));
        assert!(!s.studio.side_chat);
        s.studio.history_request = Some(2);
        s.studio_message(json!({"id":2,"result":{"forkContext":{
            "forkKind":"side_chat", "sourceProvider":"codex"
        },"blocks":[]}}));
        assert!(s.studio.side_chat);
        assert_eq!(s.studio.handoff_source, None);
    }

    #[test]
    fn context_usage_routes_to_the_matching_thread_and_requires_both_values() {
        let mut s = AppState::default();
        s.studio.thread_id = "a".into();
        s.studio_threads.insert(
            "b".into(),
            StudioState {
                thread_id: "b".into(),
                ..Default::default()
            },
        );
        s.studio_message(json!({"method":"agent.event", "params":{"threadId":"b", "type":"thread.token-usage.updated", "usage":{"contextUsed":0, "contextWindow":200000}}}));
        assert_eq!(s.studio.context_usage, None);
        assert_eq!(s.studio_threads["b"].context_usage, Some((0, 200000)));
        s.studio_message(json!({"method":"agent.event", "params":{"threadId":"b", "type":"thread.token-usage.updated", "usage":{"total":100}}}));
        assert_eq!(s.studio_threads["b"].context_usage, None);
    }

    #[test]
    fn streaming_item_snapshots_route_to_each_thread() {
        let mut s = AppState::default();
        s.studio.thread_id = "a".into();
        s.studio_threads.insert(
            "b".into(),
            StudioState {
                thread_id: "b".into(),
                ..Default::default()
            },
        );
        for (thread, value) in [("a", "first"), ("b", "other"), ("a", "complete")] {
            s.studio_message(json!({"method":"agent.event", "params": {"threadId":thread, "type":"item.updated", "item":{"itemId":"i", "kind":"assistant_text", "text":value}}}));
        }
        assert_eq!(s.studio.items.len(), 1);
        assert_eq!(s.studio.items[0].text, "complete");
        assert_eq!(s.studio_threads["b"].items[0].text, "other");
    }

    #[test]
    fn switching_keeps_drafts_and_background_interactions() {
        let mut s = AppState::default();
        s.studio_layout_ready = true;
        s.studio.thread_id = "a".into();
        s.studio.busy = true;
        s.composer.text = "draft a".into();
        s.new_studio_thread();
        let b = s.studio.thread_id.clone();
        s.composer.text = "draft b".into();
        s.studio_message(json!({"method":"agent.event", "params": {"threadId":"a", "type":"approval.requested", "requestId":"req", "approval":{"title":"Run command"}}}));
        s.open_studio_thread("a".into());
        assert!(s.studio.busy);
        assert_eq!(s.composer.text, "draft a");
        assert_eq!(s.studio.approval.as_ref().unwrap().id, "req");
        s.open_studio_thread(b);
        assert_eq!(s.composer.text, "draft b");
        assert!(s.studio.approval.is_none());
    }

    #[test]
    fn sidecar_exit_settles_every_running_thread() {
        let mut s = AppState::default();
        s.studio.busy = true;
        s.studio.pending_send = Some("one".into());
        s.studio_threads.insert(
            "b".into(),
            StudioState {
                busy: true,
                pending_send: Some("two".into()),
                ..Default::default()
            },
        );
        s.studio_message(json!({"method":"sidecar.exited", "params":{"error":"pipe closed"}}));
        assert!(!s.studio.busy && s.studio.pending_send.is_none());
        assert!(!s.studio_threads["b"].busy && s.studio_threads["b"].pending_send.is_none());
        assert_eq!(s.studio_threads["b"].error.as_deref(), Some("pipe closed"));
    }

    #[test]
    fn title_edit_commits_on_blur_and_escape_cancels() {
        let mut s = AppState::default();
        s.studio.title = "Original".into();
        s.studio.title_editing = true;
        s.studio.title_draft = TextEdit::new("  Updated  ");
        s.studio.title_draft.focused = false;
        AppState::poll(&mut s, 0.0, &mut rune::Tx::default());
        assert_eq!(s.studio.title, "Updated");
        assert!(!s.studio.title_editing);

        s.studio.title_editing = true;
        s.studio.title_draft = TextEdit::new("Discarded");
        s.studio.title_editing = false; // Escape cancels before focus is lost.
        AppState::poll(&mut s, 0.0, &mut rune::Tx::default());
        assert_eq!(s.studio.title, "Updated");
    }

    #[test]
    fn reorder_and_maximize_preserve_width_and_pane_identity() {
        let mut s = AppState {
            studio_layout_ready: true,
            ..Default::default()
        };
        s.studio.project_path = "/demo".into();
        s.studio.thread_id = "a".into();
        s.studio_layout = json!({"version":2,"rows":[{"projectPath":"/demo","panes":[
            {"id":"a", "anchor":{"threadId":"a"}, "width":1},
            {"id":"b", "anchor":{"threadId":"b"}, "width":0}
        ]}]});
        s.move_studio_thread(1);
        assert_eq!(s.studio_layout["rows"][0]["panes"][1]["id"], "a");
        s.toggle_studio_zen("a");
        s.cycle_studio_width("a");
        assert_eq!(s.studio_layout["rows"][0]["panes"][1]["width"], 1);
        assert_eq!(s.studio_layout["rows"][0]["panes"][1]["zen"], true);
        s.toggle_studio_zen("a");
        s.cycle_studio_width("a");
        assert_eq!(s.studio_layout["rows"][0]["panes"][1]["width"], 2);
    }

    #[test]
    fn focus_width_and_close_update_only_the_target_pane() {
        let mut s = AppState::default();
        s.projects.push(Project {
            name: "demo".into(),
            path: "/demo".into(),
        });
        s.selected_project = Some(0);
        s.studio_layout_ready = true;
        s.studio.project_path = "/demo".into();
        s.studio.thread_id = "a".into();
        s.studio.thread_open = true;
        s.studio_layout = json!({"version":2, "rows":[{"projectPath":"/demo", "focusedId":"a", "panes":[
            {"id":"a", "anchor":{"threadId":"a"}, "width":0},
            {"id":"b", "anchor":{"threadId":"b"}, "width":0}
        ]}], "focusedRow":"/demo"});
        s.studio_threads.insert(
            "b".into(),
            StudioState {
                thread_id: "b".into(),
                thread_open: true,
                project_path: "/demo".into(),
                ..Default::default()
            },
        );
        s.cycle_studio_width("b");
        assert_eq!(s.studio_layout["rows"][0]["panes"][1]["width"], 1);
        s.open_studio_thread("b".into());
        assert_eq!(s.studio_layout["rows"][0]["focusedId"], "b");
        s.close_studio_thread("b");
        assert_eq!(s.studio.thread_id, "a");
        assert_eq!(
            s.studio_layout["rows"][0]["panes"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(s.studio_layout["rows"][0]["focusedId"], "a");
    }

    #[test]
    fn new_thread_waits_for_layout_to_load() {
        let mut s = AppState::default();
        s.new_studio_thread();
        assert!(s.studio.thread_id.is_empty());
        assert!(s.studio.error.is_some());
    }

    #[test]
    fn saving_a_pane_keeps_other_projects_and_existing_panes() {
        let mut s = AppState::default();
        s.projects.push(Project {
            name: "a".into(),
            path: "/a".into(),
        });
        s.selected_project = Some(0);
        s.studio.thread_id = "new".into();
        s.studio_layout_ready = true;
        s.studio_layout = json!({"version":2, "rows":[
            {"projectPath":"/a", "focusedId":"old", "panes":[{"id":"old", "kind":"thread", "anchor":{"kind":"thread", "threadId":"old"}}]},
            {"projectPath":"/b", "focusedId":"b", "panes":[{"id":"b"}]}
        ], "focusedRow":"/a"});
        s.save_studio_layout();
        let rows = s.studio_layout["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["panes"].as_array().unwrap().len(), 2);
        assert_eq!(rows[0]["focusedId"], "new");
        assert_eq!(rows[1]["projectPath"], "/b");
    }
}

#[derive(Default)]
pub(crate) struct StartActionsState {
    pub(crate) page: Option<Page>,
    pub(crate) bounds: [[f32; 4]; 3],
    pub(crate) offsets: [[f32; 2]; 3],
    pub(crate) active: [bool; 3],
    /// The poll's frame clock (seconds) the times below are on.
    pub(crate) clock: f64,
    /// A running app (not a `--scene` snapshot), whose start screen enters.
    pub(crate) live: bool,
    /// When the start screen mounted, for its entrance.
    pub(crate) mounted: Option<f64>,
    /// The rotating wordmark's word, the one before it, and when it changed.
    pub(crate) word: usize,
    pub(crate) prev_word: Option<usize>,
    pub(crate) word_at: Option<f64>,
}

impl StartActionsState {
    pub(crate) fn reset_for_page(&mut self, page: Page) -> bool {
        if self.page == Some(page) {
            return false;
        }
        self.page = Some(page);
        self.bounds = [[0.0; 4]; 3];
        self.offsets = [[0.0; 2]; 3];
        self.active = [false; 3];
        true
    }

    pub(crate) fn pointer_move(&mut self, x: f32, y: f32, pending: bool) -> bool {
        let mut offsets = [[0.0; 2]; 3];
        let mut active = self.active;
        if !pending {
            active = [false; 3];
            for i in 0..3 {
                let [left, top, width, height] = self.bounds[i];
                let dx = x - (left + width / 2.0);
                let dy = y - (top + height / 2.0);
                active[i] =
                    width > 0.0 && dx.abs() < width / 2.0 + 12.0 && dy.abs() < height / 2.0 + 12.0;
                if active[i] {
                    offsets[i] = [dx / 9.0, dy / 9.0];
                }
            }
        }
        let changed = offsets != self.offsets || active != self.active;
        self.offsets = offsets;
        self.active = active;
        changed
    }
}

#[cfg(test)]
mod start_actions_tests {
    use super::{Page, StartActionsState, StudioModel, StudioProvider};

    #[test]
    fn studio_overview_toggles_navigates_and_enters_a_column() {
        let mut s = super::AppState {
            page: Page::Studio,
            selected_project: Some(0),
            projects: vec![super::Project {
                name: "kone".into(),
                path: "/demo".into(),
            }],
            ..Default::default()
        };
        s.studio.project_path = "/demo".into();
        s.studio.thread_id = "thread-one".into();
        s.studio_layout = serde_json::json!({"version":2,"rows":[{"projectPath":"/demo","focusedId":"thread-one","panes":[
            {"id":"thread-one","kind":"thread","width":0,"anchor":{"kind":"thread","threadId":"thread-one"}},
            {"id":"thread-two","kind":"thread","width":0,"anchor":{"kind":"thread","threadId":"thread-two"}}
        ]}]});
        let toggle = rune::KeyEvent {
            key: rune::Key::Command('o'),
            mods: rune::Mods {
                cmd: true,
                shift: true,
                ..Default::default()
            },
        };
        let right = rune::KeyEvent {
            key: rune::Key::Right,
            mods: rune::Mods::default(),
        };
        let enter = rune::KeyEvent {
            key: rune::Key::Enter,
            mods: rune::Mods::default(),
        };
        let mut tx = rune::Tx::default();
        assert!(super::AppState::studio_key(&mut s, &toggle, &mut tx));
        assert!(s.studio.overview);
        assert_eq!(s.studio.overview_selection, 0);
        assert!(super::AppState::studio_key(&mut s, &right, &mut tx));
        assert_eq!(s.studio.overview_selection, 1);
        assert_eq!(s.studio.thread_id, "thread-two");
        for exit in [rune::Key::Escape, rune::Key::Text(" ".into())] {
            let exit = rune::KeyEvent {
                key: exit,
                mods: rune::Mods::default(),
            };
            assert!(super::AppState::studio_key(&mut s, &exit, &mut tx));
            assert!(!s.studio.overview);
            assert_eq!(s.studio.thread_id, "thread-two");
            assert!(super::AppState::studio_key(&mut s, &toggle, &mut tx));
            assert!(s.studio.overview);
        }
        assert!(super::AppState::studio_key(&mut s, &enter, &mut tx));
        assert!(!s.studio.overview);
        assert_eq!(s.studio.thread_id, "thread-two");
    }

    #[test]
    fn studio_overview_vertical_navigation_changes_rows_and_space_exits() {
        let mut s = super::AppState {
            page: Page::Studio,
            selected_project: Some(0),
            projects: vec![
                super::Project {
                    name: "kone".into(),
                    path: "/demo".into(),
                },
                super::Project {
                    name: "nova".into(),
                    path: "/nova".into(),
                },
            ],
            ..Default::default()
        };
        s.studio.project_path = "/demo".into();
        s.studio.thread_id = "one".into();
        s.studio.overview = true;
        s.studio_layout = serde_json::json!({"version":2,"rows":[
            {"projectPath":"/demo","focusedId":"one","panes":[{"id":"one","kind":"thread","width":0,"anchor":{"kind":"thread","threadId":"one"}}]},
            {"projectPath":"/nova","focusedId":"two","panes":[{"id":"two","kind":"thread","width":0,"anchor":{"kind":"thread","threadId":"two"}}]}
        ]});
        let mut tx = rune::Tx::default();
        let key = |key| rune::KeyEvent {
            key,
            mods: rune::Mods::default(),
        };
        assert!(super::AppState::studio_key(
            &mut s,
            &key(rune::Key::Down),
            &mut tx
        ));
        assert_eq!(s.studio.project_path, "/nova");
        assert!(s.studio.overview);
        assert!(super::AppState::studio_key(
            &mut s,
            &key(rune::Key::Down),
            &mut tx
        ));
        assert_eq!(s.studio.project_path, "/nova");
        assert!(super::AppState::studio_key(
            &mut s,
            &key(rune::Key::Up),
            &mut tx
        ));
        assert_eq!(s.studio.project_path, "/demo");
        assert!(s.studio.overview);
        assert!(super::AppState::studio_key(
            &mut s,
            &key(rune::Key::Text(" ".into())),
            &mut tx
        ));
        assert!(!s.studio.overview);
        assert_eq!(s.studio.thread_id, "one");
    }

    #[test]
    fn composer_model_search_selects_a_matching_model_from_another_provider() {
        let mut s = super::AppState {
            page: Page::Studio,
            ..Default::default()
        };
        s.studio.picker_open = true;
        s.studio.providers = vec![
            StudioProvider {
                id: "codex".into(),
                label: "Codex".into(),
                supports_compaction: false,
            },
            StudioProvider {
                id: "claudeAgent".into(),
                label: "Claude".into(),
                supports_compaction: false,
            },
        ];
        s.studio.models = vec![StudioModel {
            id: "gpt-model".into(),
            label: "GPT Model".into(),
            efforts: vec!["medium".into()],
            default_effort: Some("medium".into()),
        }];
        s.studio.model_catalog.insert(
            "claudeAgent".into(),
            vec![StudioModel {
                id: "claude-model".into(),
                label: "Claude Model".into(),
                efforts: vec!["high".into()],
                default_effort: Some("high".into()),
            }],
        );
        s.studio.handoff_query.text = "Claude".into();
        let down = rune::KeyEvent {
            key: rune::Key::Down,
            mods: rune::Mods::default(),
        };
        let enter = rune::KeyEvent {
            key: rune::Key::Enter,
            mods: rune::Mods::default(),
        };
        let mut tx = rune::Tx::default();
        assert!(super::AppState::studio_key(&mut s, &down, &mut tx));
        assert_eq!(s.studio.provider_index, 1);
        assert_eq!(s.studio.models[0].id, "claude-model");
        assert!(super::AppState::studio_key(&mut s, &enter, &mut tx));
        assert!(!s.studio.picker_open);
        assert_eq!(s.studio.effort, "high");
    }

    #[test]
    fn page_change_clears_geometry_and_magnet_state_once() {
        let mut state = StartActionsState::default();
        assert!(state.reset_for_page(Page::Empty));
        state.bounds[0] = [10.0, 20.0, 100.0, 40.0];
        state.offsets[0] = [3.0, 2.0];
        state.active[0] = true;
        assert!(!state.reset_for_page(Page::Empty));
        assert_eq!(state.bounds[0], [10.0, 20.0, 100.0, 40.0]);
        assert!(state.reset_for_page(Page::Projects));
        assert_eq!(state.bounds, [[0.0; 4]; 3]);
        assert_eq!(state.offsets, [[0.0; 2]; 3]);
        assert_eq!(state.active, [false; 3]);
        assert!(!state.pointer_move(60.0, 40.0, false));
    }

    #[test]
    fn pending_retains_pull_until_move_then_preserves_transition_state() {
        let mut state = StartActionsState::default();
        state.bounds[0] = [0.0, 0.0, 100.0, 40.0];
        assert!(state.pointer_move(59.0, 20.0, false));
        assert_eq!(state.offsets[0], [1.0, 0.0]);
        assert!(state.active[0]);
        // Entering pending does not itself update the magnet.
        let pending = true;
        assert_eq!(state.offsets[0], [1.0, 0.0]);
        assert!(state.pointer_move(59.0, 20.0, pending));
        assert_eq!(state.offsets[0], [0.0, 0.0]);
        assert!(state.active[0]);
        assert!(!state.pointer_move(60.0, 20.0, pending));
        assert!(state.pointer_move(200.0, 20.0, false));
        assert!(!state.active[0]);
    }

    #[test]
    fn studio_escape_closes_picker_then_overview_then_composer_before_leaving_studio() {
        let mut s = super::AppState {
            page: Page::Studio,
            ..Default::default()
        };
        s.studio.composer_open = true;
        s.studio.mode_picker_open = true;
        s.studio.overview = true;
        s.composer.focused = true;
        let esc = rune::KeyEvent {
            key: rune::Key::Escape,
            mods: rune::Mods::default(),
        };
        let mut tx = rune::Tx::default();
        assert!(super::AppState::studio_key(&mut s, &esc, &mut tx));
        assert!(!s.studio.mode_picker_open);
        assert!(s.studio.overview);
        assert!(s.studio.composer_open);

        assert!(super::AppState::studio_key(&mut s, &esc, &mut tx));
        assert!(!s.studio.overview);
        assert!(s.studio.composer_open);

        assert!(super::AppState::studio_key(&mut s, &esc, &mut tx));
        assert!(!s.studio.composer_open);
        assert!(!s.composer.focused);

        assert!(!super::AppState::studio_key(&mut s, &esc, &mut tx));
    }

    #[test]
    fn studio_escape_dismisses_composer_trigger_before_collapsing_composer() {
        let mut s = super::AppState {
            page: Page::Studio,
            ..Default::default()
        };
        s.studio.composer_open = true;
        s.studio.composer_menu_marker = Some('@');
        s.composer.text = "@main".into();
        let esc = rune::KeyEvent {
            key: rune::Key::Escape,
            mods: rune::Mods::default(),
        };
        let mut tx = rune::Tx::default();
        assert!(super::AppState::studio_key(&mut s, &esc, &mut tx));
        assert_eq!(s.studio.composer_menu_marker, None);
        assert!(s.studio.composer_open);
        assert!(super::AppState::studio_key(&mut s, &esc, &mut tx));
        assert!(!s.studio.composer_open);
    }

    #[test]
    fn studio_overlay_escape_closes_only_the_top_layer() {
        let mut s = super::AppState {
            page: Page::Studio,
            ..Default::default()
        };
        s.studio.title_info_open = true;
        s.conversation_search_open = true;
        let esc = rune::KeyEvent {
            key: rune::Key::Escape,
            mods: rune::Mods::default(),
        };
        let mut tx = rune::Tx::default();
        assert!(super::AppState::studio_key(&mut s, &esc, &mut tx));
        assert!(!s.conversation_search_open);
        assert!(s.studio.title_info_open);
        assert!(super::AppState::studio_key(&mut s, &esc, &mut tx));
        assert!(!s.studio.title_info_open);
    }

    #[test]
    fn studio_project_switch_walks_destinations_and_selects_with_enter() {
        let mut s = super::AppState {
            page: Page::Studio,
            projects: vec![
                super::Project {
                    name: "kone".into(),
                    path: "/kone".into(),
                },
                super::Project {
                    name: "nova".into(),
                    path: "/nova".into(),
                },
                super::Project {
                    name: "atlas".into(),
                    path: "/atlas".into(),
                },
            ],
            selected_project: Some(0),
            studio_project_menu_open: true,
            ..Default::default()
        };
        let mut tx = rune::Tx::default();
        let key = |key| rune::KeyEvent {
            key,
            mods: rune::Mods::default(),
        };
        assert!(super::AppState::studio_key(
            &mut s,
            &key(rune::Key::Down),
            &mut tx
        ));
        assert_eq!(s.studio_project_selection, 1);
        assert!(super::AppState::studio_key(
            &mut s,
            &key(rune::Key::Enter),
            &mut tx
        ));
        assert_eq!(s.selected_project, Some(2));
        assert!(!s.studio_project_menu_open);
    }

    #[test]
    fn studio_insert_menu_uses_arrow_selection_and_enter() {
        let mut s = super::AppState {
            page: Page::Studio,
            ..Default::default()
        };
        s.projects.push(super::Project {
            name: "kone".into(),
            path: "/demo".into(),
        });
        s.selected_project = Some(0);
        s.studio_layout_ready = true;
        s.studio.project_path = "/demo".into();
        s.studio_layout = serde_json::json!({"version":2,"rows":[{"projectPath":"/demo","focusedId":"thread","panes":[]}]});
        s.studio_insert_menu = Some(("/demo".into(), 0, [20.0, 20.0, 14.0, 28.0]));
        let down = rune::KeyEvent {
            key: rune::Key::Down,
            mods: rune::Mods::default(),
        };
        let enter = rune::KeyEvent {
            key: rune::Key::Enter,
            mods: rune::Mods::default(),
        };
        let mut tx = rune::Tx::default();
        assert!(super::AppState::studio_key(&mut s, &down, &mut tx));
        assert_eq!(s.studio_insert_selection, 1);
        assert!(super::AppState::studio_key(&mut s, &enter, &mut tx));
        assert!(s.studio_insert_menu.is_none());
        assert_eq!(s.studio_layout["rows"][0]["panes"][0]["kind"], "terminal");
    }

    #[test]
    fn scratchpad_keyboard_inserts_one_project_scoped_pane() {
        let mut s = super::AppState {
            page: Page::Studio,
            studio_layout_ready: true,
            ..Default::default()
        };
        s.studio.project_path = "/scratchpad-keyboard-fixture".into();
        s.studio_layout = serde_json::json!({"version":2,"rows":[{"projectPath":s.studio.project_path,"panes":[]}]});
        s.studio_insert_menu = Some((s.studio.project_path.clone(), 0, [0.0; 4]));
        s.studio_insert_selection = 2;
        let enter = rune::KeyEvent {
            key: rune::Key::Enter,
            mods: rune::Mods::default(),
        };
        assert!(super::AppState::studio_key(
            &mut s,
            &enter,
            &mut rune::Tx::default()
        ));
        assert!(s.studio.scratchpad.is_some());
        assert_eq!(s.studio_layout["rows"][0]["panes"][0]["kind"], "scratchpad");
        s.insert_studio_scratchpad(0);
        assert_eq!(
            s.studio_layout["rows"][0]["panes"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn scratchpad_restores_store_content_and_acknowledges_only_saved_snapshot() {
        let mut s = super::AppState::default();
        s.studio.scratchpad = Some(rune::TextEdit::default());
        s.studio.scratchpad_load_request = Some(41);
        s.studio_message(serde_json::json!({"id":41,"result":[{"id":"pad-a","body":"project note","revision":3}]}));
        assert_eq!(s.studio.scratchpad.as_ref().unwrap().text, "project note");
        assert_eq!(s.studio.scratchpad_id, "pad-a");
        assert_eq!(s.studio.scratchpad_revision, 4);
        s.studio.scratchpad_saving = "first edit".into();
        s.studio.scratchpad.as_mut().unwrap().text = "later edit".into();
        s.studio.scratchpad_save_request = Some(42);
        s.studio_message(serde_json::json!({"id":42,"result":{"revision":4}}));
        assert_eq!(s.studio.scratchpad_saved, "first edit");
        assert_eq!(s.studio.scratchpad.as_ref().unwrap().text, "later edit");
        assert_eq!(s.studio.scratchpad_revision, 5);
    }

    #[test]
    fn scratchpad_late_load_preserves_typing_and_conflict_pauses_writes() {
        let mut s = super::AppState::default();
        let mut edit = rune::TextEdit::from_html("<p>typed during load</p>");
        edit.focused = true;
        s.studio.scratchpad = Some(edit);
        s.studio.scratchpad_load_request = Some(51);
        s.studio_message(serde_json::json!({"id":51,"result":[{"id":"existing","body":"<p>remote note</p>","revision":2}]}));
        assert_eq!(
            s.studio.scratchpad.as_ref().unwrap().text,
            "typed during load"
        );
        assert!(s.studio.scratchpad_conflict);
        s.persist_scratchpad();
        assert!(s.studio.scratchpad_save_request.is_none());
        s.studio.scratchpad_conflict = false;
        s.studio.scratchpad_save_request = Some(52);
        s.studio_message(serde_json::json!({"id":52,"result":{"conflict":3}}));
        assert!(s.studio.scratchpad_conflict);
        s.persist_scratchpad();
        assert!(s.studio.scratchpad_save_request.is_none());
    }

    #[test]
    fn scratchpad_storage_path_uses_bounded_components() {
        let path = super::AppState::scratchpad_path(&format!("/{}", "a".repeat(1024)));
        assert!(path.components().all(|part| part.as_os_str().len() <= 255));
        assert_ne!(path, super::AppState::scratchpad_path("/another/a"));
    }

    #[test]
    fn mode_and_effort_cycle_through_expected_order() {
        let mut s = super::AppState::default();
        s.cycle_studio_mode();
        assert_eq!(s.studio.mode, "full-access");
        s.cycle_studio_mode();
        assert_eq!(s.studio.mode, "ask");
        s.cycle_studio_mode();
        assert_eq!(s.studio.mode, "accept-edits");

        s.cycle_studio_effort();
        assert_eq!(s.studio.effort, "high");
        s.cycle_studio_effort();
        assert_eq!(s.studio.effort, "xhigh");
    }
}

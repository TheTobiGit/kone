use rune::TextEdit;

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

#[derive(Default)]
pub struct AppState {
    pub art_focused: bool,
    pub start_actions: StartActionsState,
    pub project_data: crate::project_state::ProjectState,
    pub page: Page,
    pub projects: Vec<Project>,
    pub selected_project: Option<usize>,
    pub search: TextEdit,
    pub composer: TextEdit,
    pub studio: StudioState,
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
}

impl AppState {
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
    pub draft: TextEdit,
    pub thread_open: bool,
    pub project_path: String,
    pub composer_open: bool,
    pub picker_open: bool,
    pub effort_picker_open: bool,
    pub mode_picker_open: bool,
    pub effort: String,
    pub mode: String,
    pub thread_id: String,
    pub resume: Option<String>,
    pub history_request: Option<u64>,
    pub started: bool,
    pub busy: bool,
    pub pending_send: Option<String>,
    pub start_request: Option<u64>,
    pub send_request: Option<u64>,
    pub discover_request: Option<u64>,
    pub models_request: Option<u64>,
    pub restore_model: Option<String>,
    pub providers: Vec<StudioProvider>,
    pub provider_index: usize,
    pub models: Vec<StudioModel>,
    pub model_index: usize,
    pub items: Vec<StudioItem>,
    pub error: Option<String>,
    pub approval: Option<StudioApproval>,
    pub question: Option<StudioQuestion>,
    pub answer: TextEdit,
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
    pub prompt: String,
    pub options: Vec<String>,
    pub multi: bool,
}

#[derive(Clone, Default)]
pub struct StudioItem {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub name: String,
}

#[derive(Clone)]
pub struct StudioProvider {
    pub id: String,
    pub label: String,
}

#[derive(Clone)]
pub struct StudioModel {
    pub id: String,
    pub label: String,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
}

impl AppState {
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
        let start = crate::ui::start_tick(s, clock, tx);
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
        changed || start
    }

    fn park_studio_thread(&mut self) {
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
        self.page = Page::Studio;
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
        }
        let Some(path) = self
            .selected_project
            .and_then(|i| self.projects.get(i))
            .map(|p| p.path.clone())
        else {
            return;
        };
        if opening {
            self.studio_scroll_row = Some(path.clone());
        }
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

    pub fn studio_key(s: &mut Self, event: &rune::KeyEvent, tx: &mut rune::Tx) -> bool {
        if s.page != Page::Studio {
            return false;
        }
        if event.key == rune::Key::Escape {
            if s.studio.picker_open || s.studio.mode_picker_open || s.studio.effort_picker_open {
                s.studio.picker_open = false;
                s.studio.mode_picker_open = false;
                s.studio.effort_picker_open = false;
                return true;
            }
            if s.studio.composer_open {
                s.studio.composer_open = false;
                s.composer.focused = false;
                return true;
            }
        }
        if !event.mods.cmd {
            return false;
        }
        if event.key == rune::Key::Command('n') && !event.mods.shift && !event.mods.alt {
            s.new_studio_thread();
            tx.scroll_into_view(format!("studio-pane-{}", s.studio.thread_id));
            return true;
        }
        if event.key == rune::Key::Command('r') && event.mods.shift && !event.mods.alt {
            let id = s.studio.thread_id.clone();
            s.cycle_studio_width(&id);
            return true;
        }
        if event.mods.alt && event.key == rune::Key::Enter && !event.mods.shift {
            let id = s.studio.thread_id.clone();
            s.toggle_studio_zen(&id);
            tx.scroll_into_view(format!("studio-pane-{id}"));
            return true;
        }
        if event.mods.alt
            && event.mods.shift
            && matches!(event.key, rune::Key::Left | rune::Key::Right)
        {
            let delta = if event.key == rune::Key::Left { -1 } else { 1 };
            s.move_studio_thread(delta);
            tx.scroll_into_view(format!("studio-pane-{}", s.studio.thread_id));
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
                tx.scroll_into_view(format!("studio-pane-{id}"));
            }
            return true;
        }
        false
    }

    pub fn close_studio_thread(&mut self, thread: &str) {
        let path = self.studio.project_path.clone();
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
            self.studio.composer_open = true;
            self.studio.history_request =
                self.request("history.thread", serde_json::json!({"threadId": thread}));
        }
        self.save_studio_layout();
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
        self.studio.error = None;
        self.composer.clear();
        self.save_studio_layout();
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
        if index >= self.studio.providers.len() || self.studio.started {
            return;
        }
        self.studio.provider_index = index;
        self.studio.models.clear();
        self.studio.model_index = 0;
        let provider = self.studio.providers[index].id.clone();
        self.studio.models_request =
            self.request("agent.models", serde_json::json!({"provider": provider}));
    }

    pub fn send_studio(&mut self, tx: &mut rune::Tx) {
        let input = self.composer.text.trim().to_owned();
        if input.is_empty() || self.studio.busy {
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
        self.composer.clear();
        self.studio.items.push(StudioItem {
            id: format!("user-{}", self.studio.items.len()),
            kind: "user".into(),
            text: input.clone(),
            name: String::new(),
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
            let background = self.studio_threads.remove(&thread).unwrap();
            let foreground = std::mem::replace(&mut self.studio, background);
            self.studio_message(message);
            let background = std::mem::replace(&mut self.studio, foreground);
            self.studio_threads.insert(thread, background);
            return;
        }
        if let Some(id) = message.get("id").and_then(|v| v.as_u64()) {
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
            if self.studio.history_request == Some(id) {
                self.studio.history_request = None;
                let result = &message["result"];
                self.studio.resume = result["conversationId"].as_str().map(str::to_owned);
                self.studio.restore_model = result["model"].as_str().map(str::to_owned);
                if let Some(provider) = result["provider"].as_str()
                    && let Some(index) = self.studio.providers.iter().position(|p| p.id == provider)
                {
                    self.select_provider(index);
                }
                self.studio.items.clear();
                for block in result["blocks"].as_array().into_iter().flatten() {
                    if block["role"] == "user" {
                        self.studio.items.push(StudioItem {
                            id: block["id"].as_str().unwrap_or("").to_owned(),
                            kind: "user".into(),
                            text: block["text"].as_str().unwrap_or("").to_owned(),
                            name: String::new(),
                        });
                    } else {
                        for item in block["items"].as_array().into_iter().flatten() {
                            self.studio.items.push(StudioItem {
                                id: item["itemId"].as_str().unwrap_or("").to_owned(),
                                kind: item["kind"].as_str().unwrap_or("").to_owned(),
                                text: item["text"].as_str().unwrap_or("").to_owned(),
                                name: item["name"].as_str().unwrap_or("").to_owned(),
                            });
                        }
                    }
                }
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
            if let Some(error) = message.get("error") {
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
                        })
                    })
                    .collect();
                if !self.studio.providers.is_empty() {
                    self.select_provider(0);
                }
            } else if self.studio.models_request == Some(id) {
                self.studio.models_request = None;
                self.studio.models = result
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|m| {
                        Some(StudioModel {
                            id: m["id"].as_str()?.to_owned(),
                            label: m["label"].as_str()?.to_owned(),
                            efforts: m["reasoningEfforts"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(|e| e.as_str().map(str::to_owned))
                                .collect(),
                            default_effort: m["defaultReasoningEffort"].as_str().map(str::to_owned),
                        })
                    })
                    .collect();
                if let Some(model) = self.studio.restore_model.take()
                    && let Some(index) = self.studio.models.iter().position(|m| m.id == model)
                {
                    self.studio.model_index = index;
                }
            } else if self.studio.start_request == Some(id) {
                self.studio.start_request = None;
                self.studio.started = true;
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
            "item.started" | "item.updated" | "item.completed" => {
                let item = &event["item"];
                let id = item["itemId"].as_str().unwrap_or("").to_owned();
                if id.is_empty() {
                    return;
                }
                let value = StudioItem {
                    id: id.clone(),
                    kind: item["kind"].as_str().unwrap_or("").to_owned(),
                    text: item["text"].as_str().unwrap_or("").to_owned(),
                    name: item["name"].as_str().unwrap_or("").to_owned(),
                };
                if let Some(existing) = self.studio.items.iter_mut().find(|i| i.id == id) {
                    *existing = value;
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
            "turn.completed" | "turn.aborted" | "session.exited" => self.studio.busy = false,
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
    pub(crate) bounds: [[f32; 4]; 3],
    pub(crate) offsets: [[f32; 2]; 3],
    pub(crate) active: [bool; 3],
    /// The poll's frame clock (seconds) the times below are on.
    pub(crate) clock: f64,
    /// When each action glyph's hover gesture began.
    pub(crate) started: [Option<f64>; 3],
    /// A running app (not a `--scene` snapshot), whose start screen enters.
    pub(crate) live: bool,
    /// When the start screen mounted, for its entrance.
    pub(crate) mounted: Option<f64>,
    /// The rotating wordmark's word, the one before it, and when it changed.
    pub(crate) word: usize,
    pub(crate) prev_word: Option<usize>,
    pub(crate) word_at: Option<f64>,
}

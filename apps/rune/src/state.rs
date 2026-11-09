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
    pub page: Page,
    pub projects: Vec<Project>,
    pub selected_project: Option<usize>,
    pub search: TextEdit,
    pub composer: TextEdit,
    pub studio: StudioState,
    pub bridge: Option<crate::bridge::Bridge>,
    pub launcher: crate::launcher::LauncherState,
    pub project_list_request: Option<u64>,
    pub project_remember_request: Option<u64>,
    pub pending_project_path: Option<String>,
    pub studio_layout: serde_json::Value,
    pub studio_load_request: Option<u64>,
    pub studio_layout_ready: bool,
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
    pub thread_open: bool,
    pub project_path: String,
    pub composer_open: bool,
    pub picker_open: bool,
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
pub struct StudioApproval { pub id: String, pub title: String, pub detail: String }

#[derive(Clone)]
pub struct StudioQuestion { pub id: String, pub questions: Vec<StudioQuestionEntry>, pub index: usize, pub answers: serde_json::Map<String, serde_json::Value>, pub selected: Vec<String> }
#[derive(Clone)]
pub struct StudioQuestionEntry { pub id: String, pub prompt: String, pub options: Vec<String>, pub multi: bool }

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
}

impl AppState {
    pub fn request(&mut self, method: &str, params: serde_json::Value) -> Option<u64> {
        match self.bridge.as_mut().map(|bridge| bridge.request(method, params)) {
            Some(Ok(id)) => Some(id),
            Some(Err(error)) => { self.studio.error = Some(error.to_string()); None }
            None => { self.studio.error = Some("Agent service is unavailable".into()); None }
        }
    }

    pub fn setup(s: &mut Self, wake: rune::Waker) {
        let home = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let data = home.join("Library/Application Support/kone-rune");
        let script = std::env::var_os("KONE_RUNE_SIDECAR_SCRIPT").map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("sidecar/dist/index.mjs"));
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

    pub fn poll(s: &mut Self, _: f64, _: &mut rune::Tx) -> bool {
        let mut messages = Vec::new();
        if let Some(bridge) = &s.bridge {
            while let Some(message) = bridge.try_recv() { messages.push(message); }
        }
        let changed = !messages.is_empty();
        for message in messages { s.studio_message(message); }
        changed
    }

    pub fn enter_studio(&mut self) {
        self.page = Page::Studio;
        let Some(path) = self.selected_project.and_then(|i| self.projects.get(i)).map(|p| p.path.clone()) else { return; };
        if self.studio.project_path != path {
            self.studio.project_path = path.clone();
            self.studio.thread_id.clear();
            self.studio.items.clear();
            self.studio.started = false;
            self.studio.busy = false;
            self.studio.resume = None;
        }
        let row = self.studio_layout["rows"].as_array().and_then(|rows| rows.iter().find(|r| r["projectPath"] == path));
        let thread = row.and_then(|r| {
            let panes = r["panes"].as_array()?;
            let focused = r["focusedId"].as_str();
            panes.iter().find(|p| p["id"].as_str() == focused).and_then(|p| p["anchor"]["threadId"].as_str())
                .or_else(|| panes.iter().find_map(|p| p["anchor"]["threadId"].as_str()))
        }).map(str::to_owned);
        if let Some(thread) = thread {
            if self.studio.thread_id != thread {
                self.studio.thread_id = thread.clone();
                self.studio.items.clear();
                self.studio.thread_open = true;
                self.studio.composer_open = true;
                self.studio.started = false;
                self.studio.history_request = self.request("history.thread", serde_json::json!({"threadId": thread}));
            }
        } else if self.studio.thread_id.is_empty() { self.studio.thread_open = false; }
    }

    pub fn open_studio_thread(&mut self, thread: String) {
        if self.studio.busy || self.studio.thread_id == thread { return; }
        self.studio.thread_id = thread.clone();
        self.studio.items.clear();
        self.studio.started = false;
        self.studio.resume = None;
        self.studio.thread_open = true;
        self.studio.composer_open = true;
        self.studio.history_request = self.request("history.thread", serde_json::json!({"threadId": thread}));
        self.save_studio_layout();
    }

    pub fn new_studio_thread(&mut self) {
        if self.studio.busy { return; }
        self.studio.thread_id.clear();
        self.studio.items.clear();
        self.studio.started = false;
        self.studio.resume = None;
        self.studio.thread_open = true;
        self.studio.composer_open = true;
        self.studio.error = None;
        self.composer.clear();
    }

    fn save_studio_layout(&mut self) {
        let Some(path) = self.selected_project.and_then(|i| self.projects.get(i)).map(|p| p.path.clone()) else { return; };
        let mut rows = self.studio_layout["rows"].as_array().cloned().unwrap_or_default();
        let pane = serde_json::json!({"id": self.studio.thread_id, "kind": "thread", "anchor": {"kind": "thread", "threadId": self.studio.thread_id}, "width": 2});
        if let Some(existing) = rows.iter_mut().find(|r| r["projectPath"] == path) {
            let mut focused_id = self.studio.thread_id.clone();
            if let Some(panes) = existing["panes"].as_array_mut() {
                if let Some(pane) = panes.iter().find(|p| p["anchor"]["threadId"] == self.studio.thread_id) {
                    if let Some(id) = pane["id"].as_str() { focused_id = id.to_owned(); }
                } else { panes.push(pane); }
            }
            existing["focusedId"] = focused_id.into();
        } else {
            rows.push(serde_json::json!({"projectPath": path, "panes": [pane], "focusedId": self.studio.thread_id}));
        }
        self.studio_layout = serde_json::json!({"version": 2, "rows": rows, "focusedRow": path});
        self.request("studio.save", serde_json::json!({"layout": self.studio_layout}));
    }

    pub fn select_provider(&mut self, index: usize) {
        if index >= self.studio.providers.len() || self.studio.started { return; }
        self.studio.provider_index = index;
        self.studio.picker_open = true;
        self.studio.models.clear();
        self.studio.model_index = 0;
        let provider = self.studio.providers[index].id.clone();
        self.studio.models_request = self.request("agent.models", serde_json::json!({"provider": provider}));
    }

    pub fn send_studio(&mut self, tx: &mut rune::Tx) {
        let input = self.composer.text.trim().to_owned();
        if input.is_empty() || self.studio.busy { return; }
        if !self.studio_layout_ready { self.studio.error = Some("Studio is still loading or its saved layout could not be read.".into()); return; }
        let Some(project) = self.selected_project.and_then(|i| self.projects.get(i)) else { return; };
        let cwd = project.path.clone();
        let Some(provider) = self.studio.providers.get(self.studio.provider_index).map(|p| p.id.clone()) else {
            self.studio.error = Some("No available agent provider. Install and sign in to a provider first.".into());
            return;
        };
        if self.studio.thread_id.is_empty() {
            let time = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
            self.studio.thread_id = format!("rune-{}-{time}", std::process::id());
        }
        self.studio.error = None;
        self.studio.busy = true;
        self.composer.clear();
        self.studio.items.push(StudioItem { id: format!("user-{}", self.studio.items.len()), kind: "user".into(), text: input.clone(), name: String::new() });
        tx.scroll_to_bottom("studio-transcript");
        if self.studio.started {
            self.dispatch_studio_send(input);
        } else {
            self.studio.pending_send = Some(input);
            let model = self.studio.models.get(self.studio.model_index).map(|m| m.id.clone());
            let mut params = serde_json::json!({"threadId": self.studio.thread_id, "provider": provider, "cwd": cwd});
            if let Some(model) = model { params["model"] = model.into(); }
            if let Some(resume) = &self.studio.resume { params["resume"] = resume.clone().into(); }
            self.studio.start_request = self.request("agent.start", params);
            if self.studio.start_request.is_none() { self.studio.busy = false; }
        }
    }

    fn dispatch_studio_send(&mut self, input: String) {
        let model = self.studio.models.get(self.studio.model_index).map(|m| m.id.clone());
        let mut params = serde_json::json!({"threadId": self.studio.thread_id, "input": input});
        if let Some(model) = model { params["model"] = model.into(); }
        self.studio.send_request = self.request("agent.send", params);
        if self.studio.send_request.is_none() { self.studio.busy = false; }
    }

    pub fn interrupt_studio(&mut self) {
        self.request("agent.interrupt", serde_json::json!({"threadId": self.studio.thread_id}));
    }

    pub fn answer_approval(&mut self, decision: &str) {
        if let Some(approval) = self.studio.approval.take() {
            self.request("agent.approval", serde_json::json!({"threadId": self.studio.thread_id, "requestId": approval.id, "decision": decision}));
        }
    }

    pub fn answer_question(&mut self, answer: serde_json::Value) {
        let Some(mut request) = self.studio.question.take() else { return; };
        let Some(question) = request.questions.get(request.index) else { return; };
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
        let Some(request) = self.studio.question.as_mut() else { return; };
        if let Some(index) = request.selected.iter().position(|value| value == &option) { request.selected.remove(index); }
        else { request.selected.push(option); }
    }

    fn studio_message(&mut self, message: serde_json::Value) {
        if let Some(id) = message.get("id").and_then(|v| v.as_u64()) {
            if self.studio_load_request == Some(id) {
                self.studio_load_request = None;
                if message.get("error").is_some() {
                    self.studio.error = Some("Could not load the saved Studio layout.".into());
                    return;
                }
                self.studio_layout = if message["result"]["version"] == 2 { message["result"].clone() } else { serde_json::json!({"version": 2, "rows": [], "focusedRow": null}) };
                self.studio_layout_ready = true;
                if self.page == Page::Studio { self.enter_studio(); }
                return;
            }
            if self.studio.history_request == Some(id) {
                self.studio.history_request = None;
                let result = &message["result"];
                self.studio.resume = result["conversationId"].as_str().map(str::to_owned);
                self.studio.restore_model = result["model"].as_str().map(str::to_owned);
                if let Some(provider) = result["provider"].as_str() {
                    if let Some(index) = self.studio.providers.iter().position(|p| p.id == provider) { self.select_provider(index); }
                }
                self.studio.items.clear();
                for block in result["blocks"].as_array().into_iter().flatten() {
                    if block["role"] == "user" {
                        self.studio.items.push(StudioItem { id: block["id"].as_str().unwrap_or("").to_owned(), kind: "user".into(), text: block["text"].as_str().unwrap_or("").to_owned(), name: String::new() });
                    } else {
                        for item in block["items"].as_array().into_iter().flatten() {
                            self.studio.items.push(StudioItem { id: item["itemId"].as_str().unwrap_or("").to_owned(), kind: item["kind"].as_str().unwrap_or("").to_owned(), text: item["text"].as_str().unwrap_or("").to_owned(), name: item["name"].as_str().unwrap_or("").to_owned() });
                        }
                    }
                }
                return;
            }
            if self.launcher.request_id == Some(id) {
                self.launcher.request_id = None;
                if let Some(error) = message.get("error") {
                    crate::launcher::failed(self, error["message"].as_str().unwrap_or("Project creation failed"));
                } else { crate::launcher::completed(self, &message["result"]); }
                return;
            }
            if self.project_list_request == Some(id) || self.project_remember_request == Some(id) {
                let remember = self.project_remember_request == Some(id);
                self.project_list_request = None;
                self.project_remember_request = None;
                if let Some(projects) = message["result"].as_array() {
                    self.projects = projects.iter().filter_map(|p| Some(Project { name: p["name"].as_str()?.to_owned(), path: p["path"].as_str()?.to_owned() })).collect();
                    if !remember && self.page == Page::Empty && !self.projects.is_empty() { self.page = Page::Projects; }
                    if remember {
                        self.selected_project = self.pending_project_path.take().and_then(|path| self.projects.iter().position(|p| p.path == path));
                        if self.selected_project.is_some() { self.page = Page::Overview; }
                    }
                } else if let Some(error) = message["error"]["message"].as_str() { self.studio.error = Some(error.to_owned()); }
                return;
            }
            if let Some(error) = message.get("error") {
                self.studio.error = Some(error.get("message").and_then(|v| v.as_str()).unwrap_or("Agent request failed").to_owned());
                if self.studio.start_request == Some(id) { self.studio.pending_send = None; self.studio.busy = false; self.studio.start_request = None; }
                if self.studio.send_request == Some(id) { self.studio.busy = false; self.studio.send_request = None; }
                return;
            }
            if self.studio.send_request == Some(id) { self.studio.send_request = None; }
            let result = &message["result"];
            if self.studio.discover_request == Some(id) {
                self.studio.discover_request = None;
                self.studio.providers = result.as_array().into_iter().flatten().filter(|p| p["available"].as_bool() == Some(true))
                    .filter_map(|p| Some(StudioProvider { id: p["provider"].as_str()?.to_owned(), label: p["label"].as_str()?.to_owned() })).collect();
                if !self.studio.providers.is_empty() { self.select_provider(0); }
            } else if self.studio.models_request == Some(id) {
                self.studio.models_request = None;
                self.studio.models = result.as_array().into_iter().flatten().filter_map(|m| Some(StudioModel { id: m["id"].as_str()?.to_owned(), label: m["label"].as_str()?.to_owned() })).collect();
                if let Some(model) = self.studio.restore_model.take() {
                    if let Some(index) = self.studio.models.iter().position(|m| m.id == model) { self.studio.model_index = index; }
                }
            } else if self.studio.start_request == Some(id) {
                self.studio.start_request = None;
                self.studio.started = true;
                self.save_studio_layout();
                if let Some(input) = self.studio.pending_send.take() { self.dispatch_studio_send(input); }
            }
            return;
        }
        if message["method"] == "sidecar.exited" { self.studio.error = Some("Agent service exited".into()); self.studio.busy = false; return; }
        if message["method"] != "agent.event" { return; }
        let event = &message["params"];
        if event["threadId"].as_str() != Some(&self.studio.thread_id) { return; }
        match event["type"].as_str().unwrap_or("") {
            "item.started" | "item.updated" | "item.completed" => {
                let item = &event["item"];
                let id = item["itemId"].as_str().unwrap_or("").to_owned();
                if id.is_empty() { return; }
                let value = StudioItem { id: id.clone(), kind: item["kind"].as_str().unwrap_or("").to_owned(), text: item["text"].as_str().unwrap_or("").to_owned(), name: item["name"].as_str().unwrap_or("").to_owned() };
                if let Some(existing) = self.studio.items.iter_mut().find(|i| i.id == id) { *existing = value; } else { self.studio.items.push(value); }
            }
            "approval.requested" => {
                self.studio.approval = Some(StudioApproval { id: event["requestId"].as_str().unwrap_or("").to_owned(), title: event["approval"]["title"].as_str().unwrap_or("Approval requested").to_owned(), detail: event["approval"]["detail"].as_str().unwrap_or("").to_owned() });
            }
            "approval.resolved" => self.studio.approval = None,
            "user-input.requested" => {
                let questions: Vec<StudioQuestionEntry> = event["questions"].as_array().into_iter().flatten().map(|q| StudioQuestionEntry {
                    id: q["id"].as_str().unwrap_or("").to_owned(),
                    prompt: q["question"].as_str().unwrap_or("").to_owned(),
                    options: q["options"].as_array().into_iter().flatten().filter_map(|o| o["label"].as_str().map(str::to_owned)).collect(),
                    multi: q["multiSelect"].as_bool().unwrap_or(false),
                }).collect();
                if !questions.is_empty() {
                    self.studio.question = Some(StudioQuestion { id: event["requestId"].as_str().unwrap_or("").to_owned(), questions, index: 0, answers: serde_json::Map::new(), selected: Vec::new() });
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
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn streaming_item_snapshots_replace_in_place_and_ignore_other_threads() {
        let mut s = AppState::default();
        s.studio.thread_id = "a".into();
        for (thread, value) in [("a", "first"), ("b", "other"), ("a", "complete")] {
            s.studio_message(json!({"method":"agent.event", "params": {"threadId":thread, "type":"item.updated", "item":{"itemId":"i", "kind":"assistant_text", "text":value}}}));
        }
        assert_eq!(s.studio.items.len(), 1);
        assert_eq!(s.studio.items[0].text, "complete");
    }

    #[test]
    fn saving_a_pane_keeps_other_projects_and_existing_panes() {
        let mut s = AppState::default();
        s.projects.push(Project { name: "a".into(), path: "/a".into() });
        s.selected_project = Some(0);
        s.studio.thread_id = "new".into();
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

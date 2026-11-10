use std::collections::HashMap;

use serde_json::{Value, json};

use crate::state::{AppState, Page, Project};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ProjectSort {
    #[default]
    Recent,
    Name,
}

#[derive(Clone, Debug, Default)]
pub struct ProjectMeta {
    pub pinned: bool,
    pub last_opened_at: i64,
}

#[derive(Clone, Debug)]
pub struct ProjectSession {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    pub project_path: String,
    pub pinned: bool,
    pub provider: String,
    pub branch: Option<String>,
    pub added: i64,
    pub removed: i64,
    pub tokens: i64,
    pub cost: Option<f64>,
    pub model: String,
    pub agent_name: String,
    pub avatar_svg: String,
    pub avatar: Option<String>,
}

#[derive(Debug)]
enum Pending {
    List,
    Overview(String),
    Sessions(String),
    HomeSessions(String),
    Summary(String),
    Watches,
    SessionAction(String),
}

#[derive(Default)]
pub struct ProjectState {
    pub sort: ProjectSort,
    pub menu_path: Option<String>,
    pub metadata: HashMap<String, ProjectMeta>,
    pub summaries: HashMap<String, Value>,
    watched_paths: Vec<String>,
    pub overview: Value,
    pub sessions: Vec<ProjectSession>,
    pub home_sessions: Vec<ProjectSession>,
    pub lazy: LazySessions,
    pub icons: IconHover,
    pub metric_cost: bool,
    pub hovered_session: Option<String>,
    pub hovered_project: Option<String>,
    pub pressed_project: Option<String>,
    pub delete_hold: Option<std::time::Instant>,
    pending: HashMap<u64, Pending>,
}

/// The recent list mounts eight rows at a time; its scroll watcher is read on
/// the poll clock so the 460 ms hold and the following fade share one clock.
pub struct LazySessions {
    pub limit: usize,
    pub ready: usize,
    pub clock: f64,
    pub opened: Option<f64>,
    pub reveal: Option<f64>,
    pub scroll: std::rc::Rc<std::cell::Cell<(f32, f32)>>,
    pub reduced: std::cell::Cell<bool>,
}
impl Default for LazySessions {
    fn default() -> Self {
        Self {
            limit: 8,
            ready: 8,
            clock: 0.0,
            opened: None,
            reveal: None,
            scroll: std::rc::Rc::new(std::cell::Cell::new((0.0, -1.0))),
            reduced: std::cell::Cell::new(false),
        }
    }
}
impl LazySessions {
    pub fn tick(&mut self, count: usize, clock: f64, tx: &mut rune::Tx) -> bool {
        self.clock = clock;
        let opened = *self.opened.get_or_insert(clock);
        if let Some(start) = self.reveal {
            let duration = if self.reduced.get() { 0.62 } else { 0.9 };
            if clock - start >= duration {
                self.ready = self.limit;
                self.reveal = None;
            } else {
                tx.wake_after(std::time::Duration::ZERO);
                return true;
            }
        }
        if self.limit < count {
            // Scroll watchers report after polling; keep a wake pending to consume
            // the newest position even when the window becomes idle.
            tx.wake_after(std::time::Duration::from_millis(30));
        }
        let (offset, max) = self.scroll.get();
        if self.limit < count && max >= 0.0 && max - offset <= 240.0 {
            self.limit = (self.limit + 8).min(count);
            if offset > 0.0 || clock - opened >= 0.75 {
                self.reveal = Some(clock);
            } else {
                self.ready = self.limit;
            }
            tx.wake_after(std::time::Duration::ZERO);
            return true;
        }
        false
    }
}

/// One hover gesture per icon, keyed by where it was triggered (`sort`,
/// `search`, `<project path>|pin`…). The Vue sources replay a gesture on
/// `mouseenter` but ignore a re-entry while one is still playing, so a run is
/// only stamped when the previous one has landed.
#[derive(Default)]
pub struct IconHover {
    pub clock: f64,
    runs: HashMap<String, (f64, f32)>,
}

impl IconHover {
    /// Elapsed seconds of the gesture at `key`, or `None` when it is at rest.
    pub fn since(&self, key: &str) -> Option<f32> {
        let &(at, len) = self.runs.get(key)?;
        let at = if at == f64::INFINITY { self.clock } else { at };
        let elapsed = (self.clock - at).max(0.0) as f32;
        (elapsed < len).then_some(elapsed)
    }

    /// A pointer entered `key`, which plays `len` seconds of gesture.
    pub fn enter(&mut self, key: &str, len: f32) {
        if self.since(key).is_some() {
            return;
        }
        self.runs.insert(key.to_owned(), (f64::INFINITY, len));
    }

    /// Stamps runs that started between polls and asks for frames while any is
    /// playing. Returns whether the view should run again.
    pub fn tick(&mut self, clock: f64) -> bool {
        self.clock = clock;
        let mut moving = false;
        self.runs.retain(|_, (at, len)| {
            if *at == f64::INFINITY {
                *at = clock;
            }
            let playing = clock - *at < *len as f64;
            moving |= playing;
            playing
        });
        moving
    }
}

#[cfg(test)]
mod lazy_tests {
    use super::*;
    #[test]
    fn scroll_reveals_in_batches_and_holds_masks_through_fade() {
        let mut lazy = LazySessions::default();
        let mut tx = rune::Tx::default();
        lazy.scroll.set((0.0, 500.0));
        assert!(!lazy.tick(20, 0.0, &mut tx));
        lazy.scroll.set((260.0, 500.0));
        assert!(lazy.tick(20, 1.0, &mut tx));
        assert_eq!((lazy.limit, lazy.ready), (16, 8));
        lazy.scroll.set((260.0, 1000.0));
        lazy.tick(20, 1.46, &mut tx);
        assert_eq!(lazy.ready, 8);
        lazy.tick(20, 1.91, &mut tx);
        assert_eq!(lazy.ready, 16);
    }
    #[test]
    fn opening_fills_nearby_rows_without_masking() {
        let mut lazy = LazySessions::default();
        let mut tx = rune::Tx::default();
        lazy.scroll.set((0.0, 100.0));
        assert!(lazy.tick(20, 0.1, &mut tx));
        assert_eq!((lazy.limit, lazy.ready), (16, 16));
        assert!(lazy.reveal.is_none());
    }
}

impl AppState {
    pub(crate) fn sync_project_watches(&mut self) {
        let paths: Vec<String> = if self.page == Page::Projects {
            self.projects.iter().map(|p| p.path.clone()).collect()
        } else {
            Vec::new()
        };
        if paths != self.project_data.watched_paths
            && self.bridge.is_some()
            && let Some(id) = self.request("projects.watchSummaries", json!({"paths": paths}))
        {
            self.project_data.watched_paths = paths;
            self.project_data.pending.insert(id, Pending::Watches);
        }
    }
    pub fn sorted_projects(&self) -> Vec<(usize, &Project)> {
        let mut projects: Vec<_> = self
            .projects
            .iter()
            .enumerate()
            .filter(|(_, p)| {
                p.name
                    .to_lowercase()
                    .contains(&self.search.text.trim().to_lowercase())
            })
            .collect();
        projects.sort_by(|(_, a), (_, b)| {
            let ma = self.project_data.metadata.get(&a.path);
            let mb = self.project_data.metadata.get(&b.path);
            let pinned = mb
                .is_some_and(|m| m.pinned)
                .cmp(&ma.is_some_and(|m| m.pinned));
            pinned
                .then_with(|| match self.project_data.sort {
                    ProjectSort::Recent => mb
                        .map_or(0, |m| m.last_opened_at)
                        .cmp(&ma.map_or(0, |m| m.last_opened_at)),
                    ProjectSort::Name => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
                })
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        projects
    }

    fn project_request(&mut self, method: &str, params: Value, pending: Pending) {
        if let Some(id) = self.request(method, params) {
            self.project_data.pending.insert(id, pending);
        }
    }

    pub fn refresh_project_list(&mut self) {
        self.project_request("projects.list", json!({}), Pending::List);
    }

    pub fn open_project(&mut self, path: String) {
        let Some(index) = self.projects.iter().position(|p| p.path == path) else {
            return;
        };
        let name = self.projects[index].name.clone();
        self.selected_project = Some(index);
        self.page = Page::Overview;
        self.project_data.menu_path = None;
        self.project_data
            .pending
            .retain(|_, pending| !matches!(pending, Pending::Overview(_) | Pending::Sessions(_)));
        self.project_data.overview = Value::Null;
        self.project_data.sessions.clear();
        self.project_request(
            "projects.remember",
            json!({"path": path, "name": name}),
            Pending::List,
        );
        self.project_request(
            "projects.overview",
            json!({"path": path}),
            Pending::Overview(path.clone()),
        );
        self.project_request(
            "history.list",
            json!({"projectPath": path}),
            Pending::Sessions(path),
        );
    }

    pub fn pin_project(&mut self, path: String) {
        let pinned = !self
            .project_data
            .metadata
            .get(&path)
            .is_some_and(|m| m.pinned);
        self.project_data.menu_path = None;
        self.project_request(
            "projects.pin",
            json!({"path": path, "pinned": pinned}),
            Pending::List,
        );
    }

    pub fn forget_project(&mut self, path: String) {
        self.project_data.menu_path = None;
        self.project_request("projects.forget", json!({"path": path}), Pending::List);
    }

    pub fn reveal_project(&mut self, path: String) {
        self.project_data.menu_path = None;
        if let Err(error) = std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
        {
            self.studio.error = Some(format!("Could not reveal project: {error}"));
        }
    }

    pub fn session_action(&mut self, path: String, id: String, action: &str, pinned: bool) {
        let (method, params) = match action {
            "pin" => (
                "history.setPinned",
                json!({"threadId": id, "pinned": !pinned}),
            ),
            "delete" => ("history.delete", json!({"threadId": id})),
            "archive" => ("history.archive", json!({"threadId": id, "archived": true})),
            _ => return,
        };
        self.project_request(method, params, Pending::SessionAction(path));
    }

    pub fn open_home_session(&mut self, path: String, id: String) {
        self.open_project(path);
        self.open_recent_session(id);
    }

    pub fn open_recent_session(&mut self, id: String) {
        self.enter_studio();
        self.open_studio_thread(id);
    }

    /// Returns true when this response belongs to project state.
    pub fn project_message(&mut self, message: &Value) -> bool {
        if message["method"] == "projects.status" {
            if let Some(path) = message["params"]["path"].as_str()
                && self.page == Page::Projects
                && self.projects.iter().any(|p| p.path == path)
            {
                self.project_data.pending.retain(
                    |_, p| !matches!(p, Pending::Summary(pending_path) if pending_path == path),
                );
                self.project_data
                    .summaries
                    .insert(path.to_owned(), message["params"]["tree"].clone());
            }
            return true;
        }
        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            return false;
        };
        let initial = self.project_list_request == Some(id);
        let remembered = self.project_remember_request == Some(id);
        let pending = if initial {
            self.project_list_request = None;
            Some(Pending::List)
        } else if remembered {
            self.project_remember_request = None;
            Some(Pending::List)
        } else {
            self.project_data.pending.remove(&id)
        };
        let Some(pending) = pending else { return false };
        if matches!(pending, Pending::Summary(_) | Pending::Watches)
            && message.get("error").is_some()
        {
            return true;
        }
        if let Some(error) = message.get("error") {
            self.studio.error = Some(
                error["message"]
                    .as_str()
                    .unwrap_or("Project request failed")
                    .to_owned(),
            );
            return true;
        }
        let result = &message["result"];
        match pending {
            Pending::List => {
                if let Some(list) = result.as_array() {
                    let selected = self
                        .selected_project
                        .and_then(|i| self.projects.get(i))
                        .map(|p| p.path.clone());
                    self.projects.clear();
                    self.project_data.metadata.clear();
                    for value in list {
                        if let (Some(name), Some(path)) =
                            (value["name"].as_str(), value["path"].as_str())
                        {
                            self.projects.push(Project {
                                name: name.into(),
                                path: path.into(),
                            });
                            self.project_data.metadata.insert(
                                path.into(),
                                ProjectMeta {
                                    pinned: value["pinned"].as_bool().unwrap_or(false),
                                    last_opened_at: value["lastOpenedAt"].as_i64().unwrap_or(0),
                                },
                            );
                        }
                    }
                    self.selected_project =
                        selected.and_then(|path| self.projects.iter().position(|p| p.path == path));
                    self.project_data.home_sessions.clear();
                    self.project_data.summaries.clear();
                    self.project_data.pending.retain(|_, pending| {
                        !matches!(pending, Pending::HomeSessions(_) | Pending::Summary(_))
                    });
                    let paths: Vec<String> = self.projects.iter().map(|p| p.path.clone()).collect();
                    for path in paths {
                        self.project_request(
                            "projects.summary",
                            json!({"path": path}),
                            Pending::Summary(path.clone()),
                        );
                        self.project_request(
                            "history.list",
                            json!({"projectPath": path}),
                            Pending::HomeSessions(path),
                        );
                    }
                    if initial && self.page == Page::Empty && !self.projects.is_empty() {
                        self.page = Page::Projects;
                    }
                    if remembered {
                        if let Some(path) = self.pending_project_path.take() {
                            self.open_project(path);
                        }
                    } else if self.page == Page::Projects && self.projects.is_empty() {
                        self.page = Page::Empty;
                    }
                }
            }
            Pending::SessionAction(path) => {
                if result.get("ok").and_then(Value::as_bool) == Some(false) {
                    self.studio.error = Some(
                        result["reason"]
                            .as_str()
                            .unwrap_or("Could not update conversation")
                            .to_owned(),
                    );
                    return true;
                }
                self.project_request(
                    "history.list",
                    json!({"projectPath": path}),
                    Pending::HomeSessions(path.clone()),
                );
                if self
                    .selected_project
                    .and_then(|i| self.projects.get(i))
                    .is_some_and(|p| p.path == path)
                {
                    self.project_request(
                        "history.list",
                        json!({"projectPath": path}),
                        Pending::Sessions(path),
                    );
                }
            }
            Pending::Overview(path) => {
                if self
                    .selected_project
                    .and_then(|i| self.projects.get(i))
                    .is_some_and(|p| p.path == path)
                {
                    self.project_data.overview = result.clone();
                }
            }
            Pending::Sessions(path) => {
                if self
                    .selected_project
                    .and_then(|i| self.projects.get(i))
                    .is_some_and(|p| p.path == path)
                {
                    self.project_data.sessions = parse_sessions(result, &path);
                }
            }
            Pending::HomeSessions(path) => {
                self.project_data
                    .home_sessions
                    .retain(|s| s.project_path != path);
                self.project_data
                    .home_sessions
                    .extend(parse_sessions(result, &path));
                sort_sessions(&mut self.project_data.home_sessions);
            }
            Pending::Summary(path) => {
                if self.projects.iter().any(|p| p.path == path) {
                    self.project_data.summaries.insert(path, result.clone());
                }
            }
            Pending::Watches => {}
        }
        true
    }
}

pub(crate) fn parse_sessions(result: &Value, path: &str) -> Vec<ProjectSession> {
    let mut sessions: Vec<_> = result
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| {
            Some(ProjectSession {
                id: v["threadId"].as_str()?.into(),
                title: v["title"]
                    .as_str()
                    .map(str::trim)
                    .filter(|title| !title.is_empty())
                    .unwrap_or("Untitled session")
                    .into(),
                updated_at: v["lastActivityAt"]
                    .as_i64()
                    .or_else(|| v["updatedAt"].as_i64())
                    .unwrap_or(0),
                project_path: path.into(),
                pinned: v["isPinned"].as_bool().unwrap_or(false),
                provider: v["provider"].as_str().unwrap_or("").into(),
                branch: v["branch"].as_str().map(str::to_owned),
                added: v["added"].as_i64().unwrap_or(0),
                removed: v["removed"].as_i64().unwrap_or(0),
                tokens: v["tokens"].as_i64().unwrap_or(0),
                cost: v["costUsd"].as_f64().filter(|n| n.is_finite() && *n >= 0.0),
                model: v["model"].as_str().unwrap_or("").into(),
                agent_name: v["identity"]["name"].as_str().unwrap_or("Guest").into(),
                avatar_svg: v["identity"]["svg"].as_str().unwrap_or("").into(),
                avatar: v["identity"]["avatar"].as_str().map(str::to_owned),
            })
        })
        .collect();
    sort_sessions(&mut sessions);
    sessions
}

fn sort_sessions(sessions: &mut [ProjectSession]) {
    sessions.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;

    #[test]
    fn sorting_keeps_pins_first_and_filters_names() {
        let mut state = AppState::default();
        state.projects = vec![
            Project {
                name: "Zulu".into(),
                path: "/z".into(),
            },
            Project {
                name: "Alpha".into(),
                path: "/a".into(),
            },
            Project {
                name: "Beta".into(),
                path: "/b".into(),
            },
        ];
        state.project_data.metadata.insert(
            "/z".into(),
            ProjectMeta {
                pinned: true,
                last_opened_at: 1,
            },
        );
        state.project_data.metadata.insert(
            "/a".into(),
            ProjectMeta {
                pinned: false,
                last_opened_at: 3,
            },
        );
        state.project_data.metadata.insert(
            "/b".into(),
            ProjectMeta {
                pinned: false,
                last_opened_at: 2,
            },
        );
        assert_eq!(
            state
                .sorted_projects()
                .iter()
                .map(|(_, p)| p.name.as_str())
                .collect::<Vec<_>>(),
            ["Zulu", "Alpha", "Beta"]
        );
        state.project_data.sort = ProjectSort::Name;
        state.search.text = "a".into();
        assert_eq!(
            state
                .sorted_projects()
                .iter()
                .map(|(_, p)| p.name.as_str())
                .collect::<Vec<_>>(),
            ["Alpha", "Beta"]
        );
    }

    #[test]
    fn late_project_responses_cannot_replace_selected_project() {
        let mut state = AppState::default();
        state.projects.push(Project {
            name: "B".into(),
            path: "/b".into(),
        });
        state.selected_project = Some(0);
        state
            .project_data
            .pending
            .insert(1, Pending::Overview("/a".into()));
        state
            .project_data
            .pending
            .insert(2, Pending::Sessions("/a".into()));
        assert!(state.project_message(&json!({"id":1,"result":{"workingTree":{"branch":"old"}}})));
        assert!(state.project_message(&json!({"id":2,"result":[{"threadId":"old"}]})));
        assert!(state.project_data.overview.is_null());
        assert!(state.project_data.sessions.is_empty());
    }

    #[test]
    fn project_summary_ignores_removed_projects_and_failed_reads() {
        let mut state = AppState::default();
        state.projects.push(Project {
            name: "B".into(),
            path: "/b".into(),
        });
        state
            .project_data
            .pending
            .insert(1, Pending::Summary("/a".into()));
        state
            .project_data
            .pending
            .insert(2, Pending::Summary("/b".into()));
        state
            .project_data
            .pending
            .insert(3, Pending::Summary("/b".into()));
        state.project_message(&json!({"id": 1, "result": {"branch": "old"}}));
        state.project_message(&json!({"id": 2, "result": {"branch": "main"}}));
        state.project_message(&json!({"id": 3, "error": {"message": "missing"}}));
        assert!(!state.project_data.summaries.contains_key("/a"));
        assert_eq!(state.project_data.summaries["/b"]["branch"], "main");
        assert!(state.studio.error.is_none());
    }

    #[test]
    fn watched_status_wins_over_an_older_read_and_ignores_hidden_home() {
        let mut state = AppState::default();
        state.page = Page::Projects;
        state.projects.push(Project {
            name: "B".into(),
            path: "/b".into(),
        });
        state
            .project_data
            .pending
            .insert(1, Pending::Summary("/b".into()));
        assert!(state.project_message(
            &json!({"method":"projects.status", "params":{"path":"/b", "tree":{"branch":"new"}}})
        ));
        assert!(!state.project_message(&json!({"id":1, "result":{"branch":"old"}})));
        assert_eq!(state.project_data.summaries["/b"]["branch"], "new");
        state.page = Page::Overview;
        state.project_message(
            &json!({"method":"projects.status", "params":{"path":"/b", "tree":{"branch":"late"}}}),
        );
        assert_eq!(state.project_data.summaries["/b"]["branch"], "new");
    }

    #[test]
    fn home_sessions_merge_and_sort_by_pin_then_activity() {
        let mut state = AppState::default();
        state
            .project_data
            .pending
            .insert(1, Pending::HomeSessions("/a".into()));
        state
            .project_data
            .pending
            .insert(2, Pending::HomeSessions("/b".into()));
        state.project_message(&json!({"id":1,"result":[{"threadId":"a","updatedAt":50}]}));
        state.project_message(
            &json!({"id":2,"result":[{"threadId":"b","updatedAt":1,"isPinned":true}]}),
        );
        assert_eq!(
            state
                .project_data
                .home_sessions
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            ["b", "a"]
        );
        assert_eq!(state.project_data.home_sessions[0].project_path, "/b");
    }
}

#[cfg(test)]
mod icon_hover_tests {
    use super::IconHover;

    #[test]
    fn gestures_finish_after_exit_and_ignore_reentry_until_complete() {
        let mut icons = IconHover::default();
        icons.enter("project|pin", 0.5);
        assert!(icons.tick(1.0));
        icons.enter("project|pin", 0.5);
        assert!(icons.tick(1.3));
        assert!((icons.since("project|pin").unwrap() - 0.3).abs() < 0.001);
        assert!(!icons.tick(1.5));
        icons.enter("project|pin", 0.5);
        assert!(icons.tick(1.6));
        assert_eq!(icons.since("project|pin"), Some(0.0));
    }
}

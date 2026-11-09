use std::collections::HashMap;

use serde_json::{json, Value};

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
}

#[derive(Debug)]
enum Pending {
    List,
    Overview(String),
    Sessions(String),
    HomeSessions(String),
}

#[derive(Default)]
pub struct ProjectState {
    pub sort: ProjectSort,
    pub menu_path: Option<String>,
    pub metadata: HashMap<String, ProjectMeta>,
    pub overview: Value,
    pub sessions: Vec<ProjectSession>,
    pub home_sessions: Vec<ProjectSession>,
    pending: HashMap<u64, Pending>,
}

impl AppState {
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
                    self.project_data
                        .pending
                        .retain(|_, pending| !matches!(pending, Pending::HomeSessions(_)));
                    let paths: Vec<String> = self.projects.iter().map(|p| p.path.clone()).collect();
                    for path in paths {
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
        }
        true
    }
}

fn parse_sessions(result: &Value, path: &str) -> Vec<ProjectSession> {
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

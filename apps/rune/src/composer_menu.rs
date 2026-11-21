//! The composer's `@` and `/` trigger menus, after Electron's `composerMentions.ts`,
//! `useComposerTrigger.ts` and `useComposerSlash.ts`.

use crate::state::AppState;

/// The `@` or `/` word under the composer caret, and the byte range it covers.
#[derive(Clone, Debug, PartialEq)]
pub struct Trigger {
    pub marker: char,
    pub query: String,
    pub start: usize,
    pub end: usize,
}

/// One menu row: a command name and its description, or a file name and its folder.
#[derive(Clone, Debug, PartialEq)]
pub struct MenuRow {
    pub name: String,
    pub detail: String,
}

struct SlashCommand {
    name: &'static str,
    description: &'static str,
    /// Runs without consuming the draft: `/agent` hands it to whoever is picked.
    keep_draft: bool,
    /// Drops the whole draft even when picked from the menu.
    clears_all: bool,
}

/// Electron's built-in commands, sorted by name.
const SLASH_COMMANDS: [SlashCommand; 5] = [
    SlashCommand {
        name: "agent",
        description: "Hand the turn to someone else",
        keep_draft: true,
        clears_all: false,
    },
    SlashCommand {
        name: "branch",
        description: "Switch or fork the thread branch",
        keep_draft: false,
        clears_all: false,
    },
    SlashCommand {
        name: "compact",
        description: "Compact the conversation",
        keep_draft: false,
        clears_all: false,
    },
    SlashCommand {
        name: "model",
        description: "Open model picker",
        keep_draft: false,
        clears_all: false,
    },
    SlashCommand {
        name: "new",
        description: "Start a new thread",
        keep_draft: false,
        clears_all: true,
    },
];

/// The trigger word ending at `cursor`. It starts after whitespace, so prose, email addresses,
/// paths (`src/a`) and `//` comments never open a menu.
pub fn detect_token(text: &str, cursor: usize) -> Option<Trigger> {
    let mut cursor = cursor.min(text.len());
    while !text.is_char_boundary(cursor) {
        cursor -= 1;
    }
    let start = text[..cursor]
        .char_indices()
        .rev()
        .find(|(_, c)| c.is_whitespace())
        .map_or(0, |(i, c)| i + c.len_utf8());
    let word = &text[start..cursor];
    let marker = word.chars().next()?;
    if marker != '@' && marker != '/' || word.starts_with("//") {
        return None;
    }
    Some(Trigger {
        marker,
        query: word[1..].to_owned(),
        start,
        end: cursor,
    })
}

/// A draft that leads with `/name`: the lowercased name and the text after it.
pub fn parse_leading_slash(text: &str) -> Option<(String, String)> {
    let trimmed = text.trim();
    let head_end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
    let token = detect_token(&trimmed[..head_end], head_end)?;
    if token.marker != '/' || token.query.is_empty() {
        return None;
    }
    Some((
        token.query.to_lowercase(),
        trimmed[head_end..].trim().to_owned(),
    ))
}

/// A picked path as an editable mention token, quoted when it holds a space or a quote.
pub fn format_file_mention(path: &str) -> String {
    let path = path.replace('\\', "/");
    let path = path.strip_prefix('@').unwrap_or(&path);
    if !path.contains(|c: char| c.is_whitespace() || "()@\"'`$\\".contains(c)) {
        return format!("@{path}");
    }
    format!("@\"{}\"", path.replace('\\', "\\\\").replace('"', "\\\""))
}

impl AppState {
    fn studio_thread_blank(&self) -> bool {
        self.studio.items.is_empty()
    }

    /// Electron's slash gates. `/agent` picks from the saved agent roster and `/branch` opens
    /// the worktree picker; Rune ports neither, so both stay hidden and inert.
    fn slash_allowed(&self, name: &str) -> bool {
        match name {
            "compact" => self.studio_compactable(),
            "model" => true,
            "new" => !self.studio_thread_blank(),
            _ => false,
        }
    }

    pub fn studio_compactable(&self) -> bool {
        let state = &self.studio;
        state
            .providers
            .get(state.provider_index)
            .is_some_and(|p| p.supports_compaction)
            && state.started
            && !state.busy
            && state.compact_request.is_none()
            && state.items.iter().any(|item| item.kind == "user")
    }

    pub fn compact_studio(&mut self) {
        if !self.studio_compactable() {
            return;
        }
        self.studio.compact_error = None;
        self.studio.compact_request = self.request(
            "agent.compact",
            serde_json::json!({"threadId": self.studio.thread_id}),
        );
    }

    /// The live trigger, unless Escape or a pick put the menu away. `@` names files, so it
    /// stays shut while a turn runs; `/` rows are local UI and never do.
    pub fn composer_trigger(&self) -> Option<Trigger> {
        let dismissed = self.studio.composer_menu_dismissed.as_ref();
        if dismissed.is_some_and(|(text, focus)| {
            *text == self.composer.text && *focus == self.composer.focus
        }) {
            return None;
        }
        let trigger = detect_token(&self.composer.text, self.composer.focus)?;
        (trigger.marker == '/' || !self.studio.busy).then_some(trigger)
    }

    /// Commands match by name prefix; files match anywhere in their name or folder.
    pub fn composer_menu_rows(&self, trigger: &Trigger) -> Vec<MenuRow> {
        let query = trigger.query.trim().to_lowercase();
        if trigger.marker == '/' {
            return SLASH_COMMANDS
                .iter()
                .filter(|c| self.slash_allowed(c.name) && c.name.starts_with(&query))
                .map(|c| MenuRow {
                    name: c.name.into(),
                    detail: c.description.into(),
                })
                .collect();
        }
        self.composer_mention_files()
            .into_iter()
            .filter(|(name, parent)| {
                query.is_empty()
                    || name.to_lowercase().contains(&query)
                    || parent.to_lowercase().contains(&query)
            })
            .map(|(name, detail)| MenuRow { name, detail })
            .collect()
    }

    pub(crate) fn close_composer_menu(&mut self) {
        self.studio.composer_menu_dismissed =
            Some((self.composer.text.clone(), self.composer.focus));
        self.studio.composer_menu_index = 0;
    }

    /// The menu's keys. The composer routes its focused keys here before the editor sees them,
    /// so a pick, a move or a dismissal never also edits the draft or blurs the field.
    pub fn composer_menu_key(&mut self, event: &rune::KeyEvent) -> bool {
        if matches!(
            event.key,
            rune::Key::Text(_) | rune::Key::Backspace | rune::Key::Delete
        ) {
            self.studio.composer_menu_index = 0;
            return false;
        }
        let Some(trigger) = self.composer_trigger() else {
            return false;
        };
        let count = self.composer_menu_rows(&trigger).len();
        if count == 0 || event.mods.cmd || event.mods.ctrl || event.mods.alt {
            return false;
        }
        let index = self.studio.composer_menu_index.min(count - 1);
        match event.key {
            rune::Key::Escape => self.close_composer_menu(),
            rune::Key::Down => self.studio.composer_menu_index = (index + 1) % count,
            rune::Key::Up => self.studio.composer_menu_index = (index + count - 1) % count,
            rune::Key::Enter | rune::Key::Tab if !event.mods.shift => {
                return self.accept_composer_row(index);
            }
            _ => return false,
        }
        true
    }

    /// Accept a menu row. Returns false when no menu is showing that row.
    pub fn accept_composer_row(&mut self, index: usize) -> bool {
        let Some(trigger) = self.composer_trigger() else {
            return false;
        };
        let Some(row) = self.composer_menu_rows(&trigger).into_iter().nth(index) else {
            return false;
        };
        if trigger.marker == '/' {
            return self.run_slash(&row.name, Some((trigger.start, trigger.end)));
        }
        let path = if row.detail.is_empty() {
            row.name
        } else {
            format!("{}/{}", row.detail, row.name)
        };
        let mut mention = format_file_mention(&path);
        let rest = &self.composer.text[trigger.end..];
        if !rest.starts_with(' ') {
            mention.push(' ');
        }
        let caret = trigger.start + mention.len() + usize::from(rest.starts_with(' '));
        self.composer
            .text
            .replace_range(trigger.start..trigger.end, &mention);
        self.composer.focus = caret;
        self.composer.anchor = caret;
        self.close_composer_menu();
        true
    }

    /// Run a built-in command picked from the menu (`token` is its word) or leading the draft
    /// at send time. An unknown or gated name returns false and goes to the provider as text.
    pub fn run_slash(&mut self, name: &str, token: Option<(usize, usize)>) -> bool {
        let Some(command) = SLASH_COMMANDS.iter().find(|c| c.name == name) else {
            return false;
        };
        if !self.slash_allowed(name) {
            return false;
        }
        if !command.keep_draft {
            match token {
                Some((start, end)) if !command.clears_all => {
                    self.composer.text.replace_range(start..end, "");
                    self.composer.focus = start;
                    self.composer.anchor = start;
                }
                _ => self.composer.clear(),
            }
        }
        self.close_composer_menu();
        match name {
            "compact" => self.compact_studio(),
            "model" => {
                self.studio.picker_open = true;
                self.studio.picker_opened_at = Some(std::time::Instant::now());
                self.studio.handoff_query.text.clear();
            }
            "new" => self.new_studio_thread(),
            _ => {}
        }
        true
    }
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use crate::state::{StudioItem, StudioProvider};

    fn composer(text: &str) -> AppState {
        let mut s = AppState::default();
        s.composer.text = text.into();
        s.composer.focus = text.len();
        s.composer.anchor = text.len();
        s.studio.thread_id = "t".into();
        s
    }

    fn with_history(mut s: AppState) -> AppState {
        s.studio.started = true;
        s.studio.providers = vec![StudioProvider {
            id: "codex".into(),
            label: "Codex".into(),
            supports_compaction: true,
        }];
        s.studio.items.push(StudioItem {
            id: "u1".into(),
            kind: "user".into(),
            text: "hi".into(),
            ..Default::default()
        });
        s
    }

    fn names(s: &AppState) -> Vec<String> {
        let trigger = s.composer_trigger().expect("trigger");
        s.composer_menu_rows(&trigger)
            .into_iter()
            .map(|r| r.name)
            .collect()
    }

    #[test]
    fn a_trigger_starts_only_after_whitespace() {
        assert_eq!(
            detect_token("fix /mo", 7).map(|t| t.query),
            Some("mo".into())
        );
        assert_eq!(detect_token("@src", 4).map(|t| t.start), Some(0));
        assert_eq!(detect_token("src/a", 5), None);
        assert_eq!(detect_token("// note", 2), None);
        assert_eq!(detect_token("me@example.com", 14), None);
        assert_eq!(detect_token("/model now", 10), None);
    }

    #[test]
    fn a_leading_command_reads_its_name_and_focus() {
        assert_eq!(
            parse_leading_slash("  /Compact keep the tests "),
            Some(("compact".into(), "keep the tests".into()))
        );
        assert_eq!(parse_leading_slash("// comment"), None);
        assert_eq!(parse_leading_slash("/"), None);
        assert_eq!(parse_leading_slash("run /model"), None);
    }

    #[test]
    fn a_mention_with_spaces_is_quoted() {
        assert_eq!(format_file_mention("src/main.rs"), "@src/main.rs");
        assert_eq!(
            format_file_mention("My Docs/a\"b.md"),
            "@\"My Docs/a\\\"b.md\""
        );
    }

    #[test]
    fn slash_rows_follow_electron_gates_and_prefix_match() {
        let blank = composer("/");
        assert_eq!(names(&blank), ["model"]);
        let s = with_history(composer("/"));
        assert_eq!(names(&s), ["compact", "model", "new"]);
        let s = with_history(composer("/m"));
        assert_eq!(names(&s), ["model"]);
        let mut busy = with_history(composer("/"));
        busy.studio.busy = true;
        assert_eq!(names(&busy), ["model", "new"]);
    }

    #[test]
    fn a_running_turn_hides_the_file_menu() {
        let mut s = composer("look at @ma");
        s.studio.conversation_fixture = Some("composer-picker-mention".into());
        assert!(s.composer_trigger().is_some());
        s.studio.busy = true;
        assert!(s.composer_trigger().is_none());
    }

    #[test]
    fn picking_a_file_replaces_only_its_token() {
        let mut s = composer("look at @use and fix it");
        s.studio.conversation_fixture = Some("composer-picker-mention".into());
        s.composer.focus = "look at @use".len();
        assert!(s.accept_composer_row(0));
        assert_eq!(
            s.composer.text,
            "look at @apps/web/app/composables/useAgent.ts and fix it"
        );
        assert_eq!(
            s.composer.focus,
            "look at @apps/web/app/composables/useAgent.ts ".len()
        );
        assert!(s.composer_trigger().is_none());
    }

    #[test]
    fn a_picked_command_consumes_its_token_and_unported_commands_stay_inert() {
        let mut s = with_history(composer("tidy this /comp"));
        assert!(s.accept_composer_row(0));
        assert_eq!(s.composer.text, "tidy this ");
        // No sidecar in tests: the compact request reached `request`, which reports it.
        assert_eq!(
            s.studio.error.as_deref(),
            Some("Agent service is unavailable")
        );

        let mut blank = composer("fix the login bug /ag");
        assert!(!blank.accept_composer_row(0));
        assert!(!blank.run_slash("agent", None));
        assert_eq!(blank.composer.text, "fix the login bug /ag");
        assert!(!blank.studio.picker_open);
    }

    #[test]
    fn a_typed_leading_command_runs_instead_of_sending() {
        let mut s = with_history(composer("/compact keep the tests"));
        s.close_composer_menu();
        let mut tx = rune::Tx::default();
        s.send_studio(&mut tx);
        // No sidecar in tests: the compact request reached `request`, which reports it.
        assert_eq!(
            s.studio.error.as_deref(),
            Some("Agent service is unavailable")
        );
        assert!(s.composer.text.is_empty());
        assert!(s.studio.send_request.is_none());

        let mut tx = rune::Tx::default();
        let mut s = with_history(composer("/review the diff"));
        s.send_studio(&mut tx);
        // An unknown command is the provider's: it takes the send path, which needs a layout.
        assert_eq!(s.composer.text, "/review the diff");
        assert!(
            s.studio
                .error
                .as_deref()
                .is_some_and(|e| e.starts_with("Studio is still loading"))
        );
    }
}

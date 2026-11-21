//! Small VT screen model for the Studio terminal transcript.
//! It handles cursor, erase, scrolling-region and alternate-screen commands used by CLIs.
use unicode_width::UnicodeWidthChar;

#[derive(Clone, Default)]
struct Cell {
    ch: char,
    sgr: String,
}

#[derive(Clone)]
struct Screen {
    rows: Vec<Vec<Cell>>,
    x: usize,
    y: usize,
    saved_x: usize,
    saved_y: usize,
    top: usize,
    bottom: usize,
    origin_mode: bool,
    wrap_pending: bool,
}

impl Screen {
    fn new(columns: usize, height: usize) -> Self {
        Self {
            rows: vec![vec![Cell::default(); columns]; height],
            x: 0,
            y: 0,
            saved_x: 0,
            saved_y: 0,
            top: 0,
            bottom: height - 1,
            origin_mode: false,
            wrap_pending: false,
        }
    }

    fn scroll_up(
        &mut self,
        count: usize,
        columns: usize,
        scrollback: &mut Vec<Vec<Cell>>,
        cap: usize,
        keep_history: bool,
    ) {
        for _ in 0..count.min(self.bottom - self.top + 1) {
            let row = self.rows.remove(self.top);
            if keep_history && self.top == 0 && self.bottom == self.rows.len() {
                scrollback.push(row);
                if scrollback.len() > cap {
                    scrollback.remove(0);
                }
            }
            self.rows
                .insert(self.bottom, vec![Cell::default(); columns]);
        }
    }

    fn scroll_down(&mut self, count: usize, columns: usize) {
        for _ in 0..count.min(self.bottom - self.top + 1) {
            self.rows.remove(self.bottom);
            self.rows.insert(self.top, vec![Cell::default(); columns]);
        }
    }
}

/// The bytes a focused terminal sends for a key, as xterm.js does: printable text goes
/// straight to the PTY, Ctrl+letter becomes its control byte, and cursor keys follow the
/// application's DECCKM mode. Command-modified keys stay with the app (copy, paste, shortcuts).
pub fn key_sequence(event: &rune::KeyEvent, application_cursor: bool) -> Option<String> {
    use rune::Key;
    // Off macOS, Ctrl is the command key: Rune reports Ctrl+C as `Command('c')`. Like xterm.js
    // there, it goes to the shell, except Ctrl+V and Ctrl+Shift chords (paste, copy, shortcuts).
    let control = !cfg!(target_os = "macos") && event.mods.ctrl;
    let key = match &event.key {
        Key::Command(c) if control => {
            if *c == 'v' || event.mods.shift {
                return None;
            }
            Key::Text(c.to_string())
        }
        _ if event.mods.cmd && !control => return None,
        key => key.clone(),
    };
    let cursor = |key: char| {
        if application_cursor {
            format!("\x1bO{key}")
        } else {
            format!("\x1b[{key}")
        }
    };
    let sequence = match &key {
        Key::Up => cursor('A'),
        Key::Down => cursor('B'),
        Key::Right => cursor('C'),
        Key::Left => cursor('D'),
        Key::Home => cursor('H'),
        Key::End => cursor('F'),
        Key::PageUp => "\x1b[5~".into(),
        Key::PageDown => "\x1b[6~".into(),
        Key::Tab if event.mods.shift => "\x1b[Z".into(),
        Key::Tab => "\t".into(),
        Key::Escape => "\x1b".into(),
        Key::Delete => "\x1b[3~".into(),
        Key::Backspace if event.mods.ctrl => "\x08".into(),
        Key::Backspace => "\x7f".into(),
        // Windows reports AltGr as Ctrl+Alt; the character it typed is text, not a chord.
        Key::Text(text) if cfg!(target_os = "windows") && event.mods.ctrl && event.mods.alt => {
            text.clone()
        }
        Key::Text(text) if event.mods.ctrl => {
            let ch = text.chars().next()?;
            match ch.to_ascii_lowercase() {
                c @ ('a'..='z' | '[' | '\\' | ']') => ((c as u8) & 0x1f) as char,
                ' ' | '@' | '2' => '\0',
                _ => return None,
            }
            .to_string()
        }
        Key::Text(text) if event.mods.alt => format!("\x1b{text}"),
        Key::Text(text) => text.clone(),
        _ => return None,
    };
    Some(sequence)
}

/// Whether the output last switched the cursor keys to application mode (`CSI ? 1 h`).
pub fn application_cursor(output: &str) -> bool {
    private_mode(output, 1)
}

/// Pasted text as xterm.js sends it: line breaks become Return, wrapped in `CSI 200~` and
/// `CSI 201~` when the shell turned on bracketed paste (`CSI ? 2004 h`), so it waits for Enter.
pub fn paste_sequence(text: &str, output: &str) -> String {
    let text = text.replace("\r\n", "\r").replace('\n', "\r");
    if private_mode(output, 2004) {
        format!("\x1b[200~{text}\x1b[201~")
    } else {
        text
    }
}

fn private_mode(output: &str, mode: u16) -> bool {
    let on = output.rfind(&format!("\x1b[?{mode}h"));
    let off = output.rfind(&format!("\x1b[?{mode}l"));
    match (on, off) {
        (Some(on), Some(off)) => on > off,
        (on, _) => on.is_some(),
    }
}

/// Materialize a terminal's scrollback as rows, applying VT cursor and erase commands.
/// `rows` is the live terminal height; `limit` caps retained main-screen history.
pub fn screen_lines(
    input: &str,
    columns: usize,
    rows: usize,
    limit: usize,
    cursor_visible: bool,
) -> Vec<String> {
    let columns = columns.clamp(2, 1000);
    let rows = rows.clamp(1, 500);
    let limit = limit.max(1);
    let mut main = Screen::new(columns, rows);
    let mut alternate: Option<Screen> = None;
    let mut main_restore_cursor: Option<(usize, usize)> = None;
    let mut scrollback: Vec<Vec<Cell>> = Vec::new();
    let mut sgr = String::new();
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            if chars.peek() == Some(&']') {
                chars.next();
                for c in chars.by_ref() {
                    if c == '\x07' {
                        break;
                    }
                }
                continue;
            }
            if chars.next() != Some('[') {
                continue;
            }
            let mut params = String::new();
            let mut final_byte = None;
            for byte in chars.by_ref() {
                if ('@'..='~').contains(&byte) {
                    final_byte = Some(byte);
                    break;
                }
                params.push(byte);
            }
            let private = params.starts_with('?');
            let values = params
                .trim_start_matches(['?', '>'])
                .split(';')
                .map(|v| v.parse::<usize>().unwrap_or(0))
                .collect::<Vec<_>>();
            let n = values.first().copied().filter(|v| *v != 0).unwrap_or(1);

            // DEC private modes toggle the alternate buffer and origin addressing.
            if private && final_byte == Some('h') || private && final_byte == Some('l') {
                let enabled = final_byte == Some('h');
                for mode in &values {
                    match mode {
                        6 => {
                            active(&mut main, &mut alternate).origin_mode = enabled;
                            let screen = active(&mut main, &mut alternate);
                            screen.x = 0;
                            screen.y = if enabled { screen.top } else { 0 };
                            screen.wrap_pending = false;
                        }
                        47 | 1047 | 1049 if enabled => {
                            if *mode == 1049 {
                                main_restore_cursor = Some((main.x, main.y));
                            }
                            if alternate.is_none() || *mode != 47 {
                                alternate = Some(Screen::new(columns, rows));
                            }
                        }
                        47 | 1047 | 1049 => {
                            alternate = None;
                            if *mode == 1049 {
                                let (x, y) = main_restore_cursor.take().unwrap_or((main.x, main.y));
                                main.x = x.min(columns - 1);
                                main.y = y.min(rows - 1);
                                main.wrap_pending = false;
                            }
                        }
                        _ => {}
                    }
                }
                continue;
            }

            let keep_history = alternate.is_none();
            let screen = active(&mut main, &mut alternate);
            let height = screen.rows.len();
            match final_byte.unwrap_or('\0') {
                'm' => {
                    let codes = params
                        .split(';')
                        .skip_while(|v| *v != "0")
                        .skip(1)
                        .collect::<Vec<_>>();
                    if values.is_empty() || values.contains(&0) {
                        sgr.clear();
                        if !codes.is_empty() {
                            sgr.push_str(&format!("\x1b[{}m", codes.join(";")));
                        }
                    } else {
                        sgr.push_str(&format!("\x1b[{params}m"));
                    }
                }
                'A' => {
                    screen.y = screen.y.saturating_sub(n).max(screen.top);
                    screen.wrap_pending = false;
                }
                'B' => {
                    screen.y = (screen.y + n).min(screen.bottom);
                    screen.wrap_pending = false;
                }
                'C' => {
                    screen.x = (screen.x + n).min(columns - 1);
                    screen.wrap_pending = false;
                }
                'D' => {
                    screen.x = screen.x.saturating_sub(n);
                    screen.wrap_pending = false;
                }
                'E' => {
                    screen.y = (screen.y + n).min(screen.bottom);
                    screen.x = 0;
                    screen.wrap_pending = false;
                }
                'F' => {
                    screen.y = screen.y.saturating_sub(n).max(screen.top);
                    screen.x = 0;
                    screen.wrap_pending = false;
                }
                'G' | '`' => {
                    screen.x = n.saturating_sub(1).min(columns - 1);
                    screen.wrap_pending = false;
                }
                'd' => {
                    let row = n.saturating_sub(1);
                    screen.y = if screen.origin_mode {
                        screen.top + row.min(screen.bottom - screen.top)
                    } else {
                        row.min(height - 1)
                    };
                    screen.wrap_pending = false;
                }
                'H' | 'f' => {
                    let row = values
                        .first()
                        .copied()
                        .filter(|v| *v != 0)
                        .unwrap_or(1)
                        .saturating_sub(1);
                    let col = values
                        .get(1)
                        .copied()
                        .filter(|v| *v != 0)
                        .unwrap_or(1)
                        .saturating_sub(1);
                    screen.y = if screen.origin_mode {
                        screen.top + row.min(screen.bottom - screen.top)
                    } else {
                        row.min(height - 1)
                    };
                    screen.x = col.min(columns - 1);
                    screen.wrap_pending = false;
                }
                's' => {
                    screen.saved_x = screen.x;
                    screen.saved_y = screen.y;
                }
                'u' => {
                    screen.x = screen.saved_x.min(columns - 1);
                    screen.y = screen.saved_y.min(height - 1);
                    screen.wrap_pending = false;
                }
                'r' => {
                    let top = values
                        .first()
                        .copied()
                        .filter(|v| *v != 0)
                        .unwrap_or(1)
                        .saturating_sub(1);
                    let bottom = values
                        .get(1)
                        .copied()
                        .filter(|v| *v != 0)
                        .unwrap_or(height)
                        .saturating_sub(1);
                    if top < bottom && bottom < height {
                        screen.top = top;
                        screen.bottom = bottom;
                        screen.x = 0;
                        screen.y = if screen.origin_mode { top } else { 0 };
                        screen.wrap_pending = false;
                    }
                }
                'S' => screen.scroll_up(n, columns, &mut scrollback, limit, keep_history),
                'T' => screen.scroll_down(n, columns),
                'L' => {
                    if screen.y >= screen.top && screen.y <= screen.bottom {
                        let bottom = screen.bottom;
                        for _ in 0..n.min(bottom - screen.y + 1) {
                            screen.rows.remove(bottom);
                            screen.rows.insert(screen.y, vec![Cell::default(); columns]);
                        }
                    }
                }
                'M' => {
                    if screen.y >= screen.top && screen.y <= screen.bottom {
                        for _ in 0..n.min(screen.bottom - screen.y + 1) {
                            screen.rows.remove(screen.y);
                            screen
                                .rows
                                .insert(screen.bottom, vec![Cell::default(); columns]);
                        }
                    }
                }
                'K' => {
                    let mode = values.first().copied().unwrap_or(0);
                    let (start, end) = match mode {
                        1 => (0, screen.x + 1),
                        2 => (0, columns),
                        _ => (screen.x, columns),
                    };
                    for cell in screen.rows[screen.y].iter_mut().take(end).skip(start) {
                        *cell = Cell::default();
                    }
                }
                'J' => {
                    let mode = values.first().copied().unwrap_or(0);
                    if mode == 2 || mode == 3 {
                        screen.rows = vec![vec![Cell::default(); columns]; height];
                        screen.x = 0;
                        screen.y = 0;
                        if mode == 3 && keep_history {
                            scrollback.clear();
                        }
                    } else if mode == 0 {
                        for row in screen.rows.iter_mut().skip(screen.y + 1) {
                            row.fill(Cell::default());
                        }
                        for cell in screen.rows[screen.y].iter_mut().skip(screen.x) {
                            *cell = Cell::default();
                        }
                    } else {
                        for row in screen.rows.iter_mut().take(screen.y) {
                            row.fill(Cell::default());
                        }
                        for cell in screen.rows[screen.y].iter_mut().take(screen.x + 1) {
                            *cell = Cell::default();
                        }
                    }
                }
                '@' | 'P' | 'X' => {
                    let row = &mut screen.rows[screen.y];
                    let count = n.min(columns - screen.x);
                    match final_byte.unwrap() {
                        '@' => {
                            for i in (screen.x + count..columns).rev() {
                                row[i] = row[i - count].clone();
                            }
                            for cell in row.iter_mut().skip(screen.x).take(count) {
                                *cell = Cell::default();
                            }
                        }
                        'P' => {
                            for i in screen.x..columns - count {
                                row[i] = row[i + count].clone();
                            }
                            for cell in row.iter_mut().skip(columns - count) {
                                *cell = Cell::default();
                            }
                        }
                        _ => {
                            for cell in row.iter_mut().skip(screen.x).take(count) {
                                *cell = Cell::default();
                            }
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let keep_history = alternate.is_none();
        let screen = active(&mut main, &mut alternate);
        let height = screen.rows.len();
        match ch {
            '\r' => {
                screen.x = 0;
                screen.wrap_pending = false;
            }
            '\n' | '\x0b' | '\x0c' => {
                screen.wrap_pending = false;
                if screen.y == screen.bottom {
                    screen.scroll_up(1, columns, &mut scrollback, limit, keep_history);
                } else {
                    screen.y = (screen.y + 1).min(height - 1);
                }
                if ch != '\n' {
                    screen.x = 0;
                }
            }
            '\x08' => {
                screen.x = screen.x.saturating_sub(1);
                screen.wrap_pending = false;
            }
            '\t' => {
                screen.x = ((screen.x / 8 + 1) * 8).min(columns - 1);
                screen.wrap_pending = false;
            }
            c if c.is_control() => {}
            c => {
                if screen.wrap_pending {
                    screen.x = 0;
                    if screen.y == screen.bottom {
                        screen.scroll_up(1, columns, &mut scrollback, limit, keep_history);
                    } else {
                        screen.y = (screen.y + 1).min(height - 1);
                    }
                }
                let width = UnicodeWidthChar::width(c).unwrap_or(1).clamp(1, 2);
                if screen.x + width > columns {
                    screen.x = 0;
                    if screen.y == screen.bottom {
                        screen.scroll_up(1, columns, &mut scrollback, limit, keep_history);
                    } else {
                        screen.y = (screen.y + 1).min(height - 1);
                    }
                }
                screen.rows[screen.y][screen.x] = Cell {
                    ch: c,
                    sgr: sgr.clone(),
                };
                for offset in 1..width {
                    screen.rows[screen.y][screen.x + offset] = Cell {
                        ch: ' ',
                        sgr: sgr.clone(),
                    };
                }
                screen.x += width;
                screen.wrap_pending = screen.x >= columns;
                screen.x = screen.x.min(columns - 1);
            }
        }
    }

    let (screen, history) = if let Some(alt) = alternate.as_ref() {
        (alt, &[][..])
    } else {
        (&main, scrollback.as_slice())
    };
    let mut all_rows = history.iter().chain(screen.rows.iter()).collect::<Vec<_>>();
    let active_row = history.len() + screen.y;
    let visible_count = all_rows
        .iter()
        .rposition(|row| row.iter().any(|c| c.ch != '\0' && c.ch != ' '))
        .map_or(0, |i| i + 1)
        .max(active_row + 1);
    all_rows.truncate(visible_count);
    let start = visible_count.saturating_sub(limit);
    all_rows.drain(..start);
    all_rows
        .into_iter()
        .enumerate()
        .map(|(i, row)| {
            let row_index = i + start;
            let content_end = row
                .iter()
                .rposition(|c| c.ch != '\0' && c.ch != ' ')
                .map_or(0, |i| i + 1);
            let end = if row_index == active_row {
                content_end.max(screen.x)
            } else {
                content_end
            };
            let mut out = String::new();
            let mut style = String::new();
            for (column, cell) in row.iter().take(end).enumerate() {
                if cursor_visible && row_index == active_row && column == screen.x {
                    out.push('\u{f8ff}');
                }
                if cell.sgr != style {
                    out.push_str("\x1b[0m");
                    out.push_str(&cell.sgr);
                    style = cell.sgr.clone();
                }
                out.push(if cell.ch == '\0' { ' ' } else { cell.ch });
            }
            if cursor_visible && row_index == active_row && screen.x >= end {
                out.push('\u{f8ff}');
            }
            if !style.is_empty() {
                out.push_str("\x1b[0m");
            }
            out
        })
        .collect()
}

fn active<'a>(main: &'a mut Screen, alternate: &'a mut Option<Screen>) -> &'a mut Screen {
    match alternate {
        Some(screen) => screen,
        None => main,
    }
}

#[cfg(test)]
mod tests {
    use super::screen_lines;
    use super::{application_cursor, key_sequence, paste_sequence};

    fn key(key: rune::Key, mods: rune::Mods) -> rune::KeyEvent {
        rune::KeyEvent { key, mods }
    }

    #[test]
    fn keys_encode_like_xterm() {
        use rune::{Key, Mods};
        let plain = Mods::default();
        let ctrl = Mods {
            ctrl: true,
            ..Mods::default()
        };
        let enc = |k, m| key_sequence(&key(k, m), false);
        assert_eq!(enc(Key::Text("a".into()), plain).as_deref(), Some("a"));
        assert_eq!(enc(Key::Text("c".into()), ctrl).as_deref(), Some("\x03"));
        assert_eq!(enc(Key::Text("D".into()), ctrl).as_deref(), Some("\x04"));
        assert_eq!(enc(Key::Backspace, plain).as_deref(), Some("\x7f"));
        assert_eq!(enc(Key::Up, plain).as_deref(), Some("\x1b[A"));
        assert_eq!(
            key_sequence(&key(Key::Up, plain), true).as_deref(),
            Some("\x1bOA")
        );
        let shift = Mods {
            shift: true,
            ..Mods::default()
        };
        assert_eq!(enc(Key::Tab, shift).as_deref(), Some("\x1b[Z"));
        let alt = Mods {
            alt: true,
            ..Mods::default()
        };
        assert_eq!(enc(Key::Text("b".into()), alt).as_deref(), Some("\x1bb"));
        let cmd = Mods {
            cmd: true,
            ..Mods::default()
        };
        assert_eq!(enc(Key::Text("c".into()), cmd), None, "Cmd+C stays a copy");
        // Rune reports physical Ctrl+C off macOS as `Command('c')` with both cmd and ctrl.
        let native_ctrl = Mods {
            cmd: true,
            ctrl: true,
            ..Mods::default()
        };
        let ctrl_c = enc(Key::Command('c'), native_ctrl);
        if cfg!(target_os = "macos") {
            assert_eq!(ctrl_c, None);
        } else {
            assert_eq!(
                ctrl_c.as_deref(),
                Some("\x03"),
                "Ctrl+C interrupts the shell"
            );
            assert_eq!(enc(Key::Command('v'), native_ctrl), None, "Ctrl+V pastes");
            let copy = Mods {
                shift: true,
                ..native_ctrl
            };
            assert_eq!(enc(Key::Command('c'), copy), None, "Ctrl+Shift+C copies");
        }
        assert_eq!(
            enc(Key::Command('c'), cmd),
            None,
            "a bare command chord stays with the app"
        );
        let altgr = Mods {
            cmd: true,
            ctrl: true,
            alt: true,
            ..Mods::default()
        };
        if cfg!(target_os = "windows") {
            assert_eq!(
                enc(Key::Text("@".into()), altgr).as_deref(),
                Some("@"),
                "AltGr+Q"
            );
        }
        assert_eq!(enc(Key::Enter, plain), None, "Enter flushes through submit");
    }

    #[test]
    fn paste_is_bracketed_while_the_shell_asks_for_it() {
        assert_eq!(paste_sequence("ls\npwd", "$ "), "ls\rpwd");
        assert_eq!(
            paste_sequence("ls\r\npwd", "\x1b[?2004h$ "),
            "\x1b[200~ls\rpwd\x1b[201~"
        );
        assert_eq!(paste_sequence("ls", "\x1b[?2004h$ vim\x1b[?2004l"), "ls");
    }

    #[test]
    fn application_cursor_follows_the_last_decckm_switch() {
        assert!(!application_cursor("$ ls"));
        assert!(application_cursor("\x1b[?1h vim"));
        assert!(!application_cursor("\x1b[?1h vim \x1b[?1l$ "));
    }

    #[test]
    fn carriage_return_and_erase_rewrite_the_current_row() {
        assert_eq!(
            screen_lines("hello\r\x1b[Kready", 20, 24, 20, false),
            ["ready"]
        );
    }
    #[test]
    fn cursor_addressing_and_cell_wrapping_are_applied() {
        assert_eq!(
            screen_lines("ab\x1b[1;4HXY", 4, 24, 20, false),
            ["ab X", "Y"]
        );
    }
    #[test]
    fn cursor_is_rendered_at_the_vt_column() {
        assert_eq!(
            screen_lines("hello\x1b[1;2H", 20, 24, 20, true),
            ["h\u{f8ff}ello"]
        );
    }

    #[test]
    fn cursor_movement_uses_the_resized_screen_height() {
        assert_eq!(screen_lines("a\x1b[99Bz", 20, 2, 20, false), ["a", " z"]);
    }
    #[test]
    fn sgr_is_retained_per_cell_and_reset_for_later_text() {
        let rows = screen_lines("\x1b[1;31mred\x1b[0;32mgreen", 20, 24, 20, false);
        assert_eq!(rows, ["\x1b[0m\x1b[1;31mred\x1b[0m\x1b[32mgreen\x1b[0m"]);
    }
    #[test]
    fn alternate_screen_is_isolated_and_main_screen_is_restored() {
        assert_eq!(
            screen_lines("main\x1b[?1049halt\x1b[?1049l!", 20, 24, 20, false),
            ["main!"]
        );
    }
    #[test]
    fn scrolling_region_scrolls_only_inside_its_margins() {
        let input = "top\r\nrow2\r\nrow3\r\nrow4\r\nrow5\x1b[2;4r\x1b[4;1H\r\nnew";
        let rows = screen_lines(input, 12, 24, 30, false);
        assert_eq!(rows[0], "top");
        assert_eq!(rows[1], "row3");
        assert_eq!(rows[2], "row4");
        assert_eq!(rows[3], "new");
        assert_eq!(rows[4], "row5");
    }
    #[test]
    fn explicit_scroll_command_obeys_scrolling_region() {
        let input = "one\r\ntwo\r\nthree\x1b[1;3r\x1b[2;1H\x1b[S";
        let rows = screen_lines(input, 12, 24, 30, false);
        assert_eq!(rows[0], "two");
        assert_eq!(rows[1], "three");
    }
}

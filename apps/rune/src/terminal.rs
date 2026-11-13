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

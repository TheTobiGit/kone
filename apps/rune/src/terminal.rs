//! Small VT screen model for the Studio terminal transcript.
//! It handles the cursor and erase operations used by shells and common CLI output.
use unicode_width::UnicodeWidthChar;

#[derive(Clone, Default)]
struct Cell {
    ch: char,
    sgr: String,
}

/// Materialize a terminal's scrollback as rows, applying VT cursor and erase commands.
pub fn screen_lines(input: &str, columns: usize, limit: usize) -> Vec<String> {
    let columns = columns.clamp(2, 1000);
    let mut rows = vec![vec![Cell::default(); columns]];
    let (mut x, mut y, mut saved_x, mut saved_y) = (0usize, 0usize, 0usize, 0usize);
    let mut sgr = String::new();
    let mut chars = input.chars().peekable();
    let mut wrap_pending = false;
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
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
            let values = params
                .trim_start_matches('?')
                .split(';')
                .map(|v| v.parse::<usize>().unwrap_or(0))
                .collect::<Vec<_>>();
            let n = values.first().copied().filter(|v| *v != 0).unwrap_or(1);
            let height = rows.len();
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
                    y = y.saturating_sub(n);
                    wrap_pending = false;
                }
                'B' => {
                    y = (y + n).min(height.saturating_sub(1));
                    wrap_pending = false;
                }
                'C' => {
                    x = (x + n).min(columns - 1);
                    wrap_pending = false;
                }
                'D' => {
                    x = x.saturating_sub(n);
                    wrap_pending = false;
                }
                'E' => {
                    y = (y + n).min(height.saturating_sub(1));
                    x = 0;
                    wrap_pending = false;
                }
                'F' => {
                    y = y.saturating_sub(n);
                    x = 0;
                    wrap_pending = false;
                }
                'G' => {
                    x = n.saturating_sub(1).min(columns - 1);
                    wrap_pending = false;
                }
                'H' | 'f' => {
                    y = values
                        .first()
                        .copied()
                        .unwrap_or(1)
                        .saturating_sub(1)
                        .min(height.saturating_sub(1));
                    x = values
                        .get(1)
                        .copied()
                        .unwrap_or(1)
                        .saturating_sub(1)
                        .min(columns - 1);
                    wrap_pending = false;
                }
                's' => {
                    saved_x = x;
                    saved_y = y;
                }
                'u' => {
                    x = saved_x.min(columns - 1);
                    y = saved_y.min(height.saturating_sub(1));
                    wrap_pending = false;
                }
                'K' => {
                    let mode = values.first().copied().unwrap_or(0);
                    let (start, end) = match mode {
                        1 => (0, x + 1),
                        2 => (0, columns),
                        _ => (x, columns),
                    };
                    for cell in rows[y].iter_mut().take(end).skip(start) {
                        *cell = Cell::default();
                    }
                }
                'J' => {
                    let mode = values.first().copied().unwrap_or(0);
                    if mode == 2 || mode == 3 {
                        rows = vec![vec![Cell::default(); columns]];
                        x = 0;
                        y = 0;
                    } else if mode == 0 {
                        for row in rows.iter_mut().skip(y + 1) {
                            row.fill(Cell::default());
                        }
                        for cell in rows[y].iter_mut().skip(x) {
                            *cell = Cell::default();
                        }
                    } else {
                        for row in rows.iter_mut().take(y) {
                            row.fill(Cell::default());
                        }
                        for cell in rows[y].iter_mut().take(x + 1) {
                            *cell = Cell::default();
                        }
                    }
                }
                '@' | 'P' | 'X' => {
                    let row = &mut rows[y];
                    let count = n.min(columns - x);
                    match final_byte.unwrap() {
                        '@' => {
                            for i in (x + count..columns).rev() {
                                row[i] = row[i - count].clone();
                            }
                            for cell in row.iter_mut().skip(x).take(count) {
                                *cell = Cell::default();
                            }
                        }
                        'P' => {
                            for i in x..columns - count {
                                row[i] = row[i + count].clone();
                            }
                            for cell in row.iter_mut().skip(columns - count) {
                                *cell = Cell::default();
                            }
                        }
                        _ => {
                            for cell in row.iter_mut().skip(x).take(count) {
                                *cell = Cell::default();
                            }
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        match ch {
            '\r' => {
                x = 0;
                wrap_pending = false;
            }
            '\n' => {
                y += 1;
                x = 0;
                wrap_pending = false;
                if y == rows.len() {
                    rows.push(vec![Cell::default(); columns]);
                }
            }
            '\x08' => {
                x = x.saturating_sub(1);
                wrap_pending = false;
            }
            '\t' => {
                x = ((x / 8 + 1) * 8).min(columns - 1);
                wrap_pending = false;
            }
            c if c.is_control() => {}
            c => {
                if wrap_pending {
                    x = 0;
                    y += 1;
                    if y == rows.len() {
                        rows.push(vec![Cell::default(); columns]);
                    }
                }
                let width = UnicodeWidthChar::width(c).unwrap_or(1).clamp(1, 2);
                if x + width > columns {
                    x = 0;
                    y += 1;
                    if y == rows.len() {
                        rows.push(vec![Cell::default(); columns]);
                    }
                }
                rows[y][x] = Cell {
                    ch: c,
                    sgr: sgr.clone(),
                };
                for offset in 1..width {
                    rows[y][x + offset] = Cell {
                        ch: ' ',
                        sgr: sgr.clone(),
                    };
                }
                x += width;
                wrap_pending = x >= columns;
                x = x.min(columns - 1);
            }
        }
    }
    let start = rows.len().saturating_sub(limit);
    rows.into_iter()
        .enumerate()
        .skip(start)
        .map(|(row_index, row)| {
            let content_end = row
                .iter()
                .rposition(|c| c.ch != '\0' && c.ch != ' ')
                .map_or(0, |i| i + 1);
            let end = if row_index == y {
                content_end.max(x)
            } else {
                content_end
            };
            let mut out = String::new();
            let mut style = String::new();
            for cell in row.into_iter().take(end) {
                if cell.sgr != style {
                    out.push_str("\x1b[0m");
                    out.push_str(&cell.sgr);
                    style = cell.sgr;
                }
                out.push(if cell.ch == '\0' { ' ' } else { cell.ch });
            }
            if !style.is_empty() {
                out.push_str("\x1b[0m");
            }
            out
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::screen_lines;

    #[test]
    fn carriage_return_and_erase_rewrite_the_current_row() {
        assert_eq!(screen_lines("hello\r\x1b[Kready", 20, 20), ["ready"]);
    }

    #[test]
    fn cursor_addressing_and_cell_wrapping_are_applied() {
        assert_eq!(screen_lines("ab\x1b[1;4HXY", 4, 20), ["ab X", "Y"]);
    }

    #[test]
    fn sgr_is_retained_per_cell_and_reset_for_later_text() {
        let rows = screen_lines("\x1b[1;31mred\x1b[0;32mgreen", 20, 20);
        assert_eq!(rows, ["\x1b[0m\x1b[1;31mred\x1b[0m\x1b[32mgreen\x1b[0m"]);
    }
}

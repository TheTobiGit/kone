// ── Terminal screen text ─────────────────────────────────────────────────────
// What a terminal column shows, as plain lines — for the assistant, which is
// asked "why did that fail?" about a terminal it cannot see.
//
// The stored history is the byte stream, not the screen: colour codes, cursor
// moves, and the carriage-return redraws a progress bar or a spinner is made
// of. Stripping escapes from it would leave every frame of every spinner in the
// answer. So the history is replayed through a headless xterm — the same parser
// the renderer's terminal runs — and the lines are read back off its buffer,
// which is the text a person would actually see scrolling up the column.

import { Terminal as HeadlessTerminal } from "@xterm/headless";

/** How much history is replayed. Enough for several screens of a noisy build,
 *  while keeping one call's parse bounded no matter how long the shell has been
 *  up. Starting mid-sequence can garble the first line; that line is the oldest
 *  and the least wanted. */
const REPLAY_TAIL_CHARS = 192 * 1024;
/** Scrollback the replay terminal keeps — a ceiling on `maxLines`. */
const REPLAY_SCROLLBACK = 2_000;

/**
 * The last `maxLines` lines of a terminal's screen and scrollback, as text.
 * Trailing blank lines (the unused rows below the prompt) are dropped.
 */
export async function renderScreenText(
  history: string,
  cols: number,
  rows: number,
  maxLines: number,
): Promise<string[]> {
  const terminal = new HeadlessTerminal({
    cols: Math.max(20, cols),
    rows: Math.max(5, rows),
    scrollback: REPLAY_SCROLLBACK,
    allowProposedApi: true,
  });
  try {
    const tail = history.length > REPLAY_TAIL_CHARS ? history.slice(-REPLAY_TAIL_CHARS) : history;
    await new Promise<void>((resolve) => terminal.write(tail, resolve));
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      // A wrapped row continues the one above it: join them so a long line
      // reads as the one line it was printed as.
      // Untrimmed until the whole line is joined: a row's trailing spaces are
      // real text when the next row continues it.
      const text = line.translateToString(false);
      if (line.isWrapped && lines.length > 0) {
        lines[lines.length - 1] += text;
      } else {
        lines.push(text);
      }
    }
    const trimmed = lines.map((text) => text.trimEnd());
    while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") trimmed.pop();
    const want = Math.max(1, Math.min(maxLines, REPLAY_SCROLLBACK));
    return trimmed.slice(-want);
  } finally {
    terminal.dispose();
  }
}

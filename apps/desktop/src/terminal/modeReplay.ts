// ── Terminal mode replay ─────────────────────────────────────────────────────
// A headless xterm instance runs alongside each PTY session and tracks the
// terminal *modes* the child program has set (application cursor keys,
// bracketed paste, insert mode, origin mode, kitty keyboard protocol flags,
// cursor visibility). Those modes live only in the renderer's xterm.js, so a
// fresh renderer that (re)attaches and replays stored history starts with the
// wrong input state: arrows stay in normal-cursor mode, pastes are not
// bracketed, the cursor comes back when the app hid it. Fixing it server-side
// means the replay is correct no matter which renderer attaches.
//
// The behavior contract: feed every byte the PTY emits, then prepend
// buildPreamble()'s escape sequences to the stored history on attach. The
// headless core runs xterm's real parser via internal APIs (_writeBuffer
// writeSync applies output synchronously, coreService reports cursor
// visibility, optionsService rawOptions toggle kitty keyboard support); the
// kitty keyboard protocol flags are tracked out-of-band because xterm's public
// modes surface does not expose them. Mouse tracking modes are deliberately
// NOT replayed — after an app restart the TUI that enabled mouse reporting may
// be gone, and reasserting it makes ordinary mouse movement print raw escape
// sequences into the shell.

import { Terminal as HeadlessTerminal } from "@xterm/headless";

/** Modes a fresh renderer must be told about before history replays. */
export type ModeReplayTracker = {
  feed(data: string): void;
  resize(cols: number, rows: number): void;
  buildPreamble(): string;
  dispose(): void;
};

/** The private xterm-core surface mode replay needs. */
type HeadlessTerminalInternals = {
  _core?: {
    _writeBuffer?: { writeSync(data: string | Uint8Array): void };
    coreService?: { isCursorHidden?: boolean };
    optionsService?: {
      rawOptions: { vtExtensions?: { kittyKeyboard?: boolean } };
    };
  };
};

/** Where the kitty keyboard protocol stack stands right now: the push/pop
 *  (`CSI >u` / `CSI <u`) and set (`CSI =u`) sequences a TUI sent. */
type KittyKeyboardReplayState = {
  flags: number;
  pendingSequence: string;
  stack: number[];
};

const KITTY_KEYBOARD_SEQUENCE_PATTERN = /(?:\u001b\[|\u009b)([<>=])([0-9;]*)u/g;

/** First param of `CSI <cmd>params u` is the flag set; anything non-numeric or
 *  non-positive reads as "no flags". */
function parseKittyFlags(rawParams: string): number {
  const firstParam = rawParams.split(";")[0] ?? "";
  const flags = Number(firstParam);
  return Number.isInteger(flags) && flags > 0 ? flags : 0;
}

/** A sequence may split across feed chunks; keep up to 128 bytes from the last
 *  CSI start so the next feed can complete it. */
function retainPotentialKittySequenceTail(input: string, startIndex: number): string {
  const tail = input.slice(startIndex);
  const escCsiIndex = tail.lastIndexOf("\u001b[");
  const c1CsiIndex = tail.lastIndexOf("\u009b");
  const csiIndex = Math.max(escCsiIndex, c1CsiIndex);
  return csiIndex >= 0 ? tail.slice(csiIndex, csiIndex + 128) : "";
}

/** Fold `data` into the kitty keyboard replay state: `>` pushes the current
 *  flags, `<` pops, `=` sets and clears the stack. */
function feedKittyKeyboardReplayState(state: KittyKeyboardReplayState, data: string): void {
  const input = `${state.pendingSequence}${data}`;
  let processedUntil = 0;
  KITTY_KEYBOARD_SEQUENCE_PATTERN.lastIndex = 0;

  for (const match of input.matchAll(KITTY_KEYBOARD_SEQUENCE_PATTERN)) {
    processedUntil = (match.index ?? 0) + match[0].length;
    const command = match[1];
    if (command === ">") {
      state.stack.push(state.flags);
      state.flags = parseKittyFlags(match[2] ?? "");
    } else if (command === "<") {
      state.flags = state.stack.pop() ?? 0;
    } else if (command === "=") {
      state.flags = parseKittyFlags(match[2] ?? "");
      state.stack.length = 0;
    }
  }

  state.pendingSequence = retainPotentialKittySequenceTail(input, processedUntil);
}

/** Track the live terminal modes of one PTY session. */
export function createModeReplayTracker(cols: number, rows: number): ModeReplayTracker {
  const terminal = new HeadlessTerminal({
    cols,
    rows,
    scrollback: 1,
    allowProposedApi: true,
  });
  // The public terminal type hides `_core`; this names its private internals to
  // reach the write buffer. Their presence is checked below before any use.
  // eslint-disable-next-line anti-slop/no-chained-type-assertions
  const internals = terminal as unknown as HeadlessTerminalInternals;
  const rawOptions = internals._core?.optionsService?.rawOptions;
  const writeBuffer = internals._core?._writeBuffer;

  if (!rawOptions || typeof writeBuffer?.writeSync !== "function") {
    terminal.dispose();
    throw new Error("@xterm/headless internals unavailable for terminal mode replay");
  }

  // Let the core parse kitty keyboard push/pop/set sequences instead of
  // treating them as unknown escape data.
  rawOptions.vtExtensions = { kittyKeyboard: true };
  const kittyKeyboardState: KittyKeyboardReplayState = {
    flags: 0,
    pendingSequence: "",
    stack: [],
  };

  return {
    feed(data) {
      feedKittyKeyboardReplayState(kittyKeyboardState, data);
      writeBuffer.writeSync(data);
    },
    resize(cols, rows) {
      if (terminal.cols === cols && terminal.rows === rows) return;
      terminal.resize(cols, rows);
    },
    buildPreamble() {
      const modes = terminal.modes;
      const parts: string[] = [];

      if (modes.applicationCursorKeysMode) parts.push("\u001b[?1h");
      if (modes.applicationKeypadMode) parts.push("\u001b[?66h");
      if (modes.bracketedPasteMode) parts.push("\u001b[?2004h");
      if (modes.insertMode) parts.push("\u001b[4h");
      if (modes.originMode) parts.push("\u001b[?6h");
      if (modes.reverseWraparoundMode) parts.push("\u001b[?45h");
      if (modes.sendFocusMode) parts.push("\u001b[?1004h");
      if (modes.synchronizedOutputMode) parts.push("\u001b[?2026h");
      if (!modes.wraparoundMode) parts.push("\u001b[?7l");
      if (internals._core?.coreService?.isCursorHidden === true) parts.push("\u001b[?25l");

      // Do not replay mouse tracking modes — see the file header.

      if (kittyKeyboardState.flags > 0) {
        parts.push(`\u001b[=${kittyKeyboardState.flags};1u`);
      }

      return parts.join("");
    },
    dispose() {
      terminal.dispose();
    },
  };
}

/** One-shot helper: replay stored history through a tracker and get the
 *  preamble that restores the modes it ended in. */
export function buildModeReplayPreamble(history: string): string {
  const tracker = createModeReplayTracker(80, 24);
  try {
    tracker.feed(history);
    return tracker.buildPreamble();
  } finally {
    tracker.dispose();
  }
}

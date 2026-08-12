import { describe, expect, test } from "bun:test";

import { buildModeReplayPreamble, createModeReplayTracker } from "./modeReplay.js";

// Mode replay runs the real @xterm/headless parser in the main process, so
// these tests assert the observable contract: feed output the way TerminalManager
// would (chunked, in any order), and buildPreamble() must return exactly the
// escape sequences a fresh renderer needs to restore the live mode state.

describe("createModeReplayTracker", () => {
  test("application cursor keys is replayed", () => {
    const tracker = createModeReplayTracker(80, 24);
    tracker.feed("\x1b[?1h");
    expect(tracker.buildPreamble()).toContain("\x1b[?1h");
  });

  test("bracketed paste is replayed", () => {
    const tracker = createModeReplayTracker(80, 24);
    tracker.feed("\x1b[?2004h");
    expect(tracker.buildPreamble()).toContain("\x1b[?2004h");
  });

  test("cursor hidden is replayed", () => {
    const tracker = createModeReplayTracker(80, 24);
    tracker.feed("\x1b[?25l");
    expect(tracker.buildPreamble()).toContain("\x1b[?25l");
  });

  test("kitty keyboard protocol flags are replayed", () => {
    const tracker = createModeReplayTracker(80, 24);
    tracker.feed("\x1b[=1001;1u");
    const preamble = tracker.buildPreamble();
    expect(preamble).toContain("\x1b[=1001;1u");
  });

  test("kitty push and pop restore the prior flags", () => {
    const tracker = createModeReplayTracker(80, 24);
    tracker.feed("\x1b[>1u\x1b[>4u\x1b[<u");
    expect(tracker.buildPreamble()).toContain("\x1b[=1;1u");
  });

  test("mouse tracking modes are NOT replayed", () => {
    const tracker = createModeReplayTracker(80, 24);
    tracker.feed("\x1b[?1000h");
    const preamble = tracker.buildPreamble();
    expect(preamble).not.toContain("1000");
  });

  test("no modes set yields an empty preamble", () => {
    const tracker = createModeReplayTracker(80, 24);
    tracker.feed("plain output\r\n");
    expect(tracker.buildPreamble()).toBe("");
  });

  test("modes set then unset are not replayed", () => {
    const tracker = createModeReplayTracker(80, 24);
    tracker.feed("\x1b[?1h\x1b[?1l");
    expect(tracker.buildPreamble()).toBe("");
  });

  test("a sequence split across feed chunks still applies", () => {
    const tracker = createModeReplayTracker(80, 24);
    tracker.feed("\x1b[?2");
    tracker.feed("004h");
    expect(tracker.buildPreamble()).toContain("\x1b[?2004h");
  });

  test("resize keeps the tracked modes", () => {
    const tracker = createModeReplayTracker(80, 24);
    tracker.feed("\x1b[?1h");
    tracker.resize(120, 40);
    expect(tracker.buildPreamble()).toContain("\x1b[?1h");
  });
});

describe("buildModeReplayPreamble", () => {
  test("builds a preamble from a one-shot history string", () => {
    expect(buildModeReplayPreamble("\x1b[?1h\x1b[?2004h")).toContain("\x1b[?1h");
    expect(buildModeReplayPreamble("\x1b[?1h\x1b[?2004h")).toContain("\x1b[?2004h");
  });

  test("returns an empty preamble for plain history", () => {
    expect(buildModeReplayPreamble("hello\r\nworld")).toBe("");
  });
});

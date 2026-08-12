import { describe, expect, test } from "bun:test";

import { sanitizeTerminalHistory, sanitizeTerminalHistoryChunk } from "./sanitize.js";

// The sanitizer is pure over (pending, chunk) pairs — every test asserts the
// full contract: what's kept in visibleText and what's held back as pending.

describe("sanitizeTerminalHistoryChunk", () => {
  describe("strips CSI queries", () => {
    test("device status report queries (final n)", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1b[5n")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
      expect(sanitizeTerminalHistoryChunk("", "ok\x1b[6n")).toEqual({
        visibleText: "ok",
        pendingControlSequence: "",
      });
    });

    test("cursor position report replies (final R)", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1b[12;34R")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
    });

    test("device attribute queries/replies (final c)", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1b[0c")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
      expect(sanitizeTerminalHistoryChunk("", "\x1b[?1;2c")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
    });

    test("XTVERSION query (final >q)", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1b[>0q")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
      expect(sanitizeTerminalHistoryChunk("", "\x1b[>84q")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
    });

    test("Kitty keyboard protocol query (final ?u)", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1b[?u")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
      expect(sanitizeTerminalHistoryChunk("", "\x1b[?4u")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
    });

    test("DECRQM mode queries (…$p) and DECRPM replies (…$y)", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1b[?2026$p")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
      expect(sanitizeTerminalHistoryChunk("", "\x1b[?1$y")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
    });

    test("DECRQSS-style ?$u query", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1b[?$u")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
    });

    test("8-bit C1 CSI form (0x9b)", () => {
      expect(sanitizeTerminalHistoryChunk("", "\u009b5n")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
    });
  });

  describe("strips DCS queries and replies", () => {
    test("DECRQSS query ($q)", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1bP$q\x1b\\")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
    });

    test("XTGETTCAP query (+q)", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1bP+q\x1b\\")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
    });

    test("DECRQSS/XTGETTCAP replies ([01]$r / [01]+r)", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1bP1$r\x1b\\")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
      expect(sanitizeTerminalHistoryChunk("", "\x1bP0+r\x1b\\")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
    });

    test("BEL-terminated DCS", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1bP$q\x07")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
    });
  });

  describe("strips OSC colour queries", () => {
    test("OSC 10;? (fg colour report)", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1b]10;?\x07")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
      expect(sanitizeTerminalHistoryChunk("", "\x1b]10;?\x1b\\")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
    });

    test("OSC 11;rgb:… (bg palette update)", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1b]11;rgb:0f0f0f\x1b\\")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
    });

    test("OSC 12;? (cursor colour report)", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1b]12;?\x07")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
    });
  });

  describe("keeps setters and visible content", () => {
    test("DECSTR soft reset (!p)", () => {
      expect(sanitizeTerminalHistoryChunk("", "x\x1b[!p")).toEqual({
        visibleText: "x\x1b[!p",
        pendingControlSequence: "",
      });
    });

    test("DECSCL conformance level (\"p)", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1b[61\"p")).toEqual({
        visibleText: "\x1b[61\"p",
        pendingControlSequence: "",
      });
    });

    test("DECSCUSR cursor style (space-intermediate q)", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1b[ q")).toEqual({
        visibleText: "\x1b[ q",
        pendingControlSequence: "",
      });
      expect(sanitizeTerminalHistoryChunk("", "\x1b[2 q")).toEqual({
        visibleText: "\x1b[2 q",
        pendingControlSequence: "",
      });
    });

    test("restore cursor (bare u)", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1b[u")).toEqual({
        visibleText: "\x1b[u",
        pendingControlSequence: "",
      });
    });

    test("OSC title sequences", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1b]0;my title\x07")).toEqual({
        visibleText: "\x1b]0;my title\x07",
        pendingControlSequence: "",
      });
      expect(sanitizeTerminalHistoryChunk("", "\x1b]2;~/dev\x1b\\")).toEqual({
        visibleText: "\x1b]2;~/dev\x1b\\",
        pendingControlSequence: "",
      });
    });

    test("plain text", () => {
      expect(sanitizeTerminalHistoryChunk("", "hello world\n$ ")).toEqual({
        visibleText: "hello world\n$ ",
        pendingControlSequence: "",
      });
    });

    test("SGR colour codes", () => {
      expect(sanitizeTerminalHistoryChunk("", "\x1b[31mred\x1b[0m")).toEqual({
        visibleText: "\x1b[31mred\x1b[0m",
        pendingControlSequence: "",
      });
    });

    test("queries stripped from a mixed stream, setters kept", () => {
      expect(
        sanitizeTerminalHistoryChunk(
          "",
          "\x1b[31mred\x1b[5n\x1b[0m\x1b]10;?\x07\x1b[ q\x1b]0;t\x07",
        ),
      ).toEqual({
        visibleText: "\x1b[31mred\x1b[0m\x1b[ q\x1b]0;t\x07",
        pendingControlSequence: "",
      });
    });
  });

  describe("chunk boundaries", () => {
    test("a split CSI query is held pending and stripped once completed", () => {
      const first = sanitizeTerminalHistoryChunk("", "\x1b[");
      expect(first).toEqual({ visibleText: "", pendingControlSequence: "\x1b[" });
      expect(sanitizeTerminalHistoryChunk(first.pendingControlSequence, "5n")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
    });

    test("a kept CSI sequence held pending is emitted once completed", () => {
      const first = sanitizeTerminalHistoryChunk("", "hi\x1b[3");
      expect(first).toEqual({ visibleText: "hi", pendingControlSequence: "\x1b[3" });
      expect(sanitizeTerminalHistoryChunk(first.pendingControlSequence, "1m")).toEqual({
        visibleText: "\x1b[31m",
        pendingControlSequence: "",
      });
    });

    test("a split OSC query is held pending and stripped once terminated", () => {
      const first = sanitizeTerminalHistoryChunk("", "\x1b]10;");
      expect(first).toEqual({ visibleText: "", pendingControlSequence: "\x1b]10;" });
      expect(sanitizeTerminalHistoryChunk(first.pendingControlSequence, "?\x07")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
    });

    test("a split OSC title is held pending and kept once terminated", () => {
      const first = sanitizeTerminalHistoryChunk("", "p\x1b]0;ti");
      expect(first).toEqual({ visibleText: "p", pendingControlSequence: "\x1b]0;ti" });
      expect(sanitizeTerminalHistoryChunk(first.pendingControlSequence, "tle\x07")).toEqual({
        visibleText: "\x1b]0;title\x07",
        pendingControlSequence: "",
      });
    });

    test("a split DCS query split across three chunks", () => {
      const one = sanitizeTerminalHistoryChunk("", "\x1bP$");
      expect(one).toEqual({ visibleText: "", pendingControlSequence: "\x1bP$" });
      const two = sanitizeTerminalHistoryChunk(one.pendingControlSequence, "q\x1b");
      expect(two).toEqual({ visibleText: "", pendingControlSequence: "\x1bP$q\x1b" });
      expect(sanitizeTerminalHistoryChunk(two.pendingControlSequence, "\\")).toEqual({
        visibleText: "",
        pendingControlSequence: "",
      });
    });

    test("a bare ESC at the end of a chunk stays pending", () => {
      expect(sanitizeTerminalHistoryChunk("", "a\x1b")).toEqual({
        visibleText: "a",
        pendingControlSequence: "\x1b",
      });
      // ESC + a final byte resumes as a 2-byte escape sequence (kept — the
      // parser preserves plain ESC sequences; only queries are stripped).
      expect(sanitizeTerminalHistoryChunk("\x1b", "b")).toEqual({
        visibleText: "\x1bb",
        pendingControlSequence: "",
      });
    });
  });
});

describe("sanitizeTerminalHistory", () => {
  test("one-shot full-buffer sanitization", () => {
    const history =
      "prompt$ ls\n" +
      "\x1b[31mfile\x1b[0m\n" +
      "\x1b[5n" +
      "\x1b[?2026$p" +
      "\x1bP+q\x1b\\" +
      "\x1b]11;rgb:0f0f0f\x1b\\" +
      "\x1b]0;kone\x07";
    expect(sanitizeTerminalHistory(history)).toBe(
      "prompt$ ls\n\x1b[31mfile\x1b[0m\n\x1b]0;kone\x07",
    );
  });

  test("empty input", () => {
    expect(sanitizeTerminalHistory("")).toBe("");
  });
});

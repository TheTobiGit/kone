import { describe, expect, test } from "bun:test";

import {
  classifyIpcError,
  kindHint,
  peelIpcError,
  peelIpcErrorLine,
  type IpcErrorKind,
} from "./ipcError";

describe("peelIpcError", () => {
  test("strips the Electron wrapper, error name, and git's fatal prefix", () => {
    const err = new Error(
      "Error invoking remote method 'git:clone': GitError: fatal: could not read from remote",
    );
    expect(peelIpcError(err, "fallback")).toBe("could not read from remote");
  });

  test("strips a plain Error: name", () => {
    const err = new Error(
      "Error invoking remote method 'agent:send-turn': Error: boom",
    );
    expect(peelIpcError(err, "fallback")).toBe("boom");
  });

  test("strips a bare fatal: prefix case-insensitively", () => {
    expect(peelIpcError(new Error("FATAL: out of memory"), "fallback")).toBe(
      "out of memory",
    );
  });

  test("keeps a multi-line message intact", () => {
    const err = new Error(
      "Error invoking remote method 'git:merge': GitError: CONFLICT (content): a\nb",
    );
    expect(peelIpcError(err, "fallback")).toBe("CONFLICT (content): a\nb");
  });

  test("falls back when nothing usable remains", () => {
    expect(peelIpcError(new Error(""), "fallback")).toBe("fallback");
    expect(
      peelIpcError(
        new Error("Error invoking remote method 'git:x': GitError: "),
        "fallback",
      ),
    ).toBe("fallback");
  });

  test("handles non-Error inputs", () => {
    expect(peelIpcError("fatal: boom", "fallback")).toBe("boom");
    expect(peelIpcError(undefined, "fallback")).toBe("fallback");
    expect(peelIpcError(null, "fallback")).toBe("fallback");
  });
});

describe("peelIpcErrorLine", () => {
  test("surfaces a single-line git failure instead of the fallback", () => {
    const err = new Error(
      "Error invoking remote method 'git:push': GitError: Cannot push from detached HEAD — check out a branch first.",
    );
    expect(peelIpcErrorLine(err, "Something went wrong")).toBe(
      "Cannot push from detached HEAD — check out a branch first.",
    );
  });

  test("collapses multi-line git stderr to the last non-empty line", () => {
    const err = new Error(
      "Error invoking remote method 'git:merge': GitError: CONFLICT (content): Merge conflict in a.txt\na.txt",
    );
    expect(peelIpcErrorLine(err, "Something went wrong")).toBe("a.txt");
  });

  test("falls back when the collapse leaves nothing", () => {
    expect(peelIpcErrorLine(new Error(""), "fallback")).toBe("fallback");
    expect(
      peelIpcErrorLine(
        new Error("Error invoking remote method 'git:x': GitError: "),
        "fallback",
      ),
    ).toBe("fallback");
  });
});

describe("peelIpcError with a kind marker", () => {
  test("strips a leading [kone:KIND] marker so it never shows raw", () => {
    const err = new Error(
      "Error invoking remote method 'git:pull': GitError: [kone:AUTH_FAILURE] bad credentials",
    );
    expect(peelIpcError(err, "fallback")).toBe("bad credentials");
  });

  test("peelIpcErrorLine strips the marker too", () => {
    const err = new Error(
      "Error invoking remote method 'git:pull': GitError: [kone:NETWORK]\ncould not reach origin",
    );
    expect(peelIpcErrorLine(err, "fallback")).toBe("could not reach origin");
  });

  test("peelIpcError strips a TIMEOUT marker with no fallback", () => {
    const err = new Error("[kone:TIMEOUT] git:status timed out after 20000ms");
    expect(peelIpcError(err, "fallback")).toBe(
      "git:status timed out after 20000ms",
    );
  });
});

describe("classifyIpcError", () => {
  test("recovers the kind and the human remainder from a marked error", () => {
    const err = new Error(
      "Error invoking remote method 'git:pull': GitError: [kone:AUTH_FAILURE] bad credentials",
    );
    expect(classifyIpcError(err, "fallback")).toEqual({
      kind: "AUTH_FAILURE",
      message: "bad credentials",
    });
  });

  test("leaves an unmarked error with kind null and its peeled text", () => {
    const err = new Error(
      "Error invoking remote method 'git:clone': GitError: fatal: could not read from remote",
    );
    expect(classifyIpcError(err, "fallback")).toEqual({
      kind: null,
      message: "could not read from remote",
    });
  });

  test("falls back when nothing remains", () => {
    const err = new Error(
      "Error invoking remote method 'git:pull': GitError: [kone:NETWORK] ",
    );
    expect(classifyIpcError(err, "fallback")).toEqual({
      kind: "NETWORK",
      message: "fallback",
    });
    expect(classifyIpcError(new Error(""), "fallback")).toEqual({
      kind: null,
      message: "fallback",
    });
  });

  test("classifies a bare TIMEOUT marker", () => {
    const err = new Error("[kone:TIMEOUT] git:status timed out after 20000ms");
    expect(classifyIpcError(err, "fallback")).toEqual({
      kind: "TIMEOUT",
      message: "git:status timed out after 20000ms",
    });
  });

  test("keeps the TIMEOUT kind through the Electron wrapper prefix", () => {
    const err = new Error(
      "Error invoking remote method 'git:status': GitError: [kone:TIMEOUT] git:status timed out after 20000ms",
    );
    expect(classifyIpcError(err, "fallback").kind).toBe("TIMEOUT");
  });
});

describe("kindHint", () => {
  test("gives actionable copy for known kinds", () => {
    expect(kindHint("AUTH_FAILURE")).toBe("Check your git credentials.");
    expect(kindHint("NETWORK")).toBe(
      "Can't reach GitHub — check your connection.",
    );
  });

  test("returns null for null, INTERNAL, and unknown kinds", () => {
    expect(kindHint(null)).toBeNull();
    expect(kindHint("INTERNAL")).toBeNull();
    // SAFETY: deliberately invalid kind — the test asserts unknown kinds get
    // no hint rather than throwing.
    expect(kindHint("BOGUS" as IpcErrorKind)).toBeNull();
  });

  test("gives a retry hint for TIMEOUT", () => {
    expect(kindHint("TIMEOUT")).toBe("The request timed out — try again.");
  });
});

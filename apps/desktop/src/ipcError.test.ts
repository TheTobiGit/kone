import { describe, expect, test } from "bun:test";

import { IPC_ERROR_KINDS, markKind, parseKind } from "./ipcError.js";

describe("markKind", () => {
  test("prefixes the message with the [kone:KIND] marker", () => {
    expect(markKind("AUTH_FAILURE", "bad credentials")).toBe(
      "[kone:AUTH_FAILURE] bad credentials",
    );
  });

  test("preserves the message verbatim after the marker", () => {
    expect(markKind("NETWORK", "fatal: could not read from remote\ndetails")).toBe(
      "[kone:NETWORK] fatal: could not read from remote\ndetails",
    );
  });
});

describe("parseKind", () => {
  test("recovers the kind and the human remainder", () => {
    expect(parseKind("[kone:NOT_AUTHENTICATED] Sign in to GitHub")).toEqual({
      kind: "NOT_AUTHENTICATED",
      message: "Sign in to GitHub",
    });
  });

  test("round-trips markKind", () => {
    const kind = "NO_GITHUB_REMOTE" as const;
    expect(parseKind(markKind(kind, "no remotes point at GitHub"))).toEqual({
      kind,
      message: "no remotes point at GitHub",
    });
  });

  test("returns null kind for an unmarked message", () => {
    expect(parseKind("plain old failure")).toEqual({
      kind: null,
      message: "plain old failure",
    });
  });

  test("does not treat a mid-sentence marker as a kind", () => {
    expect(parseKind("the tool said [kone:NETWORK] and then stopped")).toEqual({
      kind: null,
      message: "the tool said [kone:NETWORK] and then stopped",
    });
  });

  test("handles an empty message", () => {
    expect(parseKind("")).toEqual({ kind: null, message: "" });
  });
});

describe("IPC_ERROR_KINDS", () => {
  test("is a non-empty list of UPPER_SNAKE kinds", () => {
    expect(IPC_ERROR_KINDS.length).toBeGreaterThan(0);
    for (const kind of IPC_ERROR_KINDS) {
      expect(kind).toMatch(/^[A-Z][A-Z_]*$/);
    }
  });
});

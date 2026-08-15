import { describe, expect, test } from "bun:test";

import { GitError, isExecTimeout, lastStderrLine } from "./core.js";

describe("GitError", () => {
  test("unclassified errors keep a plain message and null kind", () => {
    const err = new GitError("fatal: boom", 128);
    expect(err.message).toBe("fatal: boom");
    expect(err.kind).toBeNull();
  });

  test("classified() carries the kind in the message and the field", () => {
    const err = GitError.classified("AUTH_FAILURE", "bad credentials", 128);
    expect(err.kind).toBe("AUTH_FAILURE");
    expect(err.message).toBe("[kone:AUTH_FAILURE] bad credentials");
    expect(err.code).toBe(128);
  });

  test("is still an instanceof GitError for existing catch sites", () => {
    const err = GitError.classified("NETWORK", "offline");
    expect(err).toBeInstanceOf(GitError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("lastStderrLine", () => {
  test("returns the last non-empty line", () => {
    expect(lastStderrLine("a\nb\nc", "fallback")).toBe("c");
  });

  test("falls back when there is nothing usable", () => {
    expect(lastStderrLine("", "fallback")).toBe("fallback");
    expect(lastStderrLine("\n \n", "fallback")).toBe("fallback");
  });
});

describe("isExecTimeout", () => {
  test("killed runs are timeouts", () => {
    expect(isExecTimeout({ killed: true })).toBe(true);
  });

  test("ETIMEDOUT code is a timeout", () => {
    expect(isExecTimeout({ code: "ETIMEDOUT" })).toBe(true);
  });

  test("a real exit code is not a timeout", () => {
    expect(isExecTimeout({ code: 128 })).toBe(false);
  });

  test("killed: false is not a timeout", () => {
    expect(isExecTimeout({ killed: false })).toBe(false);
  });

  test("an ordinary error is not a timeout", () => {
    expect(isExecTimeout(new Error("boom"))).toBe(false);
  });
});

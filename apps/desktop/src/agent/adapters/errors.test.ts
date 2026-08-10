import { describe, expect, test } from "bun:test";

import {
  classifyProviderError,
  isNonFatalCodexError,
  isRecoverableCodexResumeError,
  isResumeRefusalError,
} from "./errors.js";

describe("classifyProviderError", () => {
  test("recognizes dead-session transport signatures as session-closed", () => {
    expect(classifyProviderError("unknown session abc")).toBe("session-closed");
    expect(classifyProviderError("unknown provider session")).toBe("session-closed");
    expect(classifyProviderError("session is closed")).toBe("session-closed");
    expect(classifyProviderError("write_stdin failed: stdin is closed for this session")).toBe(
      "session-closed",
    );
  });

  test("recognizes credential failures as auth", () => {
    expect(classifyProviderError("Not authenticated")).toBe("auth");
    expect(classifyProviderError("authentication failed: invalid token")).toBe("auth");
    expect(classifyProviderError("request unauthorized")).toBe("auth");
    expect(classifyProviderError("HTTP 401 Unauthorized")).toBe("auth");
  });

  test("everything else is unknown", () => {
    expect(classifyProviderError("thread/resume failed: timed out waiting for server")).toBe("unknown");
    expect(classifyProviderError("")).toBe("unknown");
  });
});

describe("isRecoverableCodexResumeError", () => {
  test("refusal-class resume failures are recoverable via fresh start", () => {
    expect(isRecoverableCodexResumeError(new Error("thread/resume failed: thread not found"))).toBe(true);
    expect(isRecoverableCodexResumeError(new Error("thread/resume: no such thread ses_1"))).toBe(true);
    expect(isRecoverableCodexResumeError(new Error("thread/resume failed: missing thread"))).toBe(true);
    expect(isRecoverableCodexResumeError(new Error("thread/resume failed: unknown session"))).toBe(true);
  });

  test("non-resume errors and transient failures are NOT masked by a fresh start", () => {
    expect(isRecoverableCodexResumeError(new Error("thread/start failed: permission denied"))).toBe(false);
    expect(
      isRecoverableCodexResumeError(new Error("thread/resume failed: timed out waiting for server")),
    ).toBe(false);
    expect(isRecoverableCodexResumeError(new Error("thread/resume failed: connection refused"))).toBe(false);
  });
});

describe("isNonFatalCodexError", () => {
  test("known-benign error-notification messages are warnings, not failures", () => {
    expect(isNonFatalCodexError("write_stdin failed: stdin is closed for this session")).toBe(true);
    expect(isNonFatalCodexError("context window exceeded")).toBe(false);
  });
});

describe("isResumeRefusalError", () => {
  test("refusal-class session failures are recoverable via fresh start", () => {
    expect(isResumeRefusalError(new Error("Session not found: ses_1"))).toBe(true);
    expect(isResumeRefusalError(new Error("session/resume failed: no such session"))).toBe(true);
    expect(isResumeRefusalError(new Error("unknown session abc"))).toBe(true);
    expect(isResumeRefusalError(new Error("session/load: session is closed"))).toBe(true);
  });

  test("transient and auth failures are NOT masked by a fresh start", () => {
    expect(isResumeRefusalError(new Error("session/load timed out waiting for server"))).toBe(false);
    expect(isResumeRefusalError(new Error("session/resume failed: permission denied"))).toBe(false);
    expect(isResumeRefusalError(new Error("connection refused"))).toBe(false);
  });
});

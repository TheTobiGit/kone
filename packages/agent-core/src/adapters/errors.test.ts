import { describe, expect, test } from "bun:test";

import {
  classifyProviderError,
  errorText,
  isNonFatalCodexError,
  isQuotaOrRateLimitError,
  isRecoverableCodexResumeError,
  isResumeRefusalError,
  limitResetFromError,
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

describe("errorText", () => {
  test("unwraps the shapes providers actually put on the wire", () => {
    expect(errorText("plain text  ")).toBe("plain text");
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText({ message: "rate limit exceeded" })).toBe("rate limit exceeded");
    expect(errorText({ error: { message: "upstream refused" } })).toBe("upstream refused");
    expect(errorText([{ message: "first" }, { message: "second" }])).toBe("first; second");
  });

  test("unwraps OpenCode's nested { name, data: { message } } payloads", () => {
    expect(
      errorText({ name: "ProviderAuthError", data: { providerID: "anthropic", message: "not signed in" } }),
    ).toBe("not signed in");
    expect(errorText({ name: "UnknownError", data: { message: "upstream 500" } })).toBe("upstream 500");
    // MessageOutputLengthError carries an empty `data` — the name is all there is.
    expect(errorText({ name: "MessageOutputLengthError", data: {} })).toBe("MessageOutputLengthError");
  });

  test("walks an Error's cause when the wrapper carries no message of its own", () => {
    expect(errorText(new Error("", { cause: { message: "upstream refused" } }))).toBe(
      "upstream refused",
    );
    expect(errorText(new Error("wrapper", { cause: { message: "inner" } }))).toBe("wrapper");
  });

  test("reports an unrecognized payload as a human line, never as JSON", () => {
    expect(errorText({ code: 500, retryable: false })).toBe("Unknown error (code 500)");
    expect(errorText({ retryable: false })).toBe("Unknown error from the provider");
    const circular = { self: {} };
    circular.self = circular;
    const text = errorText(circular);
    expect(text).toBe("Unknown error from the provider");
    expect(text).not.toContain("[object Object]");
  });

  test("empty-ish values produce no message rather than a fake one", () => {
    expect(errorText(null)).toBe("");
    expect(errorText(undefined)).toBe("");
    expect(errorText("")).toBe("");
  });
});

describe("quota classification", () => {
  test("classifies limit shapes and messages as quota", () => {
    expect(classifyProviderError("429 Too Many Requests")).toBe("quota");
    expect(classifyProviderError("you have hit your usage limit")).toBe("quota");
    expect(isQuotaOrRateLimitError({ status: 429 })).toBe(true);
    expect(isQuotaOrRateLimitError({ code: "insufficient_quota" })).toBe(true);
    expect(isQuotaOrRateLimitError(new Error("connection reset"))).toBe(false);
  });
});

describe("limitResetFromError", () => {
  const NOW = 1_800_000_000_000;
  const LATER = NOW + 3_600_000;

  test("reads an ISO reset nested in the payload", () => {
    expect(limitResetFromError({ error: { resetsAt: new Date(LATER).toISOString() } }, NOW)).toBe(LATER);
  });

  test("reads Codex epoch-second resets and the codexErrorInfo container", () => {
    expect(limitResetFromError({ reset_at: Math.floor(LATER / 1000) }, NOW)).toBe(LATER);
    expect(
      limitResetFromError({ error: { codexErrorInfo: { rate_limit: { resetsAt: LATER } } } }, NOW),
    ).toBe(LATER);
  });

  test("reads a Retry-After duration and header", () => {
    expect(limitResetFromError({ retry_after: 60 }, NOW)).toBe(NOW + 60_000);
    expect(limitResetFromError({ headers: { "Retry-After": "90" } }, NOW)).toBe(NOW + 90_000);
  });

  test("never invents a reset: absent, past, or unrelated fields read null", () => {
    expect(limitResetFromError({ message: "usage limit" }, NOW)).toBeNull();
    expect(limitResetFromError({ resetsAt: new Date(NOW - 1).toISOString() }, NOW)).toBeNull();
    expect(limitResetFromError({ retry_after: 0 }, NOW)).toBeNull();
    expect(limitResetFromError(null, NOW)).toBeNull();
    expect(limitResetFromError("429", NOW)).toBeNull();
  });

  test("a self-referential payload does not loop", () => {
    const circular: unknown[] = [];
    circular.push(circular);
    expect(limitResetFromError(circular, NOW)).toBeNull();
  });
});

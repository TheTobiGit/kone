import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "~/types/session";
import { sessionCost } from "./sessionCost";

describe("sessionCost", () => {
  const baseSession: SessionSummary = {
    threadId: "t-1",
    title: "Test Session",
    provider: "antigravity",
    brand: "antigravity",
    updatedAt: Date.now(),
  };

  test("returns explicit costUsd when present", () => {
    expect(sessionCost({ ...baseSession, costUsd: 1.25, tokens: 500_000 })).toBe(1.25);
    expect(sessionCost({ ...baseSession, costUsd: 0, tokens: 500_000 })).toBe(0);
  });

  test("returns 0 when tokens are absent or non-positive", () => {
    expect(sessionCost({ ...baseSession, tokens: undefined })).toBe(0);
    expect(sessionCost({ ...baseSession, tokens: 0 })).toBe(0);
    expect(sessionCost({ ...baseSession, tokens: -100 })).toBe(0);
  });

  test("estimates spend for Antigravity flash models", () => {
    const session: SessionSummary = {
      ...baseSession,
      provider: "antigravity",
      model: "Gemini 3.5 Flash (High)",
      tokens: 1_000_000,
    };
    expect(sessionCost(session)).toBeCloseTo(0.2, 4);
  });

  test("estimates spend for Antigravity pro models", () => {
    const session: SessionSummary = {
      ...baseSession,
      provider: "antigravity",
      model: "Gemini 3.1 Pro (High)",
      tokens: 1_000_000,
    };
    expect(sessionCost(session)).toBeCloseTo(1.5, 4);
  });

  test("estimates spend for Claude and Codex providers", () => {
    expect(
      sessionCost({
        ...baseSession,
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        tokens: 1_000_000,
      }),
    ).toBeCloseTo(4.8, 4);

    expect(
      sessionCost({
        ...baseSession,
        provider: "codex",
        model: "gpt-5.4-mini",
        tokens: 1_000_000,
      }),
    ).toBeCloseTo(0.45, 4);
  });
});

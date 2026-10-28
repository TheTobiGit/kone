import { describe, expect, test } from "bun:test";
import type { ProviderKind } from "~/types/desktop";
import { canSignIn, PROVIDER_LOGIN } from "~/utils/providerLogin";

// The renderer login table is a hand-kept mirror of agent-core's LOGIN_COMMANDS
// (web can't import agent-core, so there is nothing to compare against at test
// time). What is worth pinning here is the contract the surfaces rely on: every
// provider has an answer, only Droid's is null, and the strings are the ones the
// CLIs document — a typo here is a command the user would copy and run.

const PROVIDERS: ProviderKind[] = [
  "codex",
  "claudeAgent",
  "cursor",
  "opencode",
  "droid",
  "antigravity",
  "cline",
];

describe("PROVIDER_LOGIN", () => {
  test("answers for every provider, and only Droid has no login", () => {
    for (const provider of PROVIDERS) {
      expect(PROVIDER_LOGIN[provider]).not.toBeUndefined();
      expect(canSignIn(provider)).toBe(provider !== "droid");
    }
    expect(PROVIDER_LOGIN.droid).toBeNull();
  });

  test("names each CLI's documented login command", () => {
    expect(PROVIDER_LOGIN.codex).toEqual({ display: "codex login", finish: "browser" });
    expect(PROVIDER_LOGIN.claudeAgent).toEqual({
      display: "claude auth login",
      finish: "browser",
    });
    expect(PROVIDER_LOGIN.cursor).toEqual({
      display: "cursor-agent login",
      finish: "browser",
    });
    expect(PROVIDER_LOGIN.antigravity).toEqual({ display: "agy login", finish: "browser" });
    expect(PROVIDER_LOGIN.cline).toEqual({ display: "cline auth", finish: "browser" });
  });

  test("opencode's provider menu finishes in the terminal", () => {
    expect(PROVIDER_LOGIN.opencode).toEqual({
      display: "opencode auth login",
      finish: "terminal",
    });
  });
});

import { describe, expect, test } from "bun:test";

import type { ProviderStatus } from "~/types/desktop";
import { resolveProviderSendAvailability } from "./providerAvailability";

// These cases are the same ones packages/agent-core/src/providerHealth.test.ts
// asserts against its copy of the rule. Two surfaces disagreeing about whether
// a send is allowed is the failure this pair of suites exists to catch.

function status(over: Partial<ProviderStatus>): ProviderStatus {
  return {
    provider: "codex",
    label: "Codex",
    available: true,
    authStatus: "authenticated",
    readiness: "ready",
    ...over,
  };
}

describe("resolveProviderSendAvailability", () => {
  test("a ready provider can take a turn", () => {
    const availability = resolveProviderSendAvailability({ provider: "codex", statuses: [status({})] });
    expect(availability.usable).toBe(true);
    expect(availability.reason).toBe("");
  });

  test("an unprobed provider is unknown, not broken — a cold launch stays sendable", () => {
    const availability = resolveProviderSendAvailability({ provider: "codex", statuses: [] });
    expect(availability.usable).toBe(true);
    expect(availability.status).toBeNull();
  });

  test("blocks a signed-out provider and shows the probe's own words", () => {
    const availability = resolveProviderSendAvailability({
      provider: "codex",
      statuses: [
        status({
          readiness: "needs-login",
          authStatus: "unauthenticated",
          message: "Run `codex login` to sign in.",
        }),
      ],
    });
    expect(availability.usable).toBe(false);
    expect(availability.reason).toBe("Run `codex login` to sign in.");
  });

  test("falls back to a readiness sentence when the probe left no message", () => {
    const availability = resolveProviderSendAvailability({
      provider: "codex",
      statuses: [status({ available: false, readiness: "not-installed", authStatus: "unknown" })],
    });
    expect(availability.usable).toBe(false);
    expect(availability.reason).toBe("Codex is not installed on this machine.");
  });

  test("reads the row for the asked-for provider, not the first one", () => {
    const statuses = [
      status({ provider: "cursor", label: "Cursor", readiness: "needs-login" }),
      status({}),
    ];
    expect(resolveProviderSendAvailability({ provider: "codex", statuses }).usable).toBe(true);
    expect(resolveProviderSendAvailability({ provider: "cursor", statuses }).usable).toBe(false);
  });
});

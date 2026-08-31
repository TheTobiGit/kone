import { describe, expect, test } from "bun:test";

import {
  probeDetail,
  providerStatusesEqual,
  resolveProviderSendAvailability,
  stabilizeProviderStatuses,
  versionProbeFailure,
} from "./providerHealth.js";
import type { ProbeResult } from "./spawn.js";
import type { ProviderStatus } from "./types.js";

function result(over: Partial<ProbeResult> & Pick<ProbeResult, "outcome">): ProbeResult {
  return { stdout: "", stderr: "", code: null, ...over };
}

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

describe("versionProbeFailure", () => {
  test("only a missing binary is reported as not installed", () => {
    const failure = versionProbeFailure({
      label: "Codex CLI",
      installHint: "Install it.",
      result: result({ outcome: "missing" }),
    });
    expect(failure.readiness).toBe("not-installed");
    expect(failure.available).toBe(false);
    expect(failure.message).toBe("Install it.");
  });

  test("a slow CLI stays available and never suggests installing anything", () => {
    const failure = versionProbeFailure({
      label: "Codex CLI",
      installHint: "Install it.",
      result: result({ outcome: "timeout" }),
    });
    expect(failure.readiness).toBe("error");
    expect(failure.available).toBe(true);
    expect(failure.transient).toBe(true);
    expect(failure.message).not.toContain("Install");
  });

  test("a non-zero exit carries the CLI's own stderr back to the user", () => {
    const failure = versionProbeFailure({
      label: "Codex CLI",
      installHint: "Install it.",
      result: result({ outcome: "nonzero", code: 1, stderr: "libssl.so.3: cannot open" }),
    });
    expect(failure.readiness).toBe("error");
    expect(failure.available).toBe(true);
    expect(failure.transient).toBeUndefined();
    expect(failure.message).toContain("libssl.so.3: cannot open");
  });
});

describe("probeDetail", () => {
  test("prefers stderr, falls back to stdout, then to the exit code", () => {
    expect(probeDetail(result({ outcome: "nonzero", code: 2, stdout: "out", stderr: "err" }))).toBe(
      "err",
    );
    expect(probeDetail(result({ outcome: "nonzero", code: 2, stdout: "out" }))).toBe("out");
    expect(probeDetail(result({ outcome: "nonzero", code: 2 }))).toBe("Command exited with code 2.");
    expect(probeDetail(result({ outcome: "ok", code: 0 }))).toBeUndefined();
  });
});

describe("stabilizeProviderStatuses", () => {
  test("keeps a known-good row when this round's probe timed out", () => {
    const previous = [status({ version: "1.2.3", authLabel: "ChatGPT Sign-In" })];
    const next = [
      status({ authStatus: "unknown", readiness: "error", message: "no answer", transient: true }),
    ];

    expect(stabilizeProviderStatuses(previous, next)).toEqual(previous);
  });

  test("lets a real verdict through, however bad", () => {
    const previous = [status({})];
    const next = [
      status({ available: false, authStatus: "unknown", readiness: "not-installed" }),
    ];

    expect(stabilizeProviderStatuses(previous, next)).toEqual(next);
  });

  test("does not resurrect a row that was already broken", () => {
    const previous = [status({ readiness: "needs-login", authStatus: "unauthenticated" })];
    const next = [status({ readiness: "error", message: "no answer", transient: true })];

    // Nothing usable to fall back to, so the honest "no answer" stands.
    expect(stabilizeProviderStatuses(previous, next)).toEqual([
      status({ readiness: "error", message: "no answer" }),
    ]);
  });

  test("strips the transient marker so it never reaches the cache or the UI", () => {
    const next = [status({ readiness: "error", transient: true })];
    for (const row of stabilizeProviderStatuses([], next)) {
      expect(row).not.toHaveProperty("transient");
    }
  });

  test("matches rows by provider rather than by position", () => {
    const previous = [status({ provider: "cursor", label: "Cursor" }), status({})];
    const next = [
      status({ readiness: "error", transient: true }),
      status({ provider: "cursor", label: "Cursor", readiness: "error", transient: true }),
    ];

    expect(stabilizeProviderStatuses(previous, next)).toEqual([
      status({}),
      status({ provider: "cursor", label: "Cursor" }),
    ]);
  });
});

describe("providerStatusesEqual", () => {
  test("an unchanged round compares equal, so nothing is announced", () => {
    expect(providerStatusesEqual([status({})], [status({})])).toBe(true);
  });

  test("notices a field that moved", () => {
    expect(providerStatusesEqual([status({})], [status({ readiness: "needs-login" })])).toBe(false);
    expect(providerStatusesEqual([status({})], [status({ message: "signed out" })])).toBe(false);
    expect(providerStatusesEqual([status({})], [status({ version: "2.0.0" })])).toBe(false);
  });

  test("a provider appearing or disappearing is a change", () => {
    expect(providerStatusesEqual([], [status({})])).toBe(false);
    expect(providerStatusesEqual([status({}), status({ provider: "cursor" })], [status({})])).toBe(
      false,
    );
  });

  test("ignores the internal transient marker", () => {
    expect(providerStatusesEqual([status({})], [status({ transient: true })])).toBe(true);
  });
});

describe("resolveProviderSendAvailability", () => {
  test("a ready provider can take a turn", () => {
    const availability = resolveProviderSendAvailability({
      provider: "codex",
      statuses: [status({})],
    });
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
});

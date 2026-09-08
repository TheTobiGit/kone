import { describe, expect, test } from "bun:test";

import type { ProviderStatus } from "~/types/desktop";
import {
  compactAvailability,
  compactPropsForSession,
  type CompactSessionLike,
  type CompactSnapshot,
} from "./compactAvailability";

describe("compactAvailability", () => {
  test("a supported idle thread with history is available", () => {
    expect(
      compactAvailability({ supported: true, hasUserTurn: true, working: false, compacting: false }),
    ).toEqual({ state: "available" });
  });

  test("an unsupported provider is unavailable, whatever else holds", () => {
    expect(
      compactAvailability({ supported: false, hasUserTurn: true, working: false, compacting: false }),
    ).toEqual({ state: "unavailable", reason: "Compaction is unavailable for this provider" });
  });

  test("a thread with no user turn is unavailable", () => {
    expect(
      compactAvailability({ supported: true, hasUserTurn: false, working: false, compacting: false }),
    ).toEqual({ state: "unavailable", reason: "Nothing to compact yet" });
  });

  test("an in-flight compaction reads as compacting, even while working", () => {
    expect(
      compactAvailability({ supported: true, hasUserTurn: true, working: true, compacting: true }),
    ).toEqual({ state: "compacting" });
  });

  test("a working thread without an in-flight compaction waits", () => {
    expect(
      compactAvailability({ supported: true, hasUserTurn: true, working: true, compacting: false }),
    ).toEqual({ state: "unavailable", reason: "Wait for the turn to finish" });
  });
});

describe("compactPropsForSession", () => {
  const statuses: ProviderStatus[] = [
    {
      provider: "codex",
      label: "Codex",
      available: true,
      authStatus: "authenticated",
      readiness: "ready",
      supportsThreadCompaction: true,
    },
    {
      provider: "droid",
      label: "Droid",
      available: true,
      authStatus: "authenticated",
      readiness: "ready",
    },
  ];

  function source(overrides: Partial<CompactSnapshot> = {}): CompactSnapshot {
    return {
      provider: "codex",
      hasUserTurn: true,
      working: false,
      compacting: false,
      compactError: null,
      compactThread: () => {},
      ...overrides,
    };
  }

  test("no session hides the card", () => {
    expect(compactPropsForSession(null, statuses)).toEqual({});
    expect(compactPropsForSession(undefined, statuses)).toEqual({});
  });

  test("an unsupported provider hides the card", () => {
    expect(compactPropsForSession(source({ provider: "droid" }), statuses)).toEqual({});
  });

  test("an available thread wires the call through", () => {
    let called = false;
    const props = compactPropsForSession(
      source({ compactThread: () => { called = true; } }),
      statuses,
    );
    expect(props.compactState).toBe("available");
    expect(props.compactReason).toBeUndefined();
    props.onCompact?.();
    expect(called).toBe(true);
  });

  test("busy and error states ride along", () => {
    const busy = compactPropsForSession(source({ working: true }), statuses);
    expect(busy.compactState).toBe("unavailable");
    expect(busy.compactReason).toBe("Wait for the turn to finish");
    expect(busy.onCompact).toBeDefined();

    const failed = compactPropsForSession(source({ compactError: "Nope." }), statuses);
    expect(failed.compactState).toBe("available");
    expect(failed.compactError).toBe("Nope.");
  });

  test("a live session unwraps to the same props", () => {
    let called = false;
    const live: CompactSessionLike = {
      provider: { value: "codex" },
      blocks: { value: [{ role: "user" }] },
      busy: { value: false },
      queuedTurns: { value: [] },
      compacting: { value: false },
      compactError: { value: null },
      compactThread: () => { called = true; },
    };
    const props = compactPropsForSession(live, statuses);
    expect(props.compactState).toBe("available");
    props.onCompact?.();
    expect(called).toBe(true);
  });

  test("a working live session waits", () => {
    const live: CompactSessionLike = {
      provider: { value: "codex" },
      blocks: { value: [{ role: "user" }] },
      busy: { value: true },
      queuedTurns: { value: [] },
      compacting: { value: false },
      compactError: { value: null },
      compactThread: () => {},
    };
    expect(compactPropsForSession(live, statuses).compactState).toBe("unavailable");
  });
});

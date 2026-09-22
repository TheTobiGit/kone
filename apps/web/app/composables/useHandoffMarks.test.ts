import { afterEach, describe, expect, test } from "bun:test";
import { useHandoffMarks } from "./useHandoffMarks";
import type {
  ForkContext,
  HandoffLink,
  ProviderKind,
  RuntimeEvent,
} from "~/types/desktop";

/** The slice of the desktop bridge the composable actually reaches for. */
type BridgeHost = {
  koneDesktop: {
    agent: {
      history: { handoffsFromSource: (sourceThreadId: string) => Promise<HandoffLink[]> };
      onEvent: (fn: (e: RuntimeEvent) => void) => () => void;
    };
  };
};

function installBridge(links: HandoffLink[]) {
  let calls = 0;
  let listener: ((event: RuntimeEvent) => void) | null = null;
  const host: BridgeHost = {
    koneDesktop: {
      agent: {
        history: {
          handoffsFromSource: () => {
            calls += 1;
            return Promise.resolve(links);
          },
        },
        onEvent: (fn) => {
          listener = fn;
          return () => {
            listener = null;
          };
        },
      },
    },
  };
  // SAFETY: the composable reads only window.koneDesktop.agent.history and
  // .onEvent, which BridgeHost provides; nothing else here touches window.
  (globalThis as { window?: BridgeHost }).window = host;
  return {
    calls: () => calls,
    emit: (event: RuntimeEvent) => listener?.(event),
  };
}

afterEach(() => {
  // SAFETY: restores the no-bridge shape between tests — a defined window
  // with no koneDesktop, exactly what the composable guards.
  (globalThis as { window?: object }).window = {};
});

function handoffEvent(sourceThreadId: string): RuntimeEvent {
  return {
    type: "thread.handoff-created",
    threadId: "h-new",
    // SAFETY: the composable reads only type and sourceThreadId off the
    // event; provider/at/source/requestId ride along for the union shape.
    provider: "claudeAgent" as ProviderKind,
    at: Date.now(),
    source: "kone.store",
    sourceThreadId,
    requestId: "r-1",
  };
}

describe("useHandoffMarks", () => {
  test("a handoff thread marks its source, oldest-first with its links", async () => {
    installBridge([
      { threadId: "h-2", provider: "opencode", handedAt: 300, kind: "handoff" },
      { threadId: "h-1", provider: "claudeAgent", model: "claude-sonnet-5", handedAt: 200, kind: "handoff" },
    ]);
    const forkContext: ForkContext = {
      sourceThreadId: "t-src",
      forkPointBlockId: null,
      importedAt: 100,
      bootstrapStatus: "completed",
      forkKind: "handoff",
      sourceProvider: "claudeAgent",
      sourceModel: "claude-opus-5",
    };
    const { marks, reload } = useHandoffMarks({
      threadId: () => "h-0",
      forkContext: () => forkContext,
      enabled: () => true,
    });
    await reload();
    expect(marks.value.map((m) => m.kind)).toEqual(["from", "to", "to"]);
    expect(marks.value[0]).toMatchObject({ threadId: "t-src", label: "Claude Opus 5" });
    expect(marks.value[1]).toMatchObject({ threadId: "h-1" });
    expect(marks.value[1]!.label).toContain("Claude");
  });

  test("a handoff-created event for this thread reloads its links", async () => {
    const bridge = installBridge([]);
    const { marks, reload } = useHandoffMarks({
      threadId: () => "t-src",
      forkContext: () => null,
      enabled: () => true,
    });
    await reload();
    expect(marks.value).toEqual([]);
    // Setup already fired one read; the manual reload is the second.
    expect(bridge.calls()).toBe(2);
    bridge.emit(handoffEvent("t-src"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.calls()).toBe(3);
  });

  test("disabled surfaces fetch nothing and mark nothing", async () => {
    installBridge([{ threadId: "h-1", provider: "codex", handedAt: 200, kind: "handoff" }]);
    const { marks, reload } = useHandoffMarks({
      threadId: () => "t-src",
      forkContext: () => null,
      enabled: () => false,
    });
    await reload();
    expect(marks.value).toEqual([]);
  });
});

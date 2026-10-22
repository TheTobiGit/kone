import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { patchProviderSettings, resetProviderSettingsForTests } from "./providerSettings.js";
import { setUserDataDir } from "./userDataDir.js";
import type { ProviderAdapter, RuntimeEvent } from "./types.js";

// The two per-provider usage-limit toggles, read where they actually gate the
// behaviour: `resumeAtReset` when the limit is recorded (schedule or not) and
// again when the scheduled resume comes due (send or drop), and
// `snoozeWhenLimited` when the limit is recorded. The store is real, so the
// assertions read the marks and rows the app would see.

mock.module("./sqlite.js", () => ({ DatabaseSync: Database }));

const dir = mkdtempSync(path.join(tmpdir(), "kone-limit-toggles-"));
setUserDataDir(dir);

const { ConversationStore } = await import("./ConversationStore.js");
const { AgentService } = await import("./AgentService.js");
const { initThreadDispatcher } = await import("./dispatch.js");

type Store = InstanceType<typeof ConversationStore>;
type Service = InstanceType<typeof AgentService>;
const store: Store = new ConversationStore();

class Adapter {
  // SAFETY: this test fake always represents the Codex adapter.
  provider = "codex" as const;
  capabilities: ProviderAdapter["capabilities"] = {
    sessionModelSwitch: "unsupported",
    streamsText: false,
    supportsToolEvents: false,
    supportsResume: true,
    supportsModelList: false,
    supportsSubagents: false,
  };
  emit: ((event: RuntimeEvent) => void) | null = null;
  sent: string[] = [];
  async discover(): Promise<Awaited<ReturnType<ProviderAdapter["discover"]>>> {
    return { provider: "codex", label: "Codex", available: false, authStatus: "unknown", readiness: "not-installed" };
  }
  async listModels(): Promise<Awaited<ReturnType<ProviderAdapter["listModels"]>>> {
    return [];
  }
  async startSession(input: Parameters<ProviderAdapter["startSession"]>[0]): Promise<Awaited<ReturnType<ProviderAdapter["startSession"]>>> {
    return { threadId: input.threadId, provider: input.provider, cwd: input.cwd, status: "ready" };
  }
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async stopAll(): Promise<void> {}
  async respondToRequest(): Promise<void> {}
  async respondToUserInput(): Promise<Awaited<ReturnType<ProviderAdapter["respondToUserInput"]>>> {
    return { owned: false };
  }
  async listSessions(): Promise<Awaited<ReturnType<ProviderAdapter["listSessions"]>>> {
    return [];
  }
  async hasSession(): Promise<boolean> {
    return true;
  }
  async sendTurn(input: { threadId: string; input: string }): Promise<{ threadId: string; turnId: string }> {
    this.sent.push(input.input);
    return { threadId: input.threadId, turnId: `t-${this.sent.length}` };
  }
}

function build(adapter: Adapter): Service {
  return new AgentService({
    store,
    historyStore: store,
    continuationStore: store,
    checkpointStore: null,
    retentionSweepMs: 0,
    stopTotalTimeoutMs: 60,
    adapters: (emit) => {
      adapter.emit = emit;
      return [adapter];
    },
  });
}

/** The events one service announced, so a test can assert on the ones a list
 *  needs (the limit mark, the snooze) rather than on the store alone. */
function capture(service: Service): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  service.onEvent((event) => events.push(event));
  return events;
}

beforeEach(() => {
  // Every test starts from the shipped defaults: a fresh settings file, no
  // cached envelope.
  rmSync(path.join(dir, "provider-settings.json"), { force: true });
  setUserDataDir(dir);
  resetProviderSettingsForTests();
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("resumeAtReset", () => {
  test("off: the thread is marked limited but no resume is scheduled", async () => {
    const id = "toggle-resume-off";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    const events = capture(svc);
    patchProviderSettings("codex", { resumeAtReset: false });
    const resetAt = Date.now() + 60_000;

    svc.setThreadLimited(id, resetAt);

    const meta = store.threadMeta(id);
    expect(meta?.limitedAt ?? null).not.toBeNull();
    expect(meta?.limitResetAt).toBe(resetAt);
    expect(events.some((event) => event.type === "thread.limit.updated")).toBe(true);
    expect(store.listContinuationsForThread(id)).toEqual([]);
    await svc.stopAll();
  });

  test("on by default: the thread is marked limited and the resume is scheduled", async () => {
    const id = "toggle-resume-default";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    const resetAt = Date.now() + 60_000;

    svc.setThreadLimited(id, resetAt);

    const rows = store.listContinuationsForThread(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("limit-reset");
    expect(rows[0]?.dueAt).toBe(resetAt);
    await svc.stopAll();
  });

  test("turned off while a resume is pending: the sweep drops the row without sending", async () => {
    const id = "toggle-resume-due-off";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    const dispatcher = initThreadDispatcher({ service: svc, store, broadcast: () => {} });
    // Scheduled while the toggle was on, then switched off before it is due.
    svc.setThreadLimited(id, Date.now() + 60_000);
    expect(store.listContinuationsForThread(id)).toHaveLength(1);
    patchProviderSettings("codex", { resumeAtReset: false });
    // Bring the pending row due now so this sweep is the one that meets it.
    store.cancelContinuationsForThread(id);
    store.scheduleContinuation({ threadId: id, kind: "limit-reset", dueAt: 0 });

    await dispatcher.dispatchDueContinuations();

    expect(adapter.sent).toEqual([]);
    expect(store.listContinuationsForThread(id)).toEqual([]);
    await svc.stopAll();
  });

  test("turned back on while a resume is pending: the sweep sends it", async () => {
    const id = "toggle-resume-due-on";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    const dispatcher = initThreadDispatcher({ service: svc, store, broadcast: () => {} });
    patchProviderSettings("codex", { resumeAtReset: false });
    svc.setThreadLimited(id, Date.now() + 60_000);
    store.scheduleContinuation({ threadId: id, kind: "limit-reset", dueAt: 0 });
    patchProviderSettings("codex", { resumeAtReset: true });

    await dispatcher.dispatchDueContinuations();

    expect(adapter.sent.some((text) => text.includes("usage limit has reset"))).toBe(true);
    expect(store.listContinuationsForThread(id)).toEqual([]);
    await svc.stopAll();
  });
});

describe("snoozeWhenLimited", () => {
  test("on: a limit with a future reset snoozes the thread until the reset", async () => {
    const id = "toggle-snooze-on";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    const events = capture(svc);
    patchProviderSettings("codex", { snoozeWhenLimited: true });
    const resetAt = Date.now() + 60_000;

    svc.setThreadLimited(id, resetAt);

    expect(store.threadMeta(id)?.snoozedUntil).toBe(resetAt);
    const snoozed = events.find((event) => event.type === "thread.snooze.updated");
    expect(snoozed).toMatchObject({ threadId: id, snoozedUntil: resetAt });
    await svc.stopAll();
  });

  test("on with no reset: nothing to wait for, so no snooze", async () => {
    const id = "toggle-snooze-no-reset";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    const events = capture(svc);
    patchProviderSettings("codex", { snoozeWhenLimited: true });

    svc.setThreadLimited(id, null);

    expect(store.threadMeta(id)?.limitedAt ?? null).not.toBeNull();
    expect(store.threadMeta(id)?.snoozedUntil ?? null).toBeNull();
    expect(events.some((event) => event.type === "thread.snooze.updated")).toBe(false);
    await svc.stopAll();
  });

  test("off by default: a limit with a reset is not snoozed", async () => {
    const id = "toggle-snooze-default";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);

    svc.setThreadLimited(id, Date.now() + 60_000);

    expect(store.threadMeta(id)?.snoozedUntil ?? null).toBeNull();
    await svc.stopAll();
  });
});

describe("a thread that fell back to another provider", () => {
  // The thread was started on Claude, then routed to Codex, which hit the
  // limit: Codex's toggles apply, not the original provider's.
  test("the limiting provider's toggles decide the snooze and the resume", async () => {
    const id = "toggle-fallback-limit";
    store.ensureThread({ threadId: id, provider: "claudeAgent", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    patchProviderSettings("codex", { resumeAtReset: false, snoozeWhenLimited: true });
    const resetAt = Date.now() + 60_000;

    svc.setThreadLimited(id, resetAt, "codex");

    expect(store.threadMeta(id)?.snoozedUntil).toBe(resetAt);
    expect(store.listContinuationsForThread(id)).toEqual([]);
    await svc.stopAll();
  });

  test("the due-time recheck reads the limiting provider's resumeAtReset", async () => {
    const id = "toggle-fallback-due";
    store.ensureThread({ threadId: id, provider: "claudeAgent", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    const dispatcher = initThreadDispatcher({ service: svc, store, broadcast: () => {} });
    svc.setThreadLimited(id, Date.now() + 60_000, "codex");
    const [row] = store.listContinuationsForThread(id);
    expect(row).toBeDefined();
    patchProviderSettings("codex", { resumeAtReset: false });
    // Bring the pending row due now, keeping what it recorded.
    store.cancelContinuationsForThread(id);
    store.scheduleContinuation({ threadId: id, kind: "limit-reset", dueAt: 0, payloadJson: row?.payloadJson });

    await dispatcher.dispatchDueContinuations();

    expect(adapter.sent).toEqual([]);
    expect(store.listContinuationsForThread(id)).toEqual([]);
    await svc.stopAll();
  });
});

describe("provider settings through the service", () => {
  test("a patch of both toggles is what the snapshot reads back", async () => {
    const adapter = new Adapter();
    const svc = build(adapter);

    const snapshot = svc.patchProviderSettings("codex", {
      resumeAtReset: false,
      snoozeWhenLimited: true,
    });

    expect(snapshot.settings.codex).toMatchObject({
      resumeAtReset: false,
      snoozeWhenLimited: true,
    });
    expect(svc.getProviderSettingsSnapshot().settings.codex).toMatchObject({
      resumeAtReset: false,
      snoozeWhenLimited: true,
    });
    await svc.stopAll();
  });
});

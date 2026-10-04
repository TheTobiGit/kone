import { describe, expect, test } from "bun:test";
import { effectScope, nextTick, ref } from "vue";

import { useAgentInbox, type AgentInboxBridge } from "./useAgentInbox";
import type { InboxEntry, RuntimeEvent } from "~/types/desktop";

function entry(over: Partial<InboxEntry> = {}): InboxEntry {
  return {
    inboxId: "msg_1",
    kind: "note",
    urgent: false,
    rings: false,
    state: "unseen",
    sender: { kind: "agent", threadId: "s", name: "Ada", relationship: "peer" },
    body: "hello",
    replyTo: null,
    answers: null,
    createdAt: 1,
    seenAt: null,
    seenVia: null,
    turnId: null,
    ...over,
  };
}

function fakeBridge(inboxes: Record<string, { waiting: InboxEntry[]; seen: InboxEntry[] }>) {
  let listener: ((event: RuntimeEvent) => void) | null = null;
  const reads: string[] = [];
  const bridge: AgentInboxBridge = {
    inboxList: (id) => {
      reads.push(id);
      return Promise.resolve(inboxes[id]?.waiting ?? []);
    },
    inboxHistory: (id) => Promise.resolve(inboxes[id]?.seen ?? []),
    onEvent: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
  return {
    bridge,
    reads,
    attached: () => listener !== null,
    changed: (threadId: string) =>
      listener?.({ type: "thread.inbox-changed", threadId, provider: "codex", at: 0, source: "kone.store" }),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const afterBurst = () => new Promise((resolve) => setTimeout(resolve, 150));

describe("useAgentInbox", () => {
  test("reads what waits and what was seen for the thread", async () => {
    const fake = fakeBridge({ t: { waiting: [entry()], seen: [entry({ inboxId: "msg_0", state: "seen" })] } });
    const scope = effectScope();
    const inbox = scope.run(() => useAgentInbox(ref("t"), () => fake.bridge))!;
    await settle();

    expect(inbox.loaded.value).toBe(true);
    expect(inbox.waiting.value.map((e) => e.inboxId)).toEqual(["msg_1"]);
    expect(inbox.seen.value.map((e) => e.inboxId)).toEqual(["msg_0"]);
    scope.stop();
  });

  test("re-reads once per burst of changes to its own thread, never for another", async () => {
    const fake = fakeBridge({ t: { waiting: [], seen: [] } });
    const scope = effectScope();
    scope.run(() => useAgentInbox(ref("t"), () => fake.bridge));
    await settle();
    expect(fake.reads).toEqual(["t"]);

    fake.changed("other");
    fake.changed("t");
    fake.changed("t");
    await afterBurst();
    expect(fake.reads).toEqual(["t", "t"]);
    scope.stop();
  });

  test("follows the thread, and a slow read for the old one does not land", async () => {
    let release: (rows: InboxEntry[]) => void = () => {};
    const fake = fakeBridge({ b: { waiting: [entry({ inboxId: "msg_b" })], seen: [] } });
    const slow: AgentInboxBridge = {
      ...fake.bridge,
      inboxList: (id) =>
        id === "a" ? new Promise<InboxEntry[]>((resolve) => (release = resolve)) : fake.bridge.inboxList(id),
    };
    const threadId = ref("a");
    const scope = effectScope();
    const inbox = scope.run(() => useAgentInbox(threadId, () => slow))!;
    threadId.value = "b";
    await nextTick();
    await settle();
    release([entry({ inboxId: "msg_a" })]);
    await settle();

    expect(inbox.waiting.value.map((e) => e.inboxId)).toEqual(["msg_b"]);
    scope.stop();
  });

  test("a failed read says so and keeps what it had", async () => {
    const fake = fakeBridge({ t: { waiting: [entry()], seen: [] } });
    let fail = false;
    const flaky: AgentInboxBridge = {
      ...fake.bridge,
      inboxList: (id) => (fail ? Promise.reject(new Error("store closed")) : fake.bridge.inboxList(id)),
    };
    const scope = effectScope();
    const inbox = scope.run(() => useAgentInbox(ref("t"), () => flaky))!;
    await settle();
    fail = true;
    await inbox.refresh();

    expect(inbox.error.value).toContain("store closed");
    expect(inbox.waiting.value).toHaveLength(1);
    scope.stop();
  });

  test("stops listening when its scope ends", async () => {
    const fake = fakeBridge({});
    const scope = effectScope();
    scope.run(() => useAgentInbox(ref("t"), () => fake.bridge));
    expect(fake.attached()).toBe(true);
    scope.stop();
    expect(fake.attached()).toBe(false);
  });
});

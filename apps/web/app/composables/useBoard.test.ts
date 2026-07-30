import { describe, expect, test } from "bun:test";
import { nextTick, ref, shallowRef } from "vue";
import type { Ref } from "vue";
import { useBoard } from "./useBoard";

// Minimal fakes for the three composables useBoard wraps. useBoard only ever
// touches the surface used here (the `.sessions` list + a few async stubs), so
// these stand in without pulling the real agent/terminal/scratchpad runtimes.

interface FakeThread {
  key: string;
  threadId: Ref<string | null>;
  blocks: Ref<unknown[]>;
  busy: Ref<boolean>;
  provider: Ref<string>;
  title: Ref<string>;
  error: Ref<unknown>;
}

function makeThread(key: string, threadId: string | null = null): FakeThread {
  return {
    key,
    threadId: ref(threadId),
    blocks: ref([]),
    busy: ref(false),
    provider: ref("codex"),
    title: ref(""),
    error: ref(null),
  };
}

function harness() {
  // shallowRef: like the real composables' session lists, so the nested `.value`
  // refs on a session (threadId, busy, …) aren't auto-unwrapped by deep reactivity.
  const agentSessions = shallowRef<FakeThread[]>([]);
  const termSessions = shallowRef<unknown[]>([]);
  const padSessions = shallowRef<unknown[]>([]);

  const agent = {
    sessions: agentSessions,
    activeKey: ref<string | null>(null),
    openThread: async () => {},
    newThreadAt: async () => {},
    closeThread: async (k: string) => {
      agentSessions.value = agentSessions.value.filter((s) => s.key !== k);
    },
    focusThread: () => {},
  };
  const terminal = { sessions: termSessions, spawn: async () => "", close: async () => {} };
  const scratchpad = {
    sessions: padSessions,
    open: async () => "",
    close: async () => {},
    append: async () => {},
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const board = useBoard({ agent, terminal, scratchpad } as any);
  return { board, agentSessions };
}

async function settle() {
  await nextTick();
  await nextTick();
}

describe("useBoard — eviction goes dormant, not deleted (B)", () => {
  test("a thread evicted after it has a threadId survives dormant", async () => {
    const { board, agentSessions } = harness();

    // The session lands and the board adopts it.
    const t = makeThread("t1");
    agentSessions.value = [t];
    await settle();
    expect(board.entries.value.length).toBe(1);

    // Its first turn mints a real thread id; syncAnchors writes it onto the entry.
    t.threadId.value = "thread-real-id";
    await settle();

    // useAgent evicts the idle background session (past MAX_RESIDENT).
    agentSessions.value = [];
    await settle();

    // The entry stays — dormant (no session), anchor remembers the id to re-open.
    expect(board.entries.value.length).toBe(1);
    const entry = board.entries.value[0]!;
    expect(entry.kind).toBe("thread");
    expect(entry.anchor.kind === "thread" && entry.anchor.threadId).toBe("thread-real-id");
    const pane = board.panes.value[0]!;
    expect(pane.session).toBeNull();
  });

  test("a blank thread evicted before it ever sent is removed", async () => {
    const { board, agentSessions } = harness();

    const t = makeThread("t2"); // threadId stays null — never sent a turn
    agentSessions.value = [t];
    await settle();
    expect(board.entries.value.length).toBe(1);

    agentSessions.value = [];
    await settle();

    // Nothing to re-attach to → the entry is gone, not left as a dead pane.
    expect(board.entries.value.length).toBe(0);
  });
});

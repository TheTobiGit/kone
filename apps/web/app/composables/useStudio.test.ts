import { describe, expect, test } from "bun:test";
import { nextTick, ref, shallowRef } from "vue";
import type { Ref } from "vue";
import { useStudio } from "./useStudio";

// Minimal fakes for the three composables useStudio wraps. useStudio only ever
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
  isSideChat?: Ref<boolean>;
  sideChatSource?: Ref<string | null>;
}

function makeThread(
  key: string,
  threadId: string | null = null,
  sideChatSource: string | null = null,
): FakeThread {
  return {
    key,
    threadId: ref(threadId),
    blocks: ref([]),
    busy: ref(false),
    provider: ref("codex"),
    title: ref(""),
    error: ref(null),
    isSideChat: ref(Boolean(sideChatSource)),
    sideChatSource: ref(sideChatSource),
  };
}

function harness() {
  // shallowRef: like the real composables' session lists, so the nested `.value`
  // refs on a session (threadId, busy, …) aren't auto-unwrapped by deep reactivity.
  const agentSessions = shallowRef<FakeThread[]>([]);
  const termSessions = shallowRef<Array<{ key: string; terminalId: string }>>([]);
  const padSessions = shallowRef<unknown[]>([]);
  const closedTerminalKeys: string[] = [];

  const agent = {
    sessions: agentSessions,
    activeKey: ref<string | null>(null),
    // Mirrors the real registry: the column exists (and its key is knowable) the
    // moment you ask for it, while the transcript load resolves separately. The
    // studio relies on exactly that split to bind a pane before its history lands.
    openThreadHandle: (threadId: string) => {
      const found = agentSessions.value.find((s) => s.threadId.value === threadId);
      if (found) return { key: found.key, ready: Promise.resolve() };
      const t = makeThread(`thread-${agentSessions.value.length + 1}`, threadId);
      // The real openStored adopts the stored transcript synchronously and only
      // defers the CLI spawn, so the session is non-blank the instant it exists.
      // That matters here: persistableThreadId treats a blank session as an
      // unsaved slate and would null out the pane's anchor.
      t.blocks.value = [{ role: "user", text: "stored" }];
      agentSessions.value = [...agentSessions.value, t];
      return { key: t.key, ready: nextTick() };
    },
    openThread: async (threadId: string) => {
      await agent.openThreadHandle(threadId).ready;
    },
    newThreadAt: async (index: number) => {
      const t = makeThread(`thread-${agentSessions.value.length + 1}`);
      const list = [...agentSessions.value];
      list.splice(Math.min(index, list.length), 0, t);
      agentSessions.value = list;
      return t.key;
    },
    closeThread: async (k: string) => {
      agentSessions.value = agentSessions.value.filter((s) => s.key !== k);
    },
    focusThread: () => {},
  };
  let termSeq = 0;
  const terminal = {
    sessions: termSessions,
    spawn: async () => {
      termSeq += 1;
      const key = `term-${termSeq}`;
      termSessions.value = [...termSessions.value, { key, terminalId: key }];
      // The real spawn awaits the PTY bridge *after* pushing its session, so the
      // reconcile watcher gets a chance to run while the caller is still mid-attach
      // and hasn't recorded the mapping yet. Yield here so the fake has that same
      // window — it's what the "attach never conjures a second column" test needs.
      await nextTick();
      return key;
    },
    close: async (k: string) => {
      closedTerminalKeys.push(k);
      termSessions.value = termSessions.value.filter((s) => s.key !== k);
    },
  };
  const scratchpad = {
    sessions: padSessions,
    open: async () => {
      const key = "pad-1";
      padSessions.value = [{ key, scratchpadId: key }];
      return key;
    },
    close: async () => {},
    append: async () => {},
  };

  // SAFETY: these three fakes implement exactly the agent/terminal/scratchpad
  // surface useStudio touches; the cast supplies the rest of the deps shape the
  // tests never exercise.
  const studio = useStudio({ agent, terminal, scratchpad, projectPath: "/p" } as any);
  return { studio, agentSessions, termSessions, padSessions, closedTerminalKeys };
}

async function settle() {
  await nextTick();
  await nextTick();
}

describe("useStudio — eviction goes dormant, not deleted (B)", () => {
  test("a thread evicted after it has a threadId survives dormant", async () => {
    const { studio, agentSessions } = harness();

    // The session lands and the studio adopts it.
    const t = makeThread("t1");
    agentSessions.value = [t];
    await settle();
    expect(studio.entries.value.length).toBe(1);

    // Its first turn mints a real thread id AND lands a transcript block;
    // syncAnchors writes the id onto the entry (a real conversation, not a blank
    // slate that merely carries a client-minted id).
    t.threadId.value = "thread-real-id";
    t.blocks.value = [{ role: "user" }];
    await settle();

    // useAgent evicts the idle background session (past MAX_RESIDENT).
    agentSessions.value = [];
    await settle();

    // The entry stays — dormant (no session), anchor remembers the id to re-open.
    expect(studio.entries.value.length).toBe(1);
    const entry = studio.entries.value[0]!;
    expect(entry.kind).toBe("thread");
    expect(entry.anchor.kind === "thread" && entry.anchor.threadId).toBe("thread-real-id");
    const pane = studio.panes.value[0]!;
    expect(pane.session).toBeNull();
  });

  test("a blank thread evicted before it ever sent is removed", async () => {
    const { studio, agentSessions } = harness();

    const t = makeThread("t2"); // threadId stays null — never sent a turn
    agentSessions.value = [t];
    await settle();
    expect(studio.entries.value.length).toBe(1);

    agentSessions.value = [];
    await settle();

    // Nothing to re-attach to → the entry is gone, not left as a dead pane.
    expect(studio.entries.value.length).toBe(0);
  });

  test("a blank thread carrying a client id is not persisted as a real one", async () => {
    const { studio, agentSessions } = harness();

    // A session that already has its client-minted id (as every ThreadSession
    // does from construction) but no transcript — the blank slate the composer
    // shows before you send. It must NOT persist that id, or it comes back as an
    // empty column on relaunch.
    const t = makeThread("t3", "client-uid");
    agentSessions.value = [t];
    await settle();

    const layout = studio.serialize();
    expect(layout.panes.length).toBe(1);
    expect(layout.panes[0]!.anchor.kind === "thread" && layout.panes[0]!.anchor.threadId).toBe(
      null,
    );

    // Once it actually runs a turn (transcript lands), its id becomes worth keeping.
    t.blocks.value = [{ role: "user" }];
    await settle();
    const after = studio.serialize();
    expect(after.panes[0]!.anchor.kind === "thread" && after.panes[0]!.anchor.threadId).toBe(
      "client-uid",
    );
  });
});

describe("useStudio — restore drops phantom thread panes", () => {
  test("a stored thread id with no live conversation behind it is dropped", async () => {
    const { studio } = harness();

    const layout = {
      projectPath: "/p",
      panes: [
        { id: "p1", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: "real-1" }, width: 0 },
        { id: "p2", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: "phantom-2" }, width: 0 },
      ],
      focusedId: "p1",
    };

    // Only "real-1" is a persisted conversation; "phantom-2" is a blank thread
    // that was saved before the guard existed.
    await studio.restore(layout, new Set(["real-1"]));

    expect(studio.entries.value.length).toBe(1);
    const entry = studio.entries.value[0]!;
    expect(entry.anchor.kind === "thread" && entry.anchor.threadId).toBe("real-1");
  });

  test("without a known-id set (no bridge) every stored thread is kept", async () => {
    const { studio } = harness();

    const layout = {
      projectPath: "/p",
      panes: [
        { id: "p1", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: "a" }, width: 0 },
        { id: "p2", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: "b" }, width: 0 },
      ],
      focusedId: "p1",
    };

    await studio.restore(layout);
    expect(studio.entries.value.length).toBe(2);
  });

  test("a layout with two panes for one thread keeps only the leftmost", async () => {
    const { studio } = harness();

    // Written by the duplicate-pane bug: the same conversation persisted twice.
    // The first (leftmost) pane keeps its id, width and focus; the twin is
    // dropped so it can't resurrect as a second column on every relaunch.
    const layout = {
      projectPath: "/p",
      panes: [
        { id: "p1", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: "dup-1" }, width: 2 },
        { id: "p2", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: "dup-1" }, width: 0 },
      ],
      focusedId: "p2",
    };

    await studio.restore(layout, new Set(["dup-1"]));

    expect(studio.entries.value.length).toBe(1);
    expect(studio.entries.value[0]!.id).toBe("p1");
    expect(studio.entries.value[0]!.width).toBe(2);
    // Focus fell back to the surviving pane rather than pointing at a dropped one.
    expect(studio.focusedId.value).toBe("p1");
  });

  test("a phantom duplicate never shadows the real pane", async () => {
    const { studio } = harness();

    // First pane's id is unknown (phantom — dropped by the known-id filter);
    // the second pane is the real conversation. The dedup must not let the
    // phantom consume the "seen" slot and drop the real one.
    const layout = {
      projectPath: "/p",
      panes: [
        { id: "p1", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: "gone-1" }, width: 0 },
        { id: "p2", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: "real-1" }, width: 1 },
      ],
      focusedId: "p2",
    };

    await studio.restore(layout, new Set(["real-1"]));

    expect(studio.entries.value.length).toBe(1);
    expect(studio.entries.value[0]!.id).toBe("p2");
    expect(studio.entries.value[0]!.anchor).toEqual({ kind: "thread", threadId: "real-1" });
  });
});

describe("useStudio — a threadless studio stays threadless", () => {
  test("restoring a terminal-only layout disposes the boot thread and claims the studio", async () => {
    const { studio, agentSessions, termSessions } = harness();

    // useAgent spawns one blank thread at construction; the studio adopts it.
    agentSessions.value = [makeThread("boot")];
    await settle();
    expect(studio.entries.value.length).toBe(1);

    const handled = await studio.restore({
      projectPath: "/p",
      panes: [
        { id: "p1", kind: "terminal" as const, anchor: { kind: "terminal" as const, terminalId: "t-1" }, width: 0 },
      ],
      focusedId: "p1",
    });
    await settle();

    // handled → the caller must skip agent.start(); the blank boot session is
    // gone, so reconcile has nothing to adopt as a surprise empty column.
    expect(handled).toBe(true);
    expect(agentSessions.value.length).toBe(0);
    expect(studio.entries.value.map((e) => e.kind)).toEqual(["terminal"]);
    expect(termSessions.value.length).toBe(1);
  });

  test("closing the last thread beside a terminal does not re-add an empty thread", async () => {
    const { studio, agentSessions } = harness();

    agentSessions.value = [makeThread("boot")];
    await settle();
    const threadPane = studio.entries.value[0]!.id;

    await studio.open("terminal");
    await settle();
    expect(studio.entries.value.length).toBe(2);

    await studio.close(threadPane);
    await settle();

    // Just the terminal. The old useAgent "strip is never empty" respawn is what
    // used to put a blank thread column straight back.
    expect(agentSessions.value.length).toBe(0);
    expect(studio.entries.value.map((e) => e.kind)).toEqual(["terminal"]);
  });

  test("closing every window leaves a bare desktop", async () => {
    const { studio, agentSessions } = harness();

    agentSessions.value = [makeThread("boot")];
    await settle();
    await studio.open("terminal");
    await settle();

    for (const id of studio.entries.value.map((e) => e.id)) await studio.close(id);
    await settle();

    // Zero panes, and nothing respawns to fill the gap.
    expect(studio.entries.value.length).toBe(0);
    expect(studio.focusedId.value).toBeNull();
    expect(agentSessions.value.length).toBe(0);
  });

  test("a saved empty desktop restores empty rather than booting a thread", async () => {
    const { studio, agentSessions } = harness();

    agentSessions.value = [makeThread("boot")];
    await settle();

    const handled = await studio.restore({ projectPath: "/p", panes: [], focusedId: null });
    await settle();

    expect(handled).toBe(true);
    expect(studio.entries.value.length).toBe(0);
    expect(agentSessions.value.length).toBe(0);
  });

  test("a layout whose panes are all phantoms is not applied", async () => {
    const { studio, agentSessions } = harness();

    agentSessions.value = [makeThread("boot")];
    await settle();

    // Stored a thread that no longer has a conversation behind it — nothing to
    // show, so restore declines to take over the studio.
    const handled = await studio.restore(
      {
        projectPath: "/p",
        panes: [
          { id: "p1", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: "gone" }, width: 0 },
        ],
        focusedId: "p1",
      },
      new Set<string>(),
    );

    expect(handled).toBe(false);
    // The boot thread is untouched — the studio never took over.
    expect(agentSessions.value.length).toBe(1);
  });
});

describe("useStudio — blank thread slot restore (W7 / L6)", () => {
  test("one blank thread slot survives restore at its index; a second is dropped", async () => {
    const { studio } = harness();

    const layout = {
      projectPath: "/p",
      panes: [
        { id: "p-blank", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: null }, width: 0 },
        { id: "p-term", kind: "terminal" as const, anchor: { kind: "terminal" as const, terminalId: null }, width: 1 },
        { id: "p-blank2", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: null }, width: 0 },
      ],
      focusedId: "p-term",
    };

    await studio.restore(layout);
    await settle();

    expect(studio.entries.value.map((e) => e.id)).toEqual(["p-blank", "p-term"]);
    expect(studio.entries.value[0]!.anchor).toEqual({ kind: "thread", threadId: null });
    expect(studio.focusedId.value).toBe("p-term");
  });

  test("a layout of only blank thread slots is a legitimate restore", async () => {
    const { studio, agentSessions } = harness();

    agentSessions.value = [makeThread("boot")];
    await settle();

    const handled = await studio.restore({
      projectPath: "/p",
      panes: [
        { id: "p1", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: null }, width: 0 },
      ],
      focusedId: "p1",
    });
    await settle();

    expect(handled).toBe(true);
    expect(studio.entries.value.length).toBe(1);
    expect(studio.entries.value[0]!.anchor).toEqual({ kind: "thread", threadId: null });
  });
});

describe("useStudio — studio laws", () => {
  test("L3: open(thread) twice with a blank thread present reuses the blank column", async () => {
    const { studio } = harness();

    await studio.open("thread");
    await settle();
    const firstId = studio.entries.value[0]!.id;

    await studio.open("thread");
    await settle();

    expect(studio.entries.value.length).toBe(1);
    expect(studio.focusedId.value).toBe(firstId);
  });

  test("L3: open(thread) reuses a restored DORMANT blank slot, not a second column", async () => {
    const { studio } = harness();

    // Project-home open: the saved blank column restores dormant (deferHeavyAttach
    // leaves it un-attached, session === null). This is the case that used to slip
    // past blank suppression and land the home with two empty threads.
    await studio.restore(
      {
        projectPath: "/p",
        panes: [
          { id: "p-blank", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: null }, width: 0 },
        ],
        focusedId: "p-blank",
      },
      undefined,
      { deferHeavyAttach: true },
    );
    await settle();
    expect(studio.entries.value.length).toBe(1);
    expect(studio.panes.value[0]!.session).toBeNull(); // dormant

    // Creating a new thread must reuse that slot (attaching it), never stack a
    // second blank column.
    await studio.open("thread");
    await settle();

    expect(studio.entries.value.length).toBe(1);
    expect(studio.entries.value[0]!.id).toBe("p-blank");
    expect(studio.panes.value[0]!.session).not.toBeNull(); // reused → now live
  });

  test("L3: open(thread, { threadId }) always creates a second column", async () => {
    const { studio } = harness();

    await studio.open("thread");
    await settle();
    await studio.open("thread", { threadId: "real-1" });
    await settle();

    expect(studio.entries.value.length).toBe(2);
    expect(studio.entries.value[1]!.anchor).toEqual({ kind: "thread", threadId: "real-1" });
  });

  test("L3: open(thread, { threadId }) of an already-hosted thread focuses its pane (one pane per thread)", async () => {
    const { studio } = harness();

    await studio.open("thread", { threadId: "side-1" });
    await settle();
    const firstId = studio.entries.value[0]!.id;
    const firstAnchor = studio.entries.value[0]!.anchor;

    // The same thread (the side-chat join path) must not mint a second column —
    // it focuses the pane that already hosts it.
    const again = await studio.open("thread", { threadId: "side-1", near: firstId });
    await settle();

    expect(studio.entries.value.length).toBe(1);
    expect(again).toBe(firstId);
    expect(studio.focusedId.value).toBe(firstId);
    expect(firstAnchor).toEqual({ kind: "thread", threadId: "side-1" });
  });

  test("L3: open(thread, { threadId }) re-opens a CLOSED thread as a fresh column", async () => {
    const { studio } = harness();

    await studio.open("thread", { threadId: "side-1" });
    await settle();
    const firstId = studio.entries.value[0]!.id;
    await studio.close(firstId);
    await settle();
    expect(studio.entries.value.length).toBe(0);

    // Once its pane is gone the thread is no longer hosted — reopening mints a
    // new column bound to the same thread.
    const again = await studio.open("thread", { threadId: "side-1" });
    await settle();
    expect(studio.entries.value.length).toBe(1);
    expect(again).not.toBe(firstId);
    expect(studio.entries.value[0]!.anchor).toEqual({ kind: "thread", threadId: "side-1" });
  });

  test("L4: open(terminal) lands immediately right of the focused column", async () => {
    const { studio } = harness();

    await studio.open("thread");
    await settle();
    await studio.open("terminal");
    await settle();
    await studio.open("scratchpad");
    await settle();

    const terminalId = studio.entries.value[1]!.id;
    studio.focus(terminalId);
    await studio.open("terminal");
    await settle();

    expect(studio.entries.value.map((e) => e.kind)).toEqual([
      "thread",
      "terminal",
      "terminal",
      "scratchpad",
    ]);
  });

  test("L4: adopted sessions land right of focus, not at the strip end", async () => {
    const { studio, agentSessions } = harness();

    const boot = makeThread("boot");
    agentSessions.value = [boot];
    await settle();
    await studio.open("terminal");
    await settle();
    await studio.open("scratchpad");
    await settle();

    const terminalId = studio.entries.value[1]!.id;
    studio.focus(terminalId);

    const adopted = makeThread("adopted", "real-1");
    adopted.blocks.value = [{ role: "user" }];
    agentSessions.value = [...agentSessions.value, adopted];
    await settle();

    expect(studio.entries.value.map((e) => e.kind)).toEqual([
      "thread",
      "terminal",
      "thread",
      "scratchpad",
    ]);
    const adoptedPane = studio.panes.value[2];
    expect(adoptedPane?.kind).toBe("thread");
    if (adoptedPane?.kind === "thread") {
      expect(adoptedPane.session).toMatchObject({ key: "adopted" });
      expect(adoptedPane.session?.threadId.value).toBe("real-1");
    }
  });

  test("L5: closing a terminal tears down its session and leaves other panes", async () => {
    const { studio, termSessions, closedTerminalKeys } = harness();

    await studio.open("terminal");
    await settle();
    await studio.open("terminal");
    await settle();
    const middleId = studio.entries.value[0]!.id;
    const middleKey = termSessions.value[0]!.key;

    await studio.close(middleId);
    await settle();

    expect(studio.entries.value.length).toBe(1);
    expect(closedTerminalKeys).toEqual([middleKey]);
    expect(termSessions.value.length).toBe(1);
  });

  test("W6: serialize writes terminalId null for terminal panes", async () => {
    const { studio } = harness();

    await studio.open("terminal");
    await settle();

    const layout = studio.serialize();
    expect(layout.panes[0]!.anchor).toEqual({ kind: "terminal", terminalId: null });
  });

  test("L6: restore round-trip preserves order, widths, and focus", async () => {
    const { studio } = harness();

    await studio.restore({
      projectPath: "/p",
      panes: [
        { id: "p1", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: "real-1" }, width: 1 },
        { id: "p2", kind: "terminal" as const, anchor: { kind: "terminal" as const, terminalId: null }, width: 0 },
        { id: "p3", kind: "scratchpad" as const, anchor: { kind: "scratchpad" as const, scratchpadId: null }, width: 2 },
      ],
      focusedId: "p2",
    });
    await settle();

    const roundTrip = studio.serialize();
    expect(roundTrip.panes.map((p) => p.kind)).toEqual(["thread", "terminal", "scratchpad"]);
    expect(roundTrip.panes.map((p) => p.width)).toEqual([1, 0, 2]);
    expect(roundTrip.focusedId).toBe("p2");
  });

  test("restore attaches every stored thread, not only the focused one", async () => {
    const { studio } = harness();

    await studio.restore({
      projectPath: "/p",
      panes: [
        { id: "p1", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: "real-1" }, width: 0 },
        { id: "p2", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: "real-2" }, width: 0 },
      ],
      focusedId: "p1",
    });
    await settle();

    expect(studio.panes.value.map((p) => p.session !== null)).toEqual([true, true]);
    expect(studio.entries.value.map((e) => e.id)).toEqual(["p1", "p2"]);
  });

  test("wakeThreadPanes attaches dormant threads after a deferred restore", async () => {
    const { studio } = harness();

    await studio.restore(
      {
        projectPath: "/p",
        panes: [
          { id: "p1", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: "real-1" }, width: 0 },
          { id: "p2", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: "real-2" }, width: 0 },
        ],
        focusedId: "p1",
      },
      undefined,
      { deferHeavyAttach: true },
    );
    await settle();
    expect(studio.panes.value.every((p) => p.session === null)).toBe(true);

    await studio.wakeThreadPanes();
    await settle();

    expect(studio.panes.value.map((p) => p.session !== null)).toEqual([true, true]);
    expect(studio.focusedId.value).toBe("p1");
  });
});

describe("useStudio — attach never conjures a second column", () => {
  // The bug: every backend spawn pushes its session into the registry *before* its
  // own await resolves, so the reconcile watcher fires mid-attach, sees a live
  // session no pane has claimed yet, and adopts it into a brand-new pane. Focusing
  // one restored terminal therefore produced two columns — and closing a terminal
  // focuses a neighbour, which is why "close one, click another" kept conjuring a
  // third. attach() runs inside mutate() so reconcile can't observe the half-state.
  test("focusing a dormant terminal attaches it in place, no extra pane", async () => {
    const { studio, termSessions } = harness();

    await studio.restore({
      projectPath: "/p",
      panes: [
        { id: "p1", kind: "terminal" as const, anchor: { kind: "terminal" as const, terminalId: null }, width: 0 },
        { id: "p2", kind: "terminal" as const, anchor: { kind: "terminal" as const, terminalId: null }, width: 0 },
      ],
      focusedId: "p1",
    });
    await settle();

    // p1 attached on restore (it's focused); p2 is dormant until it's focused.
    expect(studio.entries.value.length).toBe(2);
    expect(termSessions.value.length).toBe(1);

    studio.focus("p2");
    await settle();

    expect(studio.entries.value.map((e) => e.id)).toEqual(["p1", "p2"]);
    expect(termSessions.value.length).toBe(2);
    expect(studio.panes.value.every((p) => p.session !== null)).toBe(true);
  });

  test("closing a terminal and focusing the survivor spawns nothing new", async () => {
    const { studio, termSessions, closedTerminalKeys } = harness();

    await studio.restore({
      projectPath: "/p",
      panes: [
        { id: "p1", kind: "terminal" as const, anchor: { kind: "terminal" as const, terminalId: null }, width: 0 },
        { id: "p2", kind: "terminal" as const, anchor: { kind: "terminal" as const, terminalId: null }, width: 0 },
      ],
      focusedId: "p1",
    });
    await settle();
    studio.focus("p2");
    await settle();
    expect(termSessions.value.length).toBe(2);

    // Close the focused one: focus hands off to the neighbour, whose session is
    // already live, so nothing may spawn and the PTY that left must be torn down.
    const closing = studio.panes.value.find((p) => p.id === "p2")!;
    // SAFETY: every session kind the studio attaches carries a stable string
    // `key` (the entry↔session matching contract), and this harness's
    // terminal sessions are no exception.
    const closingKey = closing.session ? (closing.session as { key: string }).key : "";
    await studio.close("p2");
    await settle();

    expect(studio.entries.value.map((e) => e.id)).toEqual(["p1"]);
    expect(closedTerminalKeys).toEqual([closingKey]);
    expect(termSessions.value.length).toBe(1);
    expect(studio.focusedId.value).toBe("p1");
  });
});

describe("useStudio — one pane per thread, however it arrives", () => {
  // The bug: agent.openThread() called from outside studio.open() (recent click,
  // shell reveal, launcher resume) spawns a session the studio only knows how to
  // adopt as a brand-new pane. A dormant pane whose anchor remembers the same
  // threadId was invisible to ADOPT, so the studio ended up with two columns for
  // one conversation. Reconcile must re-attach the dormant pane in place.
  test("an outside openThread for a dormant thread re-attaches its pane, no second column", async () => {
    const { studio, agentSessions } = harness();

    // A real conversation lands and the studio adopts it.
    const t1 = makeThread("t1", "thread-real-id");
    t1.blocks.value = [{ role: "user" }];
    agentSessions.value = [t1];
    await settle();
    const paneId = studio.entries.value[0]!.id;
    studio.setWidth(paneId, 2);

    // Eviction (pruneResident) strands a dormant pane whose anchor remembers id.
    agentSessions.value = [];
    await settle();
    expect(studio.entries.value.length).toBe(1);
    expect(studio.panes.value[0]!.session).toBeNull();

    // The recent-session click path: agent.openThread spawns a fresh session for
    // the same threadId — reconcile must claim the dormant pane, not mint.
    const t2 = makeThread("t2", "thread-real-id");
    t2.blocks.value = [{ role: "user" }];
    agentSessions.value = [t2];
    await settle();

    expect(studio.entries.value.length).toBe(1);
    expect(studio.entries.value[0]!.id).toBe(paneId);
    expect(studio.entries.value[0]!.width).toBe(2);
    const pane = studio.panes.value[0]!;
    expect(pane.session).toMatchObject({ key: "t2" });
  });

  test("a background re-attach does not steal focus from the focused pane", async () => {
    const { studio, agentSessions, termSessions } = harness();

    // Thread (later evicted → dormant) + a focused terminal.
    const t = makeThread("t1", "bg-1");
    t.blocks.value = [{ role: "user" }];
    agentSessions.value = [t];
    await settle();
    await studio.open("terminal");
    await settle();
    const terminalId = studio.entries.value[1]!.id;
    studio.focus(terminalId);
    agentSessions.value = [];
    await settle();

    // The thread re-opens from outside the studio while the terminal is focused.
    const t2 = makeThread("t2", "bg-1");
    t2.blocks.value = [{ role: "user" }];
    agentSessions.value = [t2];
    await settle();

    expect(studio.entries.value.length).toBe(2);
    expect(studio.entries.value[0]!.anchor).toEqual({ kind: "thread", threadId: "bg-1" });
    expect(studio.panes.value[0]!.session).toMatchObject({ key: "t2" });
    // Focus stays on the terminal — background adoptions never steal it.
    expect(studio.focusedId.value).toBe(terminalId);
    expect(termSessions.value.length).toBe(1);
  });

  test("restore re-attaches a live unclaimed session to its stored pane", async () => {
    const { studio, agentSessions } = harness();

    // The session was opened outside the studio before restore (launcher resume),
    // so it carries a real transcript and survives G6's blank-sweep.
    const t = makeThread("live", "resume-1");
    t.blocks.value = [{ role: "user" }];
    agentSessions.value = [t];
    await settle();

    // The saved layout remembers the same thread as a pane; deferHeavyAttach
    // leaves it dormant, so the trailing reconcile must re-attach the live
    // session to it — one pane, in its saved spot.
    await studio.restore(
      {
        projectPath: "/p",
        panes: [
          { id: "p1", kind: "thread" as const, anchor: { kind: "thread" as const, threadId: "resume-1" }, width: 3 },
          { id: "p2", kind: "terminal" as const, anchor: { kind: "terminal" as const, terminalId: null }, width: 0 },
        ],
        focusedId: "p2",
      },
      new Set(["resume-1"]),
      { deferHeavyAttach: true },
    );
    await settle();

    expect(studio.entries.value.length).toBe(2);
    expect(studio.entries.value[0]!.id).toBe("p1");
    expect(studio.entries.value[0]!.width).toBe(3);
    expect(studio.panes.value[0]!.session).toMatchObject({ key: "live" });
    expect(studio.focusedId.value).toBe("p2");
  });

  test("a duplicate session for an already-live thread never mints a second pane", async () => {
    const { studio, agentSessions } = harness();

    const t1 = makeThread("t1", "dup-1");
    t1.blocks.value = [{ role: "user" }];
    agentSessions.value = [t1];
    await settle();
    expect(studio.entries.value.length).toBe(1);

    // Degenerate state (a second session claiming the same id) — the studio must
    // not render a second column for it; the pane already hosts that thread.
    const t2 = makeThread("t2", "dup-1");
    t2.blocks.value = [{ role: "user" }];
    agentSessions.value = [...agentSessions.value, t2];
    await settle();

    expect(studio.entries.value.length).toBe(1);
  });

  test("concurrent open(thread, { threadId }) calls fold into one pane", async () => {
    const { studio } = harness();

    // Two opens in the same tick (double click, join racing resume): both pass
    // the pre-mutation dedup, but the in-lock re-check must fold the loser into
    // the winner's pane instead of minting a duplicate.
    const [a, b] = await Promise.all([
      studio.open("thread", { threadId: "race-1" }),
      studio.open("thread", { threadId: "race-1" }),
    ]);
    await settle();

    expect(a).toBe(b);
    expect(studio.entries.value.length).toBe(1);
    expect(studio.entries.value[0]!.anchor).toEqual({ kind: "thread", threadId: "race-1" });
    expect(studio.focusedId.value).toBe(a);
  });

  test("concurrent blank open(thread) calls still mint one column", async () => {
    const { studio } = harness();

    const [a, b] = await Promise.all([studio.open("thread"), studio.open("thread")]);
    await settle();

    expect(a).toBe(b);
    expect(studio.entries.value.length).toBe(1);
  });
});

describe("useStudio — side chat clustering and strip order", () => {
  test("opening a new pane while focused on a main chat with side chats places the new pane after the side chats", async () => {
    const { studio, agentSessions } = harness();

    // Set up main thread and two side chats
    const mainThread = makeThread("main-session", "main-1");
    mainThread.blocks.value = [{ role: "user" }];
    const side1 = makeThread("side1-session", "side-1", "main-1");
    side1.blocks.value = [{ role: "user" }];
    const side2 = makeThread("side2-session", "side-2", "main-1");
    side2.blocks.value = [{ role: "user" }];

    agentSessions.value = [mainThread];
    await settle();
    const mainPaneId = studio.entries.value[0]!.id;

    // Open side chats near the main thread
    agentSessions.value = [mainThread, side1];
    const s1Id = await studio.open("thread", { threadId: "side-1", near: mainPaneId, sideChatSource: "main-1" });
    agentSessions.value = [mainThread, side1, side2];
    const s2Id = await studio.open("thread", { threadId: "side-2", near: mainPaneId, sideChatSource: "main-1" });
    await settle();

    expect(studio.entries.value.map((e) => e.id)).toEqual([mainPaneId, s1Id, s2Id]);

    // Focus main thread and open a terminal (e.g. keyboard shortcut)
    studio.focus(mainPaneId);
    const termId = await studio.open("terminal");
    await settle();

    // Terminal must land AFTER both side chats, not between main and side chats
    expect(studio.entries.value.map((e) => e.id)).toEqual([mainPaneId, s1Id, s2Id, termId]);
  });

  test("opening a new pane while focused on a side chat places the new pane after all side chats of the cluster", async () => {
    const { studio, agentSessions } = harness();

    const mainThread = makeThread("main-session", "main-1");
    mainThread.blocks.value = [{ role: "user" }];
    const side1 = makeThread("side1-session", "side-1", "main-1");
    side1.blocks.value = [{ role: "user" }];
    const side2 = makeThread("side2-session", "side-2", "main-1");
    side2.blocks.value = [{ role: "user" }];

    agentSessions.value = [mainThread, side1, side2];
    const mainPaneId = await studio.open("thread", { threadId: "main-1" });
    const s1Id = await studio.open("thread", { threadId: "side-1", near: mainPaneId, sideChatSource: "main-1" });
    const s2Id = await studio.open("thread", { threadId: "side-2", near: mainPaneId, sideChatSource: "main-1" });
    await settle();

    // Focus the first side chat and open a terminal
    studio.focus(s1Id);
    const termId = await studio.open("terminal");
    await settle();

    expect(studio.entries.value.map((e) => e.id)).toEqual([mainPaneId, s1Id, s2Id, termId]);
  });

  test("opening a second side chat off the main thread places it after existing side chats", async () => {
    const { studio, agentSessions } = harness();

    const mainThread = makeThread("main-session", "main-1");
    mainThread.blocks.value = [{ role: "user" }];
    const side1 = makeThread("side1-session", "side-1", "main-1");
    side1.blocks.value = [{ role: "user" }];
    const side2 = makeThread("side2-session", "side-2", "main-1");
    side2.blocks.value = [{ role: "user" }];

    agentSessions.value = [mainThread, side1, side2];
    const mainPaneId = await studio.open("thread", { threadId: "main-1" });
    const s1Id = await studio.open("thread", { threadId: "side-1", near: mainPaneId, sideChatSource: "main-1" });
    const s2Id = await studio.open("thread", { threadId: "side-2", near: mainPaneId, sideChatSource: "main-1" });
    await settle();

    expect(studio.entries.value.map((e) => e.id)).toEqual([mainPaneId, s1Id, s2Id]);
  });

  test("moving a main thread moves its side chats with it as an atomic cluster", async () => {
    const { studio, agentSessions } = harness();

    const leftTerm = await studio.open("terminal");
    const mainThread = makeThread("main-session", "main-1");
    mainThread.blocks.value = [{ role: "user" }];
    const side1 = makeThread("side1-session", "side-1", "main-1");
    side1.blocks.value = [{ role: "user" }];

    agentSessions.value = [mainThread, side1];
    await settle();
    const mainPaneId = studio.entries.value.find(
      (e) => e.anchor.kind === "thread" && e.anchor.threadId === "main-1",
    )!.id;
    const s1Id = studio.entries.value.find(
      (e) => e.anchor.kind === "thread" && e.anchor.threadId === "side-1",
    )!.id;
    studio.focus(s1Id);
    const rightTerm = await studio.open("terminal");
    await settle();

    expect(studio.entries.value.map((e) => e.id)).toEqual([leftTerm, mainPaneId, s1Id, rightTerm]);

    // Move main thread right: the cluster [mainPaneId, s1Id] moves past rightTerm
    studio.move(mainPaneId, 1);
    expect(studio.entries.value.map((e) => e.id)).toEqual([leftTerm, rightTerm, mainPaneId, s1Id]);

    // Move main thread left: the cluster moves back past rightTerm
    studio.move(mainPaneId, -1);
    expect(studio.entries.value.map((e) => e.id)).toEqual([leftTerm, mainPaneId, s1Id, rightTerm]);

    // Move leftTerm right: it jumps past the entire cluster [mainPaneId, s1Id]
    studio.move(leftTerm, 1);
    expect(studio.entries.value.map((e) => e.id)).toEqual([mainPaneId, s1Id, leftTerm, rightTerm]);
  });

  test("reordering sibling side chats moves within the cluster", async () => {
    const { studio, agentSessions } = harness();

    const mainThread = makeThread("main-session", "main-1");
    mainThread.blocks.value = [{ role: "user" }];
    const side1 = makeThread("side1-session", "side-1", "main-1");
    side1.blocks.value = [{ role: "user" }];
    const side2 = makeThread("side2-session", "side-2", "main-1");
    side2.blocks.value = [{ role: "user" }];

    agentSessions.value = [mainThread, side1, side2];
    const mainPaneId = await studio.open("thread", { threadId: "main-1" });
    const s1Id = await studio.open("thread", { threadId: "side-1", near: mainPaneId, sideChatSource: "main-1" });
    const s2Id = await studio.open("thread", { threadId: "side-2", near: mainPaneId, sideChatSource: "main-1" });
    await settle();

    expect(studio.entries.value.map((e) => e.id)).toEqual([mainPaneId, s1Id, s2Id]);

    // Move s1 right: swaps s1 and s2
    studio.move(s1Id, 1);
    expect(studio.entries.value.map((e) => e.id)).toEqual([mainPaneId, s2Id, s1Id]);

    // Move s1 left: swaps back
    studio.move(s1Id, -1);
    expect(studio.entries.value.map((e) => e.id)).toEqual([mainPaneId, s1Id, s2Id]);
  });
});

import { describe, expect, it } from "bun:test";
import { computed, ref } from "vue";
import type { ThreadSession } from "~/composables/useAgent";
import type { PendingApproval, PendingUserInput } from "~/composables/agentTypes";
import type { Pane } from "~/types/studio";
import { describePane, threadViewStatus } from "./viewPanes";

/** The slice of a session describePane reads, with a live one's defaults. */
function liveDefaults() {
  return {
    threadId: ref("th-1"),
    title: ref("Fix titles"),
    provider: ref("claudeAgent"),
    model: ref("opus"),
    blocks: ref([{ id: "b1" }]),
    busy: computed(() => false),
    unstarted: computed(() => false),
    error: ref<string | null>(null),
    sessionState: ref("ready"),
    session: ref({}),
    pendingApproval: computed<PendingApproval | null>(() => null),
    pendingUserInput: ref<PendingUserInput | null>(null),
    isSideChat: computed(() => false),
    worktreePath: ref<string | null>(null),
    queuedTurns: ref<object[]>([]),
  };
}

function session(over: Partial<ReturnType<typeof liveDefaults>> = {}): ThreadSession {
  // SAFETY: the helpers under test read only the members liveDefaults names.
  // eslint-disable-next-line anti-slop/no-chained-type-assertions
  return { ...liveDefaults(), ...over } as unknown as ThreadSession;
}

function threadPane(s: ThreadSession | null, over: Partial<Pane["entry"]> = {}): Pane {
  return {
    id: "p1",
    kind: "thread",
    session: s,
    entry: { id: "p1", kind: "thread", anchor: { kind: "thread", threadId: "th-1" }, width: 1, ...over },
  };
}

describe("threadViewStatus", () => {
  it("ranks a parked thread above a working one", () => {
    const parked = session({
      busy: computed(() => true),
      pendingApproval: computed<PendingApproval | null>(() => ({
        requestId: "r",
        approval: { kind: "command", title: "rm -rf dist" },
      })),
    });
    expect(threadViewStatus(parked)).toBe("waiting-for-approval");
    expect(threadViewStatus(session({ busy: computed(() => true) }))).toBe("working");
  });

  it("reads a failed and a never-started thread", () => {
    expect(threadViewStatus(session({ error: ref("boom") }))).toBe("failed");
    expect(threadViewStatus(session({ unstarted: computed(() => true) }))).toBe("not-started");
    expect(threadViewStatus(session())).toBe("idle");
  });
});

describe("describePane", () => {
  it("describes a live thread column with what it is waiting on", () => {
    const s = session({
      pendingUserInput: ref<PendingUserInput | null>({
        requestId: "q",
        questions: [{ id: "a", header: "", question: "Which branch?", options: [] }],
      }),
      queuedTurns: ref<object[]>([{}, {}]),
      worktreePath: ref("/wt/1"),
    });
    expect(describePane(threadPane(s), "p1")).toEqual({
      kind: "thread",
      focused: true,
      threadId: "th-1",
      title: "Fix titles",
      status: "waiting-for-user-input",
      provider: "claudeAgent",
      model: "opus",
      worktree: "/wt/1",
      queued: 2,
      waitingOn: { kind: "question", summary: "Which branch?" },
    });
  });

  it("describes a dormant column by the thread it will reattach to", () => {
    expect(describePane(threadPane(null, { zen: true }), "other")).toEqual({
      kind: "thread",
      focused: false,
      zen: true,
      threadId: "th-1",
      title: "",
      status: "dormant",
    });
  });

  it("describes a blank thread column as one with nothing in it", () => {
    const blank = session({ blocks: ref([]) });
    expect(describePane(threadPane(blank), "p1")).toMatchObject({ threadId: null, status: "not-started" });
  });

  it("describes a terminal with what is running in it", () => {
    const pane: Pane = {
      id: "p2",
      kind: "terminal",
      entry: { id: "p2", kind: "terminal", anchor: { kind: "terminal", terminalId: "pty-1" }, width: 1 },
      // SAFETY: describePane reads only these fields of a terminal session.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      session: {
        terminalId: "pty-1",
        cwd: "/home/u/kone",
        status: "ready",
        hasRunningSubprocess: true,
        childCommandLabel: "bun dev",
      } as unknown as Extract<Pane, { kind: "terminal" }>["session"],
    };
    expect(describePane(pane, "p2")).toEqual({
      kind: "terminal",
      focused: true,
      terminalId: "pty-1",
      cwd: "/home/u/kone",
      status: "ready",
      running: "bun dev",
    });
  });
});

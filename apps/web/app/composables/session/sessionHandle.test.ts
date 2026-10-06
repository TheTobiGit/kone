import { describe, expect, test } from "bun:test";
import { ref, shallowRef } from "vue";
import type { ProviderKind, Session } from "~/types/desktop";
import { useSessionHandle, type ResumeStage } from "./sessionHandle";

function handleOn(provider: ProviderKind, conversationId?: string) {
  const live: Session = { threadId: "t", provider, cwd: "/tmp", status: "ready", mode: "ask" };
  if (conversationId) live.conversationId = conversationId;
  const session = shallowRef<Session | null>(live);
  const deferred = ref(false);
  const staged: ResumeStage[] = [];
  const handle = useSessionHandle({
    session,
    deferred,
    isForgotten: () => false,
    stageResume: (stage) => void staged.push(stage),
  });
  /** Put a new session on the thread, as start() or a hand-in does. */
  const takeOn = (next: ProviderKind, id?: string): void => {
    const taken: Session = { threadId: "t", provider: next, cwd: "/tmp", status: "ready", mode: "ask" };
    if (id) taken.conversationId = id;
    session.value = taken;
    deferred.value = false;
  };
  return { handle, session, deferred, staged, takeOn };
}

describe("the conversation a session resumes", () => {
  test("is the one its own session reported", () => {
    const { handle, staged, deferred } = handleOn("claudeAgent");
    handle.noteRefs("claudeAgent", { conversationId: "conv-1", resumeSessionAt: "uuid-1" });

    handle.exited();

    expect(staged).toEqual([{ resumeId: "conv-1", provider: "claudeAgent", resumeSessionAt: "uuid-1" }]);
    expect(deferred.value).toBe(true);
  });

  test("is never another provider's", () => {
    const { handle, staged, takeOn } = handleOn("codex");
    handle.noteRefs("codex", { conversationId: "codex-conv" });

    // Handed in place to Claude, whose session has not reported yet.
    takeOn("claudeAgent");
    handle.exited();

    // Staged, Claude would have been asked to resume a Codex thread id.
    expect(staged).toEqual([]);
  });

  test("ignores what a session the thread moved off still says", () => {
    const { handle, staged } = handleOn("claudeAgent");
    handle.noteRefs("claudeAgent", { conversationId: "claude-conv", resumeSessionAt: "claude-cursor" });

    handle.noteRefs("codex", { conversationId: "codex-conv", resumeSessionAt: "codex-cursor" });
    handle.exited();

    expect(staged).toEqual([{ resumeId: "claude-conv", provider: "claudeAgent", resumeSessionAt: "claude-cursor" }]);
  });

  test("never carries the last session's cursor onto the next", () => {
    const { handle, staged, takeOn } = handleOn("claudeAgent");
    handle.noteRefs("claudeAgent", { conversationId: "conv-1", resumeSessionAt: "uuid-1" });
    handle.exited();

    // The next session on the same provider — another model, or a fresh
    // conversation — comes up and ends before it reports anything.
    takeOn("claudeAgent", "conv-2");
    handle.exited();

    expect(staged.at(-1)).toEqual({ resumeId: "conv-2", provider: "claudeAgent" });
  });
});

describe("a hand-in", () => {
  test("leaves the session it adopted started", () => {
    const { handle, deferred, staged, session } = handleOn("codex", "codex-conv");
    handle.beginHandIn();

    // The desktop side stops the old session on the way.
    handle.exited();
    const target: Session = { threadId: "t", provider: "claudeAgent", cwd: "/tmp", status: "ready", mode: "ask" };
    handle.adoptHandIn(target);

    // Left deferred, the next send's ensureStarted() started a second session
    // over the one the hand-in had just brought up.
    expect(deferred.value).toBe(false);
    expect(session.value).toBe(target);
    // Its stop is the swap, not a session to resume.
    expect(staged).toEqual([]);
  });

  test("that fails after stopping the old session leaves the next send to start one", () => {
    const { handle, deferred, session } = handleOn("codex", "codex-conv");
    handle.beginHandIn();
    handle.exited();

    handle.handInFailed();

    expect(session.value).toBeNull();
    expect(deferred.value).toBe(true);
  });

  test("that fails before stopping anything keeps the live session", () => {
    const { handle, deferred, session } = handleOn("codex", "codex-conv");
    handle.beginHandIn();

    handle.handInFailed();

    expect(session.value).not.toBeNull();
    expect(deferred.value).toBe(false);
  });
});

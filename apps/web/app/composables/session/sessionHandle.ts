import type { Ref } from "vue";
import type { ProviderKind, RuntimeEvent, Session } from "~/types/desktop";

// The thread's hold on its live provider session, past start(): which
// conversation that session is in, so it can be resumed once the session is
// gone, and whether an exit is that session's at all. Everything here is
// about the one session the thread is on — what an earlier session said, or
// one on another provider, is never carried onto it.

/** A conversation for the next start() to resume, and the provider it
 *  belongs to — a resume id means nothing to any other. */
export type ResumeStage = {
  resumeId: string;
  provider: ProviderKind;
  /** Claude's cursor into the conversation; absent for other providers. */
  resumeSessionAt?: string;
};

export type SessionHandleDeps = {
  session: Ref<Session | null>;
  deferred: Ref<boolean>;
  /** Whether the thread was let go (dispose): nothing restarts it. */
  isForgotten: () => boolean;
  stageResume: (stage: ResumeStage) => void;
};

type SessionExited = Extract<RuntimeEvent, { type: "session.exited" }>;

export function useSessionHandle(deps: SessionHandleDeps) {
  /** What the session's events said about its conversation, and which
   *  provider said it. A session reports its conversation once it is up, so
   *  the id start() was handed back can be missing (a fresh conversation) or
   *  stale; this is the freshest. */
  let reported: { provider: ProviderKind; conversationId?: string; resumeSessionAt?: string } | null = null;
  /** A hand-in is swapping the session out from under the thread: the old
   *  one's exit is the swap, not a session to bring back. Whether that exit
   *  has been seen yet, too — a hand-in that fails after it left the thread
   *  with no session. */
  let handIn: { oldExited: boolean } | null = null;

  /** An event's envelope named the conversation or Claude's cursor into it.
   *  Kept only for the provider the thread is on: another's is a session the
   *  thread has moved off. */
  function noteRefs(
    provider: ProviderKind,
    refs: { conversationId?: string; resumeSessionAt?: string },
  ): void {
    const live = deps.session.value;
    if (live && live.provider !== provider) return;
    if (reported?.provider !== provider) reported = { provider };
    if (refs.conversationId) reported.conversationId = refs.conversationId;
    if (refs.resumeSessionAt) reported.resumeSessionAt = refs.resumeSessionAt;
  }

  /** A new session is coming up: nothing the last one said is its. */
  function forgetConversation(): void {
    reported = null;
  }

  /** What `live` reported about its conversation, when it was the one that
   *  reported it. */
  function reportedFor(live: Session): typeof reported {
    return reported?.provider === live.provider ? reported : null;
  }

  /** Whether an exit is the live session's. One from another provider, or
   *  naming a conversation other than the one this session reported, is a
   *  session the thread has since moved off — late, or stopped in a hand-in —
   *  and the live one is still up. With no session here, any exit is news. */
  function ownsExit(event: SessionExited): boolean {
    const live = deps.session.value;
    if (!live) return true;
    if (event.provider !== live.provider) return false;
    const ours = reportedFor(live)?.conversationId ?? live.conversationId;
    const theirs = event.refs?.conversationId;
    return !ours || !theirs || ours === theirs;
  }

  /** Stage the live session's conversation so the next start() resumes it
   *  instead of minting a blank one. Claude's cursor rides along only when it
   *  came from the same session as the id. */
  function restageResume(live: Session): void {
    const own = reportedFor(live);
    const resumeId = own?.conversationId ?? live.conversationId;
    if (!resumeId) return;
    const stage: ResumeStage = { resumeId, provider: live.provider };
    if (own?.resumeSessionAt) stage.resumeSessionAt = own.resumeSessionAt;
    deps.stageResume(stage);
  }

  /** The live session ended. A stop this side asked for — hibernate,
   *  dispose, a restart — drops the session itself; this is for the one that
   *  died on its own, which left the thread looking started, so the next send
   *  went to a session nothing would answer from. Re-armed the way hibernate()
   *  leaves it: the next send starts a session that resumes the conversation. */
  function exited(): void {
    const live = deps.session.value;
    if (handIn) handIn.oldExited = true;
    else if (live && !deps.isForgotten()) {
      restageResume(live);
      deps.session.value = null;
      deps.deferred.value = true;
    }
    forgetConversation();
  }

  /** A hand-in is about to stop the live session and start the target's. */
  function beginHandIn(): void {
    handIn = { oldExited: false };
  }

  /** The hand-in's session is up — started by the desktop side, so the
   *  thread is started: nothing is left for the next send to start. */
  function adoptHandIn(next: Session): void {
    handIn = null;
    deps.session.value = next;
    deps.deferred.value = false;
  }

  /** The hand-in broke. Once the old session was stopped, the thread has none
   *  and the next send starts one; short of that, the old one is still up. */
  function handInFailed(): void {
    const oldExited = handIn?.oldExited ?? false;
    handIn = null;
    if (!oldExited || deps.isForgotten()) return;
    deps.session.value = null;
    deps.deferred.value = true;
  }

  return {
    noteRefs,
    forgetConversation,
    ownsExit,
    restageResume,
    exited,
    beginHandIn,
    adoptHandIn,
    handInFailed,
  };
}

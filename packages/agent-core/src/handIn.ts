import { getConversationStore } from "./ConversationStore.js";
import type {
  HandInInput,
  HandInRecord,
  HandInResult,
  ProviderKind,
  Session,
  SessionStartInput,
} from "./types.js";

// Thread hand-in — the same conversation, in new hands.
//
// A handoff mints a NEW thread seeded with the old one's transcript: two
// threads, one past. A hand-in performs the same context transfer without the
// new thread. The kone thread id, its title, its blocks, its workspace and its
// place in the project all survive; only the provider session underneath is
// replaced, and the thread simply carries on.
//
// The three durable consequences, all in ConversationStore:
//   1. `thread_hand_ins` gains a row naming what the thread was handed from
//      and to, so the timeline can mark the boundary. `threads.provider` is
//      only the CURRENT owner from here on — the rows are the rest.
//   2. That same write clears `conversation_id` / `resume_session_at`. They
//      name a conversation inside the OLD provider; handing them to the new
//      one would ask it to resume something it has never had.
//   3. The row starts `bootstrap_status = 'pending'`, which is what makes the
//      next turn replay the prior transcript into the fresh session
//      (sidechat.ts reads it, the turn's settle consumes it). The transcript
//      serializer is the fork/handoff one — a hand-in replays exactly the
//      history a handoff would have imported, it just replays it into the
//      thread it is already in.

export const HAND_IN_INTRO = "This conversation has just changed hands to you.";
export const HAND_IN_BOUNDARY_INSTRUCTION =
  "Continue this conversation from the transcript below. Treat it as settled history — what was actually said and done in this same conversation before you took it over — and carry on the same task. Answer the latest user message directly, building on that history.";

/** The message an overlong first turn after a hand-in is rejected with. The
 *  prior history rides that turn, so a message leaving no room for it cannot
 *  run — rejected up front rather than silently dropping the history. */
export const HAND_IN_MESSAGE_TOO_LONG =
  "This message is too long to include the conversation's prior history. Shorten the message and retry.";

/** Whether a thread can change hands, and if not, why. The renderer disables
 *  the control on these; `handInThread` enforces them. */
export function handInEligibility(
  threadId: string,
  target: { provider: ProviderKind; model?: string },
): { ok: true } | { ok: false; reason: string } {
  const store = getConversationStore();
  const meta = store.threadMeta(threadId);
  if (!meta) return { ok: false, reason: `Hand-in thread not found: ${threadId}` };
  const currentModel = meta.model?.trim() ? meta.model : undefined;
  const targetModel = target.model?.trim() ? target.model : undefined;
  // A hand-in to the hands the thread is already in is a no-op that would
  // still cost a session restart and leave a marker saying nothing changed.
  if (target.provider === meta.provider && targetModel === currentModel) {
    return { ok: false, reason: "Select a different provider or model to hand this thread to" };
  }
  return { ok: true };
}

/** The session lifecycle a hand-in drives, narrowed to the two calls it makes
 *  so the operation can be exercised without a live provider layer.
 *  AgentService satisfies it structurally. */
export interface HandInSessions {
  stopSession(threadId: string): Promise<void>;
  startSession(input: SessionStartInput): Promise<Session>;
}

/**
 * Hand a live thread to another provider/model without leaving it.
 *
 * Stop-first, so the thread is never owned by two provider sessions at once:
 * the outgoing session is disposed, the record is written (which retargets
 * the thread row and drops the old provider's resume ids), and only then does
 * a session for the target provider start against the SAME thread id. The
 * prior transcript reaches the new session as the next turn's one-shot
 * bootstrap rather than as a start-time argument, because that is the one
 * moment every adapter can be handed text: as a turn.
 *
 * Throws on an unknown thread, an ineligible target (see handInEligibility),
 * or a failed record write. A failure to start the new session propagates
 * with the record already written — the thread's stored owner is the target
 * either way, so reopening it starts the session that could not start here,
 * rather than silently routing the next turn back to a provider that no
 * longer holds the conversation.
 */
export async function handInThread(
  sessions: HandInSessions,
  input: HandInInput,
): Promise<HandInResult> {
  if (!input.threadId || !input.target?.provider) {
    throw new Error("hand-in requires threadId and target.provider");
  }
  const store = getConversationStore();
  const meta = store.threadMeta(input.threadId);
  if (!meta) throw new Error(`Hand-in thread not found: ${input.threadId}`);
  const eligible = handInEligibility(input.threadId, input.target);
  if (!eligible.ok) throw new Error(eligible.reason);

  const fromProvider = meta.provider;
  const fromModel = meta.model?.trim() ? meta.model : undefined;
  const toModel = input.target.model?.trim() ? input.target.model : undefined;

  // Dispose first. A stop that throws must not leave a retargeted thread
  // behind a still-running old session, so nothing is written until the old
  // hands have let go.
  await sessions.stopSession(input.threadId);

  const write: Parameters<typeof store.writeHandIn>[0] = {
    threadId: input.threadId,
    fromProvider,
    toProvider: input.target.provider,
    at: Date.now(),
  };
  if (fromModel) write.fromModel = fromModel;
  if (toModel) write.toModel = toModel;
  const record: HandInRecord | null = store.writeHandIn(write);
  if (!record) throw new Error(`Could not record hand-in for thread: ${input.threadId}`);

  const start: SessionStartInput = {
    threadId: input.threadId,
    provider: input.target.provider,
    cwd: meta.projectPath,
  };
  if (toModel) start.model = toModel;
  // The thread's own selection stands in for anything the caller left open.
  // Interaction mode especially: providers that must be launched with their
  // permission posture (Claude takes it as a spawn flag) cannot be talked into
  // it afterwards, so a hand-in that dropped the mode would come up locked out
  // of the posture the thread is actually running under.
  const effort = input.target.effort ?? meta.selection?.effort;
  const mode = input.target.mode ?? meta.selection?.mode;
  if (effort) start.effort = effort;
  if (mode) start.mode = mode;
  const session = await sessions.startSession(start);

  return { threadId: input.threadId, record, session };
}

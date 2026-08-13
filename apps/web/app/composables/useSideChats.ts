import type { CreateSideChatResult, CreateSideChatTarget } from "~/types/desktop";

// Side chat creation, renderer side (docs/side-chat-design.md §5). The desktop
// IPC channel (`agent:create-side-chat`) is one-shot and idempotent on the
// minted thread id; this module adds the *user-path* semantics on top of it:
//
// - client-minted ids: the renderer mints threadId + requestId (kone owns
//   thread ids), so a replayed dispatch resolves "exists" instead of forking
//   twice;
// - in-flight join: rapid repeat calls keyed by the source thread join the
//   same flight instead of dispatching a second fork;
// - promptTail: extra prompts queue on the tail (deduped by text) and dispatch
//   once creation settles.
//
// The UI owns panes and sessions; this module only guarantees the fork happens
// exactly once and the queued prompts reach it.

/** A flight in progress for one source thread. `creation` settles once the
 *  fork row exists; `promptTail` chains the queued prompts after it. */
type SideChatFlight = {
  creation: Promise<{ threadId: string; status: "created" | "exists" }>;
  submittedPrompts: Set<string>;
  promptTail: Promise<void>;
};

const flights = new Map<string, SideChatFlight>();

function uid(): string {
  return "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

export type SideChatCreationOptions = {
  /** The thread the side chat forks from. */
  sourceThreadId: string;
  /** Optional prompt to send once the fork exists (queued after creation
   *  settles; deduped by trimmed text against the flight's other prompts). */
  prompt?: string;
  /** Optional title override (default: `Sidechat: <seed>`). */
  title?: string;
  /** Target provider/model/effort/mode. Absent fields inherit the source
   *  thread. */
  target?: CreateSideChatTarget;
  /** Dispatch a prompt to the child's session once creation settles. The UI
   *  wires this to the side chat session's send — for useAgent that is the
   *  deferred-start path, so the session (and the bootstrap) come up on this
   *  first send. Defaults to a no-op when only the fork is wanted (the user
   *  types into the child's composer). */
  sendPrompt?: (threadId: string, prompt: string) => Promise<void> | void;
  /** Error surface for a queued prompt's send failure. */
  onPromptError?: (error: unknown, prompt: string) => void;
};

export type SideChatCreationResult = {
  /** The side chat's thread id (stable across joins and replays). */
  threadId: string;
  /** `"created"` on the flight that wrote the fork, `"exists"` on a join or a
   *  replay of an already-created id. */
  status: "created" | "exists";
  /** True when this call joined an in-flight creation instead of starting one. */
  joined: boolean;
};

/** Create (or join) a side chat for a source thread — the user path. Calling
 *  this twice rapidly for the same source yields one fork; the second call
 *  resolves with the same thread id once the first settles. Prompts queue on
 *  the flight's tail, deduped by trimmed text, and dispatch in order after
 *  creation. */
export async function createOrJoinSidechat(
  options: SideChatCreationOptions,
): Promise<SideChatCreationResult> {
  const { sourceThreadId, prompt, title, target, sendPrompt, onPromptError } = options;
  const trimmed = prompt?.trim();
  const api = window.koneDesktop?.agent;
  const dispatch = sendPrompt ?? (() => {});

  const existing = flights.get(sourceThreadId);
  if (existing) {
    if (trimmed && !existing.submittedPrompts.has(trimmed)) {
      existing.submittedPrompts.add(trimmed);
      existing.promptTail = existing.promptTail.then(() =>
        dispatchPrompt(existing.creation, trimmed, dispatch, onPromptError),
      );
    }
    const result = await existing.creation;
    return { ...result, joined: true };
  }

  const threadId = uid();
  const requestId = uid();
  const creation = (async (): Promise<{ threadId: string; status: "created" | "exists" }> => {
    if (!api) {
      // Browser dev has no bridge — the flight still resolves so the join
      // semantics hold, but no fork exists on any disk.
      return { threadId, status: "created" };
    }
    const result: CreateSideChatResult = await api.createSideChat({
      requestId,
      threadId,
      sourceThreadId,
      ...(trimmed ? { prompt: trimmed } : {}),
      ...(title ? { title } : {}),
      ...(target ? { target } : {}),
    });
    return { threadId: result.threadId, status: result.status };
  })();

  // Queue the first prompt on the tail like any other — everything dispatches
  // in order once the fork row exists.
  const submitted = new Set<string>();
  let tail: Promise<void> = Promise.resolve();
  if (trimmed) {
    submitted.add(trimmed);
    tail = tail.then(() => dispatchPrompt(creation, trimmed, dispatch, onPromptError));
  }
  const flight: SideChatFlight = { creation, submittedPrompts: submitted, promptTail: tail };
  flights.set(sourceThreadId, flight);

  try {
    const result = await creation;
    return { ...result, joined: false };
  } finally {
    // Drop the flight once creation settles and its tail has drained, so the
    // next call after a settle starts a fresh flight.
    const settled = await flight.promptTail.catch(() => {});
    void settled;
    if (flights.get(sourceThreadId) === flight) flights.delete(sourceThreadId);
  }
}

/** Send one queued prompt to the created side chat, surfacing failures on the
 *  flight's error callback. */
async function dispatchPrompt(
  creation: Promise<{ threadId: string; status: string }>,
  prompt: string,
  sendPrompt: (threadId: string, prompt: string) => Promise<void> | void,
  onPromptError?: (error: unknown, prompt: string) => void,
): Promise<void> {
  const { threadId } = await creation;
  try {
    await sendPrompt(threadId, prompt);
  } catch (error) {
    onPromptError?.(error, prompt);
  }
}

import { randomUUID } from "node:crypto";
import type { EmitEvent, ProviderKind, RuntimeEvent, UserInputAnswers, UserInputQuestion } from "./types.js";

export type UserQuestionRequest = {
  threadId: string;
  turnId: string;
  provider: ProviderKind;
  cwd: string;
  questions: UserInputQuestion[];
  signal?: AbortSignal;
};

type UserInputRequested = Extract<RuntimeEvent, { type: "user-input.requested" }>;

type QueuedQuestion = {
  /** The ask, as emitted once it heads its thread's queue. */
  requested: UserInputRequested;
  /** Emitted: only a shown ask's resolution is news to anybody. */
  shown: boolean;
  /** Kone's own tool call, waiting on the answer. A provider's ask has none:
   *  its adapter resolves it and reports that with its own event. */
  tool?: { resolve: (answers: UserInputAnswers) => void; removeAbort: () => void };
};

/** Every question a thread puts to the user, whoever asks it: Kone's blocking
 *  question tool and each provider's own user-input request. One shows per
 *  thread; the rest wait behind it in the order they were asked, so nothing
 *  downstream ever holds more than one, and none waits on an answer nobody
 *  can see. Kone's own calls resolve here; a provider's resolve in its
 *  adapter, whose resolution passes through `admit`. */
export class UserQuestionRequests {
  /** Provider request IDs are scoped to their thread, not globally unique. */
  private readonly pending = new Map<string, Map<string, QueuedQuestion>>();

  constructor(private readonly emit: EmitEvent) {}

  /** The gateway awaits this; answering resolves the tool call, never a send. */
  ask(request: UserQuestionRequest): Promise<UserInputAnswers> {
    if (request.signal?.aborted) return Promise.resolve({});
    const { threadId, turnId, provider, questions, signal } = request;
    const requestId = `question:${randomUUID()}`;
    return new Promise((resolve) => {
      const abort = () => this.respond(threadId, requestId, {});
      signal?.addEventListener("abort", abort, { once: true });
      this.enqueue({
        requested: { type: "user-input.requested", threadId, turnId, provider, source: "kone.store", at: Date.now(), requestId, questions },
        shown: false,
        tool: { resolve, removeAbort: () => signal?.removeEventListener("abort", abort) },
      });
    });
  }

  /** A provider's own question event, on its way out of the adapter. Takes the
   *  ones this queue owns — an ask joins its thread's queue, and a resolution
   *  goes out only for the ask that was showing — and returns false for
   *  everything else, which the caller emits as it is. */
  admit(event: RuntimeEvent): boolean {
    if (event.type === "user-input.requested") {
      if (this.pending.get(event.threadId)?.has(event.requestId)) return false;
      this.enqueue({ requested: event, shown: false });
      return true;
    }
    if (event.type !== "user-input.resolved") return false;
    const queued = this.pending.get(event.threadId)?.get(event.requestId);
    if (!queued || queued.tool) return false;
    this.remove(queued);
    if (queued.shown) {
      this.emit(event);
      this.showHead(event.threadId);
    }
    return true;
  }

  /** Answer one of Kone's own questions. False when it is not one, or no
   *  longer waits — a provider's ask is answered through its adapter. */
  respond(threadId: string, requestId: string, answers: UserInputAnswers): boolean {
    const queued = this.pending.get(threadId)?.get(requestId);
    if (!queued?.tool) return false;
    this.settle(queued, answers);
    this.showHead(threadId);
    return true;
  }

  /** Unblock Kone's own question calls — the thread's, or one turn's. A
   *  provider's asks stay with the provider, which ends them with its turn. */
  cancel(threadId: string, turnId?: string): void {
    this.close(threadId, turnId, false);
  }

  /** The turn or the session holding the thread's questions is over: Kone's
   *  calls are unblocked, and a provider's asks leave the queue. The adapter
   *  still reports their end itself, if it ever does. */
  end(threadId: string, turnId?: string): void {
    this.close(threadId, turnId, true);
  }

  private close(threadId: string, turnId: string | undefined, providerAsks: boolean): void {
    for (const queued of this.pending.get(threadId)?.values() ?? []) {
      const { requested } = queued;
      if (turnId !== undefined && requested.turnId !== turnId) continue;
      if (queued.tool) this.settle(queued, {});
      else if (providerAsks) this.remove(queued);
    }
    this.showHead(threadId);
  }

  private enqueue(queued: QueuedQuestion): void {
    const { threadId, requestId } = queued.requested;
    let questions = this.pending.get(threadId);
    if (!questions) {
      questions = new Map();
      this.pending.set(threadId, questions);
    }
    questions.set(requestId, queued);
    this.showHead(threadId);
  }

  private remove(queued: QueuedQuestion): void {
    const { threadId, requestId } = queued.requested;
    const questions = this.pending.get(threadId);
    if (!questions) return;
    questions.delete(requestId);
    if (questions.size === 0) this.pending.delete(threadId);
  }

  /** Show the thread's oldest ask, unless it already shows. */
  private showHead(threadId: string): void {
    for (const queued of this.pending.get(threadId)?.values() ?? []) {
      if (queued.shown) return;
      queued.shown = true;
      this.emit(queued.requested);
      return;
    }
  }

  private settle(queued: QueuedQuestion, answers: UserInputAnswers): void {
    const { threadId, provider, requestId } = queued.requested;
    this.remove(queued);
    queued.tool?.removeAbort();
    if (queued.shown) {
      this.emit({ type: "user-input.resolved", threadId, provider, source: "kone.store", at: Date.now(), requestId, answers });
    }
    queued.tool?.resolve(answers);
  }
}

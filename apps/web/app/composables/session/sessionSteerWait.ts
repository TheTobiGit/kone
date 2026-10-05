import { shallowRef, watchEffect, type Ref } from "vue";
import type { StepWait } from "~/types/desktop";
import type { ThreadBlock } from "~/composables/agentTypes";
import { peelIpcError } from "~/utils/ipcError";

// The user's steer kone steer is holding until the running tool call
// finishes, on a provider that cannot take a message mid-turn: what the pill
// above the composer reads to offer Interrupt now. Each wait is bound to its
// id and the turn it ends, so a late reply cannot raise one that is over, and
// Interrupt now ends only the turn it was offered for.

/** The slice of the bridge this unit reaches. */
export type SteerWaitBridge = {
  interruptStepWaitNow?: (threadId: string, waitId: string) => Promise<boolean>;
};

export type SessionSteerWaitDeps = {
  threadId: Ref<string>;
  blocks: Ref<ThreadBlock[]>;
  error: Ref<string | null>;
  bridge: () => SteerWaitBridge | null;
};

/** Whether the turn a wait ends is still running on screen. */
export function steerWaitTurnRunning(wait: StepWait, blocks: readonly ThreadBlock[]): boolean {
  return blocks.some((b) => b.role === "assistant" && b.turnId === wait.turnId && b.state === "running");
}

export function useSessionSteerWait(deps: SessionSteerWaitDeps) {
  const steerWait = shallowRef<StepWait | null>(null);
  // Gone with its own turn, even when another starts at once and the thread
  // never reads idle in between.
  watchEffect(() => {
    const wait = steerWait.value;
    if (wait && !steerWaitTurnRunning(wait, deps.blocks.value)) steerWait.value = null;
  });

  /** A steer's reply named a wait. One whose turn has already ended — the
   *  reply came back after it — raises nothing. */
  function offer(wait: StepWait | undefined): void {
    if (!wait || !steerWaitTurnRunning(wait, deps.blocks.value)) return;
    steerWait.value = wait;
  }

  /** Interrupt now, for the wait on screen. The pill goes only once the turn
   *  is being ended; a refusal (parked on the user, say) keeps the offer. */
  async function interruptNow(): Promise<void> {
    const wait = steerWait.value;
    const api = deps.bridge();
    if (!wait || !api?.interruptStepWaitNow) return;
    try {
      const ended = await api.interruptStepWaitNow(deps.threadId.value, wait.id);
      if (ended && steerWait.value?.id === wait.id) steerWait.value = null;
    } catch (e) {
      deps.error.value = peelIpcError(e, "Could not interrupt the agent");
    }
  }

  return { steerWait, offer, interruptNow };
}

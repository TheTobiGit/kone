// The open subagent shell — which delegate's expanded transcript is on screen.
//
// Clicking a row in the Subagents dock (or the activity feed's subagent step)
// opens that delegate's EXPANDED shell: the zoom-in of the dock. The shell is
// keyed by *identity* (a run's stable `toolUseId`, a spawned thread's
// `threadId`) but derives the delegate itself fresh from the live block tree and
// spawn list, so a still-working child keeps streaming into the open shell
// instead of freezing on the snapshot the dock rows came from.
//
// This owns only "which shell is open, and what it needs from the thread under
// it". The two actions it can't perform itself — answering an approval, and
// revealing a spawned thread as a real conversation — are passed in, because
// both belong to the surface that hosts the shell rather than to the shell.

import { computed, provide, ref, watch } from "vue";
import type { ComputedRef, Ref } from "vue";
import type { ApprovalDecision } from "~/types/desktop";
import type { ThreadSession } from "~/composables/useAgent";
import type { Cue } from "~/composables/useSound";
import {
  SUBAGENT_OPEN_KEY,
  type ActiveSubagentsState,
  type DelegateRow,
} from "~/utils/subagentRuns";

export type ShellTarget =
  | { kind: "run"; toolUseId: string }
  | { kind: "thread"; threadId: string };

export interface UseSubagentShellOptions {
  /** The live derive, not the dock's debounced snapshot: an open shell has to
   *  keep streaming while the dock ticks at its own rate. */
  subagents: ComputedRef<ActiveSubagentsState>;
  /** The thread the shell hangs off. A shell belongs to one thread. */
  focusedThread: ComputedRef<ThreadSession | null>;
  /** The ask the main modal is showing, so the shell can take it over. */
  focusedPendingApproval: ComputedRef<{ requestId: string } | null>;
  /** Identity of the focused thread — a change closes the shell. */
  focusedKey: ComputedRef<string | null>;
  /** Answer an approval. The shell renders it inline; the decision still goes
   *  through the host's one approval path. */
  respondApproval: (requestId: string, decision: ApprovalDecision) => void;
  /** Reveal a spawned thread as a real conversation (loads its stored
   *  transcript and brings its column forward). */
  revealThread: (threadId: string) => void;
  cue: (name: Cue) => void;
}

export function useSubagentShell(o: UseSubagentShellOptions) {
  const activeShell: Ref<ShellTarget | null> = ref(null);

  const activeShellRun = computed(() => {
    const t = activeShell.value;
    if (t?.kind === "run") {
      return o.subagents.value.runs.find((r) => r.toolUseId === t.toolUseId) ?? null;
    }
    return null;
  });

  const activeShellThread = computed(() => {
    const t = activeShell.value;
    if (t?.kind === "thread") {
      return (
        o.focusedThread.value?.spawnedChildren.value.find((c) => c.threadId === t.threadId) ??
        null
      );
    }
    return null;
  });

  function onOpenShell(target: ShellTarget): void {
    o.cue("press");
    activeShell.value = target;
  }

  function onCloseShell(): void {
    activeShell.value = null;
  }

  // The approvals this shell's run is parked on — attributed upstream in useAgent
  // when exactly one run was live as the ask landed (originToolUseId). Un-attributable
  // asks (the parent's own, or a concurrent batch) stay with the main modal.
  const shellApprovals = computed(() => {
    const run = activeShellRun.value;
    if (!run) return [];
    return (o.focusedThread.value?.pendingApprovals.value ?? []).filter(
      (a) => a.originToolUseId === run.toolUseId,
    );
  });

  // When the shell renders the pending approval inline, the main modal steps
  // aside for that request — one ask, one place to answer it.
  const shellSuppressesApproval = computed(() => {
    const p = o.focusedPendingApproval.value;
    return !!p && shellApprovals.value.some((a) => a.requestId === p.requestId);
  });

  function onDecideShellApproval(requestId: string, decision: ApprovalDecision): void {
    o.respondApproval(requestId, decision);
  }

  function onShellOpenThread(): void {
    const t = activeShell.value;
    if (t?.kind !== "thread") return;
    activeShell.value = null;
    o.revealThread(t.threadId);
  }

  // Clicking a delegate row opens what that kind of delegate IS: a provider-native
  // run opens its live transcript in the shell in place; a spawned thread is a
  // real, persistent conversation — the shell shows its projection, and the
  // shell's open-thread action reveals the thread itself.
  function onOpenDelegate(row: DelegateRow): void {
    if (row.target.kind === "run") {
      onOpenShell({ kind: "run", toolUseId: row.target.toolUseId });
      return;
    }
    onOpenShell({ kind: "thread", threadId: row.target.threadId });
  }

  // A shell belongs to one thread; switching the focused column (or leaving the
  // surface) takes it away with the dock that opened it.
  watch(o.focusedKey, () => {
    activeShell.value = null;
  });

  // A spawned thread that vanishes from the live list (never spawned, archived,
  // swept) takes its shell with it.
  watch(activeShellThread, (t) => {
    if (activeShell.value?.kind === "thread" && !t) activeShell.value = null;
  });

  // The activity feed's subagent step rows have no direct emit path to the host,
  // so the open handler rides provide/inject instead (see SUBAGENT_OPEN_KEY).
  provide(SUBAGENT_OPEN_KEY, (toolUseId: string) => onOpenShell({ kind: "run", toolUseId }));

  return {
    activeShell,
    activeShellRun,
    activeShellThread,
    shellApprovals,
    shellSuppressesApproval,
    onOpenShell,
    onCloseShell,
    onDecideShellApproval,
    onShellOpenThread,
    onOpenDelegate,
  };
}

// Away-from-thread status pills — and the sound a finished turn makes.
//
// A project can have several threads live at once. Any thread whose live (or
// just-settled) turn is off-screen rides a dynamic-island pill in the corner,
// stacked one per thread. A running thread always shows while you're away; a
// finished reply waits there until you open it, at which point it's "seen" and
// steps aside. The thread you're actually viewing never pills.
//
// The completion cue lives here too, because it answers the same question from
// the other side: this decides *when a turn has just finished*, and both the
// pill and the sound are consequences of that one edge. Splitting them would
// mean two watchers computing the same signature and disagreeing about which
// finishes were real.

import { computed, ref, watch } from "vue";
import type { ComputedRef } from "vue";
import { SESSION_BRAND } from "~/types/session";
import { sessionBrand } from "~/utils/modelCatalog";
import type { Cue } from "~/composables/useSound";
import type { useAgent } from "~/composables/useAgent";

export interface UseThreadPillsOptions {
  agent: ReturnType<typeof useAgent>;
  cue: (name: Cue) => void;
  /** Every live thread is on screen as a column — so all of them count as seen.
   *  This is what keeps stepping away from a row you'd been watching from
   *  raising a pill for each column. */
  threadsOnScreen: ComputedRef<boolean>;
  /** Pills only belong where no thread is on screen. The repository surface is
   *  its own world, so they step aside there too. */
  pillsWelcome: ComputedRef<boolean>;
  /** Something is over the surface (a file detail) — pills step aside and return
   *  when it closes. */
  blocked: ComputedRef<boolean>;
}

export function useThreadPills(o: UseThreadPillsOptions) {
  const { agent, cue } = o;

  /** A cheap per-thread signature — id + current turn id + state — not a deep
   *  walk of every thread's block tree. Both watchers below care only whether a
   *  turn changed identity or settled, and that is all this tracks; a deep watch
   *  re-ran them on every streamed token for no gain. (E1) */
  const turnSignature = () =>
    agent.threads.value
      .map((t) => `${t.threadId}:${t.block?.turnId ?? ""}:${t.block?.state ?? ""}`)
      .join("|");

  // The turn you've last seen for each thread (recorded while it's on-screen) —
  // a settled reply you've already read won't re-pill after you leave.
  const seenTurns = ref<Record<string, string>>({});

  watch([o.threadsOnScreen, turnSignature], () => {
    if (!o.threadsOnScreen.value) return;
    // Only mark a turn seen once it's settled. Marking it seen the instant its
    // running block appears means a reply that finishes *after* the user steps
    // away never re-pills (its turnId never changes), so the completion goes
    // unannounced. Waiting for the settled state keeps the on-screen case honest
    // (it settles under the user's eyes) while still pilling an away-completion.
    const seen = { ...seenTurns.value };
    let touched = false;
    for (const t of agent.threads.value) {
      if (t.block && t.block.state !== "running" && seen[t.threadId] !== t.block.turnId) {
        seen[t.threadId] = t.block.turnId;
        touched = true;
      }
    }
    if (touched) seenTurns.value = seen;
  });

  /** Record a turn as seen from outside — opening a pill's thread. Refuses a
   *  still-running turn: marking one seen early would suppress its completion
   *  pill if the user opens it and leaves before it finishes, and the
   *  settled-only watcher above cannot undo a premature seen. */
  function markSeen(threadId: string, turnId: string, running: boolean): void {
    if (running) return;
    seenTurns.value = { ...seenTurns.value, [threadId]: turnId };
  }

  // ── the completion cue ──────────────────────────────────────────────────────
  // A turn finishing is the one agent moment worth hearing: you can send, look
  // away, and know from a soft resolve that a reply has landed. We watch each
  // thread's live turn settle out of `running` and cue once on that edge —
  // `ready` for a clean finish, `error` for a failed one. An interrupt is the
  // user's own doing (already cued at the click), so it stays silent. Keyed by
  // turn id so a single settle fires exactly once, never on re-render, and a
  // brand-new thread's first turn isn't mistaken for a finish.
  const settledTurns = ref<Record<string, string>>({});
  // The first pass only records what's already settled — a rehydrated project
  // mounts with every past turn in `completed`, and none of those just happened.
  // Real finishes are the transitions we see *after* that baseline.
  let settleWatcherPrimed = false;
  watch(
    turnSignature,
    () => {
      const settled = { ...settledTurns.value };
      let touched = false;
      for (const t of agent.threads.value) {
        const block = t.block;
        if (!block || block.state === "running") continue;
        if (settled[t.threadId] === block.turnId) continue;
        settled[t.threadId] = block.turnId;
        touched = true;
        if (!settleWatcherPrimed) continue; // baseline: seed, don't announce
        if (block.state === "completed") cue("ready");
        else if (block.state === "failed") cue("error");
      }
      if (touched) settledTurns.value = settled;
      settleWatcherPrimed = true;
    },
    { immediate: true },
  );

  // Pills the user has waved away, per thread → the turn they dismissed. Unlike
  // `seenTurns` this also silences a *running* turn: you've said you don't want to
  // be told about this one. The thread's next turn mints a new id, so a dismissal
  // never permanently mutes a conversation.
  const dismissedTurns = ref<Record<string, string>>({});

  function onDismissThread(threadId: string, turnId: string): void {
    cue("press");
    dismissedTurns.value = { ...dismissedTurns.value, [threadId]: turnId };
    seenTurns.value = { ...seenTurns.value, [threadId]: turnId };
  }

  // The pill stack: off-screen threads with a live-or-unseen turn, oldest first
  // so the newest sits closest to the corner.
  const pillThreads = computed(() => {
    if (o.blocked.value) return [];
    if (!o.pillsWelcome.value) return [];
    return agent.threads.value
      .filter((t) => {
        if (!t.everRan || !t.block) return false;
        if (dismissedTurns.value[t.threadId] === t.block.turnId) return false;
        const running = t.block.state === "running";
        const unseen = seenTurns.value[t.threadId] !== t.block.turnId;
        return running || unseen;
      })
      .map((t) => ({
        key: t.key,
        threadId: t.threadId,
        title: t.title,
        brand: sessionBrand(t.provider, SESSION_BRAND[t.provider] ?? "generic", t.model),
        block: t.block,
        turnId: t.block?.turnId ?? "",
        task: t.task,
      }))
      .sort((a, b) => (a.block?.at ?? 0) - (b.block?.at ?? 0));
  });

  return { pillThreads, onDismissThread, markSeen };
}

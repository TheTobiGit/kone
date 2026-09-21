import type { Ref } from "vue";
import { applyWorkspaceStep, type WorkspaceStepRow } from "~/utils/workspaceSteps";
import type {
  ChatAttachment,
  CompactionRecord,
  ProviderKind,
  RuntimeEvent,
  RuntimeItem,
  RuntimeSessionState,
  SpawnedThread,
  SubagentRun,
  SubagentRunSnapshot,
  TokenUsage,
} from "~/types/desktop";
import { originSubagentOfApproval } from "../agentPrefetch";
import { canonicalizeItem } from "~/utils/toolName";
import { isEffortTier } from "~/utils/modelCatalog";
import type {
  AssistantBlock,
  PendingApproval,
  PendingUserInput,
  QueuedTurnEntry,
  ThreadBlock,
  UserBlock,
} from "../agentTypes";

/** Providers whose `total` is a running thread tally (keep the max) versus
 *  per-turn reporters whose `total` is one turn's spend (accumulate onto the
 *  seeded lifetime). Mirrors the store's rollup so the live meter and a
 *  reload never disagree about what `total` means. */
function isRunningTotalProvider(provider: ProviderKind): boolean {
  return (
    provider === "codex" ||
    provider === "cursor" ||
    provider === "opencode" ||
    provider === "antigravity"
  );
}

/** Merge one `total` report onto the lifetime spend. Partial reports leave
 *  the lifetime standing; running totals advance by max, per-turn reports
 *  accumulate — never a silent max that papers over the two semantics. */
function mergeTokenTotal(
  prev: number | undefined,
  next: number | undefined,
  provider: ProviderKind,
): number | undefined {
  const prevFinite = prev !== undefined && Number.isFinite(prev) ? prev : undefined;
  const nextFinite = next !== undefined && Number.isFinite(next) ? next : undefined;
  if (prevFinite === undefined) return nextFinite;
  if (nextFinite === undefined) return prevFinite;
  if (isRunningTotalProvider(provider)) return Math.max(prevFinite, nextFinite);
  return prevFinite + nextFinite;
}

/** Every ref or callback `reduce` folds into. The refs stay owned by the
 *  session that creates them — this unit only reads and writes through the
 *  handles passed here, so the return literal above never changes shape. */
export type SessionReducerDeps = {
  blocks: Ref<ThreadBlock[]>;
  threadId: Ref<string>;
  touch: () => void;
  /** Remember the freshest provider resume cursor riding the event envelope. */
  noteResumeSessionAt: (resumeSessionAt: string) => void;
  sessionState: Ref<RuntimeSessionState>;
  warning: Ref<string | null>;
  error: Ref<string | null>;
  model: Ref<string | undefined>;
  tokenUsage: Ref<TokenUsage | null>;
  title: Ref<string>;
  workspaceSteps: Ref<WorkspaceStepRow[]>;
  everRan: Ref<boolean>;
  spawnedChildren: Ref<SpawnedThread[]>;
  queuedTurnsRaw: Ref<QueuedTurnEntry[]>;
  pendingQueueAnchors: Map<string, string>;
  pendingUserInput: Ref<PendingUserInput | null>;
  pendingApprovals: Ref<PendingApproval[]>;
  anchorFor: (userBlockId: string, queueId: string) => string | undefined;
  queuedBlockIdsOf: (rows: QueuedTurnEntry[]) => Set<string>;
  sortQueuedByIds: (rows: QueuedTurnEntry[], ids: readonly string[]) => QueuedTurnEntry[];
  parseQueuedAttachments: (json?: string | null) => ChatAttachment[] | undefined;
  noteCompactedBoundary: (marker: CompactionRecord) => void;
};

/** The one place the event stream becomes UI state. Self-contained — the
 *  session owns the single event listener and calls `reduce` for events
 *  bearing its thread's id. */
export function useSessionReducer(deps: SessionReducerDeps) {
  const {
    blocks,
    threadId,
    touch,
    noteResumeSessionAt,
    sessionState,
    warning,
    error,
    model,
    tokenUsage,
    title,
    workspaceSteps,
    everRan,
    spawnedChildren,
    queuedTurnsRaw,
    pendingQueueAnchors,
    pendingUserInput,
    pendingApprovals,
    anchorFor,
    queuedBlockIdsOf,
    sortQueuedByIds,
    parseQueuedAttachments,
    noteCompactedBoundary,
  } = deps;

  function currentAssistant(turnId: string): AssistantBlock | undefined {
    for (let i = blocks.value.length - 1; i >= 0; i--) {
      const b = blocks.value[i];
      if (b && b.role === "assistant" && b.turnId === turnId) return b;
    }
    return undefined;
  }

  function upsertItem(block: AssistantBlock, item: RuntimeItem): void {
    const idx = block.items.findIndex((i) => i.itemId === item.itemId);
    // A tool_call that spawned a subagent keeps the run we've already nested on
    // it — later updates to the call itself (its result, status) must not drop
    // the child's transcript.
    if (idx === -1) block.items.push(item);
    else {
      const merged: RuntimeItem = { ...item };
      const existingSubagent = block.items[idx]!.subagent;
      if (existingSubagent) merged.subagent = existingSubagent;
      block.items[idx] = merged;
    }
    // Reassign so the shallow array ref stays reactive on nested edits.
    block.items = [...block.items];
  }

  /** Find a nested run within a turn by the tool-use id that spawned it. Runs
   *  live on their parent `tool_call` item, so this is a scan of the turn's
   *  items — cheap at kone's item counts, and it keeps the tree the single
   *  source of truth instead of a parallel index. */
  function findRun(block: AssistantBlock, toolUseId: string): SubagentRun | undefined {
    for (const item of block.items) {
      if (item.subagent?.toolUseId === toolUseId) return item.subagent;
    }
    return undefined;
  }

  /** Merge a subagent snapshot into the turn, attaching the run to its parent
   *  tool_call item the first time we see it. The adapter emits pieces (snapshots
   *  + tagged items); assembling the tree is the consumer's job. */
  function upsertRun(block: AssistantBlock, snapshot: SubagentRunSnapshot): SubagentRun | undefined {
    const existing = findRun(block, snapshot.toolUseId);
    if (existing) {
      Object.assign(existing, snapshot);
      blocks.value = [...blocks.value];
      return existing;
    }
    // The parent tool call is normally already open (the run is recognized when
    // its input finishes streaming); if it isn't, the run is dropped until the
    // parent item shows up and a later snapshot re-attaches it.
    const parent = snapshot.parentItemId
      ? block.items.find((i) => i.itemId === snapshot.parentItemId)
      : undefined;
    if (!parent) return undefined;
    const run: SubagentRun = { ...snapshot, items: [] };
    parent.subagent = run;
    block.items = [...block.items];
    blocks.value = [...blocks.value];
    return run;
  }

  /** Fold one event into this thread's state. The manager only calls this for
   *  events whose `threadId` matches ours; the guard is belt-and-braces. */
  function reduce(event: RuntimeEvent): void {
    // Any event means this conversation is alive — keep it out of the eviction
    // and reaping windows. Runs before the routing guard on purpose: a spawned
    // child's traffic is routed here too, and the parent orchestrating it is
    // very much active.
    touch();
    // The provider's resume cursor travels on the envelope; remember the
    // freshest one so a hibernated session can re-stage it (Claude-only —
    // other providers never set it).
    if (event.refs?.resumeSessionAt) noteResumeSessionAt(event.refs.resumeSessionAt);
    // A spawned child's events bear the CHILD's id — the child is the subject,
    // and its session is never in this registry (only the parent's is; the
    // parent's dock is what these events maintain). The manager routes them to
    // us by `spawned.parentThreadId`; fold by the child's own id, never ours.
    if (
      (event.type === "thread.spawned" || event.type === "thread.spawn-updated") &&
      event.spawned.parentThreadId === threadId.value
    ) {
      const kids = event.spawned;
      const exists = spawnedChildren.value.some((c) => c.threadId === kids.threadId);
      // Replace wholesale — both event types carry the WHOLE SpawnedThread, and
      // patching fields would resurrect stale ones (a cleared status, a dead
      // elapsedMs). A fresh array each time: the dock is a derived view. Kept
      // sorted by createdAt ascending so first-spawned reads as first.
      const next = (
        exists
          ? spawnedChildren.value.map((c) => (c.threadId === kids.threadId ? kids : c))
          : [...spawnedChildren.value, kids]
      ).sort((a, b) => a.createdAt - b.createdAt);
      spawnedChildren.value = next;
      return;
    }
    if (event.threadId !== threadId.value) return;
    switch (event.type) {
      case "session.state.changed":
        sessionState.value = event.state;
        // Any state change supersedes a stale warning — the turn moved on.
        warning.value = null;
        if (event.state === "error" && event.message) error.value = event.message;
        break;
      case "session.warning":
        // Non-fatal: the session keeps running. Surface the message without
        // flipping the state (a Codex error notification with willRetry, a
        // benign notice — the adapter decides what belongs here).
        warning.value = event.message;
        break;
      case "model.rerouted":
        // The provider moved the session onto another model mid-turn (capacity
        // reroute). Keep the picker/UI truthful about what is actually running.
        model.value = event.toModel;
        break;
      case "session.exited": {
        sessionState.value = "stopped";
        if (event.code && error.value === null) {
          error.value = "Agent process exited unexpectedly";
        }
        blocks.value = blocks.value.map((b) =>
          b.role === "assistant" && b.state === "running"
            ? { ...b, state: "failed", endedAt: event.at }
            : b,
        );
        break;
      }
      case "thread.token-usage.updated": {
        // Providers report usage as they have it; a later event may carry only
        // part of the picture (a fresh contextUsed with no window). Merge, so a
        // partial report refreshes what it knows and leaves the rest standing —
        // the last known contextWindow in particular — instead of clobbering it.
        // `total` is lifetime spend and `contextUsed` is window fill: running
        // totals advance by max while per-turn reports accumulate (see
        // mergeTokenTotal), so neither semantic silently overwrites the other.
        const merged: TokenUsage = { ...tokenUsage.value, ...event.usage };
        const lifetime = mergeTokenTotal(tokenUsage.value?.total, event.usage.total, event.provider);
        if (lifetime === undefined) delete merged.total;
        else merged.total = lifetime;
        tokenUsage.value = merged;
        break;
      }
      case "thread.state.changed":
        // Compaction resets the live window: the store's snapshot already moved
        // to afterTokens, so the live meter must match or a reload visibly
        // jumps. Only the window occupancy resets — the budget and the
        // auto-compact flag carry over. (Filtered to the open thread by the
        // threadId guard above the switch.)
        if (event.state === "compacted") {
          // Unknown stays unknown: the store reports an uncounted compaction
          // as NULL, and the meter hides its ring then instead of lying 0%.
          const after = event.afterTokens;
          const next: TokenUsage = { ...tokenUsage.value };
          if (after === undefined || after === null) delete next.contextUsed;
          else next.contextUsed = after;
          tokenUsage.value = next;
          // The boundary is also journaled as a row — mirror it into the
          // timeline markers so the "when/where" shows without a re-read.
          // (Filtered to the open thread by the threadId guard above.)
          const marker: CompactionRecord = {
            threadId: event.threadId,
            at: event.at,
            beforeTokens: event.beforeTokens ?? null,
            afterTokens: event.afterTokens ?? null,
          };
          noteCompactedBoundary(marker);
        }
        break;
      case "thread.title.updated":
        title.value = event.title;
        break;
      case "thread.workspace.progress":
        // Only ever arrives for a thread that asked for a worktree, and only
        // during the seconds it is being built.
        workspaceSteps.value = applyWorkspaceStep(workspaceSteps.value, event);
        break;
      case "turn.started": {
        everRan.value = true;
        // Delete only the anchor matching this started turn id, leaving any
        // subsequent queued follow-up anchors intact in the map.
        pendingQueueAnchors.delete(event.turnId);
        const assistantBlock: AssistantBlock = {
          id: event.turnId,
          role: "assistant",
          turnId: event.turnId,
          items: [],
          state: "running",
          at: event.at,
        };
        // A second send can push while idle in the gap after the first send's
        // dispatch cleared but before its turn.started folded (busy reads idle
        // there: no dispatch, no running state, no running assistant yet). When
        // the backend then queues that second push behind the first turn, the
        // queued user block is already in blocks.value when this started lands,
        // so the assistant goes right before the first queued block — after its
        // own prompt, never after a follow-up that has not run yet.
        const queuedBlockIds = queuedBlockIdsOf(queuedTurnsRaw.value);
        const firstQueuedIndex = blocks.value.findIndex(
          (b) => b.role === "user" && queuedBlockIds.has(b.id),
        );
        if (firstQueuedIndex !== -1) {
          blocks.value = [
            ...blocks.value.slice(0, firstQueuedIndex),
            assistantBlock,
            ...blocks.value.slice(firstQueuedIndex),
          ];
        } else {
          blocks.value = [...blocks.value, assistantBlock];
        }
        break;
      }
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const block = currentAssistant(event.turnId);
        if (!block) break;
        // An item produced inside a nested run belongs to that run's transcript,
        // not the parent turn's body.
        const run = event.subagentToolUseId
          ? findRun(block, event.subagentToolUseId)
          : undefined;
        // One spelling per tool from here on: providers qualify a tool_call's
        // name by its server, and every vocabulary downstream (icon, phrasing,
        // status pill) reads `name` as given rather than unwrapping its own.
        const item = canonicalizeItem(event.item);
        if (run) {
          const idx = run.items.findIndex((i) => i.itemId === item.itemId);
          if (idx === -1) run.items.push(item);
          else run.items[idx] = item;
          run.items = [...run.items];
        } else if (!event.subagentToolUseId) {
          upsertItem(block, item);
        }
        blocks.value = [...blocks.value];
        break;
      }
      case "subagent.started":
      case "subagent.updated":
      case "subagent.completed": {
        const block = currentAssistant(event.turnId);
        if (block) upsertRun(block, event.subagent);
        break;
      }
      case "turn.completed": {
        const block = currentAssistant(event.turnId);
        if (block) {
          block.state = "completed";
          block.endedAt = event.at;
        }
        blocks.value = [...blocks.value];
        break;
      }
      case "turn.aborted": {
        const block = currentAssistant(event.turnId);
        if (block) {
          block.state = event.reason === "interrupted" ? "interrupted" : "failed";
          block.error = event.message;
          block.endedAt = event.at;
        }
        // An aborted turn can never have its question answered — drop the modal.
        // (A parked approval clears via the backend's `approval.resolved`, which
        // it emits with reject-once on interrupt.)
        pendingUserInput.value = null;
        blocks.value = [...blocks.value];
        break;
      }
      case "user-input.requested": {
        const input: PendingUserInput = { requestId: event.requestId, questions: event.questions };
        if (event.postTurn) input.postTurn = true;
        pendingUserInput.value = input;
        break;
      }
      case "user-input.resolved":
        // The backend settled this round-trip (our answer, or a drain on
        // interrupt/stop). Clear the modal if it's the one we're showing.
        if (pendingUserInput.value?.requestId === event.requestId) {
          pendingUserInput.value = null;
        }
        break;
      case "approval.requested": {
        const block = event.turnId ? currentAssistant(event.turnId) : undefined;
        const origin = originSubagentOfApproval(block);
        const entry: PendingApproval = {
          requestId: event.requestId,
          approval: event.approval,
        };
        if (origin) entry.originToolUseId = origin;
        // A replayed ask replaces its earlier copy — without this the reload
        // replay stacks a second modal entry for the same gate.
        pendingApprovals.value = [
          ...pendingApprovals.value.filter((a) => a.requestId !== event.requestId),
          entry,
        ];
        break;
      }
      case "approval.resolved":
        // The backend settled this round-trip (our decision, or a drain on
        // interrupt/stop). Drop it from the queue — the modal moves to the next.
        pendingApprovals.value = pendingApprovals.value.filter(
          (a) => a.requestId !== event.requestId,
        );
        break;
      case "turn.queued": {
        // A follow-up was durably enqueued behind the running turn — park a
        // row. The display text comes from event.input, or the anchored transcript
        // block (via userBlockId), or falls back to empty. The event carries
        // the row's attachmentsJson so the live row is complete without a
        // re-read.
        const blockId = anchorFor(event.userBlockId, event.queueId);
        const anchorText = blockId
          ? blocks.value.find(
              (b): b is UserBlock => b.role === "user" && b.id === blockId,
            )?.text ?? ""
          : "";
        const entry: QueuedTurnEntry = {
          queueId: event.queueId,
          threadId: event.threadId,
          userBlockId: event.userBlockId,
          dispatchMode: event.dispatchMode,
          state: "queued",
          input: event.input || anchorText,
          attachmentsJson: event.attachmentsJson ?? null,
          createdAt: event.at,
          position: event.position,
        };
        if (event.effort) entry.effort = event.effort;
        if (event.model) entry.model = event.model;
        if (blockId) entry.blockId = blockId;
        // A re-seed may already hold this queueId — replace, never duplicate.
        // Arrival order wins: event.position goes stale after a cancellation
        // or a reorder, so it is kept on the entry for compat only and never
        // used to sort here. The display computed renumbers from array order.
        queuedTurnsRaw.value = [
          ...queuedTurnsRaw.value.filter((q) => q.queueId !== event.queueId),
          entry,
        ];
        break;
      }
      case "turn.queued-cancelled": {
        // A user drop removes one row; a stop/delete clears the whole line
        // (the backend emits one cancellation per row on stop). The dropped
        // prompt never ran, so its anchored block leaves with the row —
        // otherwise cancelling would pop the message into the thread. Only
        // entry.blockId — the transcript block the row hid — is removed here,
        // never userBlockId on its own: a re-seeded row with no block here has
        // nothing in blocks.value to drop.
        const clearingAll =
          event.reason === "stop" ||
          event.reason === "thread-deleted" ||
          event.reason === "archive";
        const dropped = clearingAll
          ? queuedTurnsRaw.value.filter((q) => q.threadId === event.threadId)
          : queuedTurnsRaw.value.filter((q) => q.queueId === event.queueId);
        pendingQueueAnchors.delete(event.queueId);
        queuedTurnsRaw.value = clearingAll
          ? queuedTurnsRaw.value.filter((q) => q.threadId !== event.threadId)
          : queuedTurnsRaw.value.filter((q) => q.queueId !== event.queueId);
        const droppedIds = new Set<string>();
        for (const q of dropped) {
          if (q.blockId) droppedIds.add(q.blockId);
        }
        if (droppedIds.size > 0) {
          blocks.value = blocks.value.filter((b) => !droppedIds.has(b.id));
        }
        break;
      }
      case "turn.promoted": {
        // The backend handed the row to the adapter as a real turn — the row
        // is consumed. (turn.promoted is the authoritative "row gone" signal:
        // it only fires after the adapter accepted the send and the store
        // marked the row promoted, so a failed promotion never clears the
        // row.) The entry IS the prompt — rebuild the user block from its
        // input + attachmentsJson every time, including re-seeded rows that
        // never had a block here.
        const promo = queuedTurnsRaw.value.find((q) => q.queueId === event.queueId);

        let userBlock: UserBlock | undefined;
        if (promo) {
          const attachments = parseQueuedAttachments(promo.attachmentsJson);
          userBlock = {
            id: promo.userBlockId,
            role: "user",
            text: promo.input,
            at: promo.createdAt,
          };
          if (attachments?.length) userBlock.attachments = attachments;
          // What the turn runs with is on the row itself — the same fields the
          // backend journals for it — so a promoted turn is stamped identically
          // whether the row was enqueued a second ago or drained from storage
          // after a quit. An unknown tier degrades to unstamped rather than
          // being read as one.
          if (isEffortTier(promo.effort)) userBlock.effort = promo.effort;
          if (promo.model) userBlock.model = promo.model;
        }

        if (userBlock) {
          // Re-place this user block at the current tail of blocks.value
          // so its order precedes its assistant reply (turn.started),
          // strictly following all settled turns.
          blocks.value = [
            ...blocks.value.filter((b) => b.id !== userBlock!.id),
            userBlock,
          ];
        }

        queuedTurnsRaw.value = queuedTurnsRaw.value.filter(
          (q) => q.queueId !== event.queueId,
        );
        pendingQueueAnchors.delete(event.queueId);
        if (event.turnId) pendingQueueAnchors.delete(event.turnId);
        break;
      }
      case "turn.steered":
        // The nudge was offered into the LIVE turn — no new boundary, no
        // state to fold beyond the user block already pushed optimistically
        // (a steer that fell back to the queue arrives as turn.queued
        // instead). Prune the steered turn's anchor if tracked.
        pendingQueueAnchors.delete(event.turnId);
        break;
      case "turn.queued-reordered": {
        if (event.threadId !== threadId.value) break;
        queuedTurnsRaw.value = sortQueuedByIds(queuedTurnsRaw.value, event.queueIds);
        break;
      }
      default:
        break;
    }
  }

  return { reduce, currentAssistant };
}

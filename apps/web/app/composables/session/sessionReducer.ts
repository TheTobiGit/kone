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
import { steerContinuationId, steeredBlockIds } from "@kone/protocol/steer-split";
import type {
  AssistantBlock,
  PendingApproval,
  PendingUserInput,
  QueuedTurnEntry,
  QueueReturn,
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
  /** Remember the conversation id and resume cursor riding this thread's
   *  event envelopes, with the provider whose session reported them. */
  noteRefs: (provider: ProviderKind, refs: { conversationId?: string; resumeSessionAt?: string }) => void;
  /** Whether an exit is the session this thread is on, rather than one it
   *  has since moved off — another provider's, or a conversation it left. */
  ownsExit: (event: Extract<RuntimeEvent, { type: "session.exited" }>) => boolean;
  /** The provider session ended: re-arm the start-on-next-send, unless a stop
   *  this side asked for has already dealt with it. */
  noteSessionExited: () => void;
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
  queueReturn: Ref<QueueReturn | null>;
  mergeQueueReturn: (rows: QueuedTurnEntry[], at: number) => QueueReturn;
  pendingQueueAnchors: Map<string, string>;
  /** The parked question as the backend reports it; the gates hide it while an answer travels. */
  parkedUserInput: Ref<PendingUserInput | null>;
  pendingApprovals: Ref<PendingApproval[]>;
  anchorFor: (userBlockId: string, queueId: string) => string | undefined;
  queuedBlockIdsOf: (rows: QueuedTurnEntry[]) => Set<string>;
  usersOwnQueuedRows: (rows: QueuedTurnEntry[]) => QueuedTurnEntry[];
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
    noteRefs,
    ownsExit,
    noteSessionExited,
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
    queueReturn,
    mergeQueueReturn,
    pendingQueueAnchors,
    parkedUserInput,
    pendingApprovals,
    anchorFor,
    queuedBlockIdsOf,
    usersOwnQueuedRows,
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

  /** The piece of a turn that holds `itemId` — a message steered into the
   *  turn splits its reply, and an item already under way when it landed
   *  keeps streaming into the piece above it. A new item goes to the latest
   *  piece. */
  function pieceHolding(turnId: string, itemId: string): AssistantBlock | undefined {
    for (const b of blocks.value) {
      if (b.role === "assistant" && b.turnId === turnId && b.items.some((i) => i.itemId === itemId)) {
        return b;
      }
    }
    return currentAssistant(turnId);
  }

  /** The piece of a turn whose items carry the nested run `toolUseId` (or
   *  its parent tool call), else the latest piece. */
  function pieceWithRun(turnId: string, toolUseId: string, parentItemId?: string): AssistantBlock | undefined {
    for (const b of blocks.value) {
      if (b.role !== "assistant" || b.turnId !== turnId) continue;
      if (findRun(b, toolUseId)) return b;
      if (parentItemId && b.items.some((i) => i.itemId === parentItemId)) return b;
    }
    return currentAssistant(turnId);
  }

  /** A message the provider took into its running turn: the reply so far
   *  settles above it, and what the agent writes from here on continues below
   *  it as the same turn — so the words the message shaped read after it, not
   *  before. Taken in before the turn said anything, the message simply moves
   *  above the reply. The store splits a reloaded thread at the same point
   *  (assembleBlocks), under the same continuation id. */
  function splitAtSteer(userBlockId: string, turnId: string, at: number): void {
    const user = blocks.value.find((b) => b.role === "user" && b.id === userBlockId);
    const open = currentAssistant(turnId);
    if (!user || !open || open.state !== "running") return;
    const continuationId = steerContinuationId(turnId, userBlockId);
    if (blocks.value.some((b) => b.id === continuationId)) return;
    const without = blocks.value.filter((b) => b !== user);
    const idx = without.indexOf(open);
    if (open.items.length === 0) {
      blocks.value = [...without.slice(0, idx), user, ...without.slice(idx)];
      return;
    }
    const rest: AssistantBlock = {
      id: continuationId,
      role: "assistant",
      turnId,
      items: [],
      state: "running",
      at,
      continues: open.continues ?? open.id,
    };
    open.state = "completed";
    open.endedAt = at;
    blocks.value = [...without.slice(0, idx + 1), user, rest, ...without.slice(idx + 1)];
  }

  /** A turn settling with nothing said after the last message steered into
   *  it: the empty piece goes, and the one above it takes the turn's outcome
   *  back — the reply never continued, so it reads as it ended. The store
   *  never splits such a turn, so a reload agrees. Returns the piece that now
   *  carries the outcome. */
  function foldEmptyContinuation(turnId: string): AssistantBlock | undefined {
    const last = currentAssistant(turnId);
    if (!last?.continues || last.items.length > 0) return last;
    blocks.value = blocks.value.filter((b) => b !== last);
    return currentAssistant(turnId);
  }

  /** The prompt a queued row carries, as a timeline block. The row IS the
   *  prompt — the block is rebuilt from its input + attachments every time,
   *  including re-seeded rows that never had a block here. What the turn
   *  runs with is on the row itself — the same fields the backend journals
   *  for it — so a promoted turn is stamped identically whether the row was
   *  enqueued a second ago or drained from storage after a quit. An unknown
   *  tier degrades to unstamped rather than being read as one. */
  function userBlockOf(row: QueuedTurnEntry): UserBlock {
    const block: UserBlock = {
      id: row.userBlockId,
      role: "user",
      text: row.input,
      at: row.createdAt,
    };
    if (row.attachments?.length) block.attachments = row.attachments;
    if (row.steered) block.steered = true;
    if (row.skills?.length) block.skills = row.skills;
    if (isEffortTier(row.effort)) block.effort = row.effort;
    if (row.model) block.model = row.model;
    return block;
  }

  /** A promoted row's block, keeping who spoke. A row's input is what the
   *  agent is sent, and for words kone wrote on someone else's behalf — a
   *  delivered agent message, a follow-up — that is the framed prompt, not
   *  what they said. The block already on screen has their words and their
   *  name, so it keeps both; the row still decides the rest. */
  function speakerKept(block: UserBlock): UserBlock {
    const shown = blocks.value.find((b): b is UserBlock => b.role === "user" && b.id === block.id);
    if (!shown?.sender || shown.sender.kind === "user") return block;
    return { ...block, text: shown.text, sender: shown.sender };
  }

  function mergeItem(previous: RuntimeItem, item: RuntimeItem): RuntimeItem {
    const merged = { ...previous, ...item };
    for (const key of ["name", "detail", "tool", "fileChanges", "tasks"] as const) {
      if (item[key] === undefined && previous[key] !== undefined) Object.assign(merged, { [key]: previous[key] });
    }
    if (previous.status !== "in-progress" && item.status === "in-progress") merged.status = previous.status;
    return merged;
  }

  function upsertItem(block: AssistantBlock, item: RuntimeItem): void {
    const idx = block.items.findIndex((i) => i.itemId === item.itemId);
    // A tool_call that spawned a subagent keeps the run we've already nested on
    // it — later updates to the call itself (its result, status) must not drop
    // the child's transcript.
    if (idx === -1) block.items.push(item);
    else {
      const previous = block.items[idx]!;
      const merged: RuntimeItem = mergeItem(previous, item);
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
    // Past the routing guard, so a spawned child's conversation never stands
    // in for this thread's. The provider's resume cursor travels on the
    // envelope beside it; the freshest one is kept so a hibernated session can
    // re-stage it (Claude-only — other providers never set it). An exit says
    // nothing new about the conversation, and is checked against what was
    // noted before it (ownsExit).
    if (event.type !== "session.exited" && (event.refs?.conversationId || event.refs?.resumeSessionAt)) {
      noteRefs(event.provider, event.refs);
    }
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
        // A session this thread has moved off ended: the one it is on has not.
        if (!ownsExit(event)) break;
        sessionState.value = "stopped";
        if (event.code && error.value === null) {
          error.value = "Agent process exited unexpectedly";
        }
        blocks.value = blocks.value.map((b) =>
          b.role === "assistant" && b.state === "running"
            ? { ...b, state: "failed", endedAt: event.at }
            : b,
        );
        // A session that ended on its own is gone all the same: kept, the next
        // send would go to a session nothing will answer from.
        noteSessionExited();
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
      case "thread.message-journaled": {
        // Words kone put on this transcript for someone else — an agent's
        // brief or message, kone's own notice. The user's own sends never
        // arrive here (they are placed as they are sent). Written for a turn
        // whose own words are already on screen, it reads above them;
        // otherwise, or when that block is not loaded here, it goes at the
        // tail. Once either way.
        if (blocks.value.some((b) => b.id === event.block.id)) break;
        const { effort: _effort, ...journaled } = event.block;
        const block: UserBlock = { ...journaled };
        const before = event.beforeBlockId
          ? blocks.value.findIndex((b) => b.id === event.beforeBlockId)
          : -1;
        blocks.value =
          before === -1
            ? [...blocks.value, block]
            : [...blocks.value.slice(0, before), block, ...blocks.value.slice(before)];
        break;
      }
      case "thread.message-unjournaled":
        // A send the service refused took its journaled message back. The
        // user's own was already dropped when the send rejected; an agent's
        // was placed here from thread.message-journaled and only goes now.
        blocks.value = blocks.value.filter((b) => b.id !== event.blockId);
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
        const block = event.subagentToolUseId
          ? pieceWithRun(event.turnId, event.subagentToolUseId)
          : pieceHolding(event.turnId, event.item.itemId);
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
          else run.items[idx] = mergeItem(run.items[idx]!, item);
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
        const block = pieceWithRun(event.turnId, event.subagent.toolUseId, event.subagent.parentItemId);
        if (block) upsertRun(block, event.subagent);
        break;
      }
      case "turn.completed": {
        const block = foldEmptyContinuation(event.turnId);
        if (block) {
          block.state = "completed";
          block.endedAt = event.at;
        }
        blocks.value = [...blocks.value];
        break;
      }
      case "turn.aborted": {
        const block = foldEmptyContinuation(event.turnId);
        if (block) {
          block.state = event.reason === "interrupted" ? "interrupted" : "failed";
          block.error = event.message;
          block.endedAt = event.at;
        }
        // An aborted turn can never have its question answered — drop the modal.
        // (A parked approval clears via the backend's `approval.resolved`, which
        // it emits with reject-once on interrupt.)
        parkedUserInput.value = null;
        blocks.value = [...blocks.value];
        break;
      }
      case "user-input.requested": {
        const input: PendingUserInput = { requestId: event.requestId, questions: event.questions };
        parkedUserInput.value = input;
        break;
      }
      case "user-input.resolved":
        // The backend settled this round-trip (our answer, or a drain on
        // interrupt/stop). Clear the modal if it's the one we're showing.
        if (parkedUserInput.value?.requestId === event.requestId) {
          parkedUserInput.value = null;
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
          createdAt: event.at,
          position: event.position,
        };
        const attachments = parseQueuedAttachments(event.attachmentsJson);
        if (attachments?.length) entry.attachments = attachments;
        if (event.skills?.length) entry.skills = event.skills;
        if (event.effort) entry.effort = event.effort;
        if (event.model) entry.model = event.model;
        if (event.mode) entry.mode = event.mode;
        if (event.sender) entry.sender = event.sender;
        if (blockId) entry.blockId = blockId;
        // A re-seed may already hold this queueId — replace, never duplicate.
        // The backend's run order wins (a steer row claims ahead of plain
        // follow-ups, so arrival is not run order); without one, arrival.
        // event.position goes stale after a cancellation or a reorder, so it
        // is kept for compat only — the display computed renumbers.
        const next = [...queuedTurnsRaw.value.filter((q) => q.queueId !== event.queueId), entry];
        queuedTurnsRaw.value = event.order ? sortQueuedByIds(next, event.order) : next;
        break;
      }
      case "turn.queued-updated": {
        // Claimed and being handed over, back in line awaiting a retry, or
        // held after its tries ran out — the row stays, only its status moves.
        queuedTurnsRaw.value = queuedTurnsRaw.value.map((q) => {
          if (q.queueId !== event.queueId) return q;
          const { retryAt: _retryAt, error: _error, ...rest } = q;
          const updated: QueuedTurnEntry = { ...rest, state: event.state };
          if (event.retryAt) updated.retryAt = event.retryAt;
          if (event.error) updated.error = event.error;
          return updated;
        });
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
        // Only the user's own words go back to the composer on a Stop: an
        // agent's message that waited in the queue was never theirs to edit.
        const returned = event.reason === "stop" ? usersOwnQueuedRows(dropped) : [];
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
        // A Stop keeps queued work from starting, not the words: they go back
        // to the composer. (The first "stop" event clears the whole line, so
        // this hands everything back once.)
        if (returned.length > 0) {
          queueReturn.value = mergeQueueReturn(returned, Date.now());
        }
        break;
      }
      case "turn.promoted": {
        // The backend handed the row to the adapter as a real turn — the row
        // is consumed. (turn.promoted is the authoritative "row gone" signal:
        // it only fires after the adapter accepted the send and the store
        // marked the row promoted, so a failed promotion never clears the
        // row.) The entry IS the prompt — rebuild the user block from its
        // input + attachments every time, including re-seeded rows that
        // never had a block here.
        const promo = queuedTurnsRaw.value.find((q) => q.queueId === event.queueId);

        const userBlock = promo ? speakerKept(userBlockOf(promo)) : undefined;

        if (userBlock) {
          // Land this prompt immediately BEFORE the assistant turn it belongs
          // to. turn.started arrives ahead of turn.promoted — the adapter
          // announces it from inside sendTurn, and the row only settles once
          // the provider has taken it — so by now this turn's reply already
          // holds the tail, and appending there reads as an answer to a
          // question that hasn't been asked yet. The tail stays the fallback
          // for a promotion whose assistant block hasn't folded yet, and the
          // only place for a steer: its turnId names the LIVE turn, whose
          // reply was already under way before these words were sent.
          // A steer whose block is already on screen was placed (and the
          // reply split) when turn.steered landed — it keeps that place.
          const placed = userBlock.steered
            ? blocks.value.findIndex((b) => b.role === "user" && b.id === userBlock.id)
            : -1;
          if (placed !== -1) {
            blocks.value = blocks.value.map((b, i) => (i === placed ? userBlock : b));
          } else {
            const without = blocks.value.filter((b) => b.id !== userBlock.id);
            const replyIndex = event.turnId && !userBlock.steered
              ? without.findIndex((b) => b.role === "assistant" && b.turnId === event.turnId)
              : -1;
            const at = replyIndex === -1 ? without.length : replyIndex;
            blocks.value = [...without.slice(0, at), userBlock, ...without.slice(at)];
            if (userBlock.steered && event.turnId) {
              splitAtSteer(userBlock.id, event.turnId, promo?.steeredAt ?? event.at);
            }
          }
        }

        queuedTurnsRaw.value = queuedTurnsRaw.value.filter(
          (q) => q.queueId !== event.queueId,
        );
        pendingQueueAnchors.delete(event.queueId);
        if (event.turnId) pendingQueueAnchors.delete(event.turnId);
        break;
      }
      case "turn.steered": {
        // The provider took the message into its LIVE turn — no new boundary.
        // The block is already on screen (steerTurn pushed it), so it only
        // gains its mark; a queued row sent now is marked here and carries the
        // mark into the block turn.promoted builds next. (A steer that fell
        // back to the queue arrives as turn.queued instead.)
        pendingQueueAnchors.delete(event.turnId);
        // Every block the steer carried, in order — a batch of delivered agent
        // messages rides one steer — so they read together above the
        // continuation rather than the last alone.
        for (const steeredId of steeredBlockIds(event)) {
          if (blocks.value.some((b) => b.role === "user" && b.id === steeredId)) {
            blocks.value = blocks.value.map((b) =>
              b.role === "user" && b.id === steeredId ? { ...b, steered: true } : b,
            );
            splitAtSteer(steeredId, event.turnId, event.at);
          }
          const row = queuedTurnsRaw.value.find((q) => q.userBlockId === steeredId);
          if (row) {
            const marked = { ...row, steered: true, steeredAt: event.at };
            queuedTurnsRaw.value = queuedTurnsRaw.value.map((q) => (q === row ? marked : q));
            // A row with no block on screen (one restored after a reopen) gets
            // its block now, so the reply splits where the provider took it in
            // rather than wherever it has got to by turn.promoted.
            if (!blocks.value.some((b) => b.role === "user" && b.id === steeredId)) {
              blocks.value = [...blocks.value, userBlockOf(marked)];
              splitAtSteer(steeredId, event.turnId, event.at);
            }
          }
        }
        break;
      }
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

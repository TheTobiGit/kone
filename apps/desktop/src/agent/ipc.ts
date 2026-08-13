import { randomUUID } from "node:crypto";
import { ipcMain, type WebContents } from "electron";

import { AgentService } from "./AgentService.js";
import { getAttachmentStore } from "./AttachmentStore.js";
import {
  getConversationStore,
  projectRuntimeEventForIpc,
  projectStoredBlocksForIpc,
  projectStoredThreadForIpc,
} from "./ConversationStore.js";
import { initThreadDispatcher } from "./dispatch.js";
import { createGateway, type GatewayHandle } from "./gateway/index.js";
import { scanAgentInventory } from "./inventory/index.js";
import { readSkillDetail } from "./inventory/skillDetail.js";
import {
  lintSkillAt,
  signalsForSkillAt,
  type SkillSignalsContext,
} from "./inventory/skillInspect.js";
import {
  deleteSkillToTrash,
  editSkillFrontmatter,
  installSkillFromGit,
  scaffoldSkill,
  type FrontmatterEdit,
} from "./inventory/skillMutate.js";
import {
  readSkillState,
  writeSkillState,
  type SkillStateContext,
  type SkillStateQuery,
  type WritableSkillState,
} from "./inventory/skillState.js";
import {
  detectProviderCredential,
  fetchProviderQuota,
  type QuotaCapableProvider,
} from "./quota/index.js";
import { localSpendForProvider } from "./quota/localSpend.js";
import { createSidechatThread } from "./sidechat.js";
import { getSpawnEngine, initSpawnEngine } from "./threadSpawn.js";
import { truncateThreadTitle } from "./threadTitle.js";
import type { UsageRange } from "./usage/report.js";
import { buildAgentUsageReport } from "./usage/buildUsageReport.js";
import type {
  ApprovalDecision,
  CreateSideChatInput,
  ProviderConfig,
  ProviderKind,
  RuntimeEvent,
  SendTurnInput,
  SessionStartInput,
  UploadAttachmentInput,
  UserInputAnswers,
} from "./types.js";

// IPC wiring for the agent layer — the direct analogue of git/ipc.ts. Request/
// ack calls are `ipcMain.handle` (agent:*); the one runtime event stream is
// pushed on the "agent:event" side channel to every live renderer, exactly like
// git's "git:status-changed". Each renderer forwards it into its own store.

/** Rebuilds the context field by field rather than spreading the renderer's
 *  object, so a stray `home` or `fs` can't redirect a settings write somewhere
 *  the user never agreed to. */
function stateContext(query: SkillStateQuery): SkillStateContext {
  return {
    origin: query.origin,
    skillName: query.skillName,
    skillPath: query.skillPath,
    scope: query.scope,
    projectPath: query.projectPath ?? null,
    frontmatter: query.frontmatter ?? null,
  };
}

let service: AgentService | null = null;

/** The gateway instance (lazily created with the service). */
let gateway: GatewayHandle | null = null;

/** The single AgentService instance (lazily created). */
export function getAgentService(): AgentService {
  if (!service) service = new AgentService();
  return service;
}

// Renderers currently subscribed to the event stream. We hold WebContents and
// drop them on destroy so a closed window leaks no forwarding.
const subscribers = new Set<WebContents>();

/** Register the agent:* IPC handlers. Call once, before creating the window. */
export function registerAgentIpc(): void {
  const svc = getAgentService();
  const store = getConversationStore();
  const attachments = getAttachmentStore();

  // Startup GC pass for orphaned attachment bytes (a crash between the
  // temp-write and the registry insert, or a row dropped after a failed
  // unlink, leaves files nothing references). Best-effort and off the hot
  // path — a failure just leaves the orphans for the next launch.
  void attachments.sweepOrphans();

  // Session lifecycle is main-process logic now (docs/thread-spawning-design.md
  // §5.1) — the spawn engine drives child threads headlessly through the same
  // dispatcher the handlers below forward to, so a spawned thread behaves
  // exactly like a renderer-driven one.
  const dispatcher = initThreadDispatcher({ service: svc, store, broadcast });

  // The agent-facing MCP gateway (docs/mcp-gateway-design.md): a loopback
  // streamable-HTTP server with scratchpad tools. Its events (scratchpad.updated)
  // flow through the same broadcast → agent:event stream; it watches the turn
  // lifecycle for its write-authority boundary. Token minting/revocation rides
  // AgentService.startSession/stopSession.
  gateway = createGateway({
    store,
    emit: (event) => broadcast(event),
    onEvents: (listener) => svc.onEvent(listener),
  });
  svc.attachGateway(gateway);

  // The spawn engine (docs/thread-spawning-design.md) drives agent-spawned
  // child threads headlessly through the same dispatcher as the renderer. Its
  // projection events are broadcast but never journaled — they recompute from
  // the store, and journaling would write derived state back into the source
  // of truth.
  initSpawnEngine({
    store,
    providers: svc,
    dispatcher,
    emit: (event) => broadcast(event, false),
    onEvents: (listener) => svc.onEvent(listener),
  });

  /** Push one runtime event to every subscribed renderer (and optionally
   *  journal it). Title updates skip the store's applyEvent — they're written
   *  directly via setTitle. The single choke point every event crosses, so it
   *  stamps the two envelope fields consumers dedupe/correlate on: `eventId`
   *  (assigned once here when the adapter didn't mint its own, so the journal
   *  and every renderer agree on one id per event) and `parentTurnId` (the
   *  spawning turn's id for a spawned child's events, registered at dispatch —
   *  F10). */
  function broadcast(event: RuntimeEvent, journal = true): void {
    const stamped: RuntimeEvent =
      event.eventId !== undefined && event.parentTurnId !== undefined
        ? event
        : {
            ...event,
            ...(event.eventId === undefined ? { eventId: randomUUID() } : {}),
            ...(event.parentTurnId === undefined
              ? { parentTurnId: dispatcher.spawnParentTurnId(event.threadId) }
              : {}),
          };
    if (journal) store.applyEvent(stamped);
    // Slim before the wire: the journal keeps the FULL payload; the renderer
    // copy gets bounded tool-call bodies (see projectRuntimeEventForIpc).
    const wire = projectRuntimeEventForIpc(stamped);
    for (const wc of subscribers) {
      if (!wc.isDestroyed()) wc.send("agent:event", wire);
    }
  }

  // Fan the merged event stream out to every subscribed renderer, and journal
  // it to the conversation store on the way through (best-effort — the store
  // guards itself, so persistence can never disrupt the live stream).
  svc.onEvent((event) => {
    // User-input questions and tool approvals are ephemeral live round-trips
    // (like title updates) — stream them to renderers but don't journal them
    // into the transcript. Spawn events are derived projections recomputed from
    // the store on every read — journaling them would write derived state back
    // into the source of truth.
    const journal =
      event.type !== "user-input.requested" &&
      event.type !== "user-input.resolved" &&
      event.type !== "approval.requested" &&
      event.type !== "approval.resolved" &&
      event.type !== "thread.spawned" &&
      event.type !== "thread.spawn-updated";
    broadcast(event, journal);
    // When a turn settles, snapshot the repo state it left behind (branch +
    // working-tree diffstat) onto the thread, so the Project Home "recent
    // conversations" block reads real numbers. Off the hot path and best-effort
    // — a git failure never disturbs the live stream.
    if (event.type === "turn.completed") {
      dispatcher.onTurnCompleted(event.threadId);
    }
  });

  // Discovery + models (read-only probes of the user's installed CLIs).
  // `agent:surface` is the instant one — last known statuses + catalogs off the
  // disk cache, no CLI spawned — so the renderer can present a real provider
  // list at app open and refresh behind it.
  ipcMain.handle("agent:surface", () => svc.cachedSurface());
  ipcMain.handle("agent:warm", () => svc.warm());
  ipcMain.handle("agent:discover", () => svc.discover());
  ipcMain.handle("agent:models", (_event, provider: ProviderKind) =>
    svc.listModels(provider),
  );

  // Per-provider install settings (custom CLI binary path, …). Read on the
  // Providers settings pane; a write persists to disk and re-points the live
  // adapter so the next discover / session uses it.
  ipcMain.handle("agent:get-settings", () => svc.getProviderSettings());
  ipcMain.handle(
    "agent:set-settings",
    (_event, provider: ProviderKind, config: ProviderConfig) =>
      svc.setProviderSettings(provider, config),
  );

  // Install maintenance: how each CLI was installed, and whether it's behind.
  // `check-latest` is the only provider call that reaches the network, so it's
  // its own channel — nothing on the launch or send path touches it.
  ipcMain.handle(
    "agent:provider-maintenance",
    (_event, options?: { checkLatest?: boolean; force?: boolean }) =>
      svc.providerMaintenance(options),
  );
  ipcMain.handle("agent:update-provider", (_event, provider: ProviderKind) =>
    svc.updateProvider(provider),
  );

  // Subscribe/unsubscribe the calling renderer to the event stream.
  ipcMain.handle("agent:subscribe", (event) => {
    const wc = event.sender;
    if (subscribers.has(wc)) return;
    subscribers.add(wc);
    wc.once("destroyed", () => subscribers.delete(wc));
    // Reload recovery: approvals/user-inputs are live round-trips and are
    // deliberately not journaled, so a re-subscribing renderer (⌘R, crash
    // reload) would otherwise never learn about an ask its turn is still
    // parked on — the modal stays gone and the turn stays blocked. Replay the
    // CURRENT parked asks to THIS subscriber only, as fresh emissions of the
    // same live ask (fresh envelope ids; sent outside broadcast so they are
    // never journaled). A second pass a beat later covers asks whose thread
    // session the reloading renderer hasn't hydrated yet — the renderer's
    // fan-out drops events aimed at a session object that doesn't exist — and
    // only still-parked, not-yet-sent asks ride the second pass, so a
    // delivered prompt is never duplicated.
    const sent = new Set<string>();
    const replayPending = () => {
      if (wc.isDestroyed()) return;
      for (const pending of svc.pendingInteractions()) {
        const key = `${pending.threadId}::${pending.requestId}`;
        if (sent.has(key)) continue;
        sent.add(key);
        wc.send("agent:event", {
          ...pending.event,
          eventId: randomUUID(),
          parentTurnId: dispatcher.spawnParentTurnId(pending.threadId),
        });
      }
    };
    replayPending();
    setTimeout(replayPending, 800);
  });
  ipcMain.handle("agent:unsubscribe", (event) => {
    subscribers.delete(event.sender);
  });

  // Session lifecycle (request/ack — results flow through agent:event). The
  // bodies live in the thread dispatcher (dispatch.ts) — the spawn engine
  // drives the same path headlessly.
  ipcMain.handle("agent:start-session", (_event, input: SessionStartInput) =>
    dispatcher.startThread(input),
  );
  // Persist an attachment's bytes to disk and hand back the bytes-free metadata
  // the composer carries on its next turn. Runs before send-turn — the composer
  // uploads on pick/drop/paste, then sends the turn with the returned ids.
  ipcMain.handle("agent:upload-attachment", (_event, input: UploadAttachmentInput) =>
    attachments.save(input),
  );

  // Side chat creation (docs/side-chat-design.md). The renderer mints the
  // thread id + request id; a replay of the same id resolves "exists" instead
  // of forking twice. The result streams to every renderer as
  // `thread.sidechat-created`; the child's session/turns then flow through the
  // normal start-session → send-turn path (the first send carries the
  // imported-transcript bootstrap).
  ipcMain.handle("agent:create-side-chat", (_event, input: CreateSideChatInput) => {
    const result = createSidechatThread(input);
    if (result.status === "created") {
      broadcast({
        type: "thread.sidechat-created",
        threadId: result.threadId,
        provider: result.provider,
        at: Date.now(),
        source: "kone.store",
        sourceThreadId: result.sourceThreadId,
        requestId: result.requestId,
      });
    }
    return result;
  });

  ipcMain.handle("agent:send-turn", (_event, input: SendTurnInput) =>
    dispatcher.sendThreadTurn(input),
  );
  ipcMain.handle("agent:interrupt", (_event, threadId: string) =>
    svc.interruptTurn(threadId),
  );
  ipcMain.handle("agent:stop-session", (_event, threadId: string) =>
    svc.stopSession(threadId),
  );
  ipcMain.handle(
    "agent:respond",
    (_event, threadId: string, requestId: string, decision: ApprovalDecision) =>
      svc.respondToRequest(threadId, requestId, decision),
  );
  ipcMain.handle(
    "agent:respond-user-input",
    (_event, threadId: string, requestId: string, answers: UserInputAnswers) =>
      svc.respondToUserInput(threadId, requestId, answers),
  );
  // Nested subagent controls — scoped to one run inside a turn, so stopping or
  // steering a child never touches the parent conversation.
  ipcMain.handle("agent:stop-subagent", (_event, threadId: string, toolUseId: string) =>
    svc.stopSubagent(threadId, toolUseId),
  );
  ipcMain.handle(
    "agent:steer-subagent",
    (_event, threadId: string, toolUseId: string, message: string) =>
      svc.steerSubagent(threadId, toolUseId, message),
  );

  // Durable turn queue + steering (the busy-intercept follow-up path). A
  // follow-up sent while a turn runs is durably enqueued and auto-promoted
  // when the turn settles; `queued-turns` lists the thread's active rows,
  // `queue-cancel` drops one (cancels with reason "user"), and `steer-turn`
  // routes a mid-turn message to the live turn when the provider has a
  // live-steer channel, else enqueues it as a steer. All three resolve once
  // accepted; the resulting events flow through agent:event.
  ipcMain.handle("agent:queued-turns", (_event, threadId: string) =>
    svc.listQueuedTurns(threadId),
  );
  ipcMain.handle("agent:queue-cancel", (_event, threadId: string, queueId: string) =>
    svc.cancelQueuedTurn(threadId, queueId),
  );
  ipcMain.handle("agent:steer-turn", (_event, input: SendTurnInput) =>
    svc.steerTurn(input),
  );
  // Read a parent thread's spawned children, projected fresh from the store.
  // The spawn events aren't journaled (derived state), so a reloaded renderer
  // has no record of them — this is the one read that repopulates the dock.
  ipcMain.handle("agent:spawn-children", (_event, threadId: string) =>
    getSpawnEngine()?.children(threadId) ?? [],
  );

  // Persisted conversation history. Reads rehydrate a project's last thread on
  // open and back the "recent conversations" block; the two mutations let a row
  // be archived (hidden, recoverable) or deleted (gone).
  // History reads return the same shapes but with tool-call bodies bounded for
  // the wire — the store keeps the full payloads (projectStoredThreadForIpc).
  ipcMain.handle("agent:history-latest", (_event, projectPath: string) => {
    const thread = store.latestThread(projectPath);
    return thread ? projectStoredThreadForIpc(thread) : null;
  });
  ipcMain.handle("agent:history-thread", (_event, threadId: string) => {
    const thread = store.loadThread(threadId);
    return thread ? projectStoredThreadForIpc(thread) : null;
  });
  // Windowed thread read (user-anchored keyset pages): first page when no
  // cursor is given, then the next strictly older page per cursor. The
  // renderer treats `nextCursor` as opaque and echoes it back. (Renderer
  // integration is pending the bridge type + load-older UI; see the store's
  // loadThreadPage doc.)
  ipcMain.handle(
    "agent:history-thread-page",
    (_event, threadId: string, options?: { limit?: number; cursor?: string }) => {
      const page = store.loadThreadPage(threadId, options);
      if (!page) return null;
      return { ...page, blocks: projectStoredBlocksForIpc(page.blocks) };
    },
  );
  ipcMain.handle("agent:history-list", (_event, projectPath: string) =>
    store.listThreads(projectPath),
  );
  // Lifetime, fully-local profile stats — aggregated in SQL across every
  // project's threads for the standalone profile board.
  ipcMain.handle("agent:profile-stats", () => store.profileStats());

  // ── the Agents space ──────────────────────────────────────────────────────
  // Usage scans Claude/Codex CLI transcripts (overall spend) and merges kone-
  // Claude/Codex from CLI transcripts; Cursor from dashboard CSV when signed in;
  // OpenCode/Droid/Antigravity from store rows for providers without transcript
  // scanning.
  ipcMain.handle(
    "agent:usage-report",
    async (
      _event,
      options: { range: UsageRange; projectPath?: string | null; forceRefresh?: boolean },
    ) => buildAgentUsageReport(store, options),
  );
  // Offline presence check only — this decides whether the row offers to
  // connect, so it must never touch the network. It may probe the keychain
  // (Claude Code and the Cursor CLI keep their login there), but only through
  // the short-timeout presence probe, never the full 90s read a fetch uses.
  ipcMain.handle("agent:quota-detect", (_event, provider: QuotaCapableProvider) =>
    detectProviderCredential(provider),
  );
  // Reaches the provider's own usage API with the token its CLI already stored.
  // `allowKeychain` arrives true only from a user-initiated connect/refresh.
  //
  // The provider's own endpoint reports rate-limit windows but no per-day spend
  // for Claude/Codex/Cursor (only OpenCode carries its own cost). So a connected
  // report gets its Today/Yesterday/30-day tiles + trend folded in here from the
  // local usage scan — the same numbers the Usage tab shows, filtered to the one
  // provider. Kept out of quota/index.ts so that layer stays free of the store;
  // enrichment is best-effort and never blocks or fails the quota read, and it
  // returns a copy rather than mutating the cached report.
  ipcMain.handle(
    "agent:quota-fetch",
    async (_event, provider: QuotaCapableProvider, options?: { allowKeychain?: boolean; force?: boolean }) => {
      const report = await fetchProviderQuota(provider, options ?? {});
      if (report.connection !== "connected" || provider === "opencode") return report;
      if (report.spend.length > 0 || report.trend.length > 0) return report;
      try {
        const { spend, trend } = await localSpendForProvider(store, provider, {
          forceRefresh: options?.force,
        });
        if (spend.length === 0 && trend.length === 0) return report;
        return { ...report, spend, trend };
      } catch (error) {
        console.warn(`Local spend enrichment failed for ${provider}: ${String(error)}`);
        return report;
      }
    },
  );
  ipcMain.handle("agent:inventory-scan", (_event, projectPath: string | null) =>
    scanAgentInventory(projectPath),
  );
  ipcMain.handle("agent:skill-read", (_event, skillMdPath: string) => readSkillDetail(skillMdPath));
  ipcMain.handle("agent:skill-state-read", (_event, query: SkillStateQuery) =>
    readSkillState(stateContext(query)),
  );
  ipcMain.handle(
    "agent:skill-state-write",
    (_event, query: SkillStateQuery, state: WritableSkillState) =>
      writeSkillState({ ...stateContext(query), state }),
  );
  ipcMain.handle("agent:skill-lint", (_event, skillMdPath: string) => lintSkillAt(skillMdPath));
  ipcMain.handle("agent:skill-signals", (_event, skillMdPath: string, context: SkillSignalsContext) =>
    signalsForSkillAt(skillMdPath, { origin: context.origin, scope: context.scope }),
  );
  ipcMain.handle("agent:skill-scaffold", (_event, root: string, name: string, description: string) =>
    scaffoldSkill(root, name, description),
  );
  ipcMain.handle(
    "agent:skill-edit-frontmatter",
    (_event, skillMdPath: string, edits: FrontmatterEdit[]) =>
      editSkillFrontmatter(skillMdPath, edits),
  );
  ipcMain.handle("agent:skill-remove", (_event, skillDir: string) => deleteSkillToTrash(skillDir));
  ipcMain.handle("agent:skill-install", (_event, url: string, destRoot: string) =>
    installSkillFromGit(url, destRoot),
  );
  ipcMain.handle("agent:history-archive", (_event, threadId: string, archived: boolean) => {
    const result = store.setArchived(threadId, archived);
    if (!result.ok) {
      console.warn(
        `[ipc] archive ${archived ? "refused" : "failed"} for ${threadId}: ${result.reason}`,
      );
    }
  });
  ipcMain.handle("agent:history-delete", async (_event, threadId: string) => {
    // Pre-flight busy guard BEFORE touching files: a spawned child mid-turn
    // must not be destroyed under its parent, and refusing must leave every
    // byte and row untouched.
    const guard = store.canDeleteThread(threadId);
    if (!guard.ok) {
      console.warn(`[ipc] delete refused for ${threadId}: ${guard.reason}`);
      return;
    }
    // Flip the thread's queued + promoting rows and surface one
    // turn.queued-cancelled (reason "thread-deleted") per row BEFORE the
    // thread is dropped: a deleted thread's follow-ups must never survive to
    // resurrect (deleteThread removes the rows outright), and every renderer
    // must learn its chips are gone. The service owns the stop-path reason
    // ("stop"); this delete path emits its own reason through the same
    // broadcast every service event crosses.
    const meta = store.threadMeta(threadId);
    const cancelledQueueIds = store.cancelQueuedTurnsForThread(threadId);
    if (meta) {
      for (const queueId of cancelledQueueIds) {
        broadcast({
          type: "turn.queued-cancelled",
          threadId,
          provider: meta.provider,
          queueId,
          reason: "thread-deleted",
          at: Date.now(),
          source: "kone.store",
        });
      }
    }
    // Unlink the thread's attachment files first (best-effort), then drop every
    // row — otherwise the bytes on disk would outlive the conversation.
    await attachments.deleteThreadFiles(threadId);
    store.deleteThread(threadId);
    dispatcher.forgetThread(threadId);
  });
  // Pin state lives in the DB (v18), so a pinned thread follows the thread
  // across browser profiles — the Project Home / launcher pin toggles call
  // this instead of writing browser localStorage.
  ipcMain.handle("agent:set-pinned", (_event, threadId: string, pinned: boolean) =>
    store.setPinned(threadId, pinned),
  );
  // Persist the user's per-thread picker selection (model / effort /
  // serviceTier / contextWindow) so a reopened thread restores the picker
  // exactly where it was left.
  ipcMain.handle(
    "agent:set-thread-selection",
    (
      _event,
      threadId: string,
      selection: { model?: string; effort?: string; serviceTier?: string; contextWindow?: string },
    ) => store.setThreadSelection(threadId, selection),
  );
  // User-initiated rename (the strip-header / recents-row rename). Sets the
  // title WITHOUT touching recency ordering (a rename is bookkeeping, not
  // conversation activity), and broadcasts the same thread.title.updated
  // event the agent-generated rename path uses, so every renderer's live
  // row/tab label updates. Resolves true when the title actually changed.
  ipcMain.handle("agent:rename-thread", (_event, threadId: string, title: string) => {
    const cleaned = truncateThreadTitle(String(title ?? "").trim());
    const changed = store.renameThread(threadId, cleaned);
    if (changed) {
      const meta = store.threadMeta(threadId);
      if (meta) {
        broadcast(
          {
            type: "thread.title.updated",
            threadId,
            provider: meta.provider,
            at: Date.now(),
            source: "kone.store",
            title: cleaned,
          },
          false,
        );
      }
    }
    return changed;
  });
}

/** Stop every agent subprocess. Call from app quit so nothing is orphaned. */
export async function shutdownAgents(): Promise<void> {
  if (gateway) {
    await gateway.shutdown().catch(() => {});
    gateway = null;
  }
  if (service) await service.stopAll();
}

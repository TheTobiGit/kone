import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { BrowserWindow, ipcMain, shell } from "electron";

import { AgentService } from "@kone/agent-core/AgentService.js";
import { getAttachmentStore } from "@kone/agent-core/AttachmentStore.js";
import {
  getConversationStore,
  projectRuntimeEventForIpc,
  projectStoredBlocksForIpc,
  projectStoredThreadForIpc,
} from "@kone/agent-core/ConversationStore.js";
import { initThreadDispatcher } from "@kone/agent-core/dispatch.js";
import { startIrcDelivery } from "@kone/agent-core/ircDelivery.js";
import { getIrcMailbox } from "@kone/agent-core/gateway/tools/irc.js";
import { EventSubscriptions } from "@kone/agent-core/eventSubscriptions.js";
import { createGateway, type GatewayHandle } from "@kone/agent-core/gateway/index.js";
import { currentAppearance, currentThemeRoster } from "../modules/system/system.js";
import {
  currentAgentRoster,
  currentProjects,
  currentStripSettings,
} from "../modules/appState/index.js";
import { scanAgentInventory } from "@kone/agent-core/inventory/index.js";
import { readSkillDetail } from "@kone/agent-core/inventory/skillDetail.js";
import { skillRootTargets } from "@kone/agent-core/inventory/skills.js";
import {
  lintSkillAt,
  signalsForSkillAt,
  type SkillSignalsContext,
} from "@kone/agent-core/inventory/skillInspect.js";
import {
  deleteSkillToTrash,
  editSkillFrontmatter,
  installSkillFromGit,
  scaffoldSkill,
  type FrontmatterEdit,
} from "@kone/agent-core/inventory/skillMutate.js";
import {
  readSkillState,
  writeSkillState,
  type SkillStateContext,
  type SkillStateQuery,
  type WritableSkillState,
} from "@kone/agent-core/inventory/skillState.js";
import {
  detectProviderCredential,
  fetchProviderQuota,
  type QuotaCapableProvider,
} from "@kone/agent-core/quota/index.js";
import { localSpendForProvider } from "@kone/agent-core/quota/localSpend.js";
import { createSidechatThread } from "@kone/agent-core/sidechat.js";
import { getSpawnEngine, initSpawnEngine } from "@kone/agent-core/threadSpawn.js";
import { truncateThreadTitle } from "@kone/agent-core/threadTitle.js";
import type { UsageRange } from "@kone/agent-core/usage/report.js";
import { buildAgentUsageReport } from "@kone/agent-core/usage/buildUsageReport.js";
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
} from "@kone/agent-core/types.js";

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

/** Teardown for the IRC delivery subscription — dropped at quit so no armed
 *  delivery timer holds the process open. */
let stopIrcDelivery: (() => void) | null = null;

/** The single AgentService instance (lazily created). */
export function getAgentService(): AgentService {
  if (!service) service = new AgentService();
  return service;
}

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
  // Renderer event-stream subscriptions: who gets the live stream, plus the
  // reload-recovery replay of parked asks. One instance per process; broadcast
  // and the subscribe/unsubscribe handlers below all read it.
  const subscriptions = new EventSubscriptions({
    pendingInteractions: () => svc.pendingInteractions(),
    parentTurnIdFor: (threadId) => dispatcher.spawnParentTurnId(threadId),
    scheduleDelay: (fn, ms) => setTimeout(fn, ms),
  });

  // The agent-facing MCP gateway (docs/mcp-gateway-design.md): a loopback
  // streamable-HTTP server with scratchpad tools. Its events (scratchpad.updated)
  // flow through the same broadcast → agent:event stream; it watches the turn
  // lifecycle for its write-authority boundary. Token minting/revocation rides
  // AgentService.startSession/stopSession.
  gateway = createGateway({
    store,
    emit: (event) => broadcast(event),
    onEvents: (listener) => svc.onEvent(listener),
    isThreadLive: (threadId) => svc.hasLiveSession(threadId),
    // The renderer owns the appearance and pushes it to the shell; reading it
    // back here is what lets app_get_theme_state describe the actual window
    // instead of the last theme an agent asked for.
    readAppearance: () => currentAppearance(),
    // Likewise the library: an install's themes are its built-ins plus whatever
    // the user imported or authored, and the renderer is the only one that
    // knows the whole set.
    readThemes: () => currentThemeRoster(),
    // The roster the same way: kone's shipped agents are prose in the
    // renderer's bundle and a stored row is a delta against one, so the
    // resolved roster an agent should be told about exists only there.
    readAgents: () => currentAgentRoster(),
    // And the thread strip's settings, which are per-install renderer storage
    // the main process has no way to read.
    readStripSettings: () => currentStripSettings(),
    // The projects the same way — which folders the user has opened is browser
    // storage. Only the list crosses: the branch and diff behind each one are
    // read from git when a tool is called, so they are never a stale mirror.
    readProjects: () => currentProjects(),
    // Starting a thread goes through the same dispatcher the renderer's own
    // "new thread" path forwards to, so a thread the assistant opens is an
    // ordinary thread on the project's board rather than a second kind of one.
    threads: {
      startThread: (start) => dispatcher.startThread(start),
      sendThreadTurn: (turn, options) => dispatcher.sendThreadTurn(turn, options),
    },
    // And the provider surface the service already keeps warm, so a thread is
    // never started on a CLI this machine cannot run.
    threadAvailability: async () => {
      const surface = svc.cachedSurface();
      return surface.statuses.map((status) => ({
        provider: status.provider,
        available: status.available,
        models: (surface.models[status.provider] ?? []).map((model) => model.id),
      }));
    },
  });
  svc.attachGateway(gateway);

  // Agent-to-agent messages reach their recipient's turn rather than sitting in
  // a mailbox nobody drains: a running thread is steered, an idle one is woken.
  // Without this the IRC tools are a dead drop — every inbox read comes back
  // empty and an agent that reached for one concludes messaging is broken.
  stopIrcDelivery = startIrcDelivery({
    mailbox: getIrcMailbox(),
    dispatcher,
    isLive: (threadId) => svc.hasLiveSession(threadId),
    isBusy: (threadId) => svc.isThreadBusy(threadId),
    // Mail that arrived while a thread was away has nothing scheduled to read
    // it: the sender's delivery already fired and found no live session. Coming
    // back is the moment to flush it.
    onThreadLive: (listener) =>
      svc.onEvent((event) => {
        if (event.type === "session.started") listener(event.threadId);
      }),
  });

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
    let stamped: RuntimeEvent;
    if (event.eventId !== undefined && event.parentTurnId !== undefined) {
      stamped = event;
    } else {
      stamped = { ...event };
      if (event.eventId === undefined) stamped.eventId = randomUUID();
      if (event.parentTurnId === undefined) {
        stamped.parentTurnId = dispatcher.spawnParentTurnId(event.threadId);
      }
    }
    if (journal) store.applyEvent(stamped);
    // Slim before the wire: the journal keeps the FULL payload; the renderer
    // copy gets bounded tool-call bodies (see projectRuntimeEventForIpc).
    const wire = projectRuntimeEventForIpc(stamped);
    subscriptions.broadcast(wire);
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
      event.type !== "thread.spawn-updated" &&
      // Archive stamps are meta like title updates: setThreadArchived wrote
      // the column directly, so journaling the announcement would record
      // derived state in the transcript journal.
      event.type !== "thread.archived" &&
      event.type !== "thread.unarchived" &&
      // App steering is live instruction for the renderer, not transcript: the
      // theme, the agent roster, the preset sub-agents and the thread strip are
      // app state the user can see for themselves, and journaling the
      // announcement would record derived state in the turn's transcript.
      event.type !== "app.theme_mutation" &&
      event.type !== "app.agent_mutation" &&
      event.type !== "app.subagent_presets_changed" &&
      event.type !== "app.strip_mutation";
    broadcast(event, journal);
    // When a turn settles, snapshot the repo state it left behind (branch +
    // working-tree diffstat) onto the thread, so the Project Home "recent
    // conversations" block reads real numbers. Off the hot path and best-effort
    // — a git failure never disturbs the live stream.
    if (event.type === "turn.completed") {
      dispatcher.onTurnCompleted(event.threadId);
    }
  });

  // A provider surface that changed under the renderer's feet — a CLI the user
  // signed into, a slow probe that finally answered — is pushed rather than
  // waited for. AgentService only fires when a round actually differs, so an
  // idle machine stays quiet. Sent to every window: provider health is machine
  // state, not thread state, so it isn't on the `agent:event` stream and has no
  // subscriber set to respect.
  svc.onProvidersChanged((statuses) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send("agent:providers-changed", statuses);
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

  // Subscribe/unsubscribe the calling renderer to the event stream. Subscribe
  // always runs the reload-recovery replay — see eventSubscriptions.ts for why
  // a re-subscribing renderer must be re-presented the asks it was parked on.
  ipcMain.handle("agent:subscribe", (event) => {
    subscriptions.subscribe(event.sender);
  });
  ipcMain.handle("agent:unsubscribe", (event) => {
    subscriptions.unsubscribe(event.sender);
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
  ipcMain.handle("agent:get-attachment-path", (_event, attachmentId: string) => {
    return attachments.resolveAbsPath(attachmentId);
  });
  ipcMain.handle("agent:show-attachment-in-folder", (_event, attachmentId: string) => {
    const absPath = attachments.resolveAbsPath(attachmentId);
    if (absPath && existsSync(absPath)) {
      shell.showItemInFolder(absPath);
      return true;
    }
    return false;
  });

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
    "agent:respond-approval",
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
    dispatcher.steerThreadTurn(input),
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
  // `history-latest` is metadata only: rehydrate() resolves the transcript
  // itself via the windowed `history-thread-page` (falling back to
  // `history-thread` only if paging comes back empty), so a full-thread
  // reconstruction here would be built and thrown away on every project open.
  ipcMain.handle("agent:history-latest", (_event, projectPath: string) => {
    return store.latestThreadMeta(projectPath);
  });
  ipcMain.handle("agent:history-thread", (_event, threadId: string) => {
    const thread = store.loadThread(threadId);
    return thread ? projectStoredThreadForIpc(thread) : null;
  });
  // Windowed thread read (user-anchored keyset pages): first page when no
  // cursor is given, then the next strictly older page per cursor. The
  // renderer treats `nextCursor` as opaque and echoes it back — this is
  // rehydrate()'s primary read path (see useAgent.ts).
  ipcMain.handle(
    "agent:history-thread-page",
    (_event, threadId: string, options?: { limit?: number; cursor?: string }) => {
      const page = store.loadThreadPage(threadId, options);
      if (!page) return null;
      return { ...page, blocks: projectStoredBlocksForIpc(page.blocks) };
    },
  );
  ipcMain.handle(
    "agent:history-list",
    (_event, projectPath: string, options?: { archived?: boolean }) =>
      store.listThreads(projectPath, options),
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
  ipcMain.handle("agent:skill-roots", (_event, projectPath: string | null) =>
    skillRootTargets(projectPath),
  );
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
  // Archive/restore runs through the service, not the bare store: the service
  // cancels the subtree's queued turns (a hidden thread must not keep a queue
  // nobody can see) and emits thread.archived / thread.unarchived so every
  // surface — this window's lists, other windows' — reconciles. The result is
  // returned so the asking surface can undo its optimistic row drop on a busy
  // refusal instead of watching the row flicker away and come back.
  ipcMain.handle("agent:history-archive", (_event, threadId: string, archived: boolean) =>
    svc.setThreadArchived(threadId, archived),
  );
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
  // Done state lives in the DB alongside pins, so a thread you have finished
  // with stays finished with across browser profiles. Distinct from archive:
  // the thread stays in the live list, it just stops asking — and it starts
  // asking again on its own the moment the agent speaks in it.
  ipcMain.handle("agent:set-done", (_event, threadId: string, done: boolean) =>
    store.setDone(threadId, done),
  );
  // Read state lives in the DB beside pins and done, so a reply you have
  // already seen stays seen across profiles and restarts. A visit time, not an
  // unread flag: the surface showing the thread is the only writer, and every
  // reader derives unread by comparing it with the thread's last activity.
  ipcMain.handle(
    "agent:set-visited",
    (_event, threadId: string, at: number, force?: boolean) =>
      store.setVisited(threadId, at, force ?? false),
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
  if (stopIrcDelivery) {
    stopIrcDelivery();
    stopIrcDelivery = null;
  }
  if (gateway) {
    await gateway.shutdown().catch(() => {});
    gateway = null;
  }
  if (service) await service.stopAll();
}

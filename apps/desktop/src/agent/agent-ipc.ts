import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";

import { AgentService } from "@kone/agent-core/AgentService.js";
import { getAttachmentStore } from "@kone/agent-core/AttachmentStore.js";
import {
  getConversationStore,
  projectRuntimeEventForIpc,
  projectStoredBlocksForIpc,
  projectStoredThreadForIpc,
} from "@kone/agent-core/ConversationStore.js";
import { initThreadDispatcher } from "@kone/agent-core/dispatch.js";
import { JobRunner } from "@kone/agent-core/jobRunner.js";
import { prepareQuitResume } from "@kone/agent-core/quitResume.js";
import { provisionWorktree } from "../modules/git/worktreeProvision.js";
import { freshestBase } from "../modules/git/worktreeBase.js";
import { renameGeneratedBranch } from "../modules/git/worktreeBranchName.js";
import { startWorktreeSweeper, sweepIdleWorktrees } from "../modules/git/worktreeSweep.js";
import { removeWorktree } from "../modules/git/worktree.js";
import {
  collectSubtreeWorktrees,
  removeCollectedWorktrees,
} from "../modules/git/worktreeCleanup.js";
import { indexThreadGates, threadGateFor } from "@kone/agent-core/spawnProjection.js";
import { startIrcDelivery } from "@kone/agent-core/ircDelivery.js";
import { getIrcMailbox } from "@kone/agent-core/gateway/tools/irc.js";
import { EventSubscriptions } from "@kone/agent-core/eventSubscriptions.js";
import { createGateway, type GatewayHandle } from "@kone/agent-core/gateway/index.js";
import { currentAppearance, currentThemeRoster } from "../modules/system/system.js";
import {
  currentAgentRoster,
  currentProjects,
  currentStripSettings,
  currentTypographySettings,
} from "../modules/appState/index.js";
import { scanAgentInventory } from "@kone/agent-core/inventory/index.js";
import { readSkillDetail } from "@kone/agent-core/inventory/skillDetail.js";
import {
  deleteSkillToTrash,
  editSkillFrontmatter,
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
  readInternalSkillsSettings,
  setPluginInternalState,
  setSkillInternalState,
  writeInternalSkillsSettings,
  type InternalSkillsSettings,
} from "@kone/agent-core/skillsSettings.js";
import {
  detectProviderCredential,
  fetchProviderQuota,
  type QuotaCapableProvider,
} from "@kone/agent-core/quota/index.js";
import { localSpendForProvider } from "@kone/agent-core/quota/localSpend.js";
import { createSidechatThread } from "@kone/agent-core/sidechat.js";
import { createHandoffThread } from "@kone/agent-core/handoff.js";
import { handInThread } from "@kone/agent-core/handIn.js";
import { exportThread } from "@kone/agent-core/threadExport.js";
import {
  parseThreadExportFormat,
  type ThreadExportDialogResult,
} from "@kone/protocol/thread-export";
import { getSpawnEngine, initSpawnEngine } from "@kone/agent-core/threadSpawn.js";
import { acceptProviderThreadTitle, truncateThreadTitle } from "@kone/agent-core/threadTitle.js";
import type { UsageRange } from "@kone/agent-core/usage/report.js";
import { buildAgentUsageReport } from "@kone/agent-core/usage/buildUsageReport.js";
import type {
  ApprovalDecision,
  CreateHandoffInput,
  HandInInput,
  CreateSideChatInput,
  ForkThreadAtBlockInput,
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

/** The bench runner, built alongside the dispatcher it drives. Null until
 *  registerAgentIpc runs, so the event tap below tolerates its absence rather
 *  than assuming a boot order. */
let jobRunner: JobRunner | null = null;

/** Teardown for the IRC delivery subscription — dropped at quit so no armed
 *  delivery timer holds the process open. */
let stopIrcDelivery: (() => void) | null = null;
let stopWorktreeSweeper: (() => void) | null = null;

/** The bench runner, once registerAgentIpc has built it. Resolved lazily by
 *  the bench IPC handlers rather than handed to them at registration: the two
 *  modules are registered independently and neither should have to know which
 *  went first. Null means the agent layer is not up, and a queued job simply
 *  waits for the next drain. */
export function getJobRunner(): JobRunner | null {
  return jobRunner;
}

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
  const dispatcher = initThreadDispatcher({
    service: svc,
    store,
    broadcast,
    // Git lives out here, so the dispatcher is handed the capability rather
    // than reaching for it. A thread that asks for its own branch gets a
    // worktree built before its session starts, and the project's checkout is
    // never moved to satisfy it.
    provisionWorkspace: (request) => provisionWorktree(request),
    // A new worktree starts from the latest copy of its branch when the user's
    // copy is only behind, and from the user's copy whenever the latest would
    // drop commits or cannot be reached.
    freshenWorkspaceBase: ({ projectPath, base }) => freshestBase(projectPath, base),
    renameWorkspaceBranch: ({ worktreePath, title }) => renameGeneratedBranch(worktreePath, title),
    // Only ever a worktree this dispatcher just built and had to give back.
    // Not forced: a directory with work in it is never removed on a cancel, and
    // git refusing is the refusal to respect. A branch this build invented goes
    // with its worktree; a branch a person named is kept by the remover.
    releaseWorkspace: ({ projectPath, worktreePath, reclaimGeneratedBranch }) => {
      if (reclaimGeneratedBranch === true) {
        return removeWorktree(projectPath, { path: worktreePath, reclaimGeneratedBranch: true });
      }
      return removeWorktree(projectPath, { path: worktreePath });
    },
  });
  // Renderer event-stream subscriptions: who gets the live stream, plus the
  // reload-recovery replay of parked asks. One instance per process; broadcast
  // and the subscribe/unsubscribe handlers below all read it.
  const subscriptions = new EventSubscriptions({
    pendingInteractions: () => svc.pendingInteractions(),
    parentTurnIdFor: (threadId) => dispatcher.spawnParentTurnId(threadId),
    scheduleDelay: (fn, ms) => setTimeout(fn, ms),
  });

  // Quit-resume: a quit that landed while turns were in flight left a record
  // behind (prepared from main's before-quit). Claimed and resumed inside the
  // dispatcher — before the window exists, so no client command can race the
  // consume. Best-effort: resuming never fails boot.
  void dispatcher.resumeQuitInterruptedChatsAtBoot();

  // The bench runner: queued jobs become threads through the same dispatcher
  // every other thread goes through, so a job behaves exactly like a thread
  // someone started by hand — it is only the deciding that is automatic.
  jobRunner = new JobRunner({
    store,
    dispatcher: {
      startThread: (input) => dispatcher.startThread(input),
      sendThreadTurn: (input, options) => dispatcher.sendThreadTurn(input, options),
      stopThread: async (threadId) => {
        await svc.stopSession(threadId);
      },
    },
    emit: (event) => broadcast(event),
  });

  // After quit-resume, deliberately: a thread that was mid-turn when the app
  // died is work already in flight, and it should get its process back before
  // the queue starts handing out new ones. Best-effort, like the resume above.
  void jobRunner.recoverAtBoot();

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
    // What a thread is parked on, if anything — approvals and user-input
    // questions are live round-trips the store never journals, so the
    // service's parked snapshot is the only place the thread list can read
    // them from. The list reads one indexed snapshot per list call; a
    // single-thread read answers off a fresh snapshot per call. The
    // approval-outranks-question precedence is owned by the shared projector.
    pendingGates: () => indexThreadGates(svc.pendingInteractions()),
    pendingThreadGate: (threadId) =>
      threadGateFor(indexThreadGates(svc.pendingInteractions()), threadId),
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
    // The typography preferences the same way: custom fonts, sizes, line height,
    // measure and smoothing, mirrored from the renderer's app:state push.
    readTypography: () => currentTypographySettings(),
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
    threadControls: {
      stopThread: async (threadId) => {
        const wasRunning = svc.hasLiveSession(threadId);
        await svc.stopSession(threadId);
        // `stopped` is the idempotent guarantee, not a torn-something-down
        // report: stopSession no-ops on an idle thread, which still leaves it
        // with nothing running. `wasRunning` says whether a session existed.
        return { stopped: true, wasRunning };
      },
      archiveThread: async (threadId, archived) => {
        const res = await svc.setThreadArchived(threadId, archived);
        if (res.ok) return { ok: true, threadIds: res.threadIds };
        return { ok: false, reason: res.reason };
      },
      deleteThread: async (threadId) => {
        const guard = store.canDeleteThread(threadId);
        if (!guard.ok) {
          return { ok: false, reason: guard.reason };
        }
        // Snapshot the subtree's worktree directories BEFORE the rows go — after
        // deleteThread nothing names them anymore. Spawned children are included:
        // subtreeWorkspaces walks the whole subtree, not just the root.
        const doomed = collectSubtreeWorktrees(store, threadId);
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
        await attachments.deleteThreadFiles(threadId);
        const res = store.deleteThread(threadId);
        dispatcher.forgetThread(threadId);
        if (!res.ok) return { ok: false, reason: res.reason };
        // Remove AFTER a successful delete, best-effort and never failing it.
        // Forced: this delete is user-confirmed and destructive, so a worktree
        // with uncommitted work goes with its thread rather than stranding a
        // directory behind a conversation that no longer exists. A directory
        // another thread still names, or one outside the managed root, is left
        // alone. Generated kone/<hex> branches go with their worktree; a branch
        // a person named is never deleted automatically.
        await removeCollectedWorktrees(doomed, {
          isReferenced: (worktreePath) => store.isWorktreePathReferenced(worktreePath),
          remove: (projectPath, worktreePath) =>
            removeWorktree(projectPath, {
              path: worktreePath,
              force: true,
              reclaimGeneratedBranch: true,
            }),
        });
        return { ok: true };
      },
      renameThread: async (threadId, title) => {
        const rawTitle = title ? String(title).trim() : "";
        const cleaned = truncateThreadTitle(rawTitle);
        if (!cleaned) return { ok: false, reason: "empty_title" };
        const meta = store.threadMeta(threadId);
        const previousTitle = meta?.title ?? null;
        const changed = store.renameThread(threadId, cleaned);
        if (changed && meta) {
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
        return { ok: true, title: cleaned, previousTitle };
      },
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
    providers: {
      readSurface: () => svc.cachedSurface(),
      discover: () => svc.discover(),
      listModels: (provider) => svc.listModels(provider),
      providerMaintenance: (options) => svc.providerMaintenance(options),
      fetchQuota: async (provider, options) => {
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
      buildUsage: (options) => buildAgentUsageReport(store, options),
      readProjects: () => currentProjects(),
      getProviderSettings: () => svc.getProviderSettings(),
      setProviderEnabled: (provider, enabled) => {
        const current = svc.getProviderSettings()[provider] ?? {};
        return svc.setProviderSettings(provider, { ...current, enabled });
      },
      updateProvider: (provider) => svc.updateProvider(provider),
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
    emit: (event) => {
      const gated = gateProviderTitle(event);
      if (gated) broadcast(gated.event, false);
    },
    onEvents: (listener) => svc.onEvent(listener),
  });

  /** Push one runtime event to every subscribed renderer (and optionally
   *  journal it). The single choke point every event crosses, so it stamps
   *  the two envelope fields consumers dedupe/correlate on: `eventId`
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

  // A provider naming the conversation itself (the self-naming adapters'
  // `session_info_update`) is only trustworthy while the thread has never
  // been answered: on a resume or a hand-in the provider's "first prompt"
  // is the replay bootstrap, so its proposal names the bootstrap rather
  // than the conversation. The gate is a settled turn — not the title text,
  // and not the mere presence of an assistant block, whose running row
  // already exists by the time the title arrives and so cannot tell a first
  // turn from a later one. kone.store titles — the first-turn fallback, the
  // background generated rename, a user rename — always pass through. An
  // accepted proposal persists through the rename path so the store and the
  // UI agree; anything else is dropped, so a thread with answers keeps its
  // title and a provider cannot re-name it on later turns.
  function gateProviderTitle(event: RuntimeEvent): { event: RuntimeEvent; journal: boolean } | null {
    if (event.type !== "thread.title.updated" || event.source === "kone.store") {
      return { event, journal: true };
    }
    const accepted = acceptProviderThreadTitle({
      hasSettledTurn: store.hasSettledAssistantTurn(event.threadId),
      proposedTitle: event.title,
    });
    if (!accepted) return null;
    store.renameThread(event.threadId, accepted);
    return { event: { ...event, title: accepted }, journal: false };
  }

  /** Event types that stream to renderers but never journal: ephemeral live
   *  round-trips, derived projections, and meta stamps the store already
   *  wrote directly. */
  const STREAM_ONLY_EVENT_TYPES: ReadonlySet<RuntimeEvent["type"]> = new Set<RuntimeEvent["type"]>([
    "user-input.requested",
    "user-input.resolved",
    "approval.requested",
    "approval.resolved",
    "thread.spawned",
    "thread.spawn-updated",
    "thread.archived",
    "thread.unarchived",
    "thread.done.updated",
    "app.theme_mutation",
    "app.agent_mutation",
    "app.subagent_presets_changed",
    "app.strip_mutation",
    "app.typography_mutation",
    "bench.job-changed",
  ]);

  // Fan the merged event stream out to every subscribed renderer, and journal
  // it to the conversation store on the way through (best-effort — the store
  // guards itself, so persistence can never disrupt the live stream).
  svc.onEvent((incoming) => {
    const gated = gateProviderTitle(incoming);
    if (!gated) return;
    const { event, journal: gateJournal } = gated;
    const journal = gateJournal && !STREAM_ONLY_EVENT_TYPES.has(event.type);
    broadcast(event, journal);
    // When a turn settles, snapshot the repo state it left behind (branch +
    // working-tree diffstat) onto the thread, so the Project Home "recent
    // conversations" block reads real numbers. Off the hot path and best-effort
    // — a git failure never disturbs the live stream.
    if (event.type === "turn.completed") {
      dispatcher.onTurnCompleted(event.threadId);
    }
    // A settled turn is also how a job ends. The runner ignores threads that
    // carry no job — which is most of them — and advances that project's queue
    // when one does. An interrupt is a cancel rather than a failure: somebody
    // stopped it on purpose, and a queue that retries what you stopped is
    // worse than one that does not.
    if (event.type === "turn.completed") {
      void jobRunner?.onThreadSettled(event.threadId, { status: "done" });
    } else if (event.type === "turn.aborted") {
      void jobRunner?.onThreadSettled(
        event.threadId,
        event.reason === "interrupted"
          ? { status: "cancelled" }
          : { status: "failed", error: event.message ?? "The turn failed." },
      );
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
  // Backing out of a worktree that is still being built. Synchronous and always
  // accepted: it records the decision, and the teardown happens when the
  // creation it is undoing actually finishes.
  ipcMain.handle("agent:cancel-workspace", (_event, threadId: string) => {
    dispatcher.cancelThreadWorkspace(threadId);
  });
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

  // Thread handoff (agent:create-handoff). The renderer mints the thread id +
  // request id; a replay of the same id resolves "exists" instead of handing
  // off twice. The result streams to every renderer as
  // `thread.handoff-created`; the new thread's session/turns then flow
  // through the normal start-session → send-turn path (the first send
  // carries the handed-transcript bootstrap).
  ipcMain.handle("agent:create-handoff", (_event, input: CreateHandoffInput) => {
    const result = createHandoffThread(input);
    if (result.status === "created") {
      broadcast({
        type: "thread.handoff-created",
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

  // Edit-and-resend of an earlier user message (fork, never mutate). The
  // renderer mints the fork's thread id + request id; a replay of the same
  // creation resolves "exists" instead of forking twice or dispatching
  // twice. The fork's first turn is dispatched before this resolves, so the
  // renderer can open the fork onto a live turn.
  ipcMain.handle("agent:fork-thread-at-block", (_event, input: ForkThreadAtBlockInput) =>
    dispatcher.forkThreadTurn(input),
  );

  ipcMain.handle("agent:send-turn", (_event, input: SendTurnInput) =>
    dispatcher.sendThreadTurn(input),
  );
  // Manual context compaction (the service runs the provider's native call or
  // its `/compact` command fallback). Resolves once the "compacted" boundary
  // has been observed or synthesized — the boundary event itself streams on
  // agent:event like every other runtime event.
  ipcMain.handle("agent:compact-thread", (_event, threadId: string) =>
    dispatcher.compactThread(threadId),
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
  ipcMain.handle("agent:queue-reorder", (_event, threadId: string, queueIds: string[]) =>
    svc.reorderQueuedTurns(threadId, queueIds),
  );
  ipcMain.handle("agent:steer-turn", (_event, input: SendTurnInput) =>
    dispatcher.steerThreadTurn(input),
  );
  // Pre-turn repository snapshots. `turn-checkpoints` lists every snapshot
  // recorded for a thread (oldest first); `preview-turn-checkpoint` names what
  // restoring one would change without changing anything; `revert-turn-checkpoint`
  // restores the working tree to the tree as it was before the named turn ran.
  // The revert is conservative: without `force` it refuses with `dirty` and the
  // exact file lists when the tree differs, and the renderer re-issues with
  // `force` once the user has confirmed them. All three resolve with plain data —
  // a revert that cannot run answers with its reason rather than throwing, so
  // the renderer can say why.
  ipcMain.handle("agent:turn-checkpoints", (_event, threadId: string) =>
    svc.listTurnCheckpoints(threadId),
  );
  ipcMain.handle("agent:preview-turn-checkpoint", (_event, threadId: string, turnId: string) =>
    svc.previewTurnCheckpoint(threadId, turnId),
  );
  ipcMain.handle(
    "agent:revert-turn-checkpoint",
    (_event, threadId: string, turnId: string, force?: boolean) =>
      svc.revertToTurnCheckpoint(threadId, turnId, force),
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
  // Settled compaction boundaries for a thread, oldest first — the timeline's
  // "when/where compacted" markers. Few rows ever (one per boundary event),
  // so this is always the full list, never a page.
  ipcMain.handle("agent:history-compactions", (_event, threadId: string) =>
    store.listCompactions(threadId),
  );
  // Continuation links leaving a source thread, oldest first — the timeline's
  // "Handed to" markers. Few rows ever (one per continuation), so this is
  // always the full list, never a page.
  ipcMain.handle("agent:history-continuations", (_event, sourceThreadId: string) =>
    store.continuationsFromSource(sourceThreadId),
  );
  // Hand a live thread to another provider/model without leaving it: the
  // thread id, title and transcript all survive and only the provider
  // session underneath is replaced. Mirrors agent:create-handoff, minus the
  // new thread — so there is no renderer-minted id and no idempotency key,
  // because the thread already exists and IS the key.
  ipcMain.handle("agent:hand-in", (_event, input: HandInInput) =>
    handInThread(svc, input),
  );

  // Every time a thread changed hands, oldest first — the timeline's
  // "changed hands" markers. Few rows ever (one per swap), so this is always
  // a whole read.
  ipcMain.handle("agent:history-hand-ins", (_event, threadId: string) =>
    store.handInsForThread(threadId),
  );
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
  // Thread export to Markdown / JSON files. Reads the full stored rows —
  // never the wire-capped projection — and streams one page at a time, so a
  // long thread exports with bounded memory. exportThread refuses the same
  // threads the shared eligibility predicate blocks, so the caller and this
  // handler cannot disagree about what is exportable.
  ipcMain.handle(
    "agent:export-thread",
    (_event, threadId: string, format: string, filePath: string) =>
      exportThread(store, threadId, format, filePath),
  );
  // Native save dialog for a thread export. The renderer never touches the
  // filesystem here: it suggests a file name + format, the dialog runs in
  // this process, and the write itself goes through `agent:export-thread`
  // with the chosen path. A dismissal resolves `{ canceled: true }` — a
  // different shape from the export outcome, so the caller can tell "picked
  // nothing" apart from "wrote nothing".
  ipcMain.handle(
    "agent:export-thread-dialog",
    async (event, suggestedName: string, format: string): Promise<ThreadExportDialogResult> => {
      const parsed = parseThreadExportFormat(format);
      const extension = parsed === "json" ? "json" : "md";
      // The suggested name crosses from the renderer, so only its basename
      // is honored — a stray directory in it must not redirect the dialog.
      const base = path.basename(suggestedName).trim();
      const saveOptions = {
        title: "Export thread",
        defaultPath: base.length > 0 ? base : `thread-export.${extension}`,
        filters:
          parsed === "json"
            ? [{ name: "JSON transcript", extensions: ["json"] }]
            : [{ name: "Markdown transcript", extensions: ["md", "markdown"] }],
      };
      const owner = BrowserWindow.fromWebContents(event.sender);
      const picked = owner
        ? await dialog.showSaveDialog(owner, saveOptions)
        : await dialog.showSaveDialog(saveOptions);
      if (picked.canceled || !picked.filePath) return { canceled: true };
      return { canceled: false, filePath: picked.filePath };
    },
  );
  ipcMain.handle(
    "agent:history-list",
    (_event, projectPath: string, options?: { archived?: boolean }) =>
      store.listThreads(projectPath, options),
  );
  // Full-text conversation search over user prompts + turn items (FTS5,
  // ranked with a snippet per hit). Global across threads, or scoped to one
  // via options.threadId. Empty or unsearchable input answers empty. The
  // renderer owns the search UI; this only answers the query.
  ipcMain.handle(
    "agent:search-conversations",
    (_event, query: string, options?: { threadId?: string; limit?: number }) =>
      store.searchConversations(query, options),
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
  ipcMain.handle(
    "agent:inventory-scan",
    (_event, projectPath: string | string[] | null) => scanAgentInventory(projectPath),
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
  ipcMain.handle("agent:skill-internal-read", () => readInternalSkillsSettings());
  ipcMain.handle(
    "agent:skill-internal-write",
    (_event, patch: Partial<InternalSkillsSettings>) => writeInternalSkillsSettings(patch),
  );
  // Canonical internal-gate writes: the backend owns the disabled-list matching,
  // so renderers pass intent ({ path, name }, on/off) and adopt the returned
  // settings instead of reconstructing the list themselves.
  ipcMain.handle(
    "agent:skill-internal-set-skill",
    (_event, skill: { path?: string; name: string }, enabled: boolean) =>
      setSkillInternalState(skill, enabled),
  );
  ipcMain.handle(
    "agent:skill-internal-set-plugin",
    (_event, pluginIdOrDir: string, enabled: boolean) =>
      setPluginInternalState(pluginIdOrDir, enabled),
  );
  ipcMain.handle(
    "agent:skill-edit-frontmatter",
    (_event, skillMdPath: string, edits: FrontmatterEdit[]) =>
      editSkillFrontmatter(skillMdPath, edits),
  );
  ipcMain.handle("agent:skill-remove", (_event, skillDir: string) => deleteSkillToTrash(skillDir));
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
    // Snapshot the subtree's worktree directories BEFORE the rows go — after
    // deleteThread nothing names them anymore. Spawned children are included:
    // subtreeWorkspaces walks the whole subtree, not just the root.
    const doomed = collectSubtreeWorktrees(store, threadId);
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
    const deleted = store.deleteThread(threadId);
    dispatcher.forgetThread(threadId);
    if (!deleted.ok) return;
    // Remove AFTER a successful delete, best-effort and never failing it.
    // Forced: this delete is user-confirmed and destructive, so a worktree
    // with uncommitted work goes with its thread rather than stranding a
    // directory behind a conversation that no longer exists. A directory
    // another thread still names, or one outside the managed root, is left
    // alone. Generated kone/<hex> branches go with their worktree; a branch
    // a person named is never deleted automatically.
    await removeCollectedWorktrees(doomed, {
      isReferenced: (worktreePath) => store.isWorktreePathReferenced(worktreePath),
      remove: (projectPath, worktreePath) =>
        removeWorktree(projectPath, {
          path: worktreePath,
          force: true,
          reclaimGeneratedBranch: true,
        }),
    });
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
  // asking again on its own the moment the agent speaks in it. Runs through
  // the service, not the bare store, so every window learns the mark over
  // thread.done.updated the way archive/restore fan out.
  ipcMain.handle("agent:set-done", (_event, threadId: string, done: boolean) =>
    svc.setThreadDone(threadId, done),
  );
  // Run the thread-retention sweep now instead of waiting for its timer. The
  // inbox asks for one when it opens, so quiet threads settle while someone
  // is looking rather than minutes later in the middle of a thread.
  // Idempotent — a sweep with no candidates is two small reads and no writes.
  ipcMain.handle("agent:retention-sweep", () => svc.sweepStaleThreads());
  // Old worktrees are put away after the number of days the user picked (null
  // is off). Changing it runs a pass straight away, so a shorter window takes
  // effect while the setting is still on screen.
  ipcMain.handle("agent:worktree-cleanup-days", () => store.worktreeCleanupDays());
  ipcMain.handle("agent:set-worktree-cleanup-days", (_event, days: number | null) => {
    // Anything but a finite number from the renderer means off.
    store.setWorktreeCleanupDays(days !== null && Number.isFinite(days) ? days : null);
    void runWorktreeSweep();
    return store.worktreeCleanupDays();
  });
  const runWorktreeSweep = (): Promise<number> =>
    sweepIdleWorktrees({
      idleWorktrees: (cutoff, limit) => store.idleWorktrees(cutoff, limit),
      isThreadLive: (threadId) => svc.hasLiveSession(threadId),
      detachWorktree: (worktreePath, branch) => store.detachWorktree(worktreePath, branch),
      cleanupDays: () => store.worktreeCleanupDays(),
    }).catch((err) => {
      console.warn("[agent] worktree cleanup failed:", err);
      return 0;
    });
  stopWorktreeSweeper ??= startWorktreeSweeper(runWorktreeSweep);
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

/** Record in-flight turns for resume after quit, then interrupt them. Called
 *  from main's before-quit ahead of the teardown: the record must be durable
 *  before the process starts dying. A failed write falls back to a plain
 *  interrupt-and-quit — the boot reconciliation still seals whatever is left.
 *  Never rejects: a record failure must not stop the quit. */
export async function prepareQuitResumeForQuit(): Promise<void> {
  if (!service) return;
  const svc = service;
  try {
    await prepareQuitResume({ quitter: svc });
  } catch (err) {
    console.error(
      "[agent] quit-resume record failed — falling back to plain interrupt-and-quit:",
      err,
    );
    await Promise.allSettled(
      svc.inFlightTurns().map(({ threadId }) => svc.interruptTurn(threadId).catch(() => {})),
    );
  }
}

/** Stop every agent subprocess. Call from app quit so nothing is orphaned. */
export async function shutdownAgents(): Promise<void> {
  if (stopWorktreeSweeper) {
    stopWorktreeSweeper();
    stopWorktreeSweeper = null;
  }
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

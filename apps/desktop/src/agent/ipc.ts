import { ipcMain, type WebContents } from "electron";

import { AgentService } from "./AgentService.js";
import { getAttachmentStore } from "./AttachmentStore.js";
import { getConversationStore } from "./ConversationStore.js";
import { detect, diffStatBetween, snapshotWorkingTree } from "../git/status.js";
import { buildResumeContext } from "./resumeContext.js";
import { createSidechatThread } from "./sidechat.js";
import {
  buildPromptThreadTitleFallback,
  canReplaceThreadTitle,
  generateThreadTitle,
} from "./threadTitle.js";
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

let service: AgentService | null = null;

/** The single AgentService instance (lazily created). */
export function getAgentService(): AgentService {
  if (!service) service = new AgentService();
  return service;
}

// Renderers currently subscribed to the event stream. We hold WebContents and
// drop them on destroy so a closed window leaks no forwarding.
const subscribers = new Set<WebContents>();

// Threads whose live provider session came up with none of the thread's context
// — no stored resume id to offer, or the provider refused the one we had (see
// Session.resumedFrom). kone still has the transcript, so the next turn on such
// a thread carries a condensed replay of it (resumeContext.ts) instead of asking
// a blank agent to "continue". One-shot: the first turn re-establishes the
// context, and everything after it is a normal continuation.
const threadsNeedingReplay = new Set<string>();

/** Register the agent:* IPC handlers. Call once, before creating the window. */
export function registerAgentIpc(): void {
  const svc = getAgentService();
  const store = getConversationStore();
  const attachments = getAttachmentStore();

  /** Push one runtime event to every subscribed renderer (and optionally
   *  journal it). Title updates skip the store's applyEvent — they're written
   *  directly via setTitle. */
  function broadcast(event: RuntimeEvent, journal = true): void {
    if (journal) store.applyEvent(event);
    for (const wc of subscribers) {
      if (!wc.isDestroyed()) wc.send("agent:event", event);
    }
  }

  // Fan the merged event stream out to every subscribed renderer, and journal
  // it to the conversation store on the way through (best-effort — the store
  // guards itself, so persistence can never disrupt the live stream).
  svc.onEvent((event) => {
    // User-input questions are an ephemeral live round-trip (like title updates)
    // — stream them to renderers but don't journal them into the transcript.
    const journal = event.type !== "user-input.requested" && event.type !== "user-input.resolved";
    broadcast(event, journal);
    // When a turn settles, snapshot the repo state it left behind (branch +
    // working-tree diffstat) onto the thread, so the Project Home "recent
    // conversations" block reads real numbers. Off the hot path and best-effort
    // — a git failure never disturbs the live stream.
    if (event.type === "turn.completed") {
      captureRepoStats(event.threadId);
    }
  });

  /** Persist a title and notify renderers. No-ops when the title is unchanged. */
  function publishTitle(input: {
    threadId: string;
    provider: ProviderKind;
    title: string;
  }): void {
    const current = store.getTitle(input.threadId);
    if (current === input.title) return;
    store.setTitle(input.threadId, input.title);
    broadcast(
      {
        type: "thread.title.updated",
        threadId: input.threadId,
        provider: input.provider,
        at: Date.now(),
        source: "kone.store",
        title: input.title,
      },
      false,
    );
  }

  /** First-turn naming: set a word-cap fallback immediately, then ask the
   *  thread's own provider (Codex or Claude) for a
   *  compact generated title in the background. Generation failures leave the
   *  fallback in place; a title the user (or a later rename) already moved off
   *  the seed is never clobbered. */
  function maybeNameThread(input: {
    threadId: string;
    provider: ProviderKind;
    message: string;
  }): void {
    const fallback = buildPromptThreadTitleFallback(input.message);
    publishTitle({
      threadId: input.threadId,
      provider: input.provider,
      title: fallback,
    });

    const cwd = store.threadProjectPath(input.threadId);
    if (!cwd) return;

    void generateThreadTitle({
      cwd,
      message: input.message,
      provider: input.provider,
    })
      .then((generated) => {
        if (!generated) return;
        if (!canReplaceThreadTitle(store.getTitle(input.threadId), fallback)) return;
        publishTitle({
          threadId: input.threadId,
          provider: input.provider,
          title: generated,
        });
      })
      .catch((err) => {
        console.error("[thread-title] background rename failed:", err);
      });
  }

  // Snapshot the working tree as the conversation's baseline the first time a
  // thread starts, so the settled diffstat can be measured against where the
  // repo stood before the conversation touched anything. Guarded on the stored
  // baseline: a resumed/re-opened session (start-session re-runs, adopting the
  // same thread id) must keep the original baseline, not rebase onto the
  // mid-conversation state. Best-effort and off the hot path.
  function captureBaseline(threadId: string, projectPath: string): void {
    if (store.getBaseline(threadId)) return;
    void snapshotWorkingTree(projectPath)
      .then((tree) => {
        if (tree && !store.getBaseline(threadId)) store.setBaseline(threadId, tree);
      })
      .catch(() => {});
  }

  // Resolve the thread's project path, run git against it, and persist the
  // snapshot. The diffstat is scoped to this conversation: baseline snapshot →
  // a fresh snapshot of the tree as the turn settles, so the +/− count only the
  // lines the conversation moved, not the repo's whole uncommitted state.
  // Swallows everything: history enrichment is a convenience.
  function captureRepoStats(threadId: string): void {
    const projectPath = store.threadProjectPath(threadId);
    if (!projectPath) return;
    void detect(projectPath)
      .then(async (repo) => {
        if (!repo) return;
        const baseline = store.getBaseline(threadId);
        const current = baseline ? await snapshotWorkingTree(projectPath) : null;
        const stat =
          baseline && current
            ? await diffStatBetween(projectPath, baseline, current)
            : { added: 0, removed: 0 };
        store.recordRepoStats({
          threadId,
          branch: repo.branch,
          added: stat.added,
          removed: stat.removed,
        });
      })
      .catch(() => {});
  }

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
  });
  ipcMain.handle("agent:unsubscribe", (event) => {
    subscribers.delete(event.sender);
  });

  // Session lifecycle (request/ack — results flow through agent:event).
  ipcMain.handle("agent:start-session", async (_event, input: SessionStartInput) => {
    const session = await svc.startSession(input);
    // Register the thread now so the project/provider/model association exists
    // before any turn streams in.
    store.ensureThread({
      threadId: input.threadId,
      projectPath: input.cwd,
      provider: input.provider,
      model: input.model,
    });
    // Record where the repo stood as this conversation begins, so its settled
    // diffstat measures only what the conversation changes (no-op if the thread
    // already has a baseline — a resumed session keeps its original one).
    captureBaseline(input.threadId, input.cwd);
    // A session that adopted the provider's own conversation carries its context
    // with it and needs nothing from us. One that didn't, on a thread that has a
    // transcript, is the crash case: stage the replay for its next turn. Side
    // chat threads are exempt — their imported transcript reaches the model via
    // the one-shot `<sidechat_context>` bootstrap instead, and replaying the
    // digest on top of it would hand the agent the same history twice.
    if (session.resumedFrom) threadsNeedingReplay.delete(input.threadId);
    else if (!store.threadForkContext(input.threadId) && store.hasUserTurn(input.threadId))
      threadsNeedingReplay.add(input.threadId);
    return session;
  });
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

  /** The recovered-transcript preamble for a thread whose session came up blank,
   *  or null. Read before the new prompt is journaled, so the digest ends at the
   *  last thing the agent actually saw. Consumed once. */
  function replayPreamble(threadId: string): string | null {
    if (!threadsNeedingReplay.delete(threadId)) return null;
    const thread = store.loadThread(threadId);
    return thread ? buildResumeContext(thread) : null;
  }

  ipcMain.handle("agent:send-turn", (_event, input: SendTurnInput) => {
    const preamble = replayPreamble(input.threadId);
    // Persist the user prompt (with any attachment metadata) before dispatching,
    // so it precedes the turn in arrival order (turn.started lands after this).
    const userTurnCount = store.recordUserBlock({
      threadId: input.threadId,
      text: input.input,
      attachments: input.attachments,
    });
    // First user turn → name the thread (fallback now, generated rename async).
    if (userTurnCount === 1) {
      const provider = store.threadMeta(input.threadId)?.provider;
      if (provider) {
        maybeNameThread({
          threadId: input.threadId,
          provider,
          // An attachment-only first turn has no prompt text — name the thread
          // after the first attached file instead of leaving it blank.
          message: input.input.trim() || input.attachments?.[0]?.name || "",
        });
      }
    }
    // Only the dispatched prompt carries the replay — the block journaled above
    // keeps the user's own words, so the transcript never shows the machinery.
    return svc.sendTurn(
      preamble ? { ...input, input: `${preamble}\n\n${input.input}` } : input,
    );
  });
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
  ipcMain.handle("agent:list-sessions", () => svc.listSessions());

  // Persisted conversation history. Reads rehydrate a project's last thread on
  // open and back the "recent conversations" block; the two mutations let a row
  // be archived (hidden, recoverable) or deleted (gone).
  ipcMain.handle("agent:history-latest", (_event, projectPath: string) =>
    store.latestThread(projectPath),
  );
  ipcMain.handle("agent:history-thread", (_event, threadId: string) =>
    store.loadThread(threadId),
  );
  ipcMain.handle("agent:history-list", (_event, projectPath: string) =>
    store.listThreads(projectPath),
  );
  ipcMain.handle(
    "agent:history-archive",
    (_event, threadId: string, archived: boolean) => store.setArchived(threadId, archived),
  );
  ipcMain.handle("agent:history-delete", async (_event, threadId: string) => {
    // Unlink the thread's attachment files first (best-effort), then drop every
    // row — otherwise the bytes on disk would outlive the conversation.
    await attachments.deleteThreadFiles(threadId);
    store.deleteThread(threadId);
    threadsNeedingReplay.delete(threadId);
  });
}

/** Stop every agent subprocess. Call from app quit so nothing is orphaned. */
export async function shutdownAgents(): Promise<void> {
  if (service) await service.stopAll();
}

import { ipcMain, type WebContents } from "electron";

import { AgentService } from "./AgentService.js";
import { getConversationStore } from "./ConversationStore.js";
import { detect } from "../git/status.js";
import {
  buildPromptThreadTitleFallback,
  canReplaceThreadTitle,
  generateThreadTitle,
} from "./threadTitle.js";
import type {
  ApprovalDecision,
  ProviderKind,
  RuntimeEvent,
  SendTurnInput,
  SessionStartInput,
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

/** Register the agent:* IPC handlers. Call once, before creating the window. */
export function registerAgentIpc(): void {
  const svc = getAgentService();
  const store = getConversationStore();

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
    broadcast(event);
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

  /** First-turn naming (research shape): set a word-cap fallback
   *  immediately, then ask the thread's own provider (Codex or Claude) for a
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

  // Resolve the thread's project path, run git against it, and persist the
  // snapshot. Swallows everything: history enrichment is a convenience.
  function captureRepoStats(threadId: string): void {
    const projectPath = store.threadProjectPath(threadId);
    if (!projectPath) return;
    void detect(projectPath)
      .then((repo) => {
        if (!repo) return;
        store.recordRepoStats({
          threadId,
          branch: repo.branch,
          added: repo.added,
          removed: repo.removed,
        });
      })
      .catch(() => {});
  }

  // Discovery + models (read-only probes of the user's installed CLIs).
  ipcMain.handle("agent:discover", () => svc.discover());
  ipcMain.handle("agent:models", (_event, provider: ProviderKind) =>
    svc.listModels(provider),
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
    return session;
  });
  ipcMain.handle("agent:send-turn", (_event, input: SendTurnInput) => {
    // Persist the user prompt before dispatching, so it precedes the turn in
    // arrival order (the turn.started event lands after this row).
    const userTurnCount = store.recordUserBlock({
      threadId: input.threadId,
      text: input.input,
    });
    // First user turn → name the thread (fallback now, generated rename async).
    if (userTurnCount === 1) {
      const provider = store.threadMeta(input.threadId)?.provider;
      if (provider) {
        maybeNameThread({
          threadId: input.threadId,
          provider,
          message: input.input,
        });
      }
    }
    return svc.sendTurn(input);
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
  ipcMain.handle("agent:history-delete", (_event, threadId: string) =>
    store.deleteThread(threadId),
  );
}

/** Stop every agent subprocess. Call from app quit so nothing is orphaned. */
export async function shutdownAgents(): Promise<void> {
  if (service) await service.stopAll();
}

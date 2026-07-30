import { contextBridge, ipcRenderer } from "electron";

import type { ScratchpadRecord, StoredBoardLayout } from "./agent/ConversationStore.js";
import type { BoardLoadInput, BoardSaveInput } from "./board/index.js";
import type {
  ApprovalDecision,
  ChatAttachment,
  ModelDescriptor,
  ProviderKind,
  ProviderStatus,
  RuntimeEvent,
  SendTurnInput,
  Session,
  SessionStartInput,
  StoredThread,
  StoredThreadMeta,
  TurnStartResult,
  UploadAttachmentInput,
  UserInputAnswers,
} from "./agent/index.js";
import type {
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal/index.js";
import type {
  ScratchpadDeleteInput,
  ScratchpadListInput,
  ScratchpadSaveInput,
} from "./scratchpad/index.js";
import type { DirListing } from "./fs.js";
import type {
  CloneProgress,
  CloneResult,
  CreateProjectOptions,
  CreateProjectResult,
  GitBranch,
  GitCommit,
  GitFileContent,
  GitFileDiff,
  GitRepo,
  GitStatus,
} from "./git/index.js";

const api = {
  isDesktop: true as const,
  platform: process.platform,
  version: process.versions.electron,
  fs: {
    home: (): Promise<string> => ipcRenderer.invoke("fs:home"),
    listDir: (dir: string): Promise<DirListing> =>
      ipcRenderer.invoke("fs:list-dir", dir),
  },
  git: {
    detect: (dir: string): Promise<GitRepo | null> =>
      ipcRenderer.invoke("git:detect", dir),
    status: (dir: string): Promise<GitStatus | null> =>
      ipcRenderer.invoke("git:status", dir),
    diff: (
      dir: string,
      path: string,
      staged: boolean,
    ): Promise<GitFileDiff | null> =>
      ipcRenderer.invoke("git:diff", dir, path, staged),
    content: (dir: string, path: string): Promise<GitFileContent | null> =>
      ipcRenderer.invoke("git:content", dir, path),
    branches: (dir: string): Promise<GitBranch[]> =>
      ipcRenderer.invoke("git:branches", dir),
    log: (dir: string, limit?: number): Promise<GitCommit[]> =>
      ipcRenderer.invoke("git:log", dir, limit),
    clone: (url: string, dest: string): Promise<CloneResult> =>
      ipcRenderer.invoke("git:clone", url, dest),
    // Abort the clone currently in flight (its git.clone() invoke then rejects).
    cancelClone: (): Promise<void> => ipcRenderer.invoke("git:clone-cancel"),
    create: (opts: CreateProjectOptions): Promise<CreateProjectResult> =>
      ipcRenderer.invoke("git:create", opts),
    // Live status: watch the repo and receive a fresh GitStatus whenever it moves
    // on disk (edit, terminal `git add`, commit, branch switch). Returns an
    // unsubscribe fn that also stops the watcher in the main process.
    watchStatus: (dir: string, cb: (status: GitStatus) => void): (() => void) => {
      const listener = (_event: unknown, status: GitStatus) => cb(status);
      ipcRenderer.on("git:status-changed", listener);
      void ipcRenderer.invoke("git:watch", dir);
      return () => {
        ipcRenderer.removeListener("git:status-changed", listener);
        void ipcRenderer.invoke("git:unwatch");
      };
    },
    // Working-tree mutations. They resolve once git has run; the open project's
    // watcher then pushes the resulting status.
    stage: (dir: string, paths: string[]): Promise<void> =>
      ipcRenderer.invoke("git:stage", dir, paths),
    unstage: (dir: string, paths: string[]): Promise<void> =>
      ipcRenderer.invoke("git:unstage", dir, paths),
    discard: (dir: string, paths: string[]): Promise<void> =>
      ipcRenderer.invoke("git:discard", dir, paths),
    // Switch the working tree to a local branch. Rejects (with git's message)
    // when the checkout is blocked; the open project's watcher pushes the new
    // status on success.
    checkout: (dir: string, branch: string): Promise<void> =>
      ipcRenderer.invoke("git:checkout", dir, branch),
    // Subscribe to clone progress; returns an unsubscribe fn. Only meaningful
    // while a git.clone() invoke is in flight.
    onCloneProgress: (cb: (p: CloneProgress) => void): (() => void) => {
      const listener = (_event: unknown, p: CloneProgress) => cb(p);
      ipcRenderer.on("git:clone-progress", listener);
      return () => ipcRenderer.removeListener("git:clone-progress", listener);
    },
  },
  system: {
    username: (): Promise<string | null> =>
      ipcRenderer.invoke("system:username"),
    reveal: (target: string): Promise<void> =>
      ipcRenderer.invoke("system:reveal", target),
  },
  agent: {
    // Probe which agent CLIs are installed + logged in on this machine.
    discover: (): Promise<ProviderStatus[]> => ipcRenderer.invoke("agent:discover"),
    models: (provider: ProviderKind): Promise<ModelDescriptor[]> =>
      ipcRenderer.invoke("agent:models", provider),
    // Session lifecycle — these resolve when the turn is *accepted*; the actual
    // output arrives on the agent:event stream (subscribe via onEvent).
    startSession: (input: SessionStartInput): Promise<Session> =>
      ipcRenderer.invoke("agent:start-session", input),
    // Persist an attachment's bytes to disk; resolves to the bytes-free
    // ChatAttachment the composer then carries on its next turn.
    uploadAttachment: (input: UploadAttachmentInput): Promise<ChatAttachment> =>
      ipcRenderer.invoke("agent:upload-attachment", input),
    sendTurn: (input: SendTurnInput): Promise<TurnStartResult> =>
      ipcRenderer.invoke("agent:send-turn", input),
    interrupt: (threadId: string): Promise<void> =>
      ipcRenderer.invoke("agent:interrupt", threadId),
    stopSession: (threadId: string): Promise<void> =>
      ipcRenderer.invoke("agent:stop-session", threadId),
    respond: (
      threadId: string,
      requestId: string,
      decision: ApprovalDecision,
    ): Promise<void> => ipcRenderer.invoke("agent:respond", threadId, requestId, decision),
    respondUserInput: (
      threadId: string,
      requestId: string,
      answers: UserInputAnswers,
    ): Promise<void> =>
      ipcRenderer.invoke("agent:respond-user-input", threadId, requestId, answers),
    listSessions: (): Promise<Session[]> => ipcRenderer.invoke("agent:list-sessions"),
    // Persisted conversation history (read-only): rehydrate a project's last
    // thread on open, or list past ones. Null when nothing is stored yet.
    history: {
      latest: (projectPath: string): Promise<StoredThread | null> =>
        ipcRenderer.invoke("agent:history-latest", projectPath),
      thread: (threadId: string): Promise<StoredThread | null> =>
        ipcRenderer.invoke("agent:history-thread", threadId),
      list: (projectPath: string): Promise<StoredThreadMeta[]> =>
        ipcRenderer.invoke("agent:history-list", projectPath),
      // Hide a thread from the recent list (recoverable), or destroy it outright.
      archive: (threadId: string, archived: boolean): Promise<void> =>
        ipcRenderer.invoke("agent:history-archive", threadId, archived),
      remove: (threadId: string): Promise<void> =>
        ipcRenderer.invoke("agent:history-delete", threadId),
    },
    // The ONE runtime event stream. Subscribing registers this renderer in the
    // main process; the returned fn unsubscribes and detaches the listener.
    onEvent: (cb: (event: RuntimeEvent) => void): (() => void) => {
      const listener = (_event: unknown, ev: RuntimeEvent) => cb(ev);
      ipcRenderer.on("agent:event", listener);
      void ipcRenderer.invoke("agent:subscribe");
      return () => {
        ipcRenderer.removeListener("agent:event", listener);
        void ipcRenderer.invoke("agent:unsubscribe");
      };
    },
  },
  terminal: {
    open: (input: TerminalOpenInput): Promise<TerminalSessionSnapshot> =>
      ipcRenderer.invoke("terminal:open", input),
    write: (input: TerminalWriteInput): Promise<void> =>
      ipcRenderer.invoke("terminal:write", input),
    resize: (input: TerminalResizeInput): Promise<void> =>
      ipcRenderer.invoke("terminal:resize", input),
    clear: (terminalId: string): Promise<void> =>
      ipcRenderer.invoke("terminal:clear", terminalId),
    close: (input: TerminalCloseInput): Promise<void> =>
      ipcRenderer.invoke("terminal:close", input),
    onEvent: (cb: (event: TerminalEvent) => void): (() => void) => {
      const listener = (_event: unknown, ev: TerminalEvent) => cb(ev);
      ipcRenderer.on("terminal:event", listener);
      void ipcRenderer.invoke("terminal:subscribe");
      return () => {
        ipcRenderer.removeListener("terminal:event", listener);
        void ipcRenderer.invoke("terminal:unsubscribe");
      };
    },
  },
  scratchpad: {
    list: (input: ScratchpadListInput): Promise<ScratchpadRecord[]> =>
      ipcRenderer.invoke("scratchpad:list", input),
    save: (input: ScratchpadSaveInput): Promise<{ savedAt: number } | null> =>
      ipcRenderer.invoke("scratchpad:save", input),
    delete: (input: ScratchpadDeleteInput): Promise<void> =>
      ipcRenderer.invoke("scratchpad:delete", input),
  },
  board: {
    load: (input: BoardLoadInput): Promise<StoredBoardLayout | null> =>
      ipcRenderer.invoke("board:load", input),
    save: (input: BoardSaveInput): Promise<{ savedAt: number } | null> =>
      ipcRenderer.invoke("board:save", input),
  },
};

contextBridge.exposeInMainWorld("koneDesktop", api);

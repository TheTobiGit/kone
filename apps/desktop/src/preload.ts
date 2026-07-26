import { contextBridge, ipcRenderer } from "electron";

import type {
  ApprovalDecision,
  ModelDescriptor,
  ProviderKind,
  ProviderStatus,
  RuntimeEvent,
  SendTurnInput,
  Session,
  SessionStartInput,
  TurnStartResult,
} from "./agent/index.js";
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
    listSessions: (): Promise<Session[]> => ipcRenderer.invoke("agent:list-sessions"),
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
};

contextBridge.exposeInMainWorld("koneDesktop", api);

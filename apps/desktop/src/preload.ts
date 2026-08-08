import { contextBridge, ipcRenderer } from "electron";

import type { ScratchpadRecord, StoredBoardLayout } from "./agent/ConversationStore.js";
import type { BoardLoadInput, BoardSaveInput } from "./board/index.js";
import type {
  ApprovalDecision,
  ChatAttachment,
  CreateSideChatInput,
  CreateSideChatResult,
  ModelDescriptor,
  ProviderCacheSnapshot,
  ProviderConfig,
  ProviderKind,
  ProviderMaintenance,
  ProviderSettingsMap,
  ProviderStatus,
  ProviderUpdateResult,
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
  GitCommitAuthors,
  GitCommitDetail,
  GitCommitOptions,
  GitContributors,
  GitFileContent,
  GitFileDiff,
  GitIdentity,
  GitLogo,
  GitProjectFile,
  GitPullOptions,
  GitPushOptions,
  GitReadme,
  GitRemote,
  GitRepo,
  GitRepoState,
  GitStashEntry,
  GitStatus,
  GitHubPrCreateOptions,
  GitHubPrCreateResult,
  GitHubPullRequest,
  GitHubPullRequestDetail,
  GitHubRepoInfo,
  GitHubStatus,
  GitHubUser,
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
    files: (dir: string, query?: string): Promise<GitProjectFile[]> =>
      ipcRenderer.invoke("git:files", dir, query),
    branches: (dir: string): Promise<GitBranch[]> =>
      ipcRenderer.invoke("git:branches", dir),
    log: (dir: string, limit?: number, skip?: number): Promise<GitCommit[]> =>
      ipcRenderer.invoke("git:log", dir, limit, skip),
    // ── Git Space surface (spec §5.2) ──────────────────────────────────────
    /** Configured remotes, origin first. */
    remotes: (dir: string): Promise<GitRemote[]> =>
      ipcRenderer.invoke("git:remotes", dir),
    /** Mid-operation state (merge/rebase/…) + conflicted paths. */
    repoState: (dir: string): Promise<GitRepoState | null> =>
      ipcRenderer.invoke("git:repo-state", dir),
    /** Commit staged changes (optionally amend / skip hooks). */
    commit: (dir: string, opts: GitCommitOptions): Promise<void> =>
      ipcRenderer.invoke("git:commit", dir, opts),
    fetch: (dir: string, remote?: string): Promise<void> =>
      ipcRenderer.invoke("git:fetch", dir, remote),
    pull: (dir: string, opts?: GitPullOptions): Promise<void> =>
      ipcRenderer.invoke("git:pull", dir, opts),
    push: (dir: string, opts?: GitPushOptions): Promise<void> =>
      ipcRenderer.invoke("git:push", dir, opts),
    createBranch: (
      dir: string,
      name: string,
      opts?: { from?: string; checkout?: boolean },
    ): Promise<void> => ipcRenderer.invoke("git:create-branch", dir, name, opts),
    deleteBranch: (
      dir: string,
      name: string,
      opts?: { force?: boolean; remote?: boolean },
    ): Promise<void> => ipcRenderer.invoke("git:delete-branch", dir, name, opts),
    renameBranch: (dir: string, from: string, to: string): Promise<void> =>
      ipcRenderer.invoke("git:rename-branch", dir, from, to),
    mergeBranch: (
      dir: string,
      name: string,
      opts?: { noFf?: boolean },
    ): Promise<void> => ipcRenderer.invoke("git:merge-branch", dir, name, opts),
    /** Continue / abort whatever repoState() reports. */
    continueOperation: (dir: string): Promise<void> =>
      ipcRenderer.invoke("git:continue-operation", dir),
    abortOperation: (dir: string): Promise<void> =>
      ipcRenderer.invoke("git:abort-operation", dir),
    commitDetail: (dir: string, hash: string): Promise<GitCommitDetail | null> =>
      ipcRenderer.invoke("git:commit-detail", dir, hash),
    commitDiff: (dir: string, hash: string, path: string): Promise<GitFileDiff | null> =>
      ipcRenderer.invoke("git:commit-diff", dir, hash, path),
    stashes: (dir: string): Promise<GitStashEntry[]> =>
      ipcRenderer.invoke("git:stashes", dir),
    stashPush: (
      dir: string,
      opts?: { message?: string; includeUntracked?: boolean },
    ): Promise<void> => ipcRenderer.invoke("git:stash-push", dir, opts),
    /** `pop: true` removes the entry after applying. */
    stashApply: (dir: string, index: number, opts?: { pop?: boolean }): Promise<void> =>
      ipcRenderer.invoke("git:stash-apply", dir, index, opts),
    stashDrop: (dir: string, index: number): Promise<void> =>
      ipcRenderer.invoke("git:stash-drop", dir, index),
    // ── About section ──────────────────────────────────────────────────────
    /** Repo README markdown, or null when the repo has none. */
    readme: (dir: string): Promise<GitReadme | null> =>
      ipcRenderer.invoke("git:readme", dir),
    /** The name/email git attributes work to in this repo. */
    identity: (dir: string): Promise<GitIdentity> =>
      ipcRenderer.invoke("git:identity", dir),
    /** Repo logo as a data URL, or null when nothing qualifies. */
    logo: (dir: string): Promise<GitLogo | null> =>
      ipcRenderer.invoke("git:logo", dir),
    /** The repo's contributors, from git — always available, no network. */
    contributors: (dir: string): Promise<GitContributors> =>
      ipcRenderer.invoke("git:contributors", dir),
    github: {
      status: (): Promise<GitHubStatus> => ipcRenderer.invoke("github:status"),
      /** The repo's public GitHub surface, or null when there's no GitHub info. */
      repo: (dir: string): Promise<GitHubRepoInfo | null> =>
        ipcRenderer.invoke("github:repo", dir),
      /** The repo's GitHub contributors (with avatars), or null when there's no GitHub info. */
      contributors: (dir: string): Promise<GitContributors | null> =>
        ipcRenderer.invoke("github:contributors", dir),
      /** The signed-in GitHub user (with avatar data URL), or null. */
      me: (): Promise<GitHubUser | null> => ipcRenderer.invoke("github:me"),
      prs: (
        dir: string,
        opts?: { state?: "open" | "all"; limit?: number },
      ): Promise<GitHubPullRequest[]> => ipcRenderer.invoke("github:prs", dir, opts),
      createPr: (dir: string, opts: GitHubPrCreateOptions): Promise<GitHubPrCreateResult> =>
        ipcRenderer.invoke("github:create-pr", dir, opts),
      checkoutPr: (dir: string, number: number): Promise<void> =>
        ipcRenderer.invoke("github:checkout-pr", dir, number),
      prDetail: (dir: string, number: number): Promise<GitHubPullRequestDetail | null> =>
        ipcRenderer.invoke("github:pr-detail", dir, number),
      prDiff: (dir: string, number: number): Promise<GitFileDiff[]> =>
        ipcRenderer.invoke("github:pr-diff", dir, number),
      commitAuthors: (dir: string): Promise<GitCommitAuthors | null> =>
        ipcRenderer.invoke("github:commit-authors", dir),
      /** Open a URL in the user's real browser. */
      open: (url: string): Promise<void> => ipcRenderer.invoke("github:open", url),
    },
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
      // Pushes are tagged with the dir they belong to, so several watchers can
      // share the one channel — the open project and every launcher folder —
      // each firing its callback only for its own repo.
      const listener = (_event: unknown, pushedDir: string, status: GitStatus) => {
        if (pushedDir === dir) cb(status);
      };
      ipcRenderer.on("git:status-changed", listener);
      void ipcRenderer.invoke("git:watch", dir);
      return () => {
        ipcRenderer.removeListener("git:status-changed", listener);
        void ipcRenderer.invoke("git:unwatch", dir);
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
    // The last known provider surface off the main process's disk cache — no
    // CLI is spawned, so this resolves immediately and lets the picker be real
    // at app open instead of merely populated.
    surface: (): Promise<ProviderCacheSnapshot> => ipcRenderer.invoke("agent:surface"),
    // Ask the main process to re-probe everything in the background.
    warm: (): Promise<void> => ipcRenderer.invoke("agent:warm"),
    // Probe which agent CLIs are installed + logged in on this machine.
    discover: (): Promise<ProviderStatus[]> => ipcRenderer.invoke("agent:discover"),
    models: (provider: ProviderKind): Promise<ModelDescriptor[]> =>
      ipcRenderer.invoke("agent:models", provider),
    // Per-provider install settings (custom CLI binary path, …). Read once on
    // app open; writing one provider persists the whole map and re-points its
    // live adapter, and resolves to the updated full map.
    getSettings: (): Promise<ProviderSettingsMap> => ipcRenderer.invoke("agent:get-settings"),
    setSettings: (provider: ProviderKind, config: ProviderConfig): Promise<ProviderSettingsMap> =>
      ipcRenderer.invoke("agent:set-settings", provider, config),
    // How each provider's CLI is installed, and whether a newer one exists.
    // `checkLatest` is the network half — the settings pane asks for it when the
    // user is looking; nothing else in the app does.
    maintenance: (options?: {
      checkLatest?: boolean;
      force?: boolean;
    }): Promise<ProviderMaintenance[]> => ipcRenderer.invoke("agent:provider-maintenance", options),
    // Run the update through whichever channel installed the CLI, then re-probe.
    updateProvider: (provider: ProviderKind): Promise<ProviderUpdateResult> =>
      ipcRenderer.invoke("agent:update-provider", provider),
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
    // Fork a side chat off a source thread (docs/side-chat-design.md). The
    // renderer mints the thread id; a replayed id resolves "exists".
    createSideChat: (input: CreateSideChatInput): Promise<CreateSideChatResult> =>
      ipcRenderer.invoke("agent:create-side-chat", input),
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
    stopSubagent: (threadId: string, toolUseId: string): Promise<void> =>
      ipcRenderer.invoke("agent:stop-subagent", threadId, toolUseId),
    steerSubagent: (threadId: string, toolUseId: string, message: string): Promise<void> =>
      ipcRenderer.invoke("agent:steer-subagent", threadId, toolUseId, message),
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
    save: (input: ScratchpadSaveInput): Promise<{ savedAt: number; revision: number } | { conflict: number } | null> =>
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

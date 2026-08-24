import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type {
  AgentRecord,
  QueuedTurnRow,
  ScratchpadRecord,
  StoredStudioLayout,
  StoredThreadPage,
  SubagentPresetRecord,
  ThreadAgentBinding,
} from "./agent/ConversationStore.js";
import type { AgentInventory } from "./agent/inventory/types.js";
import type { SkillDetail } from "./agent/inventory/skillDetail.js";
import type { SkillSignalsContext } from "./agent/inventory/skillInspect.js";
import type { SkillFinding } from "./agent/inventory/skillLint.js";
import type { SkillSignals } from "./agent/inventory/skillSignals.js";
import type { FrontmatterEdit, MutateResult } from "./agent/inventory/skillMutate.js";
import type { SkillRootTarget } from "./agent/inventory/skills.js";
import type {
  SkillStateQuery,
  SkillStateResult,
  StateWriteResult,
  WritableSkillState,
} from "./agent/inventory/skillState.js";
import type { QuotaCapableProvider } from "./agent/quota/index.js";
import type { QuotaProviderReport } from "./agent/quota/types.js";
import type { AgentUsageReport, UsageRange } from "./agent/usage/report.js";
import type { StudioSaveInput } from "./modules/studio/index.js";
import type {
  ApprovalDecision,
  ChatAttachment,
  CreateSideChatInput,
  CreateSideChatResult,
  ModelDescriptor,
  ProfileStats,
  ProviderSurfaceSnapshot,
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
  SpawnedThread,
  StoredThread,
  StoredThreadMeta,
  TurnStartResult,
  UploadAttachmentInput,
  UserInputAnswers,
} from "./agent/index.js";
import type {
  TerminalAckInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./modules/terminal/index.js";
import type {
  ScratchpadDeleteInput,
  ScratchpadListInput,
  ScratchpadSaveInput,
  ScratchpadSaveResult,
} from "./modules/scratchpad/index.js";
import type {
  RosterBindInput,
  RosterCarryInput,
  RosterCreateInput,
  RosterDeleteInput,
  RosterDuplicateInput,
  RosterHydrateInput,
  RosterSelectInput,
  RosterSnapshot,
  RosterTeamInput,
  RosterTeamMemberInput,
  RosterUpdateInput,
} from "./modules/roster/index.js";
import type {
  PresetCreateInput,
  PresetDeleteInput,
  PresetUpdateInput,
} from "./modules/presets/index.js";
import type { AvatarFetchInput, AvatarFetchResult } from "./modules/avatars/index.js";
import type { DirListing } from "./modules/fs/fs.js";
import type { ThemeMode } from "./modules/system/system.js";
import type {
  CloneProgress,
  CloneResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  CreateProjectOptions,
  CreateProjectResult,
  GitActionProgressEvent,
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
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStashEntry,
  GitStatus,
  GitHubPrCreateOptions,
  GitHubPrCreateResult,
  GitHubPullRequest,
  GitHubPullRequestDetail,
  GitHubRepoInfo,
  GitHubStatus,
  GitHubUser,
} from "./modules/git/index.js";


const api = {
  platform: process.platform,
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
      open: (url: string): Promise<void> => ipcRenderer.invoke("github:open", url),
    },
    clone: (url: string, dest: string): Promise<CloneResult> =>
      ipcRenderer.invoke("git:clone", url, dest),
    // Abort the clone currently in flight (its git.clone() invoke then rejects).
    cancelClone: (): Promise<void> => ipcRenderer.invoke("git:cancel-clone"),
    create: (opts: CreateProjectOptions): Promise<CreateProjectResult> =>
      ipcRenderer.invoke("git:create", opts),
    // Live status: watch the repo and receive a fresh GitStatus whenever it moves
    // on disk (edit, terminal `git add`, commit, branch switch). Returns an
    // unsubscribe fn that also stops the watcher in the main process.
    watchStatus: (dir: string, cb: (status: GitStatus) => void): (() => void) => {
      // Pushes are tagged with the dir they belong to, so several watchers can
      // share the one channel — the open project and every launcher folder —
      // each firing its callback only for its own repo.
      const listener = (_event: IpcRendererEvent, pushedDir: string, status: GitStatus) => {
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
      const listener = (_event: IpcRendererEvent, p: CloneProgress) => cb(p);
      ipcRenderer.on("git:clone-progress", listener);
      return () => ipcRenderer.removeListener("git:clone-progress", listener);
    },
    // AI commit message generation
    generateCommitMessage: (
      dir: string,
      opts?: Partial<CommitMessageGenerationInput>,
    ): Promise<CommitMessageGenerationResult> =>
      ipcRenderer.invoke("git:generate-commit-message", dir, opts),
    // Multi-stage stacked action (branch -> stage -> commit -> push -> pr)
    runStackedAction: (
      dir: string,
      input: GitRunStackedActionInput,
    ): Promise<GitRunStackedActionResult> =>
      ipcRenderer.invoke("git:run-stacked-action", dir, input),
    // Stream stacked action progress
    onActionProgress: (cb: (event: GitActionProgressEvent) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, event: GitActionProgressEvent) => cb(event);
      ipcRenderer.on("git:action-progress", listener);
      return () => ipcRenderer.removeListener("git:action-progress", listener);
    },
  },

  system: {
    username: (): Promise<string | null> =>
      ipcRenderer.invoke("system:username"),
    reveal: (target: string): Promise<void> =>
      ipcRenderer.invoke("system:reveal", target),
  },
  // Appearance: "light" | "dark" | "system". The main process applies it to
  // nativeTheme so the OS chrome and the window follow the same choice.
  setTheme: (mode: ThemeMode): Promise<void> =>
    ipcRenderer.invoke("theme:set", mode),
  // Window chrome for the renderer's caption buttons. getState/toggleMaximize
  // return live maximized/fullscreen flags; onState pushes each transition.
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: (): Promise<{ isMaximized: boolean; isFullscreen: boolean }> =>
      ipcRenderer.invoke("window:toggle-maximize"),
    close: (): Promise<void> => ipcRenderer.invoke("window:close"),
    getState: (): Promise<{ isMaximized: boolean; isFullscreen: boolean }> =>
      ipcRenderer.invoke("window:get-state"),
    onState: (cb: (state: { isMaximized: boolean; isFullscreen: boolean }) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, state: { isMaximized: boolean; isFullscreen: boolean }) => cb(state);
      ipcRenderer.on("window:state", listener);
      return () => ipcRenderer.removeListener("window:state", listener);
    },
  },
  agent: {
    // The last known provider surface off the main process's disk cache — no
    // CLI is spawned, so this resolves immediately and lets the picker be real
    // at app open instead of merely populated.
    surface: (): Promise<ProviderSurfaceSnapshot> => ipcRenderer.invoke("agent:surface"),
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
    ): Promise<void> => ipcRenderer.invoke("agent:respond-approval", threadId, requestId, decision),
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
    // Durable turn queue + steering: a follow-up sent while a turn runs is
    // durably enqueued and auto-promoted on settlement. List the thread's
    // active queue, drop one entry (cancels with reason "user"), or steer a
    // mid-turn message into the live turn (falls back to the queue when the
    // provider has no live-steer channel).
    queuedTurns: (threadId: string): Promise<QueuedTurnRow[]> =>
      ipcRenderer.invoke("agent:queued-turns", threadId),
    cancelQueuedTurn: (threadId: string, queueId: string): Promise<boolean> =>
      ipcRenderer.invoke("agent:queue-cancel", threadId, queueId),
    steerTurn: (input: SendTurnInput): Promise<TurnStartResult> =>
      ipcRenderer.invoke("agent:steer-turn", input),
    spawnChildren: (threadId: string): Promise<SpawnedThread[]> =>
      ipcRenderer.invoke("agent:spawn-children", threadId),
    // Persisted conversation history (read-only): rehydrate a project's last
    // thread on open, or list past ones. Null when nothing is stored yet.
    history: {
      latest: (projectPath: string): Promise<StoredThreadMeta | null> =>
        ipcRenderer.invoke("agent:history-latest", projectPath),
      thread: (threadId: string): Promise<StoredThread | null> =>
        ipcRenderer.invoke("agent:history-thread", threadId),
      // Windowed thread read (user-anchored keyset pages): first page when no
      // cursor is given; pass `nextCursor` back verbatim for the next strictly
      // older page. Null when the thread is missing. The renderer treats the
      // cursor as opaque.
      threadPage: (
        threadId: string,
        options?: { limit?: number; cursor?: string },
      ): Promise<StoredThreadPage | null> =>
        ipcRenderer.invoke("agent:history-thread-page", threadId, options),
      list: (projectPath: string): Promise<StoredThreadMeta[]> =>
        ipcRenderer.invoke("agent:history-list", projectPath),
      // Hide a thread from the recent list (recoverable), or destroy it outright.
      archive: (threadId: string, archived: boolean): Promise<void> =>
        ipcRenderer.invoke("agent:history-archive", threadId, archived),
      remove: (threadId: string): Promise<void> =>
        ipcRenderer.invoke("agent:history-delete", threadId),
      // Pin state lives in the DB (not browser localStorage) — a pinned thread
      // follows the thread across profiles.
      setPinned: (threadId: string, pinned: boolean): Promise<void> =>
        ipcRenderer.invoke("agent:set-pinned", threadId, pinned),
      // Lifetime, fully-local usage stats aggregated across every project, for
      // the standalone profile board.
      profileStats: (): Promise<ProfileStats> =>
        ipcRenderer.invoke("agent:profile-stats"),
    },
    // The Agents space's three reads. Usage is local SQL over the same per-turn
    // rows history is built from, bounded to a window and optionally to one
    // project. Quota reaches a provider's own usage API — only for a provider
    // the user connected, and `allowKeychain` only on a user-initiated action.
    // Inventory is a read-only walk of the CLIs' config roots, plus one
    // single-file detail read for the skill detail view.
    usage: {
      report: (options: {
        range: UsageRange;
        projectPath?: string | null;
        forceRefresh?: boolean;
      }): Promise<AgentUsageReport> => ipcRenderer.invoke("agent:usage-report", options),
    },
    quota: {
      detect: (provider: QuotaCapableProvider): Promise<boolean> =>
        ipcRenderer.invoke("agent:quota-detect", provider),
      fetch: (
        provider: QuotaCapableProvider,
        options?: { allowKeychain?: boolean; force?: boolean },
      ): Promise<QuotaProviderReport> =>
        ipcRenderer.invoke("agent:quota-fetch", provider, options),
    },
    inventory: {
      scan: (projectPath: string | null): Promise<AgentInventory> =>
        ipcRenderer.invoke("agent:inventory-scan", projectPath),
      readSkill: (skillMdPath: string): Promise<SkillDetail | null> =>
        ipcRenderer.invoke("agent:skill-read", skillMdPath),
    },
    // Managing a skill, as opposed to reporting one. Every call resolves to a
    // result carrying its own sentence about what happened; none of them throw
    // across the wire.
    skills: {
      readState: (query: SkillStateQuery): Promise<SkillStateResult> =>
        ipcRenderer.invoke("agent:skill-state-read", query),
      writeState: (query: SkillStateQuery, state: WritableSkillState): Promise<StateWriteResult> =>
        ipcRenderer.invoke("agent:skill-state-write", query, state),
      lint: (skillMdPath: string): Promise<SkillFinding[]> =>
        ipcRenderer.invoke("agent:skill-lint", skillMdPath),
      signals: (
        skillMdPath: string,
        context: SkillSignalsContext,
      ): Promise<SkillSignals | null> =>
        ipcRenderer.invoke("agent:skill-signals", skillMdPath, context),
      roots: (projectPath: string | null): Promise<SkillRootTarget[]> =>
        ipcRenderer.invoke("agent:skill-roots", projectPath),
      scaffold: (root: string, name: string, description: string): Promise<MutateResult> =>
        ipcRenderer.invoke("agent:skill-scaffold", root, name, description),
      editFrontmatter: (skillMdPath: string, edits: FrontmatterEdit[]): Promise<MutateResult> =>
        ipcRenderer.invoke("agent:skill-edit-frontmatter", skillMdPath, edits),
      remove: (skillDir: string): Promise<MutateResult> =>
        ipcRenderer.invoke("agent:skill-remove", skillDir),
      installFromGit: (url: string, destRoot: string): Promise<MutateResult> =>
        ipcRenderer.invoke("agent:skill-install", url, destRoot),
    },
    // Persist the user's per-thread picker selection (model/effort/serviceTier/
    // contextWindow) so a reopened thread restores the picker exactly.
    setThreadSelection: (
      threadId: string,
      selection: { model?: string; effort?: string; serviceTier?: string; contextWindow?: string },
    ): Promise<void> => ipcRenderer.invoke("agent:set-thread-selection", threadId, selection),
    // User-initiated rename. Resolves true when the title changed. Does not
    // touch recency ordering; the title.updated event follows on the stream.
    renameThread: (threadId: string, title: string): Promise<boolean> =>
      ipcRenderer.invoke("agent:rename-thread", threadId, title),
    // The ONE runtime event stream. Subscribing registers this renderer in the
    // main process; the returned fn unsubscribes and detaches the listener.
    onEvent: (cb: (event: RuntimeEvent) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, ev: RuntimeEvent) => cb(ev);
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
    close: (input: TerminalCloseInput): Promise<void> =>
      ipcRenderer.invoke("terminal:close", input),
    restart: (input: TerminalRestartInput): Promise<TerminalSessionSnapshot> =>
      ipcRenderer.invoke("terminal:restart", input),
    // Renderer flow-control: report consumed output bytes so the main process
    // can pause/resume the PTY (backpressure).
    ack: (input: TerminalAckInput): Promise<void> =>
      ipcRenderer.invoke("terminal:ack", input),
    onEvent: (cb: (event: TerminalEvent) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, ev: TerminalEvent) => cb(ev);
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
    save: (input: ScratchpadSaveInput): Promise<ScratchpadSaveResult> =>
      ipcRenderer.invoke("scratchpad:save", input),
    delete: (input: ScratchpadDeleteInput): Promise<void> =>
      ipcRenderer.invoke("scratchpad:delete", input),
  },
  studio: {
    load: (): Promise<StoredStudioLayout | null> => ipcRenderer.invoke("studio:load"),
    save: (input: StudioSaveInput): Promise<{ savedAt: number } | null> =>
      ipcRenderer.invoke("studio:save", input),
  },
  roster: {
    hydrate: (input: RosterHydrateInput): Promise<RosterSnapshot> =>
      ipcRenderer.invoke("roster:hydrate", input),
    create: (input: RosterCreateInput): Promise<AgentRecord | null> =>
      ipcRenderer.invoke("roster:create", input),
    update: (input: RosterUpdateInput): Promise<AgentRecord | null> =>
      ipcRenderer.invoke("roster:update", input),
    delete: (input: RosterDeleteInput): Promise<boolean> =>
      ipcRenderer.invoke("roster:delete", input),
    duplicate: (input: RosterDuplicateInput): Promise<AgentRecord | null> =>
      ipcRenderer.invoke("roster:duplicate", input),
    team: (input: RosterTeamInput): Promise<AgentRecord[]> =>
      ipcRenderer.invoke("roster:team", input),
    addToTeam: (input: RosterTeamMemberInput): Promise<boolean> =>
      ipcRenderer.invoke("roster:team-add", input),
    removeFromTeam: (input: RosterTeamMemberInput): Promise<void> =>
      ipcRenderer.invoke("roster:team-remove", input),
    bind: (input: RosterBindInput): Promise<ThreadAgentBinding | null> =>
      ipcRenderer.invoke("roster:bind", input),
    carry: (input: RosterCarryInput): Promise<ThreadAgentBinding | null> =>
      ipcRenderer.invoke("roster:carry", input),
    select: (input: RosterSelectInput): Promise<void> =>
      ipcRenderer.invoke("roster:select", input),
  },
  presets: {
    list: (): Promise<SubagentPresetRecord[]> => ipcRenderer.invoke("presets:list"),
    create: (input: PresetCreateInput): Promise<SubagentPresetRecord | null> =>
      ipcRenderer.invoke("presets:create", input),
    update: (input: PresetUpdateInput): Promise<SubagentPresetRecord | null> =>
      ipcRenderer.invoke("presets:update", input),
    delete: (input: PresetDeleteInput): Promise<boolean> =>
      ipcRenderer.invoke("presets:delete", input),
  },
  avatars: {
    fetch: (input: AvatarFetchInput): Promise<AvatarFetchResult> =>
      ipcRenderer.invoke("avatars:fetch", input),
  },
};

contextBridge.exposeInMainWorld("koneDesktop", api);

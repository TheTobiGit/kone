// The desktop bridge `nuxt dev` stands in when there is no Electron shell: the
// slice of `window.koneDesktop` the demo world can answer, built on the same
// three repos, provider tables and thread rows the rest of lib/ defines. The
// devBridge plugin installs it; composables reach it through desktopBridge()
// exactly as they reach the real one, so none of them knows it is in dev.
//
// Reads answer after a git-like moment so the processing → reveal beats stay
// visible. Writes that would touch a disk take the same moment and change
// nothing, except where the demo would read as broken without an effect — the
// thread list keeps its pins, done marks and archive in memory.

import type {
  CloneProgress,
  GitActionProgressEvent,
  KoneGitApi,
  ProviderKind,
  ProviderMaintenance,
  ProviderUpdateResult,
  StoredThreadMeta,
} from "~/types/desktop";
import { createMockTurnRunner } from "~/composables/agentMock";
import { cloneStageAt } from "~/composables/useGitClone";
import type { DesktopAgentReach, DevBridge } from "~/utils/desktopBridge";
import * as world from "./devMocks";
import { MOCK_MAINTENANCE, MOCK_MODELS, MOCK_STATUSES } from "./devProviders";

export function createDevBridge(): DevBridge {
  return {
    fs: {
      home: () => Promise.resolve(world.MOCK_HOME),
      listDir: (dir) => Promise.resolve(world.mockListDir(dir)),
    },
    git: createDevGit(),
    agent: createDevAgent(),
    turnRunner: createMockTurnRunner,
  };
}

// ── latency ───────────────────────────────────────────────────────────────────

/** A short, slightly staggered delay standing in for real git latency. */
function later<T>(value: T, ms = 130 + Math.random() * 240): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** A write with no effect, taking a git-like moment so the caller's in-flight
 *  state gets at least one frame on screen. */
const beat = (): Promise<void> => later(undefined);

// ── git ───────────────────────────────────────────────────────────────────────

function createDevGit(): KoneGitApi {
  const cloneListeners = new Set<(p: CloneProgress) => void>();
  let cancelClone: (() => void) | null = null;

  return {
    detect: (dir) => later(world.mockDetect(dir)),
    status: (dir) => later(world.mockStatus(dir)),
    diff: (dir, path) => later(world.mockDiff(dir, path)),
    content: (dir, path) => later(world.mockContent(dir, path)),
    files: (dir, query) => later(world.mockFiles(dir, query)),
    branches: (dir) => later(world.mockBranches(dir)),
    log: (dir, limit, skip) => later(world.mockLog(dir, limit, skip)),
    remotes: (dir) => later(world.mockRemotes(dir)),
    repoState: (dir) => later(world.mockRepoState(dir)),
    commitDetail: (dir, hash) => later(world.mockCommitDetail(dir, hash)),
    commitDiff: (dir, hash, path) => later(world.mockCommitDiff(dir, hash, path)),
    stashes: (dir) => later(world.mockStashes(dir)),
    readme: (dir) => later(world.mockReadme(dir)),
    identity: (dir) => later(world.mockIdentity(dir) ?? { name: null, email: null }),
    logo: (dir) => later(world.mockLogo(dir)),
    contributors: (dir) =>
      later(world.mockContributors(dir) ?? { source: "git", people: [], total: 0 }),

    // Worktrees need a real directory; a demo one would name a path that
    // doesn't exist, so the demo world has none.
    worktrees: () => Promise.resolve([]),
    worktreeAdd: () => Promise.reject(new Error("Worktrees need the desktop app.")),
    worktreeRemove: beat,
    worktreePrune: () => Promise.resolve([]),

    // The demo repos never change on disk, so there is nothing to watch.
    watchStatus: () => () => {},
    onActionProgress: (_cb: (event: GitActionProgressEvent) => void) => () => {},

    stage: beat,
    unstage: beat,
    discard: beat,
    checkout: beat,
    commit: beat,
    fetch: beat,
    pull: beat,
    push: beat,
    createBranch: beat,
    deleteBranch: beat,
    renameBranch: beat,
    mergeBranch: beat,
    continueOperation: beat,
    abortOperation: beat,
    stashPush: beat,
    stashApply: beat,
    stashDrop: beat,

    generateCommitMessage: () =>
      later({
        subject: "feat: add OAuth login flow",
        body: "Wire up the provider handshake and persist the session token",
      }),
    runStackedAction: (_dir, input) =>
      later({
        action: input.action,
        commitSha: "a1b9f3c9e4c0b91d7f2a3d8b8c7e6f5a4b3c2d1e",
        subject: input.message,
        branch: input.branchName || "main",
        pushed: input.action.includes("push"),
      }),

    // A clone walks git's own phases over about two seconds, so the modal's
    // progress → open choreography reads like the real thing.
    clone: (url, dest) =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const DURATION = 2100;
        const tick = setInterval(() => {
          const t = Math.min((Date.now() - started) / DURATION, 1);
          for (const cb of cloneListeners) cb({ progress: t, stage: cloneStageAt(t) });
          if (t < 1) return;
          clearInterval(tick);
          cancelClone = null;
          resolve({ root: dest, name: url.split("/").pop()?.replace(/\.git$/, "") ?? dest });
        }, 50);
        cancelClone = () => {
          clearInterval(tick);
          cancelClone = null;
          reject(new Error("Clone cancelled"));
        };
      }),
    cancelClone: () => {
      cancelClone?.();
      return Promise.resolve();
    },
    onCloneProgress: (cb) => {
      cloneListeners.add(cb);
      return () => cloneListeners.delete(cb);
    },
    create: (opts) => later({ root: `${opts.parent}/${opts.name}`, name: opts.name }, 900),

    github: {
      status: () => later(world.mockGhStatus()),
      repo: (dir) => later(world.mockGhRepo(dir)),
      contributors: (dir) => later(world.mockGhContributors(dir)),
      commitAuthors: () => later(world.mockCommitAuthors()),
      me: () => later(world.mockGhMe()),
      prs: (dir, opts) => later(world.mockPrs(dir, opts?.state ?? "open")),
      prDetail: (_dir, number) => later(world.mockPrDetail(number)),
      prDiff: (_dir, number) => later(world.mockPrDiff(number)),
      // The next number, so the composer's success line reads like the real one.
      createPr: (dir) => {
        const next = (world.mockPrs(dir, "all")[0]?.number ?? 0) + 1;
        return later({ number: next, url: `https://github.com/kone-dev/kone/pull/${next}` });
      },
      checkoutPr: beat,
      open: (url) => {
        window.open(url, "_blank", "noopener");
        return Promise.resolve();
      },
    },
  };
}

// ── providers and the thread list ─────────────────────────────────────────────

function createDevAgent(): DesktopAgentReach {
  const snapshot = () => ({ version: 1, savedAt: Date.now(), statuses: MOCK_STATUSES, models: MOCK_MODELS });
  return {
    surface: () => Promise.resolve(snapshot()),
    warm: () => Promise.resolve(),
    discover: () => Promise.resolve(MOCK_STATUSES),
    onProvidersChanged: () => () => {},
    models: (provider) => Promise.resolve(MOCK_MODELS[provider] ?? []),
    maintenance: () => Promise.resolve(Object.values(MOCK_MAINTENANCE)),
    // The installer "runs" for a beat and lands on the latest version, so the
    // pane's running → succeeded transition can be seen.
    updateProvider: async (provider) => {
      const was = MOCK_MAINTENANCE[provider];
      const maintenance: ProviderMaintenance = {
        ...was,
        currentVersion: was.latestVersion ?? was.currentVersion,
        standing: was.latestKnowable ? "current" : "unknown",
      };
      const result: ProviderUpdateResult = {
        provider,
        outcome: "succeeded",
        message: null,
        output: null,
        maintenance,
        statuses: [],
      };
      return later(result, 1_400);
    },
    history: createDevHistory(),
  };
}

type DemoThread = {
  title: string;
  provider: ProviderKind;
  branch: string;
  added: number;
  removed: number;
  tokens: number;
  /** Days since the thread last moved. */
  ago: number;
  pinned?: boolean;
  unread?: boolean;
  /** Filed in the archive rather than the live list. */
  archived?: boolean;
  snippet: string;
};

// Every project the demo opens gets the same handful of threads: two vendors, a
// couple pinned, one unread, two in the archive — enough for each state of the
// list to be on screen.
const DEMO_THREADS: DemoThread[] = [
  { title: "Wire up the Droid bridge protocol", provider: "claudeAgent", branch: "main", added: 410, removed: 88, tokens: 3_200_000, ago: 7, pinned: true, snippet: "Added WebSocket transport layer and validated IPC payloads." },
  { title: "Design system tokens + main.css", provider: "codex", branch: "main", added: 256, removed: 40, tokens: 1_900_000, ago: 7, pinned: true, snippet: "Normalized spacing scale and color tokens across themes." },
  { title: "Fix structuredClone crash on re-open", provider: "claudeAgent", branch: "calm-agent-ui", added: 128, removed: 34, tokens: 1_240_000, ago: 2, snippet: "Ensured prototype-free serialization before storing state snapshots." },
  { title: "Wire the droid ACP turn params", provider: "droid", branch: "droid-bridge", added: 118, removed: 31, tokens: 740_000, ago: 0.6, unread: true, snippet: "Mapped reasoning effort and temperature overrides to CLI flags." },
  { title: "Calm material pass across tokens", provider: "claudeAgent", branch: "main", added: 342, removed: 96, tokens: 2_100_000, ago: 12, archived: true, snippet: "Softened high-contrast borders and elevated panel depth." },
  { title: "Polish agent-activity rendering", provider: "codex", branch: "agent-ui", added: 64, removed: 20, tokens: 480_000, ago: 15, archived: true, snippet: "Smoothed state transitions for turn orbs and unified edge masking." },
];

function createDevHistory(): DesktopAgentReach["history"] {
  const DAY = 86_400_000;
  const threads = new Map<string, StoredThreadMeta>();
  const seeded = new Set<string>();

  function seed(projectPath: string): void {
    if (seeded.has(projectPath)) return;
    seeded.add(projectPath);
    const now = Date.now();
    DEMO_THREADS.forEach((demo, i) => {
      const at = now - demo.ago * DAY;
      const threadId = `demo-${i + 1}:${projectPath}`;
      threads.set(threadId, {
        threadId,
        projectPath,
        provider: demo.provider,
        title: demo.title,
        branch: demo.branch,
        added: demo.added,
        removed: demo.removed,
        tokens: demo.tokens,
        snippet: demo.snippet,
        createdAt: at,
        updatedAt: at,
        lastActivityAt: at,
        isPinned: demo.pinned ?? false,
        archivedAt: demo.archived ? at : null,
        lastVisitedAt: demo.unread ? at - 1 : at,
      });
    });
  }

  function patch(threadId: string, change: Partial<StoredThreadMeta>): Promise<void> {
    const meta = threads.get(threadId);
    if (meta) threads.set(threadId, { ...meta, ...change });
    return Promise.resolve();
  }

  return {
    list: (projectPath, options) => {
      seed(projectPath);
      const archived = options?.archived ?? false;
      const rows = [...threads.values()].filter(
        (t) => t.projectPath === projectPath && Boolean(t.archivedAt) === archived,
      );
      return later(rows);
    },
    archive: (threadId, archived) => {
      if (!threads.has(threadId)) return Promise.resolve({ ok: false, reason: "missing" });
      void patch(threadId, { archivedAt: archived ? Date.now() : null });
      return Promise.resolve({ ok: true, threadIds: [threadId] });
    },
    remove: (threadId) => {
      threads.delete(threadId);
      return Promise.resolve();
    },
    setPinned: (threadId, pinned) => patch(threadId, { isPinned: pinned }),
    setDone: (threadId, done) => patch(threadId, { doneAt: done ? Date.now() : 0 }),
    setVisited: (threadId, at, force) => {
      const seen = threads.get(threadId)?.lastVisitedAt ?? 0;
      return force || at > seen ? patch(threadId, { lastVisitedAt: at }) : Promise.resolve();
    },
  };
}

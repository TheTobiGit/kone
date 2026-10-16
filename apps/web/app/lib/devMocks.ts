// The dev-only demo world — one source of truth for what the app shows in
// `nuxt dev`, where there's no Electron bridge to read a real filesystem or run
// git. The folder picker, the git summaries, the diff view and the content
// preview all resolve against the same three repos defined here, so the launcher
// and the project view stay consistent without a "keep these in sync" contract
// spread across composables.
//
// Only lib/devBridge reads it, and only the dev-only devBridge plugin loads
// that — nothing here reaches a production build. Keep it that way: a static
// import from anywhere else would pull the whole demo world back in.

import type {
  DirListing,
  GitBranch,
  GitChange,
  GitCommit,
  GitCommitAuthors,
  GitCommitDetail,
  GitContributors,
  GitDiffHunk,
  GitDiffLine,
  GitFileContent,
  GitFileDiff,
  GitFileStatus,
  GitIdentity,
  GitLogo,
  GitHubPullRequest,
  GitHubPrAction,
  GitHubComment,
  GitHubIssue,
  GitHubIssueCloseReason,
  GitHubIssueCreateResult,
  GitHubIssueDetail,
  GitHubLabel,
  GitHubPullRequestDetail,
  GitHubPerson,
  GitHubCheck,
  GitHubReviewer,
  GitHubPrCommit,
  GitHubRepoInfo,
  GitHubStatus,
  GitHubUser,
  GitProjectFile,
  GitReadme,
  GitRemote,
  GitRepo,
  GitRepoState,
  GitStashEntry,
  GitStatus,
  ProjectDirListing,
  ProjectEntry,
  ProjectFileText,
} from "~/types/desktop";

// ── the demo home directory ─────────────────────────────────────────────────

export const MOCK_HOME = "/Users/you";

const MOCK_TREE: Record<string, string[]> = {
  "/Users/you": [
    "Applications",
    "Desktop",
    "Developer",
    "Documents",
    "Downloads",
    "Library",
    "Movies",
    "Music",
    "Pictures",
    "Projects",
    "Public",
    "Sites",
    "Workspace",
  ],
  "/Users/you/Developer": ["kone", "nxui", "playground", "sandbox"],
  "/Users/you/Developer/kone": ["apps", "packages", "node_modules"],
  "/Users/you/Developer/kone/apps": ["desktop", "web"],
  "/Users/you/Developer/nxui": ["src", "docs"],
  "/Users/you/Documents": ["Notes", "Invoices"],
  "/Users/you/Downloads": [],
};

// Absolute paths the mock treats as git repo roots — the single set the picker's
// repo indicator and the git summaries below both read from.
const MOCK_REPOS = new Set([
  "/Users/you/Developer/kone",
  "/Users/you/Developer/nxui",
  "/Users/you/Developer/sandbox",
]);

export function mockListDir(dir: string): DirListing {
  const names = MOCK_TREE[dir] ?? [];
  const parts = dir.split("/").filter(Boolean);
  const name = parts[parts.length - 1] ?? dir;
  const parent = parts.length > 0 ? "/" + parts.slice(0, -1).join("/") : null;
  return {
    path: dir,
    name,
    parent: parent === "" ? "/" : parent,
    repo: MOCK_REPOS.has(dir),
    entries: names.map((n) => {
      const p = `${dir}/${n}`;
      return { name: n, path: p, repo: MOCK_REPOS.has(p) };
    }),
  };
}

// ── the demo repos ────────────────────────────────────────────────────────────
// Canned summaries for the mock repo paths above, so the picker shows a plausible
// branch + line diffstat. Each repo's changed-file list (MOCK_CHANGES) is kept
// alongside so the three demo repos each read distinctly: kone (active),
// sandbox (deletions), nxui (clean).

const MOCK_SUMMARIES: Record<
  string,
  Pick<GitRepo, "branch" | "ahead" | "behind" | "changeCount" | "added" | "removed">
> = {
  "/Users/you/Developer/kone": {
    branch: "calm-agent-ui-continuation",
    ahead: 2,
    behind: 0,
    changeCount: 19,
    added: 128,
    removed: 34,
  },
  "/Users/you/Developer/nxui": {
    branch: "main",
    ahead: 0,
    behind: 0,
    changeCount: 0,
    added: 0,
    removed: 0,
  },
  "/Users/you/Developer/sandbox": {
    branch: "spike/particles",
    ahead: 0,
    behind: 3,
    changeCount: 2,
    added: 12,
    removed: 47,
  },
};

// The changed-file lists behind each mock repo — these become the folder's
// peeking papers and the changes-panel lanes.
const MOCK_CHANGES: Record<string, GitChange[]> = {
  "/Users/you/Developer/kone": [
    { path: "apps/web/app/components/ProjectFolder.vue", status: "added", staged: true, unstaged: false, added: 96, removed: 0 },
    { path: "apps/web/app/composables/useGit.ts", status: "modified", staged: true, unstaged: false, added: 22, removed: 6 },
    { path: "apps/web/nuxt.config.js", status: "modified", staged: true, unstaged: false, added: 5, removed: 1 },
    { path: "apps/web/app/assets/css/main.css", status: "modified", staged: false, unstaged: true, added: 4, removed: 25 },
    { path: "apps/web/app/pages/index.vue", status: "modified", staged: false, unstaged: true, added: 1, removed: 2 },
    { path: "README.md", status: "modified", staged: false, unstaged: true, added: 8, removed: 2 },
    { path: "apps/web/app/components/ChangeCard.vue", status: "modified", staged: false, unstaged: true, added: 12, removed: 3 },
    { path: "apps/web/app/components/ChangePeek.vue", status: "added", staged: false, unstaged: true, added: 210, removed: 0 },
    { path: "apps/web/app/components/ChangeLane.vue", status: "modified", staged: false, unstaged: true, added: 31, removed: 44 },
    { path: "apps/web/app/components/ChangesPanel.vue", status: "modified", staged: false, unstaged: true, added: 6, removed: 2 },
    { path: "apps/web/app/components/ProjectView.vue", status: "modified", staged: false, unstaged: true, added: 74, removed: 5 },
    { path: "apps/web/app/components/RecentSessions.vue", status: "modified", staged: false, unstaged: true, added: 9, removed: 3 },
    { path: "apps/web/app/types/change.ts", status: "modified", staged: false, unstaged: true, added: 3, removed: 0 },
    { path: "apps/web/package.json", status: "modified", staged: false, unstaged: true, added: 2, removed: 1 },
    { path: "packages/contracts/src/session.ts", status: "modified", staged: false, unstaged: true, added: 17, removed: 9 },
    { path: "docs/peek.md", status: "added", staged: false, unstaged: true, added: 44, removed: 0 },
    { path: "packages/agent-core/src/gateway/index.ts", status: "modified", staged: false, unstaged: true, added: 28, removed: 12 },
    { path: "apps/web/app/composables/useProjectGit.ts", status: "added", staged: false, unstaged: true, added: 3, removed: 0 },
    { path: "src/legacy/util.ts", status: "deleted", staged: false, unstaged: true, added: 0, removed: 88 },
  ],
  "/Users/you/Developer/sandbox": [
    { path: "src/legacy-emitter.js", status: "deleted", staged: false, unstaged: true, added: 0, removed: 34 },
    { path: "src/particles.ts", status: "modified", staged: false, unstaged: true, added: 12, removed: 13 },
  ],
  "/Users/you/Developer/nxui": [],
};

// The branches each mock repo offers. Local names come first and carry their
// tracking state (upstream + divergence); the `remote` list becomes the
// remote-tracking refs the Git Space lists separately. The branch picker filters
// remotes out, so only the Git Space sees the second group.
type MockBranchSeed = {
  name: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
};
const MOCK_BRANCHES: Record<
  string,
  { local: MockBranchSeed[]; remote: string[] }
> = {
  "/Users/you/Developer/kone": {
    local: [
      { name: "calm-agent-ui-continuation", upstream: "origin/calm-agent-ui-continuation", ahead: 2, behind: 0 },
      { name: "main", upstream: "origin/main", ahead: 0, behind: 0 },
      { name: "dev", upstream: "origin/dev", ahead: 0, behind: 4 },
      { name: "premium-conversation-thread", upstream: "origin/premium-conversation-thread", ahead: 7, behind: 1 },
      { name: "feat/git-space" },
      { name: "fix/composer-pill-wrap", upstream: "origin/fix/composer-pill-wrap", ahead: 1, behind: 0 },
    ],
    remote: [
      "origin/main",
      "origin/dev",
      "origin/calm-agent-ui-continuation",
      "origin/premium-conversation-thread",
      "origin/fix/composer-pill-wrap",
      "origin/release/0.4",
    ],
  },
  "/Users/you/Developer/nxui": {
    local: [
      { name: "main", upstream: "origin/main", ahead: 0, behind: 0 },
      { name: "next", upstream: "origin/next", ahead: 0, behind: 2 },
    ],
    remote: ["origin/main", "origin/next"],
  },
  "/Users/you/Developer/sandbox": {
    local: [{ name: "spike/particles" }, { name: "main", upstream: "origin/main", ahead: 0, behind: 3 }],
    remote: ["origin/main"],
  },
};

export function mockBranches(dir: string): GitBranch[] {
  const summary = MOCK_SUMMARIES[dir];
  if (!summary) return [];
  const seeds = MOCK_BRANCHES[dir];
  if (!seeds) {
    return summary.branch
      ? [{ name: summary.branch, current: true, remote: false }]
      : [];
  }
  const local: GitBranch[] = seeds.local.map((seed) => {
    const branch: GitBranch = {
      name: seed.name,
      current: seed.name === summary.branch,
      remote: false,
    };
    if (seed.upstream) branch.upstream = seed.upstream;
    if (seed.ahead !== undefined) branch.ahead = seed.ahead;
    if (seed.behind !== undefined) branch.behind = seed.behind;
    return branch;
  });
  const remote: GitBranch[] = seeds.remote.map((name) => ({
    name,
    current: false,
    remote: true,
  }));
  return [...local, ...remote];
}

export function mockDetect(dir: string): GitRepo | null {
  const summary = MOCK_SUMMARIES[dir];
  if (!summary) return null;
  const name = dir.split("/").filter(Boolean).pop() ?? dir;
  return {
    root: dir,
    name,
    detached: false,
    clean: summary.changeCount === 0,
    ...summary,
  };
}

export function mockStatus(dir: string): GitStatus | null {
  const summary = MOCK_SUMMARIES[dir];
  const changes = MOCK_CHANGES[dir];
  if (!summary || !changes) return null;
  return {
    root: dir,
    branch: summary.branch,
    detached: false,
    head: "0000000",
    upstream:
      MOCK_BRANCHES[dir]?.local.find((b) => b.name === summary.branch)?.upstream ??
      null,
    ahead: summary.ahead,
    behind: summary.behind,
    changes,
    staged: changes.filter((c) => c.staged).length,
    unstaged: changes.filter((c) => c.unstaged).length,
    untracked: changes.filter((c) => c.status === "untracked").length,
    clean: changes.length === 0,
  };
}

// ── synthesized diffs + content ───────────────────────────────────────────────

// Plausible source lines to fill a mock hunk, chosen by file extension so the
// dev preview reads like the file it claims to be.
function linePool(path: string): string[] {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "vue")
    return [
      '<template>',
      '  <section class="panel">',
      '    <header class="panel__head">{{ title }}</header>',
      '    <div v-for="item in items" :key="item.id" class="row">',
      '      <span class="row__name">{{ item.name }}</span>',
      '    </div>',
      '  </section>',
      '</template>',
      '',
      'const items = computed(() => props.data);',
    ];
  if (ext === "css")
    return [
      '.panel {',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 14px;',
      '  padding: 16px;',
      '  border-radius: 12px;',
      '  background-color: var(--ground);',
      '  color: var(--ink);',
      '}',
      '.panel__head { font-weight: 500; }',
    ];
  if (ext === "md" || ext === "mdx" || ext === "markdown")
    return [
      '# kone',
      '',
      'A **calm** git client — changes read like a page, not a diff dump.',
      '',
      '## Getting started',
      '',
      'Clone the repo and start the dev server:',
      '',
      '```bash',
      'bun install',
      'bun run dev:web',
      '```',
      '',
      '## Principles',
      '',
      '- Borderless surfaces over boxed cards',
      '- Soft, low elevation — never a heavy shadow',
      '- Sound and motion stay _sparse_',
      '',
      '> Restraint is the feature.',
      '',
      'See the [handbook](https://example.com) for the full story.',
    ];
  if (ext === "json" || ext === "js" && path.includes("config"))
    return [
      'export default {',
      '  css: ["~/assets/css/main.css"],',
      '  modules: ["@vueuse/nuxt"],',
      '  devtools: { enabled: true },',
      '  app: { head: { title: "kone" } },',
      '  nitro: { preset: "node-server" },',
      '  vite: { clearScreen: false },',
      '};',
      '',
      '// generated',
    ];
  return [
    'export function resolve(input: string) {',
    '  const trimmed = input.trim();',
    '  if (!trimmed) return null;',
    '  const parts = trimmed.split("/");',
    '  return parts.filter(Boolean);',
    '}',
    '',
    'const cache = new Map<string, string>();',
    'let pending = 0;',
    'return { resolve, cache };',
  ];
}

// A small in-place edit to a line, so a mock modification reads like a real one
// (one token changed) rather than a wholesale line swap — this is what gives the
// diff's word-level highlighting something believable to emphasise.
function tweak(line: string, seed: number): string {
  const num = line.match(/\d+/);
  if (num) return line.replace(/\d+/, String(Number(num[0]) + 1 + (seed % 3)));
  if (line.includes("const ")) return line.replace("const ", "let ");
  if (line.includes("return ")) return line.replace("return ", "yield ");
  const word = line.match(/[A-Za-z_]{4,}/);
  if (word) return line.replace(word[0], `${word[0]}X`);
  return `${line} //~`;
}

// The working-tree diff for one mock change. Paths outside MOCK_CHANGES still
// get a diff — the demo thread's tool calls touch files the mock working tree
// never listed, and the changes dock reads a diff for whatever they name.
export function mockDiff(dir: string, relPath: string): GitFileDiff | null {
  const change = MOCK_CHANGES[dir]?.find((c) => c.path === relPath);
  if (!change) return synthDiff(relPath, "modified", 7, 4);
  return synthDiff(relPath, change.status, change.added ?? 0, change.removed ?? 0);
}

// Synthesize a readable diff from nothing but a path and a diffstat. Shared by
// the working-tree view and the Git Space's per-commit diffs, so a file that
// isn't in MOCK_CHANGES (any file touched by a historical commit) still reads
// like real source. Added/untracked → all inserts; deleted → all deletes;
// modified → a small centred hunk. Line counts drive the volume (capped so it
// stays legible).
function synthDiff(
  relPath: string,
  status: GitFileStatus,
  addedCount: number,
  removedCount: number,
): GitFileDiff {
  const pool = linePool(relPath);
  const pick = (i: number) => pool[i % pool.length]!;
  const nAdd = Math.min(addedCount, 9);
  const nDel = Math.min(removedCount, 7);

  const lines: GitDiffLine[] = [];
  let oldNo: number;
  let newNo: number;
  const ctx = (t: string) => {
    lines.push({ kind: "context", text: t, oldNo, newNo });
    oldNo++;
    newNo++;
  };
  const del = (t: string) => {
    lines.push({ kind: "del", text: t, oldNo, newNo: null });
    oldNo++;
  };
  const add = (t: string) => {
    lines.push({ kind: "add", text: t, oldNo: null, newNo });
    newNo++;
  };

  if (status === "added" || status === "untracked") {
    oldNo = 0;
    newNo = 1;
    for (let i = 0; i < Math.max(nAdd, 1); i++) add(pick(i));
  } else if (status === "deleted") {
    oldNo = 1;
    newNo = 0;
    for (let i = 0; i < Math.max(nDel, 1); i++) del(pick(i));
  } else {
    // A realistic modification: the first `paired` lines are edited in place
    // (each deletion has a matching, lightly-tweaked addition, so the diff's
    // word-level view highlights just the changed token); any remaining
    // additions are fresh lines. Deletions lead, then additions — as git orders
    // a hunk — and the pairing lines up del[i] with add[i].
    oldNo = 18;
    newNo = 18;
    const paired = Math.min(nDel, nAdd);
    ctx(pick(0));
    for (let i = 0; i < nDel; i++) del(pick(i + 1));
    for (let i = 0; i < nAdd; i++) {
      add(i < paired ? tweak(pick(i + 1), i) : pick(i + 1 + nDel));
    }
    ctx(pick(9));
  }

  return {
    path: relPath,
    status,
    binary: false,
    hunks: [
      {
        header: "",
        oldStart: lines[0]?.oldNo ?? 1,
        newStart: lines[0]?.newNo ?? 1,
        lines,
      },
    ],
    added: addedCount,
    removed: removedCount,
  };
}

// A plausible file body for the detail view's content preview. Deleted files
// have no working-tree content (null text). Others repeat the extension's line
// pool to a believable length.
export function mockContent(dir: string, relPath: string): GitFileContent | null {
  const change = MOCK_CHANGES[dir]?.find((c) => c.path === relPath);
  if (!change) return null;
  if (change.status === "deleted") return { text: null, binary: false, truncated: false };
  const pool = linePool(relPath);
  const len = Math.min(60, Math.max(pool.length, (change.added ?? 0) + 8));
  const lines: string[] = [];
  for (let i = 0; i < len; i++) lines.push(pool[i % pool.length]!);
  return { text: lines.join("\n"), binary: false, truncated: false };
}

const MOCK_PROJECT_FILES: Record<string, string[]> = {
  "/Users/you/Developer/kone": [
    "README.md",
    "package.json",
    "apps/desktop/src/main.ts",
    "apps/web/app/pages/index.vue",
    "apps/web/app/components/AgentComposer.vue",
    "apps/web/app/components/ConversationThread.vue",
    "apps/web/app/composables/useAgent.ts",
    "apps/web/app/composables/useGit.ts",
    "apps/web/app/assets/css/main.css",
  ],
};

// ── the Git Space demo world ──────────────────────────────────────────────────
// Everything the Git Space reads — history, remotes, stashes, pull requests — is
// synthesized here. It is deterministic on purpose: the same repo path always
// yields the same commits, hashes and timestamps, so a screenshot taken twice is
// identical and a reviewer can point at "the third commit" and mean it.

/** A fixed "now" for the demo world. Every relative time below is measured from
 *  this instant rather than the real clock, so the history reads the same today
 *  and next month. */
const MOCK_NOW = Date.parse("2026-08-03T11:20:00Z");

/** Cheap deterministic 32-bit hash — the seed behind every synthesized value. */
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A believable 40-char object name derived from a seed. */
function mockHash(seed: string): string {
  let out = "";
  let h = seedOf(seed);
  while (out.length < 40) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

/** git's own relative-date phrasing, measured from MOCK_NOW. */
function relativeAt(ms: number): string {
  const mins = Math.max(1, Math.round((MOCK_NOW - ms) / 60000));
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  if (months < 24) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

// Subjects written the way this repo actually writes them (conventional commits,
// lower-case, no trailing period) so the history column reads like real work.
const MOCK_SUBJECTS = [
  "fix(ui): prevent composer single-line pill wrap flash",
  "feat(ui): archive threads from columns and crossfade dock stacks",
  "feat(ui): Factory Droid provider surface",
  "feat(agent): Factory Droid provider with ACP adapter",
  "fix(agent): seal a live turn when its session is stopped",
  "refactor(agent): fan one provider listener out to every session",
  "feat(ui): scrollable tiling rail for the thread strip",
  "fix(git): reconcile optimistic staging with the watcher push",
  "feat(ui): hold-to-confirm for destructive file actions",
  "perf(ui): take the CLI spawn off the thread-open critical path",
  "fix(ui): keep xterm's fit() valid while a surface is hidden",
  "feat(agent): per-model reasoning-effort ladder",
  "fix(agent): mint globally-unique turn ids",
  "feat(ui): dithered particle wordmark on the launcher",
  "style(ui): drop every remaining card border",
  "feat(git): stream real clone progress into the modal",
  "fix(ui): stop the greeting flashing its empty state",
  "feat(ui): file detail spec-sheet with a two-gutter diff",
  "refactor(git): fold disk truth through one applyStatus",
  "feat(ui): corner folder fans its peeking papers on hover",
  "fix(desktop): spawn agent CLIs from outside the asar",
  "feat(ui): agent orb thinking indicator",
  "chore: bump hugeicons and drop the unused three.js bundle",
  "fix(ui): tabular numerals for every diffstat",
  "feat(agent): resume a stored conversation on relaunch",
  "fix(terminal): stop leaking the host TERM into the pty",
  "feat(ui): branch picker in the corner folder",
  "refactor(web): one reactive git model per open project",
  "fix(ui): honour prefers-reduced-motion in the entrance cascade",
  "feat(ui): scratchpad pane capture from a turn",
];

const MOCK_AUTHORS = [
  { author: "Gideon Sarfo", email: "stephen.seirh@amalitech.com" },
  { author: "Ama Boateng", email: "ama@kone.dev" },
  { author: "Kwesi Mensah", email: "kwesi@kone.dev" },
];

// Paths a synthesized commit can touch, so its file list looks like this app.
const MOCK_TOUCHABLE = [
  "apps/web/app/components/ProjectView.vue",
  "apps/web/app/components/ConversationThread.vue",
  "apps/web/app/components/AgentComposer.vue",
  "apps/web/app/components/ChangesPanel.vue",
  "apps/web/app/components/ThreadStrip.vue",
  "apps/web/app/composables/useAgent.ts",
  "apps/web/app/composables/useGit.ts",
  "apps/web/app/composables/useProjectGit.ts",
  "apps/web/app/assets/css/main.css",
  "packages/agent-core/src/agent-ipc.ts",
  "apps/desktop/src/git/status.ts",
  "apps/desktop/src/git/diff.ts",
  "apps/desktop/src/preload.ts",
  "docs/archive/agentic-providers-plan.md",
  "README.md",
  "package.json",
];

/** The full synthesized history for a repo — HEAD first, oldest last. Built once
 *  per path and cached, since every section that mentions a commit reads it. */
const historyCache = new Map<string, GitCommit[]>();
function historyFor(dir: string): GitCommit[] {
  const cached = historyCache.get(dir);
  if (cached) return cached;
  if (!MOCK_SUMMARIES[dir]) return [];

  const commits: GitCommit[] = [];
  const offset = seedOf(dir) % MOCK_SUBJECTS.length;
  for (let i = 0; i < 120; i++) {
    const seed = seedOf(`${dir}#${i}`);
    // Step through the subjects by a stride coprime with their count: every
    // subject appears once before any repeats, so the log reads like real work
    // instead of the same line eight times over.
    const subject = MOCK_SUBJECTS[(offset + i * 7) % MOCK_SUBJECTS.length]!;
    const who = MOCK_AUTHORS[(seed >>> 7) % MOCK_AUTHORS.length]!;
    // Gaps widen as the log goes back: minutes early on, then days, then weeks.
    const minutesAgo = 14 + i * 47 + i * i * 26;
    const at = MOCK_NOW - minutesAgo * 60000;
    const hash = mockHash(`${dir}:${i}:${subject}`);
    commits.push({
      hash,
      short: hash.slice(0, 7),
      subject,
      author: who.author,
      email: who.email,
      date: new Date(at).toISOString(),
      relative: relativeAt(at),
    });
  }
  historyCache.set(dir, commits);
  return commits;
}

export function mockLog(dir: string, limit = 50, skip = 0): GitCommit[] {
  const all = historyFor(dir);
  const from = Math.max(0, Math.floor(skip));
  const count = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;
  return all.slice(from, from + count);
}

export function mockCommitDetail(dir: string, hash: string): GitCommitDetail | null {
  const all = historyFor(dir);
  const index = all.findIndex((c) => c.hash === hash || c.short === hash);
  if (index === -1) return null;
  const commit = all[index]!;
  const seed = seedOf(commit.hash);

  // 2–6 files, drawn deterministically from the touchable pool without repeats.
  const count = 2 + (seed % 5);
  const files: GitCommitDetail["files"] = [];
  const used = new Set<number>();
  for (let i = 0; i < count; i++) {
    let pick = (seed + i * 37) % MOCK_TOUCHABLE.length;
    while (used.has(pick)) pick = (pick + 1) % MOCK_TOUCHABLE.length;
    used.add(pick);
    const path = MOCK_TOUCHABLE[pick]!;
    const fileSeed = seedOf(`${commit.hash}:${path}`);
    // The first file of an "add"-flavoured commit reads as new; the rest are edits.
    const status: GitFileStatus =
      i === 0 && commit.subject.startsWith("feat") && fileSeed % 3 === 0
        ? "added"
        : fileSeed % 17 === 0
          ? "deleted"
          : "modified";
    const added = status === "deleted" ? 0 : 3 + (fileSeed % 84);
    const removed = status === "added" ? 0 : 1 + ((fileSeed >>> 5) % 41);
    files.push({ path, status, added, removed, binary: false });
  }

  const body =
    seed % 3 === 0
      ? ""
      : [
          "The previous approach recomputed this on every frame, which showed up",
          "as a stutter on the first paint of a busy project.",
          "",
          "Measured on the demo repo: 41ms → 6ms.",
        ].join("\n");

  return {
    commit,
    body,
    // The oldest synthesized commit is the root; everything else has one parent.
    parents: index + 1 < all.length ? [all[index + 1]!.hash] : [],
    files,
    added: files.reduce((sum, f) => sum + f.added, 0),
    removed: files.reduce((sum, f) => sum + f.removed, 0),
  };
}

export function mockCommitDiff(
  dir: string,
  hash: string,
  path: string,
): GitFileDiff | null {
  const detail = mockCommitDetail(dir, hash);
  const file = detail?.files.find((f) => f.path === path);
  if (!file) return null;
  return synthDiff(file.path, file.status, file.added, file.removed);
}

// ── remotes, repo state, stashes ─────────────────────────────────────────────

const MOCK_REMOTE_SLUGS: Record<string, string> = {
  "/Users/you/Developer/kone": "kone-dev/kone",
  "/Users/you/Developer/nxui": "kone-dev/nxui",
};

export function mockRemotes(dir: string): GitRemote[] {
  const slug = MOCK_REMOTE_SLUGS[dir];
  // sandbox deliberately has no remote, so the "LOCAL ONLY" masthead and the
  // "no GitHub remote" pull-request state are both reachable in dev.
  if (!slug) return [];
  const url = `git@github.com:${slug}.git`;
  return [{ name: "origin", fetchUrl: url, pushUrl: url, slug, host: "github.com" }];
}

export function mockRepoState(dir: string): GitRepoState {
  void dir;
  return { operation: "none", conflicts: [] };
}

const MOCK_STASHES: Record<string, GitStashEntry[]> = {
  "/Users/you/Developer/kone": [
    {
      index: 0,
      ref: "stash@{0}",
      message: "wip: aurora rim on the commit field",
      branch: "calm-agent-ui-continuation",
      date: new Date(MOCK_NOW - 3 * 3600_000).toISOString(),
      relative: relativeAt(MOCK_NOW - 3 * 3600_000),
    },
    {
      index: 1,
      ref: "stash@{1}",
      message: "terminal pane spike — do not keep",
      branch: "dev",
      date: new Date(MOCK_NOW - 6 * 86400_000).toISOString(),
      relative: relativeAt(MOCK_NOW - 6 * 86400_000),
    },
  ],
};

export function mockStashes(dir: string): GitStashEntry[] {
  return MOCK_STASHES[dir] ?? [];
}

// ── GitHub ───────────────────────────────────────────────────────────────────

export function mockGhStatus(): GitHubStatus {
  return { installed: true, authenticated: true, user: "gideonsarfo", message: null };
}

// The list rows are derived from the details further down, so the list and the
// pull request it opens can never disagree about a number, a face or a check.
const MOCK_PR_DIR = "/Users/you/Developer/kone";

export function mockPrs(dir: string, state: "open" | "all" = "open"): GitHubPullRequest[] {
  if (dir !== MOCK_PR_DIR) return [];
  const all = Object.values(MOCK_PR_DETAILS)
    .sort((a, b) => b.number - a.number)
    .map(prRowOf);
  return state === "all" ? all : all.filter((pr) => pr.state === "open");
}

/** Every file the demo project holds: the canned project list plus whatever
 *  its changes touch, so the Files tab and the changes panel agree. */
function mockProjectPaths(root: string): string[] {
  const paths = new Set(MOCK_PROJECT_FILES[root] ?? []);
  for (const change of MOCK_CHANGES[root] ?? []) {
    if (change.status !== "deleted") paths.add(change.path);
  }
  return [...paths];
}

export function mockProjectDir(root: string, dir: string): ProjectDirListing {
  const prefix = dir ? `${dir}/` : "";
  const dirs = new Set<string>();
  const files = new Set<string>();
  for (const p of mockProjectPaths(root)) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) files.add(rest);
    else dirs.add(rest.slice(0, slash));
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
  const entries: ProjectEntry[] = [
    ...[...dirs].sort(byName).map((name) => ({ name, path: prefix + name, kind: "dir" as const })),
    ...[...files].sort(byName).map((name) => ({ name, path: prefix + name, kind: "file" as const })),
  ];
  return { dir, entries, truncated: false };
}

export function mockProjectFile(root: string, relPath: string): ProjectFileText {
  const pool = linePool(relPath);
  const lines: string[] = [];
  for (let i = 0; i < 48; i++) lines.push(pool[i % pool.length]!);
  const text = lines.join("\n");
  return { text, binary: false, truncated: false, size: text.length };
}

export function mockFiles(dir: string, query = ""): GitProjectFile[] {
  const paths = MOCK_PROJECT_FILES[dir] ?? MOCK_CHANGES[dir]?.map((change) => change.path) ?? [];
  const needle = query.trim().toLowerCase();
  return paths
    .filter((filePath) => !needle || filePath.toLowerCase().includes(needle))
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }))
    .slice(0, 80)
    .map((filePath) => {
      const separator = filePath.lastIndexOf("/");
      return {
        path: filePath,
        name: separator === -1 ? filePath : filePath.slice(separator + 1),
        parent: separator === -1 ? "" : filePath.slice(0, separator),
      };
    });
}

// ── About section ───────────────────────────────────────────────────────────
// The About data for the demo repos: kone gets a full README + logo + repo
// record (so the section reads like the real thing); nxui gets a thinner one;
// sandbox gets the empties — no README, no logo, no GitHub record — so the
// About section's "nothing here" states are reachable in dev.

/** The demo kone README. It is deliberately a real markdown document — the
 *  renderer's markdown styling (headings, fences, tables, links) gets judged
 *  against exactly this text. */
const MOCK_KONE_README = `<p align="center"><img src="public/logo.svg" width="64" alt="kone"></p>

# kone

A **calm** git client — the repository reads like a page, not a diff dump.
Where desktop git UIs pile on panes and chrome, kone keeps the surface quiet:
changes staged by touch, a history that reads as a narrative, and a composer
that lets an agent do the walking.

## What's inside

- **Git space** — changes, history, branches, pull requests, stashes and an
  About view in one surface, so the repo tells its own story.
- **Agent composer** — drive Codex, Claude or Cursor from inside the app.
  Bring your own subscription; kone never stores a credential.
- **Scratchpad** — capture a thought mid-turn without losing the thread.
- **Terminal** — a real pty, with the host's TERM left at the door.

## Getting started

Requires [Bun](https://bun.sh) 1.1 or newer:

\`\`\`bash
bun install
bun run dev:web        # Nuxt 4 renderer with hot reload
bun run dev:desktop    # the Electron shell
\`\`\`

## Commands

| Command             | What it does                 |
| ------------------- | ---------------------------- |
| \`bun run check-types\` | Type-check the workspace   |
| \`bun run dev:web\`     | Renderer with hot reload  |
| \`bun run build\`       | Production bundle         |

## Principles

1. Borderless surfaces over boxed cards.
2. Soft, low elevation — never a heavy shadow.
3. Sound and motion stay _sparse_.

> Restraint is the feature.

See the [handbook](https://example.com/kone-handbook) for the full story, or
file an issue on [the tracker](https://github.com/kone-dev/kone/issues).
`;

const MOCK_README: Record<string, GitReadme> = {
  "/Users/you/Developer/kone": { path: "README.md", markdown: MOCK_KONE_README },
  "/Users/you/Developer/nxui": {
    path: "README.md",
    markdown:
      "# nxui\n\nA small UI kit for the kone family — primitives only, no opinion.\n\nSee [the docs](https://example.com/nxui) for component APIs.\n",
  },
};

export function mockReadme(dir: string): GitReadme | null {
  return MOCK_README[dir] ?? null;
}

const MOCK_IDENTITY: Record<string, GitIdentity> = {
  "/Users/you/Developer/kone": { name: "Gideon Sarfo", email: "gideon@kone.dev" },
  "/Users/you/Developer/nxui": { name: "Gideon Sarfo", email: "gideon@kone.dev" },
  "/Users/you/Developer/sandbox": { name: "Ama Boateng", email: "ama@kone.dev" },
};

export function mockIdentity(dir: string): GitIdentity | null {
  return MOCK_IDENTITY[dir] ?? null;
}

/** A tiny kone wordmark — a small inline SVG is exactly what the desktop's
 *  data URL would carry, so the demo logo renders through the same path. */
const MOCK_LOGO_DATA_URL =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNCIgZmlsbD0iIzE2MTcxZiIvPjxwYXRoIGQ9Ik0yMCA0NlYyMmg3djI0aC03em0xNyAwVjIyaDd2MjRoLTd6IiBmaWxsPSIjZjRjNTQyIi8+PGNpcmNsZSBjeD0iMTUiIGN5PSIxNyIgcj0iMy40IiBmaWxsPSIjN2RkM2ZjIi8+PGNpcmNsZSBjeD0iNDkiIGN5PSI0NyIgcj0iMy40IiBmaWxsPSIjZjlhOGQ0Ii8+PC9zdmc+";

/** A generic portrait mark for the mock account. Deliberately not the repo
 *  logo: the About section draws both a few lines apart, and the same image
 *  twice makes a correct render look like a bug. */
const MOCK_AVATAR_DATA_URL =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIGZpbGw9IiM0MjUwNmIiLz48Y2lyY2xlIGN4PSIzMiIgY3k9IjI1IiByPSIxMSIgZmlsbD0iI2Q3ZGNlYiIvPjxwYXRoIGQ9Ik04IDY0YzAtMTMuMyAxMC43LTI0IDI0LTI0czI0IDEwLjcgMjQgMjR6IiBmaWxsPSIjZDdkY2ViIi8+PC9zdmc+";

const MOCK_LOGOS: Record<string, GitLogo> = {
  "/Users/you/Developer/kone": {
    path: "public/logo.svg",
    dataUrl: MOCK_LOGO_DATA_URL,
  },
};

export function mockLogo(dir: string): GitLogo | null {
  return MOCK_LOGOS[dir] ?? null;
}

/** Repo-relative images the demo READMEs point at, keyed by dir then path.
 *  The same wordmark the logo mock carries, so the README's hero renders
 *  through the identical data-URL path the desktop serves. */
const MOCK_REPO_IMAGES: Record<string, Record<string, string>> = {
  "/Users/you/Developer/kone": { "public/logo.svg": MOCK_LOGO_DATA_URL },
};

export function mockRepoImage(dir: string, path: string): string | null {
  return MOCK_REPO_IMAGES[dir]?.[path] ?? null;
}

const MOCK_REPO_INFO: Record<string, GitHubRepoInfo> = {
  "/Users/you/Developer/kone": {
    nameWithOwner: "kone-dev/kone",
    description:
      "A calm git client — changes read like a page, not a diff dump. Bring your own agent CLI.",
    homepageUrl: "https://kone.dev",
    stars: 412,
    forks: 38,
    license: "MIT",
    language: "Vue",
    topics: ["git", "electron", "nuxt", "agent", "productivity"],
    visibility: "public",
    isFork: false,
    defaultBranch: "main",
    pushedAt: new Date(MOCK_NOW - 2 * 3600_000).toISOString(),
    createdAt: new Date(MOCK_NOW - 40 * 86400_000).toISOString(),
    url: "https://github.com/kone-dev/kone",
  },
  "/Users/you/Developer/nxui": {
    nameWithOwner: "kone-dev/nxui",
    description: "A small UI kit for the kone family — primitives only.",
    homepageUrl: null,
    stars: 12,
    forks: 3,
    license: "MIT",
    language: "TypeScript",
    topics: [],
    visibility: "public",
    isFork: false,
    defaultBranch: "main",
    pushedAt: new Date(MOCK_NOW - 6 * 86400_000).toISOString(),
    createdAt: new Date(MOCK_NOW - 120 * 86400_000).toISOString(),
    url: "https://github.com/kone-dev/nxui",
  },
};

/** The repo's public GitHub surface. sandbox deliberately has no record (it
 *  has no remote), so the About section's "no GitHub info" state is reachable. */
export function mockGhRepo(dir: string): GitHubRepoInfo | null {
  return MOCK_REPO_INFO[dir] ?? null;
}

export function mockGhMe(): GitHubUser | null {
  return {
    login: "gideonsarfo",
    name: "Gideon Sarfo",
    bio: "Building kone — a calm git client.",
    avatarUrl: "https://avatars.githubusercontent.com/u/98345149?v=4",
    avatarDataUrl: MOCK_AVATAR_DATA_URL,
    htmlUrl: "https://github.com/gideonsarfo",
  };
}

// ── contributors ────────────────────────────────────────────────────────────
// The About section reads the same fact two ways: git's own list (always there,
// emails instead of avatars) and GitHub's (avatars, but only when the remote +
// `gh` cooperate). kone gets the GitHub list so the avatar path is the default
// demo; nxui gets the git list so the initials fallback is reachable too; and
// sandbox has no remote, so git's list is the only truth it can have.

// Six small head-and-shoulders marks, one distinct hue each — the same shape
// the account avatar uses, recoloured per person so the row reads as six people
// rather than one mark repeated. Deliberately not the repo logo: the same image
// twice in one section makes a correct render look like a bug.
const MOCK_CONTRIBUTOR_AVATARS = [
  // violet
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNCIgZmlsbD0iIzE2MTcxZiIvPjxjaXJjbGUgY3g9IjMyIiBjeT0iMjUiIHI9IjExIiBmaWxsPSIjYTc4YmZhIi8+PHBhdGggZD0iTTggNjRjMC0xMy4zIDEwLjctMjQgMjQtMjRzMjQgMTAuNyAyNCAyNHoiIGZpbGw9IiNhNzhiZmEiLz48L3N2Zz4=",
  // orange
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNCIgZmlsbD0iIzE2MTcxZiIvPjxjaXJjbGUgY3g9IjMyIiBjeT0iMjUiIHI9IjExIiBmaWxsPSIjZjk3MzE2Ii8+PHBhdGggZD0iTTggNjRjMC0xMy4zIDEwLjctMjQgMjQtMjRzMjQgMTAuNyAyNCAyNHoiIGZpbGw9IiNmOTczMTYiLz48L3N2Zz4=",
  // rose
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNCIgZmlsbD0iIzE2MTcxZiIvPjxjaXJjbGUgY3g9IjMyIiBjeT0iMjUiIHI9IjExIiBmaWxsPSIjZjlhOGQ0Ii8+PHBhdGggZD0iTTggNjRjMC0xMy4zIDEwLjctMjQgMjQtMjRzMjQgMTAuNyAyNCAyNHoiIGZpbGw9IiNmOWE4ZDQiLz48L3N2Zz4=",
  // teal
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNCIgZmlsbD0iIzE2MTcxZiIvPjxjaXJjbGUgY3g9IjMyIiBjeT0iMjUiIHI9IjExIiBmaWxsPSIjMmRkNGJmIi8+PHBhdGggZD0iTTggNjRjMC0xMy4zIDEwLjctMjQgMjQtMjRzMjQgMTAuNyAyNCAyNHoiIGZpbGw9IiMyZGQ0YmYiLz48L3N2Zz4=",
  // sky
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNCIgZmlsbD0iIzE2MTcxZiIvPjxjaXJjbGUgY3g9IjMyIiBjeT0iMjUiIHI9IjExIiBmaWxsPSIjN2RkM2ZjIi8+PHBhdGggZD0iTTggNjRjMC0xMy4zIDEwLjctMjQgMjQtMjRzMjQgMTAuNyAyNCAyNHoiIGZpbGw9IiM3ZGQzZmMiLz48L3N2Zz4=",
  // green
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNCIgZmlsbD0iIzE2MTcxZiIvPjxjaXJjbGUgY3g9IjMyIiBjeT0iMjUiIHI9IjExIiBmaWxsPSIjODZlZmFjIi8+PHBhdGggZD0iTTggNjRjMC0xMy4zIDEwLjctMjQgMjQtMjRzMjQgMTAuNyAyNCAyNHoiIGZpbGw9IiM4NmVmYWMiLz48L3N2Zz4=",
];

// kone has a GitHub remote and 18 contributors; only the top six (by commit
// count) are in the row, so the "+12 more" path is the one the demo shows.
const MOCK_GITHUB_CONTRIBUTORS: Record<string, GitContributors> = {
  "/Users/you/Developer/kone": {
    source: "github",
    people: [
      // `name` is the login here, exactly as github.ts builds it — GitHub's
      // contributors endpoint carries no display name, and a mock that shows
      // human names would demo a state the real bridge can't produce.
      { name: "adalovelace", login: "adalovelace", email: null, avatarDataUrl: MOCK_CONTRIBUTOR_AVATARS[0]!, commits: 412 },
      { name: "gideonsarfo", login: "gideonsarfo", email: null, avatarDataUrl: MOCK_CONTRIBUTOR_AVATARS[1]!, commits: 288 },
      { name: "amaboateng", login: "amaboateng", email: null, avatarDataUrl: MOCK_CONTRIBUTOR_AVATARS[2]!, commits: 204 },
      { name: "kwesimensah", login: "kwesimensah", email: null, avatarDataUrl: MOCK_CONTRIBUTOR_AVATARS[3]!, commits: 176 },
      { name: "esiofori", login: "esiofori", email: null, avatarDataUrl: MOCK_CONTRIBUTOR_AVATARS[4]!, commits: 95 },
      { name: "kofiadj", login: "kofiadj", email: null, avatarDataUrl: MOCK_CONTRIBUTOR_AVATARS[5]!, commits: 43 },
    ],
    total: 18,
  },
};

// git's own lists — emails, no avatars. nxui's fits the cap exactly (no "+n
// more"); sandbox gets the git list too, because a repo with no remote can only
// name its people from git.
const MOCK_GIT_CONTRIBUTORS: Record<string, GitContributors> = {
  "/Users/you/Developer/nxui": {
    source: "git",
    people: [
      { name: "Gideon Sarfo", login: null, email: "gideon@kone.dev", avatarDataUrl: null, commits: 87 },
      { name: "Ama Boateng", login: null, email: "ama@kone.dev", avatarDataUrl: null, commits: 54 },
      { name: "Kwesi Mensah", login: null, email: "kwesi@kone.dev", avatarDataUrl: null, commits: 31 },
    ],
    total: 3,
  },
  "/Users/you/Developer/sandbox": {
    source: "git",
    people: [
      { name: "Ama Boateng", login: null, email: "ama@kone.dev", avatarDataUrl: null, commits: 24 },
      { name: "Gideon Sarfo", login: null, email: "gideon@kone.dev", avatarDataUrl: null, commits: 9 },
    ],
    total: 2,
  },
};

/** The repo's contributors via GitHub, or null when there's no GitHub record.
 *  kone alone qualifies, so the avatar path is the one the demo defaults to. */
export function mockGhContributors(dir: string): GitContributors | null {
  return MOCK_GITHUB_CONTRIBUTORS[dir] ?? null;
}

/** The repo's contributors straight from git — always present when the path is
 *  a known repo, null otherwise (the empty shape the caller falls back to). */
export function mockContributors(dir: string): GitContributors | null {
  return MOCK_GIT_CONTRIBUTORS[dir] ?? null;
}

// ── pull-request details ────────────────────────────────────────────────────
// The dedicated pull-request view reads one number at a time, so these live in
// a map keyed by PR number rather than by repo path. Every PR in MOCK_PRS gets
// a detail here carrying the same number, title, author, branch and dates the
// list row shows; anything else resolves to null. #148 is the surface the view
// is designed against, so it carries the full world — a real markdown body,
// labels, reviews, a threaded conversation, a checks rollup, and a file list
// whose additions/deletions sum to the row's own diffstat.

/** One GitHub person, wearing the same avatar the contributors row gives them,
 *  so the same login always shows the same face across the demo world. */
function prPerson(login: string, name: string, avatar: string | null): GitHubPerson {
  return { login, name, avatarDataUrl: avatar };
}

const GIDEON = prPerson("gideonsarfo", "Gideon Sarfo", MOCK_CONTRIBUTOR_AVATARS[1]!);
const AMA = prPerson("amaboateng", "Ama Boateng", MOCK_CONTRIBUTOR_AVATARS[2]!);
const KWESI = prPerson("kwesimensah", "Kwesi Mensah", MOCK_CONTRIBUTOR_AVATARS[3]!);

/** A PR-branch commit with a stable oid — `short` is always the oid's first
 *  seven chars, and the headline reads like this repo's own conventional
 *  commits. `hoursAgo` places it relative to the fixed demo clock. */
function prCommit(
  seed: string,
  headline: string,
  author: string,
  hoursAgo: number,
  body = "",
): GitHubPrCommit {
  const oid = mockHash(seed);
  return {
    oid,
    short: oid.slice(0, 7),
    headline,
    body,
    author,
    date: new Date(MOCK_NOW - hoursAgo * 3600_000).toISOString(),
    relative: relativeAt(MOCK_NOW - hoursAgo * 3600_000),
  };
}

/** One check run as the rollup reports it, started `minsAgo` before the demo
 *  clock. A pending run hasn't finished and a skipped one never ran. */
function check(
  name: string,
  workflow: string,
  state: GitHubCheck["state"],
  url: string | null,
  minsAgo: number,
): GitHubCheck {
  const started = MOCK_NOW - minsAgo * 60_000;
  // Durations vary by name so the list doesn't read as one number repeated.
  const seconds = 40 + ((seedOf(name) >>> 3) % 420);
  return {
    name,
    workflow,
    state,
    url,
    startedAt: state === "skipped" ? null : new Date(started).toISOString(),
    completedAt:
      state === "skipped" || state === "pending" ? null : new Date(started + seconds * 1000).toISOString(),
  };
}

const MOCK_PR_DETAILS: Record<number, GitHubPullRequestDetail> = {
  148: {
    number: 148,
    title: "Git Space — a repository surface inside the project",
    state: "open",
    isDraft: false,
    url: "https://github.com/kone-dev/kone/pull/148",
    body: `## What this adds

The Git Space turns a project's git surface into something you read, not a
toolbox you dig through. \`feat/git-space\` lands the first two panes — Changes
and History — behind the same corner-folder gesture as the branch picker, so
the repo's story and the working tree sit one breath apart.

- **Changes** — the staged and unstaged diffstat in a quiet lane, with
  word-level highlighting on the paired edit.
- **History** — a narrative log: subject, relative date, and the author's
  face, resolved from the commit email when GitHub knows the person.
- **Branch picker** — the corner folder now lists local and remote branches,
  with the current branch's divergence marked.

### The demo world

In \`nuxt dev\` every pane resolves against the same three mock repos, so the
space and the launcher never disagree about what changed:

\`\`\`ts
const repo = mockDetect(dir);
const status = mockStatus(dir);
\`\`\`

See the [design notes](https://github.com/kone-dev/kone/wiki/git-space) for the
borders-out, elevation-out rationale.`,
    author: GIDEON,
    branch: "feat/git-space",
    headOid: null,
    mergeMethods: ["merge", "squash", "rebase"],
    canWrite: true,
    base: "main",
    forkOwner: null,
    createdAt: new Date(MOCK_NOW - 5 * 3600_000).toISOString(),
    relative: relativeAt(MOCK_NOW - 5 * 3600_000),
    updatedAt: new Date(MOCK_NOW - 3600_000).toISOString(),
    mergedAt: null,
    closedAt: null,
    mergedBy: null,
    additions: 1842,
    deletions: 96,
    changedFiles: 5,
    mergeability: "clean",
    reviewDecision: "approved",
    // The e2e run is still going, so the rollup is pending even though every
    // other check passed.
    checks: "pending",
    checkRuns: [
      check("lint", "ci.yml", "passing", "https://github.com/kone-dev/kone/actions/runs/14801", 27),
      check("typecheck", "ci.yml", "passing", "https://github.com/kone-dev/kone/actions/runs/14802", 34),
      check("test (linux)", "ci.yml", "passing", "https://github.com/kone-dev/kone/actions/runs/14803", 41),
      check("e2e (electron)", "ci.yml", "pending", "https://github.com/kone-dev/kone/actions/runs/14804", 48),
      check("docs", "docs.yml", "skipped", null, 55),
    ],
    labels: [
      { name: "git space", description: "The repository surface inside a project", color: "c5def5" },
      { name: "enhancement", description: "New feature or request", color: "84b6eb" },
      { name: "ui", description: "Visual polish or layout work", color: "f9d0c4" },
    ],
    assignees: [KWESI],
    reviews: [
      {
        author: KWESI,
        state: "approved",
        body: "The changes lane holds up at this elevation and the branch picker reads clearly. One question on the diff's word-level highlight, left inline.",
        submittedAt: new Date(MOCK_NOW - 2 * 3600_000).toISOString(),
        relative: relativeAt(MOCK_NOW - 2 * 3600_000),
        commit: mockHash("pr148:1"),
      },
      // Ama was asked but hasn't weighed in yet — that open slot is the state
      // the view has to render as still-waiting, so it gets a bodyless review.
      { author: AMA, state: "pending", body: "", submittedAt: null, relative: "", commit: null },
    ],
    comments: [
      {
        author: AMA,
        body: "The history gutter's initials fallback is a nice touch — worth keeping it in the design pass.",
        createdAt: new Date(MOCK_NOW - 3600_000).toISOString(),
        relative: relativeAt(MOCK_NOW - 3600_000),
        url: "https://github.com/kone-dev/kone/pull/148#issuecomment-1409",
      },
      {
        author: KWESI,
        body: "Reviewing the **Changes** pane now — the paired-edit highlight reads clearly at this elevation.",
        createdAt: new Date(MOCK_NOW - 2 * 3600_000).toISOString(),
        relative: relativeAt(MOCK_NOW - 2 * 3600_000),
        url: "https://github.com/kone-dev/kone/pull/148#issuecomment-1407",
      },
      {
        author: GIDEON,
        body: "First draft of the space is in. `useGitSpace` keeps one reactive model per project, so the pane and the picker stay in lockstep.",
        createdAt: new Date(MOCK_NOW - 4 * 3600_000).toISOString(),
        relative: relativeAt(MOCK_NOW - 4 * 3600_000),
        url: "https://github.com/kone-dev/kone/pull/148#issuecomment-1402",
      },
    ],
    commits: [
      prCommit("pr148:0", "fix(git): keep the corner-folder branch picker in sync", "gideonsarfo", 1),
      prCommit("pr148:1", "feat(git): diffstat changes lane with paired-edit highlighting", "gideonsarfo", 3),
      prCommit("pr148:2", "refactor(git): fold disk truth through one applyStatus", "gideonsarfo", 5),
      prCommit("pr148:3", "feat(git): open the git space as a project surface", "gideonsarfo", 6),
    ],
    files: [
      { path: "apps/web/app/components/GitSpace.vue", additions: 1042, deletions: 0, change: "added" },
      { path: "apps/web/app/composables/useGitSpace.ts", additions: 486, deletions: 0, change: "added" },
      { path: "apps/web/app/components/GitSpaceHistory.vue", additions: 214, deletions: 18, change: "modified" },
      { path: "apps/web/app/assets/css/main.css", additions: 72, deletions: 68, change: "modified" },
      { path: "apps/web/nuxt.config.ts", additions: 28, deletions: 10, change: "modified" },
    ],
    milestone: null,
  },
  146: {
    number: 146,
    title: "Factory Droid provider with ACP adapter",
    state: "open",
    isDraft: false,
    url: "https://github.com/kone-dev/kone/pull/146",
    body: "Adds the Factory Droid provider behind the ACP adapter, so a droid surface runs from the composer like any other CLI. The spawn path, the per-model reasoning-effort ladder and resume all pass through the shared session plumbing — no provider-specific forks.",
    author: AMA,
    branch: "feat/droid-provider",
    headOid: null,
    mergeMethods: ["merge", "squash", "rebase"],
    canWrite: true,
    base: "main",
    forkOwner: null,
    createdAt: new Date(MOCK_NOW - 2 * 86400_000).toISOString(),
    relative: relativeAt(MOCK_NOW - 2 * 86400_000),
    updatedAt: new Date(MOCK_NOW - 6 * 3600_000).toISOString(),
    mergedAt: null,
    closedAt: null,
    mergedBy: null,
    additions: 731,
    deletions: 212,
    changedFiles: 3,
    mergeability: "clean",
    reviewDecision: "approved",
    checks: "passing",
    checkRuns: [
      check("lint", "ci.yml", "passing", "https://github.com/kone-dev/kone/actions/runs/14601", 62),
      check("typecheck", "ci.yml", "passing", "https://github.com/kone-dev/kone/actions/runs/14602", 69),
      check("test (linux)", "ci.yml", "passing", "https://github.com/kone-dev/kone/actions/runs/14603", 76),
    ],
    labels: [],
    assignees: [GIDEON],
    reviews: [
      {
        author: GIDEON,
        state: "approved",
        body: "The ACP shape is clean and the spawn path matches the Codex adapter. Approved.",
        submittedAt: new Date(MOCK_NOW - 28 * 3600_000).toISOString(),
        relative: relativeAt(MOCK_NOW - 28 * 3600_000),
        commit: mockHash("pr146:0"),
      },
    ],
    comments: [
      {
        author: KWESI,
        body: "Nice — the adapter stays credential-free. One nit: the `droid exec --output-format acp` sample is missing from the docs.",
        createdAt: new Date(MOCK_NOW - 30 * 3600_000).toISOString(),
        relative: relativeAt(MOCK_NOW - 30 * 3600_000),
        url: "https://github.com/kone-dev/kone/pull/146#issuecomment-1398",
      },
    ],
    commits: [
      prCommit("pr146:0", "fix(agent): resolve the droid spawn path under the asar", "amaboateng", 12),
      prCommit("pr146:1", "feat(agent): per-model reasoning-effort ladder", "amaboateng", 30),
      prCommit("pr146:2", "feat(agent): Factory Droid provider with ACP adapter", "amaboateng", 46),
    ],
    files: [
      { path: "packages/agent-core/src/adapters/AntigravityAdapter.ts", additions: 412, deletions: 0, change: "added" },
      { path: "packages/agent-core/src/adapters.ts", additions: 244, deletions: 96, change: "modified" },
      { path: "apps/web/app/composables/useAgent.ts", additions: 75, deletions: 116, change: "modified" },
    ],
    milestone: null,
  },
  145: {
    number: 145,
    title: "Terminal pane: stop leaking the host TERM into the pty",
    state: "open",
    isDraft: true,
    url: "https://github.com/kone-dev/kone/pull/145",
    body: "Stops leaking the host's TERM into the pty, so the terminal pane renders its own palette instead of inheriting the shell's. Still a draft — the resize-while-hidden path is being verified.",
    author: KWESI,
    branch: "fix/pty-term",
    headOid: null,
    mergeMethods: ["merge", "squash", "rebase"],
    canWrite: true,
    base: "dev",
    forkOwner: null,
    createdAt: new Date(MOCK_NOW - 4 * 86400_000).toISOString(),
    relative: relativeAt(MOCK_NOW - 4 * 86400_000),
    updatedAt: new Date(MOCK_NOW - 3 * 86400_000).toISOString(),
    mergedAt: null,
    closedAt: null,
    mergedBy: null,
    additions: 64,
    deletions: 18,
    changedFiles: 2,
    mergeability: "draft",
    reviewDecision: "changes-requested",
    checks: "failing",
    checkRuns: [
      check("lint", "ci.yml", "passing", "https://github.com/kone-dev/kone/actions/runs/14501", 83),
      check("typecheck", "ci.yml", "failing", "https://github.com/kone-dev/kone/actions/runs/14502", 90),
    ],
    labels: [],
    assignees: [KWESI],
    reviews: [
      {
        author: AMA,
        state: "changes-requested",
        body: "The TERM scrub looks right, but the new palette reference needs a guard when the pane is created headless.",
        submittedAt: new Date(MOCK_NOW - 3 * 86400_000).toISOString(),
        relative: relativeAt(MOCK_NOW - 3 * 86400_000),
        commit: mockHash("pr145:0"),
      },
    ],
    comments: [],
    commits: [
      prCommit("pr145:0", "fix(terminal): stop leaking the host TERM into the pty", "kwesimensah", 92),
      prCommit("pr145:1", "fix(terminal): keep xterm's fit() valid while a surface is hidden", "kwesimensah", 96),
    ],
    files: [
      { path: "packages/agent-core/src/adapters/DroidAdapter.ts", additions: 38, deletions: 14, change: "modified" },
      { path: "apps/web/app/components/TerminalPane.vue", additions: 26, deletions: 4, change: "modified" },
    ],
    milestone: null,
  },
  141: {
    number: 141,
    title: "Archive threads from columns and crossfade dock stacks",
    state: "merged",
    isDraft: false,
    url: "https://github.com/kone-dev/kone/pull/141",
    body: "Archiving a thread now moves it off the strip in one gesture and the dock stacks crossfade in place, so a busy project never looks half-empty. Follow-up work — search across archived threads — is tracked in #150.",
    author: GIDEON,
    branch: "feat/archive-threads",
    headOid: null,
    mergeMethods: ["merge", "squash", "rebase"],
    canWrite: true,
    base: "main",
    forkOwner: null,
    createdAt: new Date(MOCK_NOW - 9 * 86400_000).toISOString(),
    relative: relativeAt(MOCK_NOW - 9 * 86400_000),
    updatedAt: new Date(MOCK_NOW - 8 * 86400_000).toISOString(),
    mergedAt: new Date(MOCK_NOW - 8 * 86400_000).toISOString(),
    closedAt: new Date(MOCK_NOW - 8 * 86400_000).toISOString(),
    mergedBy: GIDEON,
    additions: 402,
    deletions: 137,
    changedFiles: 3,
    mergeability: "clean",
    reviewDecision: "approved",
    checks: "passing",
    checkRuns: [
      check("lint", "ci.yml", "passing", "https://github.com/kone-dev/kone/actions/runs/14101", 97),
      check("typecheck", "ci.yml", "passing", "https://github.com/kone-dev/kone/actions/runs/14102", 104),
      check("test (linux)", "ci.yml", "passing", "https://github.com/kone-dev/kone/actions/runs/14103", 111),
    ],
    labels: [],
    assignees: [GIDEON],
    reviews: [
      {
        author: AMA,
        state: "approved",
        body: "The crossfade is subtle and the empty state holds up. Nice one.",
        submittedAt: new Date(MOCK_NOW - 8 * 86400_000).toISOString(),
        relative: relativeAt(MOCK_NOW - 8 * 86400_000),
        commit: mockHash("pr141:0"),
      },
    ],
    comments: [
      {
        author: KWESI,
        body: "Tested against a busy project — the strip feels calmer. Ship it.",
        createdAt: new Date(MOCK_NOW - 8 * 86400_000).toISOString(),
        relative: relativeAt(MOCK_NOW - 8 * 86400_000),
        url: "https://github.com/kone-dev/kone/pull/141#issuecomment-1390",
      },
    ],
    commits: [
      prCommit("pr141:0", "fix(ui): stop the greeting flashing its empty state", "gideonsarfo", 210),
      prCommit("pr141:1", "feat(ui): scrollable tiling rail for the thread strip", "gideonsarfo", 228),
      prCommit("pr141:2", "feat(ui): archive threads from columns and crossfade dock stacks", "gideonsarfo", 240),
    ],
    files: [
      { path: "apps/web/app/components/ThreadStrip.vue", additions: 188, deletions: 31, change: "modified" },
      { path: "apps/web/app/composables/useThreads.ts", additions: 142, deletions: 72, change: "modified" },
      { path: "apps/web/app/assets/css/main.css", additions: 72, deletions: 34, change: "modified" },
    ],
    milestone: null,
  },
  // Ama asked you for a review and nobody has answered yet: the row that lands
  // in "Waiting on you".
  149: {
    number: 149,
    title: "Branches: ahead/behind sparkline for every branch",
    state: "open",
    isDraft: false,
    url: "https://github.com/kone-dev/kone/pull/149",
    body: "Each branch row draws its last two weeks of commits as a sparkline, with ahead/behind against the trunk beside it, so a stale branch reads as stale before you open it.",
    author: AMA,
    branch: "feat/branch-sparklines",
    headOid: null,
    mergeMethods: ["merge", "squash", "rebase"],
    canWrite: true,
    base: "main",
    forkOwner: null,
    createdAt: new Date(MOCK_NOW - 26 * 3600_000).toISOString(),
    relative: relativeAt(MOCK_NOW - 26 * 3600_000),
    updatedAt: new Date(MOCK_NOW - 40 * 60_000).toISOString(),
    mergedAt: null,
    closedAt: null,
    mergedBy: null,
    additions: 318,
    deletions: 41,
    changedFiles: 4,
    mergeability: "blocked",
    reviewDecision: "review-required",
    checks: "passing",
    checkRuns: [
      check("lint", "ci.yml", "passing", "https://github.com/kone-dev/kone/actions/runs/14901", 50),
      check("typecheck", "ci.yml", "passing", "https://github.com/kone-dev/kone/actions/runs/14902", 50),
      check("test (linux)", "ci.yml", "passing", "https://github.com/kone-dev/kone/actions/runs/14903", 50),
      check("test (macos)", "ci.yml", "passing", "https://github.com/kone-dev/kone/actions/runs/14904", 50),
      check("e2e (electron)", "ci.yml", "passing", "https://github.com/kone-dev/kone/actions/runs/14905", 50),
      check("docs", "docs.yml", "skipped", null, 50),
    ],
    labels: [
      { name: "git space", description: "The repository surface inside a project", color: "c5def5" },
      { name: "ui", description: "Visual polish or layout work", color: "f9d0c4" },
    ],
    assignees: [AMA],
    reviews: [
      { author: GIDEON, state: "pending", body: "", submittedAt: null, relative: "", commit: null },
      { author: KWESI, state: "pending", body: "", submittedAt: null, relative: "", commit: null },
    ],
    comments: [],
    commits: [
      prCommit("pr149:0", "feat(ui): ahead/behind beside each branch", "amaboateng", 1),
      prCommit("pr149:1", "feat(ui): sparkline of a branch's last two weeks", "amaboateng", 20),
    ],
    files: [
      { path: "apps/web/app/components/git-space/GitSpaceBranches.vue", additions: 204, deletions: 33, change: "modified" },
      { path: "apps/web/app/components/git-space/BranchSparkline.vue", additions: 88, deletions: 0, change: "added" },
      { path: "apps/web/app/composables/useGitSpace.ts", additions: 22, deletions: 8, change: "modified" },
      { path: "apps/web/app/components/git-space/GitSpaceBranches.test.ts", additions: 4, deletions: 0, change: "added" },
    ],
    milestone: "Git Space v1",
  },
  // A dependency bump that fell behind main and now conflicts with it.
  147: {
    number: 147,
    title: "Bump electron from 32.1.0 to 33.0.2",
    state: "open",
    isDraft: false,
    url: "https://github.com/kone-dev/kone/pull/147",
    body: "Bumps [electron](https://github.com/electron/electron) from 32.1.0 to 33.0.2.",
    author: prPerson("dependabot", "Dependabot", null),
    branch: "dependabot/npm_and_yarn/electron-33.0.2",
    headOid: null,
    mergeMethods: ["merge", "squash", "rebase"],
    canWrite: true,
    base: "main",
    forkOwner: null,
    createdAt: new Date(MOCK_NOW - 3 * 86400_000).toISOString(),
    relative: relativeAt(MOCK_NOW - 3 * 86400_000),
    updatedAt: new Date(MOCK_NOW - 30 * 3600_000).toISOString(),
    mergedAt: null,
    closedAt: null,
    mergedBy: null,
    additions: 12,
    deletions: 12,
    changedFiles: 2,
    mergeability: "conflicting",
    reviewDecision: null,
    checks: "failing",
    checkRuns: [
      check("lint", "ci.yml", "passing", "https://github.com/kone-dev/kone/actions/runs/14701", 1800),
      check("typecheck", "ci.yml", "passing", "https://github.com/kone-dev/kone/actions/runs/14702", 1800),
      check("test (linux)", "ci.yml", "failing", "https://github.com/kone-dev/kone/actions/runs/14703", 1800),
      check("test (macos)", "ci.yml", "failing", "https://github.com/kone-dev/kone/actions/runs/14704", 1800),
    ],
    labels: [{ name: "dependencies", description: "Pull requests that update a dependency file", color: "0366d6" }],
    assignees: [],
    reviews: [],
    comments: [],
    commits: [prCommit("pr147:0", "chore(deps): bump electron from 32.1.0 to 33.0.2", "dependabot[bot]", 72)],
    files: [
      { path: "apps/desktop/package.json", additions: 1, deletions: 1, change: "modified" },
      { path: "bun.lock", additions: 11, deletions: 11, change: "modified" },
    ],
    milestone: null,
  },
};

// The demo commits carry distinct dates, so the newest one is the head here;
// the desktop reads it straight from GitHub instead.
for (const d of Object.values(MOCK_PR_DETAILS)) {
  let head: GitHubPrCommit | null = null;
  for (const c of d.commits) if (!head || c.date > head.date) head = c;
  d.headOid = head?.oid ?? null;
}

/** A detail as the list row the desktop's `gh pr list` would produce for it. */
function prRowOf(d: GitHubPullRequestDetail): GitHubPullRequest {
  const checkCounts = { passing: 0, failing: 0, pending: 0, skipped: 0 };
  for (const run of d.checkRuns) if (run.state !== "none") checkCounts[run.state] += 1;
  // An open request comes after that person's review and replaces it.
  const byLogin = new Map<string, GitHubReviewer>();
  for (const r of d.reviews) if (r.author) byLogin.set(r.author.login, { person: r.author, state: r.state });
  const reviewers = [...byLogin.values()];
  return {
    number: d.number,
    title: d.title,
    state: d.state,
    isDraft: d.isDraft,
    author: d.author?.login ?? "unknown",
    branch: d.branch,
    base: d.base,
    url: d.url,
    createdAt: d.createdAt,
    relative: d.relative,
    additions: d.additions,
    deletions: d.deletions,
    checks: d.checks,
    reviewDecision: d.reviewDecision,
    comments: d.comments.length,
    authorPerson: d.author,
    updatedAt: d.updatedAt,
    updated: d.updatedAt ? relativeAt(Date.parse(d.updatedAt)) : "",
    changedFiles: d.changedFiles,
    labels: d.labels,
    reviewers,
    mergeability: d.mergeability,
    checkCounts,
  };
}

/** One PR's full detail, or null when the number isn't one the demo world has. */
export function mockPrDetail(number: number): GitHubPullRequestDetail | null {
  return MOCK_PR_DETAILS[number] ?? null;
}

/** A pull request action played against the demo world, so the card and the
 *  list move the way they would after the real gh call. */
export function mockPrAction(number: number, action: GitHubPrAction): void {
  const d = MOCK_PR_DETAILS[number];
  if (!d) throw new Error(`No pull request #${number}.`);
  const now = new Date().toISOString();
  d.updatedAt = now;
  switch (action) {
    case "merge":
      if (d.mergeability === "conflicting") throw new Error("Pull request is not mergeable: the merge commit cannot be cleanly created.");
      d.state = "merged";
      d.mergedAt = now;
      d.mergedBy = GIDEON;
      d.mergeability = "unknown";
      break;
    case "ready":
      d.isDraft = false;
      if (d.mergeability === "draft") d.mergeability = "clean";
      break;
    case "draft":
      d.isDraft = true;
      break;
    case "close":
      d.state = "closed";
      d.closedAt = now;
      break;
    case "reopen":
      d.state = "open";
      d.closedAt = null;
      break;
  }
}

/** A comment left from the card, as yours, at the end of the conversation. */
export function mockPrComment(number: number, body: string): void {
  const d = MOCK_PR_DETAILS[number];
  if (!d) throw new Error(`No pull request #${number}.`);
  const now = new Date().toISOString();
  d.comments.push({ author: GIDEON, body, createdAt: now, relative: "just now", url: `${d.url}#issuecomment-${Date.now()}` });
  d.updatedAt = now;
}

/** The diff for a PR, one file in the same order as the detail's `files` list,
 *  each with the same path and diffstat. GitHub calls a file "removed" where
 *  git says "deleted"; everything else maps to "modified". Hunks are a
 *  representative 1–2 per file, synthesized from the extension's line pool. */
export function mockPrDiff(number: number): GitFileDiff[] {
  const detail = MOCK_PR_DETAILS[number];
  if (!detail) return [];
  return detail.files.map((file) => {
    const status: GitFileStatus =
      file.change === "added" ? "added" : file.change === "removed" ? "deleted" : "modified";
    return {
      path: file.path,
      status,
      binary: false,
      hunks: prDiffHunks(file.path, status),
      added: file.additions,
      removed: file.deletions,
    };
  });
}

/** One file's representative hunks, with git's gutter arithmetic: a context
 *  line advances both old and new numbers, an add advances only the new, a del
 *  only the old. Added files open at line 1; deleted files close from line 1;
 *  a modification is a paired edit — each deleted line gets a lightly-tweaked
 *  replacement, so the word-level view highlights just the changed token. */
function prDiffHunks(relPath: string, status: GitFileStatus): GitDiffHunk[] {
  const pool = linePool(relPath);
  const pick = (i: number) => pool[i % pool.length]!;

  const hunk = (
    header: string,
    oldStart: number,
    newStart: number,
    edit: (step: { ctx: (text: string) => void; del: (text: string) => void; add: (text: string) => void }) => void,
  ): GitDiffHunk => {
    const lines: GitDiffLine[] = [];
    let oldNo = oldStart;
    let newNo = newStart;
    edit({
      ctx: (text) => {
        lines.push({ kind: "context", text, oldNo, newNo });
        oldNo++;
        newNo++;
      },
      del: (text) => {
        lines.push({ kind: "del", text, oldNo, newNo: null });
        oldNo++;
      },
      add: (text) => {
        lines.push({ kind: "add", text, oldNo: null, newNo });
        newNo++;
      },
    });
    return { header, oldStart, newStart, lines };
  };

  if (status === "added") {
    return [
      hunk("", 0, 1, ({ add }) => {
        for (let i = 0; i < 10; i++) add(pick(i));
      }),
    ];
  }
  if (status === "deleted") {
    return [
      hunk("", 1, 0, ({ del }) => {
        for (let i = 0; i < 8; i++) del(pick(i));
      }),
    ];
  }
  // Two hunks so a long-lived file shows a second change region instead of one
  // edit floating in a vacuum.
  return [
    hunk("", 18, 18, ({ ctx, del, add }) => {
      ctx(pick(0));
      for (let i = 0; i < 3; i++) del(pick(i + 1));
      for (let i = 0; i < 3; i++) add(tweak(pick(i + 1), i));
      ctx(pick(9));
    }),
    hunk("", 34, 34, ({ ctx, del, add }) => {
      ctx(pick(0));
      for (let i = 0; i < 2; i++) del(pick(i + 2));
      for (let i = 0; i < 2; i++) add(tweak(pick(i + 2), i));
      ctx(pick(4));
    }),
  ];
}

// ── commit authors ──────────────────────────────────────────────────────────
// The history gutter resolves a face per commit email, so the demo map is keyed
// by the exact emails MOCK_AUTHORS puts on the synthesized log. Most of them are
// covered — deliberately not all — so a row still falls through to the
// initial-letter fallback and that state keeps being designed against.

export function mockCommitAuthors(): GitCommitAuthors {
  return {
    "stephen.seirh@amalitech.com": GIDEON,
    "ama@kone.dev": AMA,
  };
}

// ── issues ──────────────────────────────────────────────────────────────────
// A small tracker for the same repository: bugs and asks spread over a few
// weeks, some assigned, a pinned roadmap, and a handful closed both ways (done,
// and not planned), so every part of the Issues section has something to draw.

const ADA = prPerson("adalovelace", "Ada Lovelace", MOCK_CONTRIBUTOR_AVATARS[0]!);

const LABEL = {
  bug: { name: "bug", description: "Something isn't working", color: "d73a4a" },
  enhancement: { name: "enhancement", description: "New feature or request", color: "a2eeef" },
  git: { name: "git space", description: null, color: "bfdadc" },
  terminal: { name: "terminal", description: null, color: "c5def5" },
  linux: { name: "linux", description: null, color: "fbca04" },
  good: { name: "good first issue", description: "Good for newcomers", color: "7057ff" },
  question: { name: "question", description: "Further information is requested", color: "d876e3" },
  design: { name: "design", description: null, color: "f9a8d4" },
} satisfies Record<string, GitHubLabel>;

function issueComment(author: GitHubPerson, body: string, hoursAgo: number, n: number): GitHubComment {
  const at = MOCK_NOW - hoursAgo * 3600_000;
  return {
    author,
    body,
    createdAt: new Date(at).toISOString(),
    relative: relativeAt(at),
    url: `https://github.com/kone-dev/kone/issues/${n}#issuecomment-${seedOf(body)}`,
  };
}

function mockIssue(
  i: Omit<GitHubIssueDetail, "url" | "createdAt" | "relative" | "updatedAt" | "updated" | "closedAt" | "commentCount" | "canTriage"> & {
    openedHoursAgo: number;
    closedHoursAgo?: number;
  },
): GitHubIssueDetail {
  const { openedHoursAgo, closedHoursAgo, ...rest } = i;
  const opened = MOCK_NOW - openedHoursAgo * 3600_000;
  const closed = closedHoursAgo === undefined ? null : MOCK_NOW - closedHoursAgo * 3600_000;
  const last = Math.max(opened, closed ?? 0, ...rest.comments.map((c) => Date.parse(c.createdAt)));
  return {
    ...rest,
    url: `https://github.com/kone-dev/kone/issues/${rest.number}`,
    createdAt: new Date(opened).toISOString(),
    relative: relativeAt(opened),
    updatedAt: new Date(last).toISOString(),
    updated: relativeAt(last),
    closedAt: closed === null ? null : new Date(closed).toISOString(),
    commentCount: rest.comments.length,
    canTriage: true,
  };
}

const MOCK_ISSUES: Record<number, GitHubIssueDetail> = Object.fromEntries(
  [
    mockIssue({
      number: 152,
      title: "Roadmap: the Git Space through v1",
      state: "open",
      stateReason: null,
      author: GIDEON,
      labels: [LABEL.git, LABEL.enhancement],
      assignees: [GIDEON],
      milestone: "Git Space v1",
      isPinned: true,
      openedHoursAgo: 24 * 21,
      body: `What's left before the Git Space is called done.

- [x] About, History and Pull requests
- [ ] Issues
- [ ] Changes, Branches and Stashes in the new layout
- [ ] Keyboard pass over every section`,
      comments: [issueComment(AMA, "Issues next makes sense: half our tracker is links back to PRs anyway.", 30, 152)],
    }),
    mockIssue({
      number: 151,
      title: "Terminal loses its scrollback after the window is hidden",
      state: "open",
      stateReason: null,
      author: AMA,
      labels: [LABEL.bug, LABEL.terminal],
      assignees: [KWESI],
      milestone: null,
      isPinned: false,
      openedHoursAgo: 5,
      body: `Hide the window with the shortcut, bring it back, and the terminal starts from an empty screen.

**Expected:** the scrollback is still there.
**Seen on:** macOS 15 and Ubuntu 24.04.`,
      comments: [
        issueComment(KWESI, "I can reproduce it. The pty survives, the renderer's buffer doesn't.", 3, 151),
        issueComment(AMA, "That matches what I saw: typing still reaches the shell.", 2, 151),
      ],
    }),
    mockIssue({
      number: 150,
      title: "Show who a pull request is waiting on in the project overview",
      state: "open",
      stateReason: null,
      author: KWESI,
      labels: [LABEL.enhancement, LABEL.design],
      assignees: [],
      milestone: null,
      isPinned: false,
      openedHoursAgo: 30,
      body: "The Git Space knows whose review a pull request needs. The overview could say it in one line, so you don't have to open the space to find out it's you.",
      comments: [],
    }),
    mockIssue({
      number: 144,
      title: "AppImage won't start on Fedora without libfuse2",
      state: "open",
      stateReason: null,
      author: ADA,
      labels: [LABEL.bug, LABEL.linux],
      assignees: [GIDEON, KWESI],
      milestone: "Linux beta",
      isPinned: false,
      openedHoursAgo: 24 * 6,
      body: "Fedora 41 ships fuse3 only, so the AppImage exits straight away with `dlopen(): error loading libfuse.so.2`.",
      comments: [
        issueComment(GIDEON, "We could ship the extracted build as a tarball alongside it.", 24 * 5, 144),
        issueComment(ADA, "A tarball works for me. A `.rpm` would be nicer still.", 24 * 4, 144),
        issueComment(KWESI, "Let's do the tarball for the beta and look at packaging after.", 24 * 2, 144),
      ],
    }),
    mockIssue({
      number: 139,
      title: "Commit message suggestions ignore the repository's own style",
      state: "open",
      stateReason: null,
      author: GIDEON,
      labels: [LABEL.enhancement, LABEL.good],
      assignees: [],
      milestone: null,
      isPinned: false,
      openedHoursAgo: 24 * 12,
      body: "This repo uses conventional commits, but the suggestion box writes free-form sentences. Reading the last few subjects first would fix most of it.",
      comments: [issueComment(ADA, "Happy to pick this up.", 24 * 10, 139)],
    }),
    mockIssue({
      number: 133,
      title: "How do I point kone at a second GitHub account?",
      state: "open",
      stateReason: null,
      author: prPerson("yawdarko", "Yaw Darko", null),
      labels: [LABEL.question],
      assignees: [],
      milestone: null,
      isPinned: false,
      openedHoursAgo: 24 * 18,
      body: "I use one account for work and one for side projects. Is there a way to choose per project?",
      comments: [],
    }),
    mockIssue({
      number: 131,
      title: "Branch picker flickers while a fetch is running",
      state: "closed",
      stateReason: "completed",
      author: KWESI,
      labels: [LABEL.bug, LABEL.git],
      assignees: [GIDEON],
      milestone: "Git Space v1",
      isPinned: false,
      openedHoursAgo: 24 * 15,
      closedHoursAgo: 24 * 9,
      body: "Every progress tick re-renders the whole list, so the highlighted row jumps.",
      comments: [issueComment(GIDEON, "Fixed in #146: the list now keys rows by ref name.", 24 * 9, 131)],
    }),
    mockIssue({
      number: 127,
      title: "Add a light grey theme",
      state: "closed",
      stateReason: "not-planned",
      author: prPerson("efuaasante", "Efua Asante", null),
      labels: [LABEL.design],
      assignees: [],
      milestone: null,
      isPinned: false,
      openedHoursAgo: 24 * 26,
      closedHoursAgo: 24 * 20,
      body: "Something between the light and dark themes, for long sessions.",
      comments: [issueComment(AMA, "We'd rather tune the two themes we have than maintain a third. Closing for now.", 24 * 20, 127)],
    }),
  ].map((issue) => [issue.number, issue]),
);

function issueRowOf(d: GitHubIssueDetail): GitHubIssue {
  const { body: _body, comments: _comments, canTriage: _canTriage, ...row } = d;
  return row;
}

export function mockIssues(_dir: string, state: "open" | "all" = "open"): GitHubIssue[] {
  return Object.values(MOCK_ISSUES)
    .filter((d) => state === "all" || d.state === "open")
    .sort((a, b) => b.number - a.number)
    .map(issueRowOf);
}

export function mockIssueDetail(number: number): GitHubIssueDetail | null {
  return MOCK_ISSUES[number] ?? null;
}

export function mockIssueAction(number: number, action: "close" | "reopen", reason: GitHubIssueCloseReason = "completed"): void {
  const d = MOCK_ISSUES[number];
  if (!d) throw new Error(`No issue #${number}.`);
  const now = new Date().toISOString();
  d.updatedAt = now;
  d.updated = "just now";
  if (action === "close") {
    d.state = "closed";
    d.stateReason = reason;
    d.closedAt = now;
  } else {
    d.state = "open";
    d.stateReason = null;
    d.closedAt = null;
  }
}

export function mockIssueComment(number: number, body: string): void {
  const d = MOCK_ISSUES[number];
  if (!d) throw new Error(`No issue #${number}.`);
  const now = new Date().toISOString();
  d.comments.push({ author: GIDEON, body, createdAt: now, relative: "just now", url: `${d.url}#issuecomment-${Date.now()}` });
  d.commentCount = d.comments.length;
  d.updatedAt = now;
  d.updated = "just now";
}

export function mockCreateIssue(title: string, body: string): GitHubIssueCreateResult {
  const number = Math.max(...Object.keys(MOCK_ISSUES).map(Number), 152) + 1;
  const now = new Date().toISOString();
  MOCK_ISSUES[number] = {
    number,
    title,
    url: `https://github.com/kone-dev/kone/issues/${number}`,
    state: "open",
    stateReason: null,
    author: GIDEON,
    createdAt: now,
    relative: "just now",
    updatedAt: now,
    updated: "just now",
    closedAt: null,
    labels: [],
    assignees: [],
    commentCount: 0,
    milestone: null,
    isPinned: false,
    body,
    comments: [],
    canTriage: true,
  };
  return { number, url: MOCK_ISSUES[number]!.url };
}

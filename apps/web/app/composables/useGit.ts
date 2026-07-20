import type {
  GitBranch,
  GitChange,
  GitCommit,
  GitDiffLine,
  GitFileContent,
  GitFileDiff,
  GitRepo,
  GitStatus,
} from "~/types/desktop";

// Reads git state through the Electron bridge. Git inspection lives in the
// main process (it needs a real filesystem + the `git` binary), so there is no
// browser fallback for the heavier reads — in `nuxt dev` status/branches/log
// resolve to empty/null and `available` is false. `detect` is the exception: it
// returns a small canned summary for the mock repos so the folder picker's
// branch + diffstat is demoable in the browser (mirrors useFileSystem's mock).
export function useGit() {
  const bridge = import.meta.client ? window.koneDesktop : undefined;
  const git = bridge?.git;

  return {
    available: Boolean(git),

    detect(dir: string): Promise<GitRepo | null> {
      if (git) return git.detect(dir);
      const repo = mockDetect(dir);
      if (!repo) return Promise.resolve(null);
      // A short, slightly-staggered delay stands in for real git latency, so the
      // picker's processing→reveal beat is faithful (and visible) in `nuxt dev`.
      const delay = 140 + Math.random() * 260;
      return new Promise((resolve) => setTimeout(() => resolve(repo), delay));
    },
    status(dir: string): Promise<GitStatus | null> {
      if (git) return git.status(dir);
      const status = mockStatus(dir);
      if (!status) return Promise.resolve(null);
      const delay = 140 + Math.random() * 260;
      return new Promise((resolve) => setTimeout(() => resolve(status), delay));
    },
    diff(dir: string, path: string, staged: boolean): Promise<GitFileDiff | null> {
      if (git) return git.diff(dir, path, staged);
      const d = mockDiff(dir, path);
      // A touch of latency so the detail view's loading beat is visible in dev.
      const delay = 120 + Math.random() * 220;
      return new Promise((resolve) => setTimeout(() => resolve(d), delay));
    },
    content(dir: string, path: string): Promise<GitFileContent | null> {
      if (git) return git.content(dir, path);
      const c = mockContent(dir, path);
      const delay = 120 + Math.random() * 220;
      return new Promise((resolve) => setTimeout(() => resolve(c), delay));
    },
    branches(dir: string): Promise<GitBranch[]> {
      return git ? git.branches(dir) : Promise.resolve([]);
    },
    log(dir: string, limit?: number): Promise<GitCommit[]> {
      return git ? git.log(dir, limit) : Promise.resolve([]);
    },
    // Live status. Only the desktop bridge can watch a real filesystem, so in
    // `nuxt dev` this is a no-op (the mock repos never change on disk anyway).
    watchStatus(dir: string, cb: (status: GitStatus) => void): () => void {
      return git ? git.watchStatus(dir, cb) : () => {};
    },
    // Mutations. Without the bridge (browser dev) they resolve as no-ops — the
    // renderer's optimistic update is the only effect there.
    stage(dir: string, paths: string[]): Promise<void> {
      return git ? git.stage(dir, paths) : Promise.resolve();
    },
    unstage(dir: string, paths: string[]): Promise<void> {
      return git ? git.unstage(dir, paths) : Promise.resolve();
    },
    discard(dir: string, paths: string[]): Promise<void> {
      return git ? git.discard(dir, paths) : Promise.resolve();
    },
  };
}

// ── dev fallback ──────────────────────────────────────────────────────────────
// Canned summaries for the mock repo paths in useFileSystem, so the picker shows
// a plausible branch + line diffstat in `nuxt dev`. Keep these paths in sync.

const MOCK_SUMMARIES: Record<
  string,
  Pick<GitRepo, "branch" | "ahead" | "behind" | "changeCount" | "added" | "removed">
> = {
  "/Users/you/Developer/kone": {
    branch: "calm-agent-ui-continuation",
    ahead: 2,
    behind: 0,
    changeCount: 5,
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

function mockDetect(dir: string): GitRepo | null {
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

// The changed-file lists behind each mock repo — these become the folder's
// peeking papers. Kept in sync with MOCK_SUMMARIES so the three demo repos each
// show a distinct folder state: kone (active), sandbox (deletions), nxui (clean).
const MOCK_CHANGES: Record<string, GitChange[]> = {
  "/Users/you/Developer/kone": [
    { path: "apps/web/app/components/ProjectFolder.vue", status: "added", staged: true, unstaged: false, added: 96, removed: 0 },
    { path: "apps/web/app/composables/useGit.ts", status: "modified", staged: true, unstaged: false, added: 22, removed: 6 },
    { path: "apps/web/nuxt.config.js", status: "modified", staged: true, unstaged: false, added: 5, removed: 1 },
    { path: "apps/web/app/assets/css/main.css", status: "modified", staged: false, unstaged: true, added: 4, removed: 25 },
    { path: "apps/web/app/pages/index.vue", status: "modified", staged: false, unstaged: true, added: 1, removed: 2 },
    { path: "README.md", status: "modified", staged: false, unstaged: true, added: 8, removed: 2 },
  ],
  "/Users/you/Developer/sandbox": [
    { path: "src/legacy-emitter.js", status: "deleted", staged: false, unstaged: true, added: 0, removed: 34 },
    { path: "src/particles.ts", status: "modified", staged: false, unstaged: true, added: 12, removed: 13 },
  ],
  "/Users/you/Developer/nxui": [],
};

// Plausible source lines to fill a mock hunk, chosen by file extension so the
// dev preview reads like the file it claims to be (never used in the desktop
// build — real `git diff` drives that).
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

// Synthesize a readable diff for a mock change so the detail view is demoable in
// `nuxt dev`. Added/untracked → all inserts; deleted → all deletes; modified →
// a small centred hunk. Line counts drive the volume (capped so it stays legible).
function mockDiff(dir: string, relPath: string): GitFileDiff | null {
  const change = MOCK_CHANGES[dir]?.find((c) => c.path === relPath);
  if (!change) return null;
  const pool = linePool(relPath);
  const pick = (i: number) => pool[i % pool.length]!;
  const nAdd = Math.min(change.added ?? 0, 9);
  const nDel = Math.min(change.removed ?? 0, 7);

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

  if (change.status === "added" || change.status === "untracked") {
    oldNo = 0;
    newNo = 1;
    for (let i = 0; i < Math.max(nAdd, 1); i++) add(pick(i));
  } else if (change.status === "deleted") {
    oldNo = 1;
    newNo = 0;
    for (let i = 0; i < Math.max(nDel, 1); i++) del(pick(i));
  } else {
    oldNo = 18;
    newNo = 18;
    ctx(pick(0));
    for (let i = 0; i < nDel; i++) del(pick(i + 1));
    for (let i = 0; i < nAdd; i++) add(pick(i + 1 + nDel));
    ctx(pick(9));
  }

  return {
    path: relPath,
    status: change.status,
    binary: false,
    hunks: [
      {
        header: "",
        oldStart: lines[0]?.oldNo ?? 1,
        newStart: lines[0]?.newNo ?? 1,
        lines,
      },
    ],
    added: change.added ?? 0,
    removed: change.removed ?? 0,
  };
}

// A plausible file body for the detail view's content preview in `nuxt dev`.
// Deleted files have no working-tree content (null text). Others repeat the
// extension's line pool to a believable length.
function mockContent(dir: string, relPath: string): GitFileContent | null {
  const change = MOCK_CHANGES[dir]?.find((c) => c.path === relPath);
  if (!change) return null;
  if (change.status === "deleted") return { text: null, binary: false, truncated: false };
  const pool = linePool(relPath);
  const len = Math.min(60, Math.max(pool.length, (change.added ?? 0) + 8));
  const lines: string[] = [];
  for (let i = 0; i < len; i++) lines.push(pool[i % pool.length]!);
  return { text: lines.join("\n"), binary: false, truncated: false };
}

function mockStatus(dir: string): GitStatus | null {
  const summary = MOCK_SUMMARIES[dir];
  const changes = MOCK_CHANGES[dir];
  if (!summary || !changes) return null;
  return {
    root: dir,
    branch: summary.branch,
    detached: false,
    head: "0000000",
    upstream: null,
    ahead: summary.ahead,
    behind: summary.behind,
    changes,
    staged: changes.filter((c) => c.staged).length,
    unstaged: changes.filter((c) => c.unstaged).length,
    untracked: changes.filter((c) => c.status === "untracked").length,
    clean: changes.length === 0,
  };
}

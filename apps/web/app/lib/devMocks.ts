// The dev-only demo world — one source of truth for what the app shows in
// `nuxt dev`, where there's no Electron bridge to read a real filesystem or run
// git. The folder picker, the git summaries, the diff view and the content
// preview all resolve against the same three repos defined here, so the launcher
// and the project view stay consistent without a "keep these in sync" contract
// spread across composables.
//
// None of this ships in the desktop build — there the bridge answers every call
// and these functions are never reached (see useFileSystem / useGit).

import type {
  DirListing,
  GitBranch,
  GitChange,
  GitDiffLine,
  GitFileContent,
  GitFileDiff,
  GitRepo,
  GitStatus,
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
  ],
  "/Users/you/Developer/sandbox": [
    { path: "src/legacy-emitter.js", status: "deleted", staged: false, unstaged: true, added: 0, removed: 34 },
    { path: "src/particles.ts", status: "modified", staged: false, unstaged: true, added: 12, removed: 13 },
  ],
  "/Users/you/Developer/nxui": [],
};

// The local branches each mock repo offers the switcher — the first entry that
// matches the repo's summary branch renders as the current one.
const MOCK_BRANCHES: Record<string, string[]> = {
  "/Users/you/Developer/kone": [
    "calm-agent-ui-continuation",
    "main",
    "dev",
    "premium-conversation-thread",
  ],
  "/Users/you/Developer/nxui": ["main", "next"],
  "/Users/you/Developer/sandbox": ["spike/particles", "main"],
};

export function mockBranches(dir: string): GitBranch[] {
  const summary = MOCK_SUMMARIES[dir];
  if (!summary) return [];
  const names =
    MOCK_BRANCHES[dir] ?? (summary.branch ? [summary.branch] : []);
  return names.map((name) => ({
    name,
    current: name === summary.branch,
    remote: false,
  }));
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

// Synthesize a readable diff for a mock change. Added/untracked → all inserts;
// deleted → all deletes; modified → a small centred hunk. Line counts drive the
// volume (capped so it stays legible).
export function mockDiff(dir: string, relPath: string): GitFileDiff | null {
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

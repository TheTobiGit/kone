import { describe, expect, it } from "bun:test";

import type { GitRepo, GitStatus } from "@kone/git-core";

import type { StoredThreadMeta } from "../../types.js";
import type { ScratchpadRecord, StoredStudioLayout } from "../../conversationStoreTypes.js";
import { encodeCursor } from "../helpers.js";
import { createRegistry, type GatewayToolContext } from "../registry.js";
import type { GatewayRecord } from "../schemas.js";
import {
  createAppProjectTools,
  type AppProjectsGit,
  type AppProjectsStore,
  type ProjectRosterEntry,
  type ProjectTeamAgent,
} from "./appProjects.js";

function makeCtx(overrides: Partial<GatewayToolContext> = {}): GatewayToolContext {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    provider: "claudeAgent",
    cwd: process.cwd(),
    requestId: "req-1",
    ...overrides,
  };
}

const KONE = "/Users/dev/Developer/kone";
const SITE = "/Users/dev/Developer/site";
const NOTES = "/Users/dev/Documents/notes";

const PROJECTS: readonly ProjectRosterEntry[] = [
  { path: KONE, name: "kone", active: true, pinned: true, lastOpenedAt: 1_700_000_000_000 },
  { path: SITE, name: "site", active: false, pinned: false, lastOpenedAt: 1_699_000_000_000 },
  { path: NOTES, name: "notes", active: false, pinned: false, lastOpenedAt: null },
];

const AGENTS: readonly ProjectTeamAgent[] = [
  { name: "Maya", teams: [KONE] },
  { name: "Rex", teams: [SITE, KONE] },
  { name: "Ivy", teams: [] },
];

function repo(overrides: Partial<GitRepo> & Pick<GitRepo, "root">): GitRepo {
  return {
    name: overrides.root.split("/").pop() ?? overrides.root,
    branch: "main",
    detached: false,
    ahead: 0,
    behind: 0,
    changeCount: 0,
    clean: true,
    added: 0,
    removed: 0,
    ...overrides,
  };
}

/** kone is a dirty repo ahead of its upstream, site is a clean one, notes is a
 *  plain folder — the three answers a project list has to be able to give. */
const REPOS: Record<string, GitRepo | null> = {
  [KONE]: repo({
    root: KONE,
    branch: "dev",
    ahead: 2,
    behind: 1,
    changeCount: 3,
    clean: false,
    added: 41,
    removed: 12,
  }),
  [SITE]: repo({ root: SITE }),
  [NOTES]: null,
};

const KONE_STATUS: GitStatus = {
  root: KONE,
  branch: "dev",
  detached: false,
  head: "2bae826",
  upstream: "origin/dev",
  ahead: 2,
  behind: 1,
  changes: [
    { path: "src/a.ts", status: "modified", staged: false, unstaged: true, added: 30, removed: 10 },
    { path: "src/b.ts", status: "untracked", staged: false, unstaged: true, added: 11, removed: 0 },
    { path: "src/c.ts", status: "deleted", staged: true, unstaged: false, added: 0, removed: 2 },
  ],
  staged: 1,
  unstaged: 2,
  untracked: 1,
  clean: false,
};

function thread(overrides: Partial<StoredThreadMeta> & Pick<StoredThreadMeta, "threadId">): StoredThreadMeta {
  return {
    projectPath: KONE,
    provider: "claudeAgent",
    createdAt: 1,
    updatedAt: 2,
    branch: "dev",
    isPinned: false,
    pinnedAt: null,
    archivedAt: null,
    lastActivityAt: 2,
    doneAt: null,
    lastVisitedAt: null,
    ...overrides,
  };
}

function pad(id: string): ScratchpadRecord {
  return {
    id,
    projectPath: KONE,
    title: id,
    body: "",
    createdAt: 1,
    updatedAt: 1,
    sortIndex: 0,
    revision: 1,
  };
}

const STUDIO: StoredStudioLayout = {
  version: 2,
  rows: [{ projectPath: KONE, panes: [], focusedId: null }],
  focusedRow: KONE,
};

function makeStore(overrides: Partial<AppProjectsStore> = {}): AppProjectsStore {
  return {
    listThreads: (path, options) => {
      if (options?.archived) return path === KONE ? [thread({ threadId: "old" })] : [];
      if (path !== KONE) return [];
      return [
        thread({ threadId: "t1", title: "Wire the projects module", lastActivityAt: 900 }),
        thread({ threadId: "t2", title: "Fix the strip", lastActivityAt: 500 }),
      ];
    },
    listScratchpads: (path) => (path === KONE ? [pad("p1"), pad("p2")] : []),
    loadStudio: () => STUDIO,
    ...overrides,
  };
}

function makeGit(overrides: Partial<AppProjectsGit> = {}): AppProjectsGit {
  return {
    detect: async (dir) => REPOS[dir] ?? null,
    status: async (dir) => (dir === KONE ? KONE_STATUS : null),
    ...overrides,
  };
}

function tools(
  options: {
    projects?: readonly ProjectRosterEntry[] | null;
    store?: AppProjectsStore;
    git?: AppProjectsGit;
    agents?: readonly ProjectTeamAgent[] | null;
  } = {},
) {
  const registry = createRegistry(
    createAppProjectTools({
      store: options.store ?? makeStore(),
      readProjects: () => (options.projects === undefined ? PROJECTS : options.projects),
      readAgents: () => (options.agents === undefined ? AGENTS : options.agents),
      git: options.git ?? makeGit(),
    }),
  );
  return registry;
}

/** The text half of a result — what the model actually reads. */
function text(result: { content: Array<{ text: string }> }): string {
  return result.content.map((part) => part.text).join("\n");
}

describe("app_list_projects", () => {
  it("names every project, where it lives, and which one is on screen", async () => {
    const result = await tools().call(makeCtx(), "app_list_projects", {});
    const body = text(result);

    expect(result.isError).toBeUndefined();
    expect(body).toContain("The window is showing **kone**");
    for (const path of [KONE, SITE, NOTES]) expect(body).toContain(path);
    expect(result.structuredContent?.activePath).toBe(KONE);
  });

  it("reports each project's live git state rather than a stored copy", async () => {
    const result = await tools().call(makeCtx(), "app_list_projects", {});
    const body = text(result);

    expect(body).toContain("dev, 2 ahead, 1 behind, 3 changed files (+41/-12)");
    expect(body).toContain("main, clean");
    // A folder that is not a repo is a normal project, not an error.
    expect(body).toContain("not a git repo");
  });

  it("carries kone's own view of a project alongside git's", async () => {
    const result = await tools().call(makeCtx(), "app_list_projects", {});
    const body = text(result);

    expect(body).toContain("2 threads");
    expect(body).toContain("team: Maya, Rex");
    expect(body).toContain("on the studio");
  });

  it("skips the git reads when the caller asked for the list alone", async () => {
    let reads = 0;
    const registry = tools({
      git: makeGit({
        detect: async (dir) => {
          reads += 1;
          return REPOS[dir] ?? null;
        },
      }),
    });
    const result = await registry.call(makeCtx(), "app_list_projects", { refreshGit: false });

    expect(reads).toBe(0);
    expect(text(result)).toContain("kone");
    // SAFETY: the list handler always writes `projects` as an array of the
    // per-project records assembled in listHandler.
    const projects = result.structuredContent?.projects as GatewayRecord[];
    expect(projects[0]?.git).toBeUndefined();
  });

  it("tells a failed read apart from a folder that is not a repo", async () => {
    const registry = tools({
      git: makeGit({
        detect: async (dir) => {
          if (dir === SITE) throw new Error("ENOENT");
          return REPOS[dir] ?? null;
        },
      }),
    });
    const body = text(await registry.call(makeCtx(), "app_list_projects", {}));

    expect(body).toContain("unreadable (moved or deleted?)");
    expect(body).toContain("not a git repo");
  });

  it("leaves out what would read as nothing, so a long list stays small", async () => {
    const result = await tools().call(makeCtx(), "app_list_projects", {});
    // SAFETY: the list handler always writes `projects` as an array of the
    // per-project records assembled in listHandler.
    const rows = result.structuredContent?.projects as GatewayRecord[];
    const [kone, site, notes] = rows;

    // kone is the active, pinned, dirty one — it says all three.
    expect(kone).toMatchObject({ active: true, pinned: true });
    // site is neither, and a clean repo level with its upstream: no `active`,
    // no `pinned`, and no run of zeroes for ahead/behind/changed.
    expect(site).not.toHaveProperty("active");
    expect(site).not.toHaveProperty("pinned");
    expect(site?.git).toMatchObject({ isRepo: true, clean: true });
    expect(site?.git).not.toHaveProperty("ahead");
    expect(site?.git).not.toHaveProperty("changedFiles");
    // notes has no threads, no team and no studio row — its kone half is the
    // one count that is actually true of it.
    expect(notes?.kone).toEqual({ threads: 0 });
  });

  it("walks the projects a page at a time, reading only the page from disk", async () => {
    let reads = 0;
    const registry = tools({
      git: makeGit({
        detect: async (dir) => {
          reads += 1;
          return REPOS[dir] ?? null;
        },
      }),
    });

    const first = await registry.call(makeCtx(), "app_list_projects", { limit: 2 });
    // SAFETY: the list handler always writes `projects` as an array of records.
    const firstRows = first.structuredContent?.projects as GatewayRecord[];
    expect(firstRows.map((row) => row.name)).toEqual(["kone", "site"]);
    expect(first.structuredContent?.total).toBe(3);
    expect(first.structuredContent?.remaining).toBe(1);
    // The third repo was never touched — a page is also how many repositories
    // get read, which is the point of paging a list whose rows cost git calls.
    expect(reads).toBe(2);

    const second = await registry.call(makeCtx(), "app_list_projects", {
      limit: 2,
      cursor: String(first.structuredContent?.nextCursor),
    });
    // SAFETY: as above.
    const secondRows = second.structuredContent?.projects as GatewayRecord[];
    expect(secondRows.map((row) => row.name)).toEqual(["notes"]);
    expect(second.structuredContent).not.toHaveProperty("nextCursor");
    expect(reads).toBe(3);
  });

  it("says the walk is over rather than reading as an empty app", async () => {
    const result = await tools().call(makeCtx(), "app_list_projects", {
      cursor: encodeCursor("projects", { skip: 99 }),
    });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("end of the list");
    expect(result.structuredContent?.total).toBe(3);
  });

  it("refuses a cursor that came from somewhere else", async () => {
    const result = await tools().call(makeCtx(), "app_list_projects", {
      cursor: encodeCursor("threads", { at: 1, id: "x" }),
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("did not come from app_list_projects");
  });

  it("says the app has opened nothing rather than inventing a project", async () => {
    const result = await tools({ projects: [] }).call(makeCtx(), "app_list_projects", {});

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("No projects yet");
    expect(result.structuredContent?.projects).toEqual([]);
  });

  it("refuses rather than guessing before the renderer has reported", async () => {
    const result = await tools({ projects: null }).call(makeCtx(), "app_list_projects", {});

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("provider_unavailable");
  });
});

describe("app_get_project", () => {
  it("resolves a project by name or by path, however it is cased", async () => {
    const registry = tools();
    for (const query of ["kone", "KONE", KONE]) {
      const result = await registry.call(makeCtx(), "app_get_project", { project: query });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.path).toBe(KONE);
    }
  });

  it("lists the changed files with their per-file line counts when asked", async () => {
    const result = await tools().call(makeCtx(), "app_get_project", {
      project: "kone",
      changes: true,
    });
    const body = text(result);

    expect(body).toContain("src/a.ts — modified (+30/-10)");
    expect(body).toContain("src/b.ts — untracked (+11/-0)");
    expect(result.structuredContent?.upstream).toBe("origin/dev");
    expect(result.structuredContent?.head).toBe("2bae826");
    expect(result.structuredContent?.changedFiles).toBe(3);
    expect(result.structuredContent).not.toHaveProperty("nextCursor");
  });

  it("skips the heavier status read unless the file list was asked for", async () => {
    let reads = 0;
    const registry = tools({
      git: makeGit({
        status: async (dir) => {
          reads += 1;
          return dir === KONE ? KONE_STATUS : null;
        },
      }),
    });
    const result = await registry.call(makeCtx(), "app_get_project", { project: "kone" });

    expect(reads).toBe(0);
    expect(result.structuredContent?.changes).toBeUndefined();
    // The summary still knows the working tree is dirty — that comes from the
    // same read the list makes.
    expect(text(result)).toContain("3 changed files (+41/-12)");
  });

  it("reports the threads, scratchpads and team kone holds for the project", async () => {
    const body = text(await tools().call(makeCtx(), "app_get_project", { project: "kone" }));

    expect(body).toContain("2 threads (1 archived), 2 scratchpads");
    expect(body).toContain("has a row on the studio");
    expect(body).toContain("Team: Maya, Rex");
    expect(body).toContain("Wire the projects module");
  });

  it("pages the changed-file list, and a cursor alone asks for it", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      path: `src/file${i}.ts`,
      status: "modified" as const,
      staged: false,
      unstaged: true,
      added: i,
      removed: 0,
    }));
    const registry = tools({
      git: makeGit({ status: async () => ({ ...KONE_STATUS, changes: many }) }),
    });

    const first = await registry.call(makeCtx(), "app_get_project", {
      project: "kone",
      changes: true,
    });
    expect(first.structuredContent?.changedFiles).toBe(5);

    // The cap is well above five, so this walks with an explicit cursor built
    // from the first page's end rather than waiting for the tool to offer one.
    const second = await registry.call(makeCtx(), "app_get_project", {
      project: "kone",
      cursor: encodeCursor("changes", { skip: 3 }),
    });
    // SAFETY: the detail handler writes `changes` as an array of records
    // whenever the file list was asked for.
    const rows = second.structuredContent?.changes as GatewayRecord[];
    expect(rows.map((row) => row.path)).toEqual(["src/file3.ts", "src/file4.ts"]);
  });

  it("names the projects it does hold when asked for one it does not", async () => {
    const result = await tools().call(makeCtx(), "app_get_project", { project: "kono" });

    expect(result.isError).toBe(true);
    const body = text(result);
    expect(body).toContain("not_found");
    expect(body).toContain(KONE);
  });

  it("asks which one rather than picking a side when two share a name", async () => {
    const twin = "/Users/dev/work/site";
    const result = await tools({
      projects: [
        ...PROJECTS,
        { path: twin, name: "site", active: false, pinned: false, lastOpenedAt: 1 },
      ],
    }).call(makeCtx(), "app_get_project", { project: "site" });

    expect(result.isError).toBe(true);
    const body = text(result);
    expect(body).toContain("More than one project is called");
    expect(body).toContain(twin);
    expect(body).toContain(SITE);
  });

  it("still describes a project whose folder git cannot read", async () => {
    const registry = tools({
      git: makeGit({
        detect: async () => {
          throw new Error("ENOENT");
        },
      }),
    });
    const result = await registry.call(makeCtx(), "app_get_project", { project: "kone" });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("unreadable");
    // The kone-side half of the answer survives a folder that has gone.
    expect(text(result)).toContain("2 threads");
  });
});

describe("the projects tools as the gateway serves them", () => {
  it("read without a live turn — an agent can ask what it is looking at", () => {
    for (const tool of createAppProjectTools({ store: makeStore() })) {
      expect(tool.requiresActiveTurn).toBe(false);
      expect(tool.permission).toBe("allow");
      expect(tool.promptSnippet).toBeTruthy();
      expect(tool.promptSnippet).not.toContain("\n");
    }
  });
});

// The projects on the app, as gateway tools: which folders the user has opened,
// where they live, what git says about each one, and what kone itself holds
// against them.
//
// Two halves, from two places, because neither one knows the whole answer:
//
// - The *list* is the renderer's. Which projects the user has opened, which is
//   pinned, which is on screen right now — all of it lives in browser storage,
//   so it arrives here the same way the roster and the strip settings do: the
//   renderer pushes, the shell remembers, these tools read it back.
// - The *state* is read live, here, at call time. A branch and a diff go stale
//   in seconds and the launcher only watches the tiles it can see, so mirroring
//   what a tile last rendered would have an agent describe a repo the user
//   moved on from ten commits ago. `git` is asked instead, on the spot.
//
// Everything else an agent would otherwise reconstruct by hand — how many
// threads a project has, when it was last worked on, whose team is on it,
// whether it has a row on the studio — comes from the store the gateway already
// owns, so "what is this project" is one call rather than five.

import { detect as detectRepo, status as readRepoStatus } from "@kone/git-core";
import type { GitRepo, GitStatus } from "@kone/git-core";

import type { ScratchpadRecord, StoredStudioLayout } from "../../conversationStoreTypes.js";
import type { StoredThreadMeta } from "../../types.js";
import { compact, decodeCursor, encodeCursor, squash } from "../helpers.js";
import {
  GetAppProjectInputSchema,
  GET_APP_PROJECT_JSON_SCHEMA,
  ListAppProjectsInputSchema,
  LIST_APP_PROJECTS_JSON_SCHEMA,
  PROJECT_CHANGE_LIST_CAP,
  PROJECT_LIST_DEFAULT_LIMIT,
  GatewayToolError,
  type GatewayRecord,
  type GetAppProjectInput,
  type ListAppProjectsInput,
} from "../schemas.js";
import type { GatewayToolContext, GatewayToolResult, ToolEntry } from "../registry.js";

/** One project as the renderer reports it: the folder the user opened and how
 *  the app is holding it. Nothing derived from disk — that is read here. */
export interface ProjectRosterEntry {
  /** Absolute path of the project folder. Its identity everywhere. */
  path: string;
  /** What the app calls it — usually the folder's basename, but the user's
   *  label wins where they set one. */
  name: string;
  /** The project the window is showing. At most one, and none on the home
   *  screen. */
  active: boolean;
  /** Pinned to the front of the launcher grid. */
  pinned: boolean;
  /** Epoch ms the project was last opened, or null if it has never been. */
  lastOpenedAt: number | null;
}

/** The store slice these tools read. Narrow on purpose: the whole point of
 *  naming it here is that a test can hand over four functions rather than a
 *  database. */
export interface AppProjectsStore {
  listThreads(projectPath: string, options?: { archived?: boolean }): StoredThreadMeta[];
  listScratchpads(projectPath: string): ScratchpadRecord[];
  loadStudio(): StoredStudioLayout | null;
}

/** The git reads these tools make. Injectable so the tests can describe a repo
 *  without building one. */
export interface AppProjectsGit {
  detect(dir: string): Promise<GitRepo | null>;
  status(dir: string): Promise<GitStatus | null>;
}

/** Just enough of the agent roster to say whose team a project has. The mirror
 *  carries the resolved name and the project paths each agent is on, which is
 *  the whole of what a project answer needs. */
export interface ProjectTeamAgent {
  name: string;
  teams: readonly string[];
}

export interface AppProjectsToolOptions {
  store: AppProjectsStore;
  /** The projects the renderer last reported. Absent (or null) means the app
   *  has not said what it holds, and the tools report that rather than naming a
   *  list of their own — a project the user opened is browser storage, and the
   *  shell has no second copy of it. */
  readProjects?: () => readonly ProjectRosterEntry[] | null;
  /** The agent roster, for the team half of a project's answer. Absent, a
   *  project simply reports no team rather than claiming it has none. */
  readAgents?: () => readonly ProjectTeamAgent[] | null;
  /** Overrides the git reads (tests). */
  git?: AppProjectsGit;
}

/**
 * How many repos are read at once when listing.
 *
 * Each read forks several git processes, and the launcher holds up to a couple
 * of dozen folders — firing them all at once turns one tool call into a burst
 * of a hundred subprocesses on the user's machine while they are working in it.
 * Four keeps a full list well inside a turn without the app going quiet.
 */
const GIT_READ_CONCURRENCY = 4;

/** Tags this module's two cursors. They are separate kinds because they walk
 *  different lists: one over the projects, one over a project's changed files.
 *  Feeding either to the other is a mistake, and a tagged cursor says so
 *  instead of paging from a position that means nothing there. */
const PROJECT_CURSOR = "projects";
const CHANGES_CURSOR = "changes";

/** How many rows a cursor skips, or a refusal. A cursor the caller could not
 *  have been given, read as "start from the top", would hand back the first
 *  page forever — so it is named rather than absorbed. */
function skipFrom(kind: string, cursor: string | undefined, tool: string): number {
  if (!cursor) return 0;
  const fields = decodeCursor(kind, cursor);
  if (!fields || fields.skip === undefined) {
    throw new GatewayToolError(
      "invalid_input",
      `That cursor did not come from ${tool}. Pass back the nextCursor this tool returned, or omit it to start from the beginning.`,
    );
  }
  return fields.skip;
}

/** Map `items` through `worker`, at most GIT_READ_CONCURRENCY in flight, in
 *  input order. */
async function mapLimited<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let next = 0;
  const runners = Array.from(
    { length: Math.min(GIT_READ_CONCURRENCY, items.length) },
    async () => {
      for (let index = next++; index < items.length; index = next++) {
        // SAFETY: `index < items.length` on every iteration, so the element is
        // present and the write lands inside the pre-sized results array.
        results[index] = await worker(items[index] as T);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

/** What git says about a folder, or null when the read failed. A failure is not
 *  the same answer as "not a repo": a folder the user has since deleted, or a
 *  repo whose index is locked by a command running in another window, would
 *  otherwise be reported as a plain directory. */
interface RepoReading {
  repo: GitRepo | null;
  /** The folder the project was opened at — what the repo's own root is
   *  compared against, so an answer only names the root when it differs. */
  path: string;
  /** The read itself failed — the folder is gone, or git could not answer. */
  unreadable: boolean;
}

async function readRepo(git: AppProjectsGit, path: string): Promise<RepoReading> {
  try {
    return { repo: await git.detect(path), path, unreadable: false };
  } catch {
    return { repo: null, path, unreadable: true };
  }
}

/** The git half of a project's answer. */
function repoPayload(reading: RepoReading): GatewayRecord {
  if (reading.unreadable) {
    return {
      readable: false,
      isRepo: null,
      note: "kone could not read this folder — it may have been moved, deleted, or renamed since it was opened.",
    };
  }
  const repo = reading.repo;
  if (!repo) return { readable: true, isRepo: false };
  // A clean repo sitting level with its upstream is the ordinary case, and
  // saying so in six zeroes costs more than it tells. What is sent is what is
  // true of THIS repo: the counts appear when there is something to count.
  const payload: GatewayRecord = { isRepo: true, branch: repo.branch, clean: repo.clean };
  if (repo.detached) payload.detached = true;
  if (repo.ahead > 0) payload.ahead = repo.ahead;
  if (repo.behind > 0) payload.behind = repo.behind;
  if (!repo.clean) {
    payload.changedFiles = repo.changeCount;
    payload.added = repo.added;
    payload.removed = repo.removed;
  }
  // Only worth saying when it is not the folder the project was opened at —
  // a project opened at its own repo root repeats the path otherwise.
  if (repo.root !== reading.path) payload.root = repo.root;
  return compact(payload);
}

/** A repo in one line: the branch, how it sits against its upstream, and the
 *  size of the working tree's changes. */
function repoLine(reading: RepoReading): string {
  if (reading.unreadable) return "unreadable (moved or deleted?)";
  const repo = reading.repo;
  if (!repo) return "not a git repo";
  const parts: string[] = [repo.detached ? `detached at ${repo.branch ?? "HEAD"}` : repo.branch ?? "unborn branch"];
  if (repo.ahead > 0) parts.push(`${repo.ahead} ahead`);
  if (repo.behind > 0) parts.push(`${repo.behind} behind`);
  parts.push(
    repo.clean
      ? "clean"
      : `${repo.changeCount} changed file${repo.changeCount === 1 ? "" : "s"} (+${repo.added}/-${repo.removed})`,
  );
  return parts.join(", ");
}

/** What kone holds against a project, as distinct from what is on disk. */
interface KoneReading {
  threads: number;
  archivedThreads: number;
  lastActivityAt: number | null;
  scratchpads: number;
  team: string[];
  onStudio: boolean;
}

function readKone(
  options: AppProjectsToolOptions,
  studio: StoredStudioLayout | null,
  path: string,
): KoneReading {
  const threads = options.store.listThreads(path);
  // The list is already ordered by last activity, so the head of it is the
  // project's own last activity — no scan, and no second query.
  const latest = threads[0]?.lastActivityAt ?? null;
  const team = (options.readAgents?.() ?? [])
    .filter((agent) => agent.teams.includes(path))
    .map((agent) => agent.name);
  return {
    threads: threads.length,
    archivedThreads: options.store.listThreads(path, { archived: true }).length,
    lastActivityAt: latest,
    scratchpads: options.store.listScratchpads(path).length,
    team,
    onStudio: (studio?.rows ?? []).some((row) => row.projectPath === path),
  };
}

function konePayload(kone: KoneReading): GatewayRecord {
  const payload: GatewayRecord = { threads: kone.threads };
  if (kone.archivedThreads > 0) payload.archivedThreads = kone.archivedThreads;
  if (kone.lastActivityAt !== null) payload.lastActivityAt = iso(kone.lastActivityAt);
  if (kone.scratchpads > 0) payload.scratchpads = kone.scratchpads;
  if (kone.team.length > 0) payload.team = [...kone.team];
  if (kone.onStudio) payload.onStudio = true;
  return payload;
}

/** An epoch stamp as a date a model can reason about, or null. */
function iso(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}

/** The projects the renderer reported, or a refusal. Both tools need the list
 *  first: without it there is nothing to describe and nothing to resolve a name
 *  against. */
export function requireProjects(
  options: { readProjects?: () => readonly ProjectRosterEntry[] | null },
): readonly ProjectRosterEntry[] {
  const projects = options.readProjects?.() ?? null;
  if (!projects) {
    throw new GatewayToolError(
      "provider_unavailable",
      "kone has not reported its projects yet. Try again once the app window has finished loading.",
    );
  }
  return projects;
}

/**
 * The project a caller named, by path or by name.
 *
 * A path is matched exactly and a name loosely (the same squash the roster
 * tools use), so "kone", "Kone" and the absolute path all land on the same
 * project. An ambiguous name is refused rather than guessed: two checkouts of
 * the same repo is an ordinary thing to have, and quietly answering about the
 * wrong one is worse than asking which.
 */
export function resolveProject(
  projects: readonly ProjectRosterEntry[],
  query: string,
): ProjectRosterEntry {
  const trimmed = query.trim();
  const byPath = projects.find((project) => project.path === trimmed);
  if (byPath) return byPath;

  const wanted = squash(trimmed);
  const [first, ...rest] = projects.filter((project) => squash(project.name) === wanted);
  if (first && rest.length === 0) return first;
  if (first) {
    throw new GatewayToolError(
      "invalid_input",
      `More than one project is called "${trimmed}". Name it by path instead: ${[first, ...rest]
        .map((project) => project.path)
        .join(", ")}.`,
    );
  }
  throw new GatewayToolError(
    "not_found",
    `kone has no project matching "${trimmed}". It holds: ${
      projects.length === 0
        ? "none yet"
        : projects.map((project) => `${project.name} (${project.path})`).join(", ")
    }.`,
  );
}

/** One changed file, as the detail answer lists it. */
function changePayload(change: GitStatus["changes"][number]): GatewayRecord {
  const payload: GatewayRecord = {
    path: change.path,
    status: change.status,
    added: change.added ?? 0,
    removed: change.removed ?? 0,
  };
  // Where a change sits is only worth a field when it is not the ordinary
  // place: an unstaged working-tree edit is what the overwhelming majority of
  // these are, and forty rows saying so is forty rows of nothing.
  if (change.staged) payload.staged = true;
  if (change.from) payload.from = change.from;
  return payload;
}

/** The threads a project's detail answer names, newest first and capped — the
 *  point is what the project has been worked on lately, not its whole history. */
const THREAD_LIST_CAP = 8;

function threadPayload(thread: StoredThreadMeta): GatewayRecord {
  return {
    threadId: thread.threadId,
    title: thread.title ?? null,
    provider: thread.provider,
    model: thread.model ?? null,
    branch: thread.branch ?? null,
    lastActivityAt: iso(thread.lastActivityAt ?? null),
  };
}

export function createAppProjectTools(options: AppProjectsToolOptions): ToolEntry[] {
  const git: AppProjectsGit = options.git ?? { detect: detectRepo, status: readRepoStatus };

  // ── 1. app_list_projects ─────────────────────────────────────────────────
  const listHandler = async (
    _ctx: GatewayToolContext,
    params: ListAppProjectsInput,
  ): Promise<GatewayToolResult> => {
    const projects = requireProjects(options);
    if (projects.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No projects yet — the user has not opened a folder in kone. They can open, clone or create one from the app home.",
          },
        ],
        structuredContent: { known: true, projects: [] },
      };
    }

    const withGit = params.refreshGit !== false;
    const studio = options.store.loadStudio();
    // Offset, not keyset: this list's order is the launcher's own — pins first,
    // then most-recently-opened — and it is a bounded list the user curates by
    // hand, so a position in it means the same thing between two calls in a way
    // a thread list's never does.
    const skip = skipFrom(PROJECT_CURSOR, params.cursor, "app_list_projects");
    const limit = params.limit ?? PROJECT_LIST_DEFAULT_LIMIT;
    const page = projects.slice(skip, skip + limit);
    const remaining = Math.max(0, projects.length - (skip + page.length));

    if (page.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No more projects - that was the end of the list of ${projects.length}.`,
          },
        ],
        structuredContent: { known: true, projects: [], total: projects.length },
      };
    }

    // Only the page is read from disk. A launcher of two dozen repos would
    // otherwise mean two dozen git reads for an answer that names ten.
    const readings = withGit
      ? await mapLimited(page, (project) => readRepo(git, project.path))
      : page.map(() => null);

    const rows = page.map((project, index) => {
      const kone = readKone(options, studio, project.path);
      const reading = readings[index] ?? null;
      const payload: GatewayRecord = {
        name: project.name,
        path: project.path,
        lastOpenedAt: iso(project.lastOpenedAt),
        kone: konePayload(kone),
      };
      // Only the project that IS active or pinned says so — on a launcher of
      // two dozen, `false` twice a row is most of what the list would carry.
      if (project.active) payload.active = true;
      if (project.pinned) payload.pinned = true;
      if (reading) payload.git = repoPayload(reading);
      return { project, kone, reading, payload };
    });

    const lines = rows.map(({ project, kone, reading }) => {
      const marks = [project.active ? "active" : null, project.pinned ? "pinned" : null]
        .filter((mark): mark is string => mark !== null)
        .join(", ");
      const head = `- **${project.name}**${marks ? ` (${marks})` : ""} — \`${project.path}\``;
      const gitPart = reading ? `\n  git: ${repoLine(reading)}` : "";
      const konePart = `\n  kone: ${kone.threads} thread${kone.threads === 1 ? "" : "s"}${
        kone.team.length > 0 ? `, team: ${kone.team.join(", ")}` : ""
      }${kone.onStudio ? ", on the studio" : ""}`;
      return `${head}${gitPart}${konePart}`;
    });

    const active = projects.find((project) => project.active);
    const shown = page.length < projects.length ? ` Showing ${page.length}.` : "";
    const header = active
      ? `${projects.length} project${projects.length === 1 ? "" : "s"} in kone. The window is showing **${active.name}**.${shown}`
      : `${projects.length} project${projects.length === 1 ? "" : "s"} in kone. No project is open — the window is on the app home.${shown}`;

    const payload: GatewayRecord = {
      known: true,
      activePath: active?.path ?? null,
      projects: rows.map((row) => row.payload),
      total: projects.length,
    };
    const body = [header, "", ...lines];
    if (remaining > 0) {
      payload.remaining = remaining;
      payload.nextCursor = encodeCursor(PROJECT_CURSOR, { skip: skip + page.length });
      body.push(
        "",
        `${remaining} more. Pass cursor: ${String(payload.nextCursor)} to continue from here.`,
      );
    }

    return {
      content: [{ type: "text", text: body.join("\n") }],
      structuredContent: payload,
    };
  };

  // ── 2. app_get_project ───────────────────────────────────────────────────
  const getHandler = async (
    _ctx: GatewayToolContext,
    params: GetAppProjectInput,
  ): Promise<GatewayToolResult> => {
    const project = resolveProject(requireProjects(options), params.project);
    const kone = readKone(options, options.store.loadStudio(), project.path);
    const reading = await readRepo(git, project.path);

    // The full status is a second, heavier read than `detect` — a `git status`
    // over the whole tree plus a line count per file — and on a repo mid-
    // refactor the answer it produces is the largest thing this module can
    // return. So it is opt-in: the summary above already says how many files
    // changed and by how many lines, which is the answer to most questions
    // about a project. Ask for `changes` when you need to know WHICH files.
    // A cursor is a request to continue the file list, so it implies the list
    // was asked for — a caller paging through changes should not also have to
    // keep saying it wants them.
    const changesSkip = skipFrom(CHANGES_CURSOR, params.cursor, "app_get_project");
    const wantsChanges =
      (params.changes === true || params.cursor !== undefined) && reading.repo !== null;
    let status: GitStatus | null = null;
    if (wantsChanges) {
      try {
        status = await git.status(project.path);
      } catch {
        status = null;
      }
    }

    const threads = options.store.listThreads(project.path).slice(0, THREAD_LIST_CAP);

    const changes = status?.changes ?? [];
    const listed = changes.slice(changesSkip, changesSkip + PROJECT_CHANGE_LIST_CAP);
    const changesRemaining = Math.max(0, changes.length - (changesSkip + listed.length));

    const payload: GatewayRecord = {
      name: project.name,
      path: project.path,
      active: project.active,
      pinned: project.pinned,
      lastOpenedAt: iso(project.lastOpenedAt),
      git: repoPayload(reading),
      kone: konePayload(kone),
      recentThreads: threads.map(threadPayload),
    };
    if (status) {
      payload.head = status.head;
      payload.upstream = status.upstream;
      payload.staged = status.staged;
      payload.unstaged = status.unstaged;
      payload.untracked = status.untracked;
      payload.changes = listed.map(changePayload);
      payload.changedFiles = changes.length;
      if (changesRemaining > 0) {
        payload.remaining = changesRemaining;
        payload.nextCursor = encodeCursor(CHANGES_CURSOR, {
          skip: changesSkip + listed.length,
        });
      }
    }

    const lines = [
      `**${project.name}** — \`${project.path}\``,
      `git: ${repoLine(reading)}`,
      `kone: ${kone.threads} thread${kone.threads === 1 ? "" : "s"}${
        kone.archivedThreads > 0 ? ` (${kone.archivedThreads} archived)` : ""
      }, ${kone.scratchpads} scratchpad${kone.scratchpads === 1 ? "" : "s"}${
        kone.onStudio ? ", has a row on the studio" : ""
      }.`,
    ];
    if (kone.team.length > 0) lines.push(`Team: ${kone.team.join(", ")}.`);
    if (kone.lastActivityAt !== null) lines.push(`Last worked on: ${iso(kone.lastActivityAt)}.`);
    if (listed.length > 0) {
      lines.push(
        "",
        "Changed files:",
        ...listed.map(
          (change) => `- ${change.path} — ${change.status} (+${change.added ?? 0}/-${change.removed ?? 0})`,
        ),
      );
      if (changesRemaining > 0) {
        lines.push(
          `…and ${changesRemaining} more. Pass cursor: ${String(payload.nextCursor)} to continue the file list.`,
        );
      }
    }
    if (threads.length > 0) {
      lines.push(
        "",
        "Recent threads:",
        ...threads.map((thread) => `- ${thread.title ?? "(untitled)"} — ${thread.provider}`),
      );
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: payload,
    };
  };

  return [
    {
      name: "app_list_projects",
      description:
        "List every project the user has opened in kone: its name and folder, whether it is the one on screen, whether it is pinned, when it was last opened, what git says about it right now (branch, ahead/behind, changed files, +/- lines), and what kone holds against it (threads, the agents on its team, whether it has a row on the studio). Fields that would read as nothing are left out: a project with no `active`, `pinned` or `ahead` is none of those.",
      inputSchema: ListAppProjectsInputSchema,
      jsonSchema: LIST_APP_PROJECTS_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "`app_list_projects`: the projects in kone — folder, branch, working-tree changes, threads, and which one is on screen. Pages with a cursor.",
      promptGuidelines: [
        "Call `app_list_projects` when the user talks about their projects, their repos, or 'what am I working on' — it is faster and more accurate than searching the filesystem, and it knows which project the window is actually showing.",
        "The paths it returns are the user's real project folders: use them as the working directory when you spawn work or run a command against a project.",
      ],
      handler: listHandler,
    },
    {
      name: "app_get_project",
      description:
        "Inspect one project in kone by path or name: its git state (branch, ahead/behind, how many files changed and by how many lines) alongside kone's own view of it — its recent threads, scratchpads, and the agents on its team. Pass changes: true to also list WHICH files changed, with per-file line counts and the upstream/HEAD detail; that is a heavier read, so it is off by default.",
      inputSchema: GetAppProjectInputSchema,
      jsonSchema: GET_APP_PROJECT_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "`app_get_project`: one project in full — its git state, changed files, recent threads and team.",
      promptGuidelines: [
        "Reach for `app_get_project` before `git status` in a terminal: it answers for a project the window is not currently showing, and it reports kone's side of the project too.",
      ],
      handler: getHandler,
    },
  ];
}

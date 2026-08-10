import { computed, ref, type Ref } from "vue";
import type { Project } from "~/composables/useProject";
import type { useProjectGit } from "~/composables/useProjectGit";
import { createSectionSerializer } from "~/utils/latestWins";
import type {
  GitBranch,
  GitCommit,
  GitCommitAuthors,
  GitCommitDetail,
  GitCommitOptions,
  GitContributors,
  GitFileDiff,
  GitHubPerson,
  GitHubPrCreateOptions,
  GitHubPrCreateResult,
  GitHubPullRequest,
  GitHubPullRequestDetail,
  GitHubRepoInfo,
  GitHubStatus,
  GitHubUser,
  GitIdentity,
  GitLogo,
  GitPullOptions,
  GitPushOptions,
  GitReadme,
  GitRemote,
  GitRepoState,
  GitStashEntry,
} from "~/types/desktop";

// Everything behind the Git Space, in one funnel.
//
// The space shows five views of the same repository, and almost every action in
// it invalidates more than one of them — a push moves the history *and* the
// branch list, a commit empties the working tree *and* adds a row to the log. So
// rather than let each section fetch and refresh for itself (five loading
// states, five error stories, five chances to leave a stale list on screen), the
// whole surface shares this one object: it owns the cached lists, the single
// in-flight `op`, the single `error`, and it decides what a given action makes
// stale.
//
// Two rules keep the UI honest. Actions never throw — they resolve `false` and
// park git's own message in `error`, because a rejected promise crossing into a
// template is a blank screen, while a message in the masthead is an explanation.
// And only one op runs at a time, so the space can disable its controls from a
// single boolean instead of guessing which combinations are safe to overlap.
//
// The working tree itself is not duplicated here: `useProjectGit` already owns
// `changes`/`branch`/`ahead`/`behind` and already watches the repo on disk, so
// this composable takes that instance as a collaborator and calls its `refresh()`
// rather than opening a second watcher.

export type GitSpaceOp =
  | "fetch"
  | "pull"
  | "push"
  | "commit"
  | "branch"
  | "stash"
  | "pr"
  | "checkout";

/** How many commits one page of history holds. */
const PAGE = 50;

export function useGitSpace(
  project: Ref<Project>,
  git: ReturnType<typeof useProjectGit>,
) {
  const bridge = useGit();
  const dir = () => project.value.path;

  const loaded = ref(false);
  const op = ref<GitSpaceOp | null>(null);
  const error = ref<string | null>(null);

  const remotes = ref<GitRemote[]>([]);
  const state = ref<GitRepoState>({ operation: "none", conflicts: [] });
  const commits = ref<GitCommit[]>([]);
  const commitsDone = ref(false);
  const branches = ref<GitBranch[]>([]);
  const stashes = ref<GitStashEntry[]>([]);
  const prs = ref<GitHubPullRequest[]>([]);
  const gh = ref<GitHubStatus | null>(null);
  const prState = ref<"open" | "all">("open");

  // The About section's payloads. `identity` is never null — it resolves to the
  // empty shape when git has no user configured, so the section can tell "unset"
  // from "still loading".
  const readme = ref<GitReadme | null>(null);
  const identity = ref<GitIdentity>({ name: null, email: null });
  const logo = ref<GitLogo | null>(null);
  const repoInfo = ref<GitHubRepoInfo | null>(null);
  const me = ref<GitHubUser | null>(null);
  const contributors = ref<GitContributors | null>(null);

  // Anything opened as its own view is kept once read. These are big, expensive
  // payloads behind a surface you step in and out of — reading a pull request,
  // stepping back to the list, then reopening it is a normal minute of use, and
  // it should be instant the second time rather than blank again.
  const commitDetails = ref<Record<string, GitCommitDetail>>({});
  const prDetails = ref<Record<number, GitHubPullRequestDetail>>({});
  const prDiffs = ref<Record<number, GitFileDiff[]>>({});
  // Commit email → the GitHub account that owns it. One read serves the whole
  // history: git only records an address, and this is the only thing that turns
  // an address into a face.
  const commitFaces = ref<GitCommitAuthors>({});

  /** The folder's own name — the truth when GitHub isn't reachable. */
  const name = computed(() => project.value.name);

  const origin = computed(
    () => remotes.value.find((r) => r.name === "origin") ?? remotes.value[0] ?? null,
  );

  // ── reads ──────────────────────────────────────────────────────────────────
  // Each read de-dupes: a second call for the same key joins the first rather
  // than firing another round-trip. Sections mount and refresh independently,
  // so without this a single push would trigger the same log read three times
  // over. Reads are additionally serialized per section with latest-wins
  // semantics: when a request with different parameters arrives mid-read
  // (open → all PRs, an append-page racing a reset), the older read is
  // superseded and the newer one runs strictly after it, so results always
  // land in request order and a stale read can never overwrite a fresher one.
  const serializer = createSectionSerializer();
  // Which reads have ever come back, by tag. A section with an empty list has
  // two very different meanings — "nothing here" and "still asking" — and the
  // list alone can't tell them apart. Sections draw a skeleton until their tag
  // lands here, so an unanswered read never reads as an empty repository.
  const settled = ref(new Set<string>());
  function once(key: string, run: () => Promise<void>): Promise<void> {
    // `prs:open` and `commits:reset` are separate reads of one section, so the
    // tag is the part before the colon: refreshing a list doesn't un-answer it.
    const tag = key.split(":")[0]!;
    return serializer.schedule(key, run).finally(() => {
      settled.value.add(tag);
    });
  }

  /** Has this section's read ever resolved? The one input to every skeleton. */
  function ready(tag: string): boolean {
    return settled.value.has(tag);
  }

  /** The repo-wide facts the masthead needs, plus the GitHub CLI's usability.
   *  Safe to call on every entry to the space. */
  function load(): Promise<void> {
    return once("load", async () => {
      const [remoteList, repoState, ghStatus] = await Promise.all([
        bridge.remotes(dir()).catch(() => [] as GitRemote[]),
        bridge.repoState(dir()).catch(() => null),
        gh.value ? Promise.resolve(gh.value) : bridge.github.status().catch(() => null),
      ]);
      remotes.value = remoteList;
      if (repoState) state.value = repoState;
      gh.value = ghStatus;
      loaded.value = true;
    });
  }

  function loadCommits(reset = false): Promise<void> {
    if (!reset && commitsDone.value) return Promise.resolve();
    return once(reset ? "commits:reset" : "commits", async () => {
      const skip = reset ? 0 : commits.value.length;
      const page = await bridge.log(dir(), PAGE, skip).catch(() => [] as GitCommit[]);
      commits.value = reset ? page : [...commits.value, ...page];
      commitsDone.value = page.length < PAGE;
    });
  }

  function loadBranches(): Promise<void> {
    return once("branches", async () => {
      branches.value = await bridge.branches(dir()).catch(() => [] as GitBranch[]);
    });
  }

  function loadStashes(): Promise<void> {
    return once("stashes", async () => {
      stashes.value = await bridge.stashes(dir()).catch(() => [] as GitStashEntry[]);
    });
  }

  function loadPrs(next?: "open" | "all"): Promise<void> {
    if (next) prState.value = next;
    return once(`prs:${prState.value}`, async () => {
      // Nothing to ask `gh` for without a working CLI or a GitHub remote — the
      // section renders its own explanation from `gh` / `origin` instead.
      if (!gh.value?.authenticated || !origin.value?.slug) {
        prs.value = [];
        return;
      }
      prs.value = await bridge.github
        .prs(dir(), { state: prState.value })
        .catch(() => [] as GitHubPullRequest[]);
    });
  }

  /** The whole About section in one de-duped read. Git's own answers (README,
   *  logo, commit identity, the git contributor list) never depend on GitHub,
   *  so a missing `gh` leaves those intact and only the GitHub-fed facts
   *  resolve to null — the section degrades rather than blanking. The two
   *  contributor lists are read together and the GitHub one wins when it
   *  answers, so avatars are the default but never the requirement. */
  function loadAbout(): Promise<void> {
    return once("about", async () => {
      const [rd, id, lg, repo, meInfo, ghPeople, gitPeople] = await Promise.all([
        bridge.readme(dir()).catch(() => null),
        bridge.identity(dir()).catch(() => null),
        bridge.logo(dir()).catch(() => null),
        bridge.github.repo(dir()).catch(() => null),
        bridge.github.me().catch(() => null),
        bridge.github.contributors(dir()).catch(() => null),
        bridge.contributors(dir()).catch(() => null),
      ]);
      if (rd) readme.value = rd;
      if (id) identity.value = { name: id.name ?? null, email: id.email ?? null };
      if (lg) logo.value = lg;
      if (repo) repoInfo.value = repo;
      if (meInfo) me.value = meInfo;
      contributors.value = ghPeople ?? gitPeople;
    });
  }

  /** Faces for the history. Failing costs nothing: every row already has a name
   *  and an initial to fall back to, so this is decoration that arrives late,
   *  never a thing the list waits on. */
  function loadCommitAuthors(): Promise<void> {
    return once("faces", async () => {
      if (!gh.value?.authenticated || !origin.value?.slug) return;
      const map = await bridge.github.commitAuthors(dir()).catch(() => null);
      if (map) commitFaces.value = map;
    });
  }

  /** The GitHub account behind a commit address, if it's one we've been told
   *  about. Emails are matched case-insensitively — git preserves whatever the
   *  author typed, GitHub's API doesn't. */
  function faceFor(email: string | null | undefined): GitHubPerson | null {
    if (!email) return null;
    return commitFaces.value[email.toLowerCase()] ?? null;
  }

  function commitDetail(hash: string): Promise<GitCommitDetail | null> {
    const cached = commitDetails.value[hash];
    if (cached) return Promise.resolve(cached);
    return bridge
      .commitDetail(dir(), hash)
      .then((detail) => {
        if (detail) commitDetails.value[hash] = detail;
        return detail;
      })
      .catch(() => null);
  }

  function commitDiff(hash: string, path: string): Promise<GitFileDiff | null> {
    return bridge.commitDiff(dir(), hash, path).catch(() => null);
  }

  /** Everything one pull request knows: body, reviews, comments, commits,
   *  checks, files. Null when `gh` can't answer — the view says so rather than
   *  showing an empty pull request that looks real. */
  function prDetail(
    number: number,
    fresh = false,
  ): Promise<GitHubPullRequestDetail | null> {
    const cached = prDetails.value[number];
    // A pull request is the one cached payload that genuinely moves under you —
    // someone reviews, someone comments, a check goes green — so the view can
    // ask for it again. Commits and their diffs are immutable and never do.
    if (cached && !fresh) return Promise.resolve(cached);
    return bridge.github
      .prDetail(dir(), number)
      .then((detail) => {
        if (detail) prDetails.value[number] = detail;
        return detail;
      })
      .catch(() => null);
  }

  /** The pull request's whole patch, parsed into the same shape the working
   *  tree's diffs use — so one renderer draws both and they can't drift. */
  function prDiff(number: number): Promise<GitFileDiff[]> {
    const cached = prDiffs.value[number];
    if (cached) return Promise.resolve(cached);
    return bridge.github
      .prDiff(dir(), number)
      .then((files) => {
        prDiffs.value[number] = files;
        return files;
      })
      .catch(() => []);
  }

  // ── actions ────────────────────────────────────────────────────────────────
  // The one path every mutation takes: claim the op, run it, and either clear the
  // error and refresh what it invalidated, or keep git's own words for the
  // masthead. Nothing here rejects.
  async function act(
    tag: GitSpaceOp,
    run: () => Promise<void>,
    after: () => Promise<unknown> = () => Promise.resolve(),
  ): Promise<boolean> {
    if (op.value !== null) return false;
    op.value = tag;
    try {
      await run();
      error.value = null;
      await after();
      return true;
    } catch (e) {
      error.value = messageOf(e);
      return false;
    } finally {
      op.value = null;
    }
  }

  /** The working tree moved: the changes model, the log and the branch
   *  divergence are all stale together. */
  const afterHistoryMoved = () =>
    Promise.all([git.refresh(), loadCommits(true), loadBranches()]);

  function fetchRemote(): Promise<boolean> {
    return act("fetch", () => bridge.fetch(dir()), afterHistoryMoved);
  }
  function pull(opts?: GitPullOptions): Promise<boolean> {
    return act("pull", () => bridge.pull(dir(), opts), afterHistoryMoved);
  }
  function push(opts?: GitPushOptions): Promise<boolean> {
    return act("push", () => bridge.push(dir(), opts), afterHistoryMoved);
  }
  function commit(opts: GitCommitOptions): Promise<boolean> {
    return act("commit", () => bridge.commit(dir(), opts), afterHistoryMoved);
  }

  /** Commit, then push — but only if the commit landed, so a rejected commit
   *  never pushes something the user didn't mean to send. */
  async function commitAndPush(opts: GitCommitOptions): Promise<boolean> {
    if (!(await commit(opts))) return false;
    return push();
  }

  function createBranch(
    name: string,
    opts?: { from?: string; checkout?: boolean },
  ): Promise<boolean> {
    return act(
      "branch",
      () => bridge.createBranch(dir(), name, opts),
      opts?.checkout ? afterHistoryMoved : loadBranches,
    );
  }
  function deleteBranch(
    name: string,
    opts?: { force?: boolean; remote?: boolean },
  ): Promise<boolean> {
    return act("branch", () => bridge.deleteBranch(dir(), name, opts), loadBranches);
  }
  function renameBranch(from: string, to: string): Promise<boolean> {
    return act("branch", () => bridge.renameBranch(dir(), from, to), loadBranches);
  }
  function mergeBranch(name: string): Promise<boolean> {
    return act("branch", () => bridge.mergeBranch(dir(), name), () =>
      Promise.all([afterHistoryMoved(), loadState()]),
    );
  }
  /** Moving HEAD changes every list in the space, history included. */
  function switchBranch(name: string): Promise<boolean> {
    return act("checkout", () => bridge.checkout(dir(), name), afterHistoryMoved);
  }

  function loadState(): Promise<void> {
    return once("state", async () => {
      const next = await bridge.repoState(dir()).catch(() => null);
      if (next) state.value = next;
    });
  }

  function continueOperation(): Promise<boolean> {
    return act("branch", () => bridge.continueOperation(dir()), () =>
      Promise.all([afterHistoryMoved(), loadState()]),
    );
  }
  function abortOperation(): Promise<boolean> {
    return act("branch", () => bridge.abortOperation(dir()), () =>
      Promise.all([afterHistoryMoved(), loadState()]),
    );
  }

  function stash(opts?: {
    message?: string;
    includeUntracked?: boolean;
  }): Promise<boolean> {
    return act("stash", () => bridge.stashPush(dir(), opts), () =>
      Promise.all([loadStashes(), git.refresh()]),
    );
  }
  function applyStash(index: number, pop = false): Promise<boolean> {
    return act("stash", () => bridge.stashApply(dir(), index, { pop }), () =>
      Promise.all([loadStashes(), git.refresh()]),
    );
  }
  function dropStash(index: number): Promise<boolean> {
    return act("stash", () => bridge.stashDrop(dir(), index), loadStashes);
  }

  /** Resolves the created PR (for the composer's success line), or null on
   *  failure — the message is already in `error` by then. */
  async function createPr(
    opts: GitHubPrCreateOptions,
  ): Promise<GitHubPrCreateResult | null> {
    if (op.value !== null) return null;
    op.value = "pr";
    try {
      const result = await bridge.github.createPr(dir(), opts);
      error.value = null;
      await loadPrs();
      return result;
    } catch (e) {
      error.value = messageOf(e);
      return null;
    } finally {
      op.value = null;
    }
  }

  function checkoutPr(number: number): Promise<boolean> {
    return act("checkout", () => bridge.github.checkoutPr(dir(), number), afterHistoryMoved);
  }

  function openExternal(url: string): Promise<void> {
    return bridge.github.open(url).catch(() => undefined);
  }

  return {
    available: bridge.available,
    loaded,
    op,
    error,

    remotes,
    origin,
    state,
    commits,
    commitsDone,
    branches,
    stashes,
    prs,
    gh,
    prState,

    name,
    readme,
    identity,
    logo,
    repoInfo,
    me,
    contributors,

    ready,
    load,
    loadState,
    loadCommits,
    loadBranches,
    loadStashes,
    loadPrs,
    loadAbout,
    loadCommitAuthors,
    faceFor,
    commitDetail,
    commitDiff,
    prDetail,
    prDiff,

    fetch: fetchRemote,
    pull,
    push,
    commit,
    commitAndPush,
    createBranch,
    deleteBranch,
    renameBranch,
    mergeBranch,
    switchBranch,
    continueOperation,
    abortOperation,
    stash,
    applyStash,
    dropStash,
    createPr,
    checkoutPr,
    openExternal,
  };
}

/** git writes paragraphs; the masthead has one line. Take the last thing it
 *  said, which is the part that names the actual failure. */
function messageOf(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const line = raw
    .split("\n")
    .map((l) => l.trim())
    // Electron prefixes an IPC rejection with "Error invoking remote method …:",
    // which is noise in front of git's real complaint.
    .filter((l) => l.length > 0 && !l.startsWith("Error invoking remote method"))
    .pop();
  return line ?? "Something went wrong";
}

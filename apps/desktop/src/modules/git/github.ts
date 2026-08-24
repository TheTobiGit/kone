import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { shell } from "electron";
import { z } from "zod";

import { parseSafeExternalUrl } from "../../lib/safeExternalUrl.js";
import type { JsonValue } from "@kone/agent-core/lib-jsonValue.js";
import { GitError, lastStderrLine, repoRoot, run } from "@kone/git-core/core.js";
import { parseFileDiff } from "./diff.js";
import { classifyGhError } from "./ghError.js";
import { GIT_AUTHOR_AVATAR_CAP, GIT_CONTRIBUTOR_CAP } from "@kone/git-core/types.js";
import type {
  GitCommitAuthors,
  GitContributor,
  GitContributors,
  GitFileDiff,
  GitHubCheck,
  GitHubComment,
  GitHubLabel,
  GitHubPerson,
  GitHubPrCommit,
  GitHubPrCreateOptions,
  GitHubPrCreateResult,
  GitHubPrFile,
  GitHubPullRequest,
  GitHubPullRequestDetail,
  GitHubRepoInfo,
  GitHubReview,
  GitHubStatus,
  GitHubUser,
} from "@kone/git-core/types.js";

// The GitHub surface, driven entirely through the `gh` CLI (bring-your-own-
// account — kone stores no tokens). Everything goes through `--json` so we
// parse structured output, never scraped text. The module is self-contained:
// a missing `gh` surfaces as a friendly status/error, not an ENOENT crash,
// and network calls get a longer timeout than local git.

// Network calls are slower than local git; give gh twice the room.
const GH_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER = 16 * 1024 * 1024;

const NOT_INSTALLED_MESSAGE =
  "The GitHub CLI isn't installed — install it with brew install gh.";
const NOT_AUTHENTICATED_MESSAGE = "Sign in to GitHub with gh auth login to see pull requests.";

/** Run `gh` and return stdout. A missing gh binary surfaces as a friendly
 *  GitError instead of an ENOENT crash; any other failure carries gh's last
 *  stderr line, classified onto a semantic kind. */
async function gh(cwd: string | undefined, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("gh", args, {
      cwd,
      env: { ...process.env },
      maxBuffer: GH_MAX_BUFFER,
      timeout: GH_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    // SAFETY: spawn rejections are ErrnoException and carry stderr/stdout/code.
    const err = error as NodeJS.ErrnoException & {
      stderr?: string;
      stdout?: string;
      code?: number | string;
    };
    if (err.code === "ENOENT") {
      throw GitError.classified("NOT_INSTALLED", NOT_INSTALLED_MESSAGE, null);
    }
    const line = lastStderrLine(err.stderr ?? "", err.message);
    throw GitError.classified(classifyGhError(line) ?? "INTERNAL", line, null);
  }
}

/** The GitError kinds that mean "the About section has nothing to show" — a
 *  missing gh, a logged-out gh, or a repo whose remotes point nowhere GitHub
 *  hosts. Each is a normal empty state (null), not something to crash on. */
const REPO_VIEW_ABSENCE_KINDS: ReadonlySet<string> = new Set([
  "NOT_INSTALLED",
  "NOT_AUTHENTICATED",
  "NO_GITHUB_REMOTE",
]);

// ── wire decoders ─────────────────────────────────────────────────────────────
// Every payload out of `gh --json` runs through one schema here, at the I/O
// boundary. Downstream code branches only on the decoded domain values these
// produce, never on representations. Tolerance lives in the schemas, in one
// place: an optional wire field reads as its absence value instead of making
// the whole record suspect, while a record missing something essential (an
// id, a path) fails loudly enough for the caller to skip just that record.

/** An optional wire string, collapsed to null when absent or blank — gh
 *  answers "" for an unset optional field, and the renderer wants "absent",
 *  not empty. */
const WireText = z.string().transform((s) => (s.trim() ? s : null)).catch(null);

/** A non-negative integer count; anything else reads as zero. */
const WireCount = z.number().int().nonnegative().catch(0);

/** Tolerant row list: decodes each entry against `schema`, dropping the ones
 *  that don't clear it. One malformed record — a gh quirk, an API oddity —
 *  must not lose its healthy siblings. */
function rows<Schema extends z.ZodType>(schema: Schema) {
  return z
    .array(z.unknown())
    .transform((items): z.output<Schema>[] =>
      items.flatMap((item) => {
        const parsed = schema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),
    );
}

/** One `{ login, name }` actor — gh's shape for every person field. A blank
 *  login decodes to null; callers decide whether that's skippable. */
const ActorWire = z
  .object({
    login: z.string().catch(""),
    name: z.string().nullish(),
  })
  .transform((p): GitHubPerson | null => {
    const login = p.login.trim();
    if (!login) return null;
    return { login, name: p.name?.trim() ? p.name : null, avatarDataUrl: null };
  });

/** A person field where absence reads as the anonymous author, not null. */
const AuthorLoginWire = z
  .object({ login: z.string().catch("") })
  .transform((p) => p.login.trim() || "unknown");

const PeopleListWire = rows(ActorWire)
  .catch([])
  .transform((people) => people.filter((p): p is GitHubPerson => p !== null));

// One check run or status context, flattened to the fields either carries.
const CheckRunWire = z.object({
  // A CheckRun is named; a StatusContext carries its name in `context`.
  name: z.string().catch(""),
  context: z.string().catch(""),
  state: z.string().catch(""),
  status: z.string().catch(""),
  conclusion: z.string().catch(""),
  detailsUrl: z.string().catch(""),
  targetUrl: z.string().catch(""),
  workflowName: WireText,
});

type CheckRun = z.output<typeof CheckRunWire>;

const RollupWire = rows(CheckRunWire).catch([]);

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const FAILED_STATES = new Set(["FAILURE", "ERROR"]);

/** One check run or status context as a single verdict. Skipped and neutral
 *  runs are their own state rather than a pass: a repo that skips half its
 *  matrix shouldn't read as half-green. */
function checkStateOf(run: CheckRun): GitHubCheck["state"] {
  if (FAILED_STATES.has(run.state) || FAILED_CONCLUSIONS.has(run.conclusion)) return "failing";
  if (run.conclusion === "SKIPPED" || run.conclusion === "NEUTRAL") return "skipped";
  if (run.state === "SUCCESS" || run.conclusion === "SUCCESS") return "passing";
  if (
    run.state === "PENDING" ||
    run.state === "EXPECTED" ||
    (run.status !== "" && run.status !== "COMPLETED")
  ) {
    return "pending";
  }
  return "none";
}

/** One rollup node as the detail view draws it, or null when it names itself
 *  nowhere (neither a check-run name nor a status context). */
function checkOf(run: CheckRun): GitHubCheck | null {
  const name = run.name || run.context;
  if (!name) return null;
  return {
    name,
    workflow: run.workflowName,
    state: checkStateOf(run),
    url: run.detailsUrl || run.targetUrl || null,
  };
}

/** Fold the statusCheckRollup — a mix of CheckRun and StatusContext nodes —
 *  into one verdict: any failure fails the whole PR; otherwise any pending
 *  waits; otherwise passing needs at least one success. */
function rollupChecks(runs: CheckRun[]): "passing" | "failing" | "pending" | "none" {
  if (runs.length === 0) return "none";
  let pending = 0;
  let passing = 0;
  for (const run of runs) {
    if (FAILED_STATES.has(run.state) || FAILED_CONCLUSIONS.has(run.conclusion)) return "failing";
    if (run.state === "SUCCESS" || run.conclusion === "SUCCESS") passing += 1;
    else if (
      run.state === "PENDING" ||
      run.state === "EXPECTED" ||
      (run.status !== "" && run.status !== "COMPLETED")
    ) {
      pending += 1;
    }
  }
  if (pending > 0) return "pending";
  if (passing > 0) return "passing";
  return "none";
}

const ReviewDecisionWire = z
  .enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", "REVIEW_REQUESTED"])
  .nullish()
  .catch(undefined)
  .transform((value): "approved" | "changes-requested" | "review-required" | null => {
    switch (value) {
      case "APPROVED":
        return "approved";
      case "CHANGES_REQUESTED":
        return "changes-requested";
      case "REVIEW_REQUIRED":
      case "REVIEW_REQUESTED":
        return "review-required";
      default:
        return null;
    }
  });

const ReviewStateWire = z
  .enum(["APPROVED", "CHANGES_REQUESTED", "DISMISSED", "PENDING", "COMMENTED"])
  .catch("COMMENTED")
  .transform((value): GitHubReview["state"] => {
    switch (value) {
      case "APPROVED":
        return "approved";
      case "CHANGES_REQUESTED":
        return "changes-requested";
      case "DISMISSED":
        return "dismissed";
      case "PENDING":
        return "pending";
      default:
        return "commented";
    }
  });

/** gh reports comments as a count on `pr list` and as an array on `pr view` —
 *  accept both. */
const CommentCountWire = z
  .union([z.number(), z.array(z.unknown())])
  .catch(0)
  .transform((value): number => (Array.isArray(value) ? value.length : Math.max(0, Math.floor(value))));

const ReviewWire = z.object({
  author: ActorWire.catch(null),
  state: ReviewStateWire,
  body: z.string().catch(""),
  submittedAt: WireText,
});

const CommentWire = z.object({
  author: ActorWire.catch(null),
  body: z.string().catch(""),
  createdAt: z.string().catch(""),
  url: z.string().catch(""),
  // Minimised comments are GitHub's own "this is spam / off-topic" verdict;
  // they read as absent.
  isMinimized: z.boolean().catch(false),
});

const CommitAuthorWire = z.object({
  name: z.string().catch(""),
  login: z.string().catch(""),
});

const PrCommitWire = z.object({
  oid: z.string().min(1),
  messageHeadline: z.string().catch(""),
  messageBody: z.string().catch(""),
  committedDate: WireText,
  authoredDate: WireText,
  authors: rows(CommitAuthorWire).catch([]),
});

const PrFileWire = z
  .object({
    path: z.string().min(1),
    changeType: z.string().catch(""),
    additions: WireCount,
    deletions: WireCount,
  })
  .transform((file): GitHubPrFile => ({
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
    change: fileChangeOf(file.changeType),
  }));

/** gh spells a file's change as an uppercase token; anything unrecognised
 *  draws as the plain "changed". */
function fileChangeOf(raw: string): GitHubPrFile["change"] {
  switch (raw.toLowerCase()) {
    case "added":
      return "added";
    case "modified":
      return "modified";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    case "copied":
      return "copied";
    default:
      return "changed";
  }
}

const LabelWire = z
  .object({
    name: z.string().min(1),
    description: WireText,
    color: z.string().catch(""),
  })
  .transform((label): GitHubLabel => {
    const hex = label.color.replace(/^#/, "");
    // A label with no colour still needs one to draw; grey reads as "unset".
    return {
      name: label.name,
      description: label.description,
      color: /^[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : "8b949e",
    };
  });

// The one field list for every PR fetch, so the list and any later view
// shapes cannot drift.
const PR_JSON_FIELDS =
  "number,title,state,isDraft,author,headRefName,baseRefName,url,createdAt,additions,deletions,statusCheckRollup,reviewDecision,comments,mergedAt";

const PullRequestWire = z.object({
  number: z.number().int().positive(),
  title: z.string().catch(""),
  state: z.string().catch(""),
  isDraft: z.boolean().catch(false),
  author: AuthorLoginWire.catch("unknown"),
  headRefName: z.string().catch(""),
  baseRefName: z.string().catch(""),
  url: z.string().catch(""),
  createdAt: z.string().catch(""),
  additions: WireCount,
  deletions: WireCount,
  statusCheckRollup: RollupWire,
  reviewDecision: ReviewDecisionWire,
  comments: CommentCountWire,
  // gh reports merged PRs as CLOSED unless mergedAt is set — the timestamp
  // is authoritative.
  mergedAt: WireText,
});

type DecodedPullRequest = z.output<typeof PullRequestWire>;

function pullRequestOf(pr: DecodedPullRequest): GitHubPullRequest {
  const state =
    pr.mergedAt !== null || pr.state === "MERGED"
      ? "merged"
      : pr.state === "CLOSED"
        ? "closed"
        : "open";
  return {
    number: pr.number,
    title: pr.title,
    state,
    isDraft: pr.isDraft,
    author: pr.author,
    branch: pr.headRefName,
    base: pr.baseRefName,
    url: pr.url,
    createdAt: pr.createdAt,
    relative: relativeTime(pr.createdAt),
    additions: pr.additions,
    deletions: pr.deletions,
    checks: rollupChecks(pr.statusCheckRollup),
    reviewDecision: pr.reviewDecision,
    comments: pr.comments,
  };
}

// The field list for the About section's repo view. Kept to the flat gh
// names; the nested licenseInfo/primaryLanguage/repositoryTopics/
// defaultBranchRef are unwrapped by the schema.
const REPO_JSON_FIELDS =
  "nameWithOwner,description,homepageUrl,stargazerCount,forkCount,licenseInfo,primaryLanguage,repositoryTopics,visibility,isFork,defaultBranchRef,pushedAt,createdAt,url";

const LicenseWire = z.object({
  // nickname is the short form ("MIT"); an empty nickname means "no
  // nickname", so the full name wins.
  name: WireText,
  nickname: WireText,
});

const NamedWire = z.object({ name: z.string().catch("") });

const RepoInfoWire = z.object({
  nameWithOwner: z.string().min(1),
  description: WireText,
  homepageUrl: WireText,
  stargazerCount: WireCount,
  forkCount: WireCount,
  licenseInfo: LicenseWire.nullish(),
  primaryLanguage: NamedWire.nullish(),
  // gh 2.96 reports repositoryTopics as a plain [{ name }] array (null when
  // the repo has no topics).
  repositoryTopics: rows(NamedWire.transform((t) => t.name)).nullish(),
  visibility: z
    .string()
    .catch("")
    .transform((value): GitHubRepoInfo["visibility"] => {
      const lowered = value.toLowerCase();
      return lowered === "public" || lowered === "internal" ? lowered : "private";
    }),
  isFork: z.boolean().catch(false),
  defaultBranchRef: NamedWire.nullish(),
  pushedAt: WireText,
  createdAt: WireText,
  url: z.string().catch(""),
});

type DecodedRepoInfo = z.output<typeof RepoInfoWire>;

function repoInfoOf(repo: DecodedRepoInfo): GitHubRepoInfo {
  return {
    nameWithOwner: repo.nameWithOwner,
    description: repo.description,
    homepageUrl: repo.homepageUrl,
    stars: repo.stargazerCount,
    forks: repo.forkCount,
    license: repo.licenseInfo?.nickname ?? repo.licenseInfo?.name ?? null,
    language: repo.primaryLanguage?.name || null,
    topics: repo.repositoryTopics ?? [],
    visibility: repo.visibility,
    isFork: repo.isFork,
    defaultBranch: repo.defaultBranchRef?.name || null,
    pushedAt: repo.pushedAt,
    createdAt: repo.createdAt,
    url: repo.url || `https://github.com/${repo.nameWithOwner}`,
  };
}

const ContributorWire = z
  .object({
    // Bots (dependabot[bot], …) come through as `type: Bot` — a calm surface
    // shouldn't list them as top contributors, so only real Users count.
    type: z.string().catch(""),
    login: z.string().catch(""),
    contributions: WireCount,
    avatar_url: z.string().catch(""),
  })
  .transform((row) => {
    const login = row.login.trim();
    if (row.type !== "User" || !login) return null;
    return { login, commits: row.contributions, avatarUrl: row.avatar_url || null };
  });

const UserWire = z.object({
  login: z.string().min(1),
  name: WireText,
  bio: WireText,
  avatar_url: WireText,
  html_url: z.string().catch(""),
});

const MilestoneWire = z.object({ title: z.string().catch("") });

// Everything the dedicated pull-request view draws, in one `gh pr view`.
const PR_DETAIL_JSON_FIELDS =
  "number,title,body,url,author,state,isDraft,mergeable,mergeStateStatus," +
  "additions,deletions,changedFiles,files,headRefName,headRepositoryOwner,baseRefName," +
  "reviewDecision,reviewRequests,latestReviews,comments,statusCheckRollup," +
  "commits,labels,assignees,milestone,createdAt,updatedAt,mergedAt,closedAt,mergedBy";

const PullRequestDetailWire = z.object({
  number: z.number().int().positive(),
  title: z.string().catch(""),
  body: z.string().catch(""),
  url: z.string().catch(""),
  state: z.string().catch(""),
  isDraft: z.boolean().catch(false),
  mergeable: z.string().catch(""),
  mergeStateStatus: z.string().catch(""),
  additions: WireCount,
  deletions: WireCount,
  changedFiles: WireCount,
  author: ActorWire.catch(null),
  mergedBy: ActorWire.catch(null),
  headRepositoryOwner: ActorWire.catch(null),
  assignees: PeopleListWire,
  headRefName: z.string().catch(""),
  baseRefName: z.string().catch(""),
  reviewDecision: ReviewDecisionWire,
  reviewRequests: PeopleListWire,
  latestReviews: rows(ReviewWire).catch([]),
  comments: rows(CommentWire)
    .catch([])
    .transform((list) => list.filter((comment) => !comment.isMinimized)),
  statusCheckRollup: RollupWire,
  commits: rows(PrCommitWire).catch([]),
  files: rows(PrFileWire).catch([]),
  labels: rows(LabelWire).catch([]),
  milestone: MilestoneWire.nullish(),
  createdAt: z.string().catch(""),
  updatedAt: WireText,
  mergedAt: WireText,
  closedAt: WireText,
});

type DecodedPullRequestDetail = z.output<typeof PullRequestDetailWire>;

/** Whether GitHub could merge this, in the one word worth saying. `mergeable`
 *  answers "do the trees conflict"; `mergeStateStatus` answers "would the repo
 *  let you" — a conflict outranks everything, and a draft outranks the lot,
 *  because nothing else about mergeability matters until it's ready. */
function mergeabilityOf(
  mergeable: string,
  stateStatus: string,
  isDraft: boolean,
): GitHubPullRequestDetail["mergeability"] {
  if (isDraft) return "draft";
  if (mergeable === "CONFLICTING") return "conflicting";
  switch (stateStatus) {
    case "CLEAN":
      return "clean";
    case "BLOCKED":
      return "blocked";
    case "BEHIND":
      return "behind";
    case "UNSTABLE":
      return "unstable";
    case "DIRTY":
      return "conflicting";
    case "DRAFT":
      return "draft";
    default:
      return mergeable === "MERGEABLE" ? "clean" : "unknown";
  }
}

const CommitIdentityWire = z.object({
  name: z.string().catch(""),
  email: z.string().catch(""),
});

const ApiCommitWire = z.object({
  commit: z
    .object({ author: CommitIdentityWire.nullish() })
    .nullish(),
  author: z
    .object({
      login: z.string().catch(""),
      avatar_url: z.string().catch(""),
    })
    .nullish(),
});

const GhAccountWire = z.object({
  state: z.string().catch(""),
  active: z.boolean().catch(false),
  login: z.string().catch(""),
});

const AuthHostsWire = z.object({
  hosts: z.record(z.string(), z.array(GhAccountWire)).catch({}),
});

/** "2 hours ago"-style relative time for an ISO date. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const mins = Math.max(0, Math.floor((Date.now() - then) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/** Parse a gh stdout payload, throwing the caller's error when the CLI
 *  answered with something unparseable. */
function decodeOrThrow<Schema extends z.ZodType>(
  out: string,
  schema: Schema,
  message: string,
): z.output<Schema> | null {
  let raw: JsonValue;
  try {
    raw = JSON.parse(out.trim());
  } catch {
    throw new GitError(message, null);
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Whether gh is installed and logged in, and as whom. */
export async function status(): Promise<GitHubStatus> {
  let out: string;
  try {
    out = await gh(os.homedir(), ["auth", "status", "--json", "hosts"]);
  } catch (error) {
    if (error instanceof GitError && error.kind === "NOT_INSTALLED") {
      return { installed: false, authenticated: false, user: null, message: NOT_INSTALLED_MESSAGE };
    }
    // gh runs but reported a problem (typically "please run: gh auth login").
    // gh's own line is friendlier than our canned one — keep it.
    const message = error instanceof GitError ? error.message : NOT_AUTHENTICATED_MESSAGE;
    return { installed: true, authenticated: false, user: null, message };
  }

  const trimmed = out.trim();
  if (!trimmed) {
    return { installed: true, authenticated: false, user: null, message: NOT_AUTHENTICATED_MESSAGE };
  }
  let raw: JsonValue;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { installed: true, authenticated: false, user: null, message: NOT_AUTHENTICATED_MESSAGE };
  }
  const decoded = AuthHostsWire.safeParse(raw);
  if (!decoded.success) {
    return { installed: true, authenticated: false, user: null, message: NOT_AUTHENTICATED_MESSAGE };
  }
  const accounts = Object.values(decoded.data.hosts).flat();
  // Prefer the active account, then any authenticated one.
  const user =
    accounts.find((a) => a.state === "success" && a.active)?.login ??
    accounts.find((a) => a.state === "success")?.login ??
    null;
  if (user) {
    return { installed: true, authenticated: true, user, message: null };
  }
  return { installed: true, authenticated: false, user: null, message: NOT_AUTHENTICATED_MESSAGE };
}

/** List pull requests for the repo `dir` sits in. */
export async function prs(
  dir: string,
  opts?: { state?: "open" | "all"; limit?: number },
): Promise<GitHubPullRequest[]> {
  const root = await repoRoot(dir);
  if (!root) throw GitError.classified("NOT_A_REPO", "Not inside a git repository.", null);
  const state = opts?.state ?? "open";
  const limit = Number.isFinite(opts?.limit) ? Math.max(1, Math.floor(opts?.limit ?? 50)) : 50;
  const out = await gh(root, [
    "pr",
    "list",
    "--state",
    state,
    "--limit",
    String(limit),
    "--json",
    PR_JSON_FIELDS,
  ]);
  const trimmed = out.trim();
  if (!trimmed) return [];
  const decoded = decodeOrThrow(
    trimmed,
    rows(PullRequestWire).nullable().catch(null),
    "The GitHub CLI returned unparseable pull request data.",
  );
  // A non-array answer means gh changed shape under us — say so rather than
  // show an empty list.
  if (decoded === null) {
    throw new GitError("The GitHub CLI returned unexpected pull request data.", null);
  }
  return decoded.map(pullRequestOf);
}

/** The repo's public GitHub surface (About section). Null when `dir` isn't in
 *  a repo, or when gh is missing / logged out / the repo has no GitHub remote —
 *  the empty states, not errors. */
export async function repo(dir: string): Promise<GitHubRepoInfo | null> {
  const root = await repoRoot(dir);
  if (!root) return null;
  let out: string;
  try {
    out = await gh(root, ["repo", "view", "--json", REPO_JSON_FIELDS]);
  } catch (error) {
    if (error instanceof GitError && REPO_VIEW_ABSENCE_KINDS.has(error.kind ?? "")) return null;
    throw error;
  }
  const trimmed = out.trim();
  if (!trimmed) return null;
  const decoded = decodeOrThrow(
    trimmed,
    RepoInfoWire.nullable().catch(null),
    "The GitHub CLI returned unparseable repository data.",
  );
  return decoded === null ? null : repoInfoOf(decoded);
}

/** The repository's contributors, via the GitHub API. It trades git's real
 *  names for handles — the endpoint carries no display name — and buys avatars
 *  with them. Needs gh, a login and a GitHub remote; null when any of those is
 *  missing, since those are empty states rather than errors. */
export async function contributors(dir: string): Promise<GitContributors | null> {
  const root = await repoRoot(dir);
  if (!root) return null;
  let out: string;
  try {
    // gh substitutes {owner}/{repo} from the cwd's remote — the caller's dir,
    // not a slug we plumb in.
    out = await gh(root, ["api", "repos/{owner}/{repo}/contributors?per_page=100"]);
  } catch (error) {
    if (error instanceof GitError && REPO_VIEW_ABSENCE_KINDS.has(error.kind ?? "")) return null;
    throw error;
  }
  // An empty repo answers 204 No Content — nothing to show, not an error.
  let rowsIn: (z.output<typeof ContributorWire> | null)[] | null = null;
  try {
    const trimmed = out.trim();
    if (!trimmed) return null;
    const parsed = rows(ContributorWire).safeParse(JSON.parse(trimmed));
    if (parsed.success) rowsIn = parsed.data;
  } catch {
    return null;
  }
  if (rowsIn === null) return null;
  const rowsOut = rowsIn.filter((row): row is NonNullable<typeof row> => row !== null);
  rowsOut.sort((a, b) => b.commits - a.commits);
  // Fetch avatars for the shown people only, in parallel — those past the cap
  // aren't rendered, so their fetch would be wasted network. An avatar is
  // decorative by contract: a failure is a null, never a failed call.
  const shown = rowsOut.slice(0, GIT_CONTRIBUTOR_CAP);
  const people: GitContributor[] = await Promise.all(
    shown.map(async (row) => ({
      name: row.login,
      login: row.login,
      email: null,
      avatarDataUrl: row.avatarUrl
        ? await fetchAvatarDataUrl(row.avatarUrl).catch(() => null)
        : null,
      commits: row.commits,
    })),
  );
  return { source: "github", people, total: rowsOut.length };
}

const AVATAR_TIMEOUT_MS = 5_000;
const AVATAR_CAP = 512 * 1024;

/** Fetch a remote image into a base64 data URL. The avatar is decorative by
 *  contract — every failure (timeout, oversize, non-image, offline) resolves
 *  to null and can never fail the caller. */
async function fetchAvatarDataUrl(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AVATAR_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) return null;
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > AVATAR_CAP) return null;
    const type = response.headers.get("content-type") ?? "";
    const mime = /^image\/[a-z0-9.+-]+$/i.test(type) ? type.toLowerCase() : null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > AVATAR_CAP) return null;
    return `data:${mime ?? "image/png"};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The signed-in GitHub user (About section), with the avatar fetched into a
 *  data URL when it can be. Null when gh is missing or logged out. */
export async function me(): Promise<GitHubUser | null> {
  let out: string;
  try {
    out = await gh(os.homedir(), ["api", "user"]);
  } catch (error) {
    if (error instanceof GitError && REPO_VIEW_ABSENCE_KINDS.has(error.kind ?? "")) return null;
    throw error;
  }
  const trimmed = out.trim();
  if (!trimmed) return null;
  let raw: JsonValue;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const decoded = UserWire.safeParse(raw);
  if (!decoded.success) return null;
  const wire = decoded.data;
  const htmlUrl = wire.html_url || `https://github.com/${wire.login}`;
  const user: GitHubUser = {
    login: wire.login,
    name: wire.name,
    bio: wire.bio,
    avatarUrl: wire.avatar_url,
    avatarDataUrl: null,
    htmlUrl,
  };
  if (wire.avatar_url) {
    user.avatarDataUrl = await fetchAvatarDataUrl(wire.avatar_url).catch(() => null);
  }
  return user;
}

// ── people ────────────────────────────────────────────────────────────────────

/** Avatars, cached for the life of the process and keyed by login. A face
 *  doesn't change while a window is open, and one pull request alone would
 *  otherwise refetch the same author's picture for the header, every review and
 *  every comment they left. */
const avatarCache = new Map<string, string | null>();
const AVATAR_CACHE_CAP = 256;

/** One person's avatar. `github.com/<login>.png` is a public redirect to the
 *  same CDN the API points at — no call, no token, no rate limit — which
 *  matters because `gh pr view` names people by handle and never carries a
 *  picture. Anything already holding a URL passes it in instead. */
async function avatarFor(login: string, known?: string | null): Promise<string | null> {
  const cached = avatarCache.get(login);
  if (cached !== undefined) return cached;
  const url = known ?? `https://github.com/${encodeURIComponent(login)}.png?size=96`;
  const face = await fetchAvatarDataUrl(url).catch(() => null);
  // Oldest out, so a long session browsing a busy repo can't grow without end.
  if (avatarCache.size >= AVATAR_CACHE_CAP) {
    const oldest = avatarCache.keys().next().value;
    if (oldest !== undefined) avatarCache.delete(oldest);
  }
  avatarCache.set(login, face);
  return face;
}

/** Fetch every distinct face in one parallel pass and hand it to each record
 *  that names that person. Faces are decorative by contract: a miss is a null
 *  the caller renders an initial for, never a failure. */
async function fillAvatars(people: (GitHubPerson | null)[]): Promise<void> {
  const named = people.filter((p): p is GitHubPerson => p !== null);
  const logins = [...new Set(named.map((p) => p.login))].slice(0, GIT_AUTHOR_AVATAR_CAP);
  const faces = new Map<string, string | null>();
  await Promise.all(
    logins.map(async (login) => {
      faces.set(login, await avatarFor(login));
    }),
  );
  for (const person of named) person.avatarDataUrl = faces.get(person.login) ?? null;
}

// ── pull request detail ───────────────────────────────────────────────────────

/** Map one decoded `gh pr view` payload onto the view shape. Pure: everything
 *  representation-shaped already happened in the schema above. */
function pullRequestDetailOf(wire: DecodedPullRequestDetail): GitHubPullRequestDetail {
  const state =
    wire.mergedAt !== null || wire.state === "MERGED"
      ? "merged"
      : wire.state === "CLOSED"
        ? "closed"
        : "open";

  // Who has looked at this, and who is still being waited on. `latestReviews`
  // holds one current verdict per reviewer; a request with no review yet is a
  // person too, and reads as pending rather than being left off the list.
  const reviews: GitHubReview[] = wire.latestReviews.map((row) => ({
    author: row.author,
    state: row.state,
    body: row.body,
    submittedAt: row.submittedAt,
    relative: row.submittedAt ? relativeTime(row.submittedAt) : "",
  }));
  const reviewed = new Set(reviews.map((r) => r.author?.login).filter(Boolean));
  for (const person of wire.reviewRequests) {
    if (reviewed.has(person.login)) continue;
    reviews.push({ author: person, state: "pending", body: "", submittedAt: null, relative: "" });
  }

  const comments: GitHubComment[] = wire.comments.map((row) => ({
    author: row.author,
    body: row.body,
    createdAt: row.createdAt,
    relative: row.createdAt ? relativeTime(row.createdAt) : "",
    url: row.url,
  }));

  const commits: GitHubPrCommit[] = wire.commits.map((row) => {
    const first = row.authors[0];
    const date = row.committedDate ?? row.authoredDate ?? wire.createdAt;
    return {
      oid: row.oid,
      short: row.oid.slice(0, 7),
      headline: row.messageHeadline,
      body: row.messageBody,
      author: (first?.name || first?.login || "").trim(),
      date,
      relative: relativeTime(date),
    };
  });

  return {
    number: wire.number,
    title: wire.title,
    state,
    isDraft: wire.isDraft,
    url: wire.url,
    body: wire.body,
    author: wire.author,
    branch: wire.headRefName,
    base: wire.baseRefName,
    forkOwner: wire.headRepositoryOwner?.login ?? null,
    createdAt: wire.createdAt,
    relative: wire.createdAt ? relativeTime(wire.createdAt) : "",
    updatedAt: wire.updatedAt,
    mergedAt: wire.mergedAt,
    closedAt: wire.closedAt,
    mergedBy: wire.mergedBy,
    additions: wire.additions,
    deletions: wire.deletions,
    changedFiles: wire.changedFiles,
    mergeability: mergeabilityOf(wire.mergeable, wire.mergeStateStatus, wire.isDraft),
    reviewDecision: wire.reviewDecision,
    checks: rollupChecks(wire.statusCheckRollup),
    checkRuns: wire.statusCheckRollup
      .map(checkOf)
      .filter((check): check is GitHubCheck => check !== null),
    labels: wire.labels,
    assignees: wire.assignees,
    reviews,
    comments,
    commits,
    files: wire.files,
    milestone: wire.milestone?.title || null,
  };
}

/** One pull request in full. Null when there's no such PR, or when gh is
 *  missing / logged out / the remote isn't GitHub — the empty states. */
export async function prDetail(
  dir: string,
  number: number,
): Promise<GitHubPullRequestDetail | null> {
  const root = await repoRoot(dir);
  if (!root) return null;
  if (!Number.isInteger(number) || number <= 0) {
    throw GitError.classified("INVALID_INPUT", `Invalid pull request number: ${number}`, null);
  }
  let out: string;
  try {
    out = await gh(root, ["pr", "view", String(number), "--json", PR_DETAIL_JSON_FIELDS]);
  } catch (error) {
    if (error instanceof GitError && REPO_VIEW_ABSENCE_KINDS.has(error.kind ?? "")) return null;
    // A number that doesn't exist is an empty view, not a broken one.
    if (error instanceof GitError && error.kind === "NOT_FOUND") {
      return null;
    }
    throw error;
  }
  const trimmed = out.trim();
  if (!trimmed) return null;
  const decoded = decodeOrThrow(
    trimmed,
    PullRequestDetailWire.nullable().catch(null),
    "The GitHub CLI returned unparseable pull request data.",
  );
  if (decoded === null) return null;

  const detail = pullRequestDetailOf(decoded);

  await fillAvatars([
    detail.author,
    detail.mergedBy,
    ...detail.assignees,
    ...detail.reviews.map((r) => r.author),
    ...detail.comments.map((comment) => comment.author),
  ]);
  return detail;
}

/** Every file a pull request touches, already parsed into hunks. One `gh pr
 *  diff` fetches the whole patch: asking per file would be a round trip each
 *  time, and the head branch usually isn't local to diff against anyway. */
export async function prDiff(dir: string, number: number): Promise<GitFileDiff[]> {
  const root = await repoRoot(dir);
  if (!root) return [];
  if (!Number.isInteger(number) || number <= 0) {
    throw GitError.classified("INVALID_INPUT", `Invalid pull request number: ${number}`, null);
  }
  let out: string;
  try {
    out = await gh(root, ["pr", "diff", String(number), "--patch", "--color", "never"]);
  } catch (error) {
    if (error instanceof GitError && REPO_VIEW_ABSENCE_KINDS.has(error.kind ?? "")) return [];
    throw error;
  }
  // Each file's section starts at its own `diff --git` line, which is exactly
  // the shape `parseFileDiff` gets from a single-path `git diff` — so the PR
  // view and the working tree share one parser and can't render differently.
  const files: GitFileDiff[] = [];
  for (const chunk of out.split(/^diff --git /m).slice(1)) {
    const path = pathOfPatchChunk(chunk);
    if (path) files.push(parseFileDiff(path, chunk));
  }
  return files;
}

/** The file a patch chunk is about. `+++ b/<path>` is authoritative except on a
 *  deletion, where it reads /dev/null and the `---` line has the name; the
 *  `a/x b/x` header the chunk opens with is the last resort, for a binary file
 *  that has neither. */
function pathOfPatchChunk(chunk: string): string | null {
  const plus = /^\+\+\+ b\/(.+)$/m.exec(chunk);
  if (plus?.[1] && plus[1] !== "/dev/null") return plus[1];
  const minus = /^--- a\/(.+)$/m.exec(chunk);
  if (minus?.[1] && minus[1] !== "/dev/null") return minus[1];
  const header = /^"?a\/(.+?)"? "?b\//.exec(chunk);
  return header?.[1] ?? null;
}

/** Commit email → the GitHub account behind it, so the history can put a real
 *  face beside a commit. git only ever knows a name and an address; this is the
 *  one call that turns those into people.
 *
 *  Decorative by contract, like the avatars themselves: every failure — no gh,
 *  no remote, an empty repository, a rate limit — resolves to null, because a
 *  missing face must never be the reason a history won't draw. */
export async function commitAuthors(dir: string): Promise<GitCommitAuthors | null> {
  const root = await repoRoot(dir);
  if (!root) return null;
  let decoded: z.output<typeof ApiCommitWire>[] | null = null;
  try {
    const out = await gh(root, ["api", "repos/{owner}/{repo}/commits?per_page=100"]);
    const trimmed = out.trim();
    if (!trimmed) return null;
    const parsed = rows(ApiCommitWire).safeParse(JSON.parse(trimmed));
    if (parsed.success) decoded = parsed.data;
  } catch {
    return null;
  }
  if (decoded === null) return null;

  // One entry per address, first sighting wins — the newest commit's account is
  // the current one if an address ever changed hands.
  const byEmail = new Map<string, GitHubPerson>();
  const urls = new Map<string, string>();
  for (const entry of decoded) {
    const committed = entry.commit?.author ?? null;
    const email = (committed?.email ?? "").toLowerCase();
    const login = entry.author?.login ?? "";
    if (!email || !login || byEmail.has(email)) continue;
    const name = committed?.name ?? null;
    byEmail.set(email, {
      login,
      name: name?.trim() ? name : null,
      avatarDataUrl: null,
    });
    if (entry.author?.avatar_url) {
      urls.set(login, entry.author.avatar_url);
    }
  }

  const people = [...byEmail.values()];
  const logins = [...new Set(people.map((p) => p.login))].slice(0, GIT_AUTHOR_AVATAR_CAP);
  const faces = new Map<string, string | null>();
  await Promise.all(
    logins.map(async (login) => {
      faces.set(login, await avatarFor(login, urls.get(login) ?? null));
    }),
  );
  const authors: GitCommitAuthors = {};
  for (const [email, person] of byEmail) {
    authors[email] = { ...person, avatarDataUrl: faces.get(person.login) ?? null };
  }
  return authors;
}

/** Create a pull request. The body travels by file, never argv — argv is
 *  visible in process listings and gets echoed into error text. */
export async function createPr(
  dir: string,
  opts: GitHubPrCreateOptions,
): Promise<GitHubPrCreateResult> {
  const root = await repoRoot(dir);
  if (!root) throw GitError.classified("NOT_A_REPO", "Not inside a git repository.", null);
  const title = opts.title.trim();
  if (!title) throw new GitError("Pull request title is empty.", null);
  const args = ["pr", "create", "--title", title];
  if (opts.base?.trim()) args.push("--base", opts.base.trim());
  if (opts.draft) args.push("--draft");
  let tmp: string | null = null;
  try {
    if (opts.body?.trim()) {
      tmp = await mkdtemp(path.join(os.tmpdir(), "kone-gh-"));
      const bodyFile = path.join(tmp, "body.md");
      await writeFile(bodyFile, opts.body, "utf8");
      args.push("--body-file", bodyFile);
    } else {
      args.push("--body", "");
    }
    const out = await gh(root, args);
    const url = out.trim();
    const m = /\/pull\/(\d+)/.exec(url);
    return { number: m ? Number(m[1]) : null, url };
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Check out a pull request's head branch locally (via gh). */
export async function checkoutPr(dir: string, number: number): Promise<void> {
  const root = await repoRoot(dir);
  if (!root) throw GitError.classified("NOT_A_REPO", "Not inside a git repository.", null);
  if (!Number.isInteger(number) || number <= 0) {
    throw GitError.classified("INVALID_INPUT", `Invalid pull request number: ${number}`, null);
  }
  await gh(root, ["pr", "checkout", String(number)]);
}

/** Open a URL in the user's real browser. Refuses anything but http(s). */
export async function open(url: string): Promise<void> {
  const externalUrl = parseSafeExternalUrl(url);
  if (!externalUrl) {
    throw GitError.classified("INVALID_INPUT", `Refusing to open a non-http URL: ${url}`, null);
  }
  await shell.openExternal(externalUrl);
}

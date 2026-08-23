import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { shell } from "electron";

import { parseSafeExternalUrl } from "../safeExternalUrl.js";
import type { JsonObject } from "../jsonValue.js";
import { GitError, lastStderrLine, repoRoot, run } from "./core.js";
import { parseFileDiff } from "./diff.js";
import { classifyGhError } from "./ghError.js";
import { GIT_AUTHOR_AVATAR_CAP, GIT_CONTRIBUTOR_CAP } from "./types.js";
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
} from "./types.js";

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

interface GhAccount {
  state: string;
  active: boolean;
  login: string;
  host: string;
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

  let hosts: { hosts?: Record<string, GhAccount[]> };
  try {
    hosts = JSON.parse(out.trim());
  } catch {
    return { installed: true, authenticated: false, user: null, message: NOT_AUTHENTICATED_MESSAGE };
  }
  const accounts = Object.values(hosts?.hosts ?? {}).flat();
  // Prefer the active account, then any authenticated one.
  const user = (accounts.find((a) => a.state === "success" && a.active) ??
    accounts.find((a) => a.state === "success"))?.login ?? null;
  if (user) {
    return { installed: true, authenticated: true, user, message: null };
  }
  return { installed: true, authenticated: false, user: null, message: NOT_AUTHENTICATED_MESSAGE };
}

// The one field list for every PR fetch, so the list and any later view
// shapes cannot drift.
const PR_JSON_FIELDS =
  "number,title,state,isDraft,author,headRefName,baseRefName,url,createdAt,additions,deletions,statusCheckRollup,reviewDecision,comments,mergedAt";

// The field list for the About section's repo view. Kept to the flat gh
// names; the nested licenseInfo/primaryLanguage/repositoryTopics/
// defaultBranchRef are unwrapped in mapRepoInfo.
const REPO_JSON_FIELDS =
  "nameWithOwner,description,homepageUrl,stargazerCount,forkCount,licenseInfo,primaryLanguage,repositoryTopics,visibility,isFork,defaultBranchRef,pushedAt,createdAt,url";

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const FAILED_STATES = new Set(["FAILURE", "ERROR"]);

/** Fold gh's statusCheckRollup — a mix of CheckRun and StatusContext nodes —
 *  into one verdict: any failure fails the whole PR; otherwise any pending
 *  waits; otherwise passing needs at least one success. */
function rollupChecks(rollup: unknown): "passing" | "failing" | "pending" | "none" {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let pending = 0;
  let passing = 0;
  for (const item of rollup) {
    const rec = jsonRecord(item);
    if (!rec) continue;
    const state = typeof rec.state === "string" ? rec.state : "";
    const status = typeof rec.status === "string" ? rec.status : "";
    const conclusion = typeof rec.conclusion === "string" ? rec.conclusion : "";
    if (FAILED_STATES.has(state) || FAILED_CONCLUSIONS.has(conclusion)) return "failing";
    if (state === "SUCCESS" || conclusion === "SUCCESS") passing += 1;
    else if (state === "PENDING" || state === "EXPECTED" || (status !== "" && status !== "COMPLETED")) {
      pending += 1;
    }
  }
  if (pending > 0) return "pending";
  if (passing > 0) return "passing";
  return "none";
}

function normalizeReviewDecision(
  value: unknown,
): "approved" | "changes-requested" | "review-required" | null {
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
}

/** gh reports comments as a count on `pr list` and as an array on `pr view` —
 *  accept both. */
function commentCount(value: unknown): number {
  if (typeof value === "number") return Math.max(0, Math.floor(value));
  if (Array.isArray(value)) return value.length;
  return 0;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** gh returns "" for an unset optional string (no description, no homepage) —
 *  collapse those to null so the renderer sees "absent", not empty. */
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

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

/** Map one gh PR JSON record onto the contract shape. Throws on a malformed
 *  entry so the list caller can skip it without losing the healthy ones. */
function mapPullRequest(pr: JsonObject): GitHubPullRequest {
  const number = Number(pr.number);
  if (!Number.isInteger(number) || number <= 0) throw new Error("bad number");
  const stateRaw = typeof pr.state === "string" ? pr.state : "";
  // gh reports merged PRs as CLOSED unless mergedAt is set — the timestamp is
  // authoritative.
  const mergedAt = typeof pr.mergedAt === "string" && pr.mergedAt.trim() ? pr.mergedAt : null;
  const state =
    mergedAt !== null || stateRaw === "MERGED"
      ? "merged"
      : stateRaw === "CLOSED"
        ? "closed"
        : "open";
  const createdAt = typeof pr.createdAt === "string" ? pr.createdAt : "";
  const author = jsonRecord(pr.author);
  return {
    number,
    title: typeof pr.title === "string" ? pr.title : "",
    state,
    isDraft: pr.isDraft === true,
    author:
      author && typeof author.login === "string" && author.login ? author.login : "unknown",
    branch: typeof pr.headRefName === "string" ? pr.headRefName : "",
    base: typeof pr.baseRefName === "string" ? pr.baseRefName : "",
    url: typeof pr.url === "string" ? pr.url : "",
    createdAt,
    relative: relativeTime(createdAt),
    additions: nonNegative(pr.additions),
    deletions: nonNegative(pr.deletions),
    checks: rollupChecks(pr.statusCheckRollup),
    reviewDecision: normalizeReviewDecision(pr.reviewDecision),
    comments: commentCount(pr.comments),
  };
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
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    throw new GitError("The GitHub CLI returned unparseable pull request data.", null);
  }
  if (!Array.isArray(raw)) {
    throw new GitError("The GitHub CLI returned unexpected pull request data.", null);
  }
  // One malformed entry (a gh quirk or API oddity) must not hide the healthy
  // PRs in the same list.
  const result: GitHubPullRequest[] = [];
  for (const entry of raw) {
    const rec = jsonRecord(entry);
    if (!rec) continue;
    try {
      result.push(mapPullRequest(rec));
    } catch {
      // skip the malformed entry
    }
  }
  return result;
}

/** The "repo has no GitHub info for the About section" set — a missing gh,
 *  a logged-out gh, or a repo whose remotes point nowhere GitHub hosts. Each
 *  is a normal empty state (null), not something the About section should
 *  crash on. Anything else stays an error. */
function isRepoViewAbsence(error: unknown): boolean {
  if (!(error instanceof GitError)) return false;
  return (
    error.kind === "NOT_INSTALLED" ||
    error.kind === "NOT_AUTHENTICATED" ||
    error.kind === "NO_GITHUB_REMOTE"
  );
}

/** A JSON object straight out of `gh --json` output, or null.
 *  Every caller feeds this only freshly parsed gh CLI records and probes each
 *  field with typeof/=== before trusting it. */
function jsonRecord(raw: unknown): JsonObject | null {
  // SAFETY: the typeof-object/null checks on this line are the narrowing itself;
  // gh output is wire JSON, so a non-null object satisfies JsonObject and every
  // field reads back as JsonValue.
  return typeof raw === "object" && raw !== null ? (raw as JsonObject) : null;
}

/** Map one `gh repo view --json` record onto the flat About shape, unwrapping
 *  the nested licenseInfo/primaryLanguage/repositoryTopics/defaultBranchRef. */
function mapRepoInfo(raw: unknown): GitHubRepoInfo | null {
  const rec = jsonRecord(raw);
  if (!rec || typeof rec.nameWithOwner !== "string" || !rec.nameWithOwner) return null;
  const license = jsonRecord(rec.licenseInfo);
  const language = jsonRecord(rec.primaryLanguage);
  const branch = jsonRecord(rec.defaultBranchRef);
  // gh 2.96 reports repositoryTopics as a plain [{ name }] array (null when the
  // repo has no topics).
  const topics = Array.isArray(rec.repositoryTopics)
    ? rec.repositoryTopics
        .map((t) => (jsonRecord(t))?.name)
        .filter((n): n is string => typeof n === "string")
    : [];
  // SAFETY: gh's fields are probed above; visibility is one of its fixed
  // lowercase tokens and every other read is typeof-guarded.
  return {
    nameWithOwner: rec.nameWithOwner,
    description: stringOrNull(rec.description),
    homepageUrl: stringOrNull(rec.homepageUrl),
    stars: nonNegative(rec.stargazerCount),
    forks: nonNegative(rec.forkCount),
    // nickname is the short form ("MIT"); an empty nickname means "no
    // nickname", so it falls back to the full name.
    license:
      license && typeof license.name === "string" && license.name
        ? typeof license.nickname === "string" && license.nickname
          ? license.nickname
          : license.name
        : null,
    language:
      language && typeof language.name === "string" && language.name
        ? language.name
        : null,
    topics,
    visibility:
      typeof rec.visibility === "string" && rec.visibility
        ? (rec.visibility.toLowerCase() as GitHubRepoInfo["visibility"])
        : "private",
    isFork: rec.isFork === true,
    defaultBranch:
      branch && typeof branch.name === "string" && branch.name ? branch.name : null,
    pushedAt: stringOrNull(rec.pushedAt),
    createdAt: stringOrNull(rec.createdAt),
    url: typeof rec.url === "string" && rec.url ? rec.url : `https://github.com/${rec.nameWithOwner}`,
  };
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
    if (isRepoViewAbsence(error)) return null;
    throw error;
  }
  const trimmed = out.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    throw new GitError("The GitHub CLI returned unparseable repository data.", null);
  }
  return mapRepoInfo(raw);
}

/** Map one GitHub contributors record onto a row, or null to skip it. One
 *  malformed record (a gh quirk) must not lose the rest of the list. */
function mapContributor(
  raw: unknown,
): { login: string; commits: number; avatarUrl: string | null } | null {
  const rec = jsonRecord(raw);
  if (!rec) return null;
  // Bots (dependabot[bot], …) come through as `type: Bot` — a calm surface
  // shouldn't list them as top contributors, so only real Users count.
  if (rec.type !== "User") return null;
  const login = typeof rec.login === "string" ? rec.login.trim() : "";
  if (!login) return null;
  return {
    login,
    commits: nonNegative(rec.contributions),
    avatarUrl:
      typeof rec.avatar_url === "string" && rec.avatar_url ? rec.avatar_url : null,
  };
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
    if (isRepoViewAbsence(error)) return null;
    throw error;
  }
  // An empty repo answers 204 No Content — nothing to show, not an error.
  const trimmed = out.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const rows: { login: string; commits: number; avatarUrl: string | null }[] = [];
  for (const entry of raw) {
    const row = mapContributor(entry);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => b.commits - a.commits);
  // Fetch avatars for the shown people only, in parallel — those past the cap
  // aren't rendered, so their fetch would be wasted network. An avatar is
  // decorative by contract: a failure is a null, never a failed call.
  const shown = rows.slice(0, GIT_CONTRIBUTOR_CAP);
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
  return { source: "github", people, total: rows.length };
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
    if (isRepoViewAbsence(error)) return null;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(out.trim());
  } catch {
    throw new GitError("The GitHub CLI returned unparseable user data.", null);
  }
  const rec = jsonRecord(raw);
  if (!rec || typeof rec.login !== "string" || !rec.login) return null;
  const avatarUrl = stringOrNull(rec.avatar_url);
  const user: GitHubUser = {
    login: rec.login,
    name: stringOrNull(rec.name),
    bio: stringOrNull(rec.bio),
    avatarUrl,
    avatarDataUrl: null,
    htmlUrl:
      typeof rec.html_url === "string" && rec.html_url
        ? rec.html_url
        : `https://github.com/${rec.login}`,
  };
  if (avatarUrl) {
    user.avatarDataUrl = await fetchAvatarDataUrl(avatarUrl).catch(() => null);
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

/** Read one `{ login, name }` actor — gh's shape for every person field — as a
 *  faceless person. `fillAvatars` completes the whole set in one pass, so a
 *  view with forty comments makes one fetch per *person*, not per mention. */
function actor(raw: unknown): GitHubPerson | null {
  const rec = jsonRecord(raw);
  if (!rec) return null;
  const login = typeof rec.login === "string" ? rec.login.trim() : "";
  if (!login) return null;
  return { login, name: stringOrNull(rec.name), avatarDataUrl: null };
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

/** Everything the dedicated pull-request view draws, in one `gh pr view`. */
const PR_DETAIL_JSON_FIELDS =
  "number,title,body,url,author,state,isDraft,mergeable,mergeStateStatus," +
  "additions,deletions,changedFiles,files,headRefName,headRepositoryOwner,baseRefName," +
  "reviewDecision,reviewRequests,latestReviews,comments,statusCheckRollup," +
  "commits,labels,assignees,milestone,createdAt,updatedAt,mergedAt,closedAt,mergedBy";

/** Whether GitHub could merge this, in the one word worth saying. `mergeable`
 *  answers "do the trees conflict"; `mergeStateStatus` answers "would the repo
 *  let you" — a conflict outranks everything, and a draft outranks the lot,
 *  because nothing else about mergeability matters until it's ready. */
function mergeabilityOf(
  mergeable: unknown,
  stateStatus: unknown,
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

/** One check run or status context as a single verdict. Skipped and neutral
 *  runs are their own state rather than a pass: a repo that skips half its
 *  matrix shouldn't read as half-green. */
function checkStateOf(rec: JsonObject): GitHubCheck["state"] {
  const state = typeof rec.state === "string" ? rec.state : "";
  const status = typeof rec.status === "string" ? rec.status : "";
  const conclusion = typeof rec.conclusion === "string" ? rec.conclusion : "";
  if (FAILED_STATES.has(state) || FAILED_CONCLUSIONS.has(conclusion)) return "failing";
  if (conclusion === "SKIPPED" || conclusion === "NEUTRAL") return "skipped";
  if (state === "SUCCESS" || conclusion === "SUCCESS") return "passing";
  if (state === "PENDING" || state === "EXPECTED" || (status !== "" && status !== "COMPLETED")) {
    return "pending";
  }
  return "none";
}

function mapCheck(raw: unknown): GitHubCheck | null {
  const rec = jsonRecord(raw);
  if (!rec) return null;
  // A CheckRun is named; a StatusContext carries its name in `context`.
  const name =
    (typeof rec.name === "string" && rec.name) ||
    (typeof rec.context === "string" && rec.context) ||
    "";
  if (!name) return null;
  const url =
    (typeof rec.detailsUrl === "string" && rec.detailsUrl) ||
    (typeof rec.targetUrl === "string" && rec.targetUrl) ||
    null;
  return {
    name,
    workflow: stringOrNull(rec.workflowName),
    state: checkStateOf(rec),
    url,
  };
}

function reviewStateOf(value: unknown): GitHubReview["state"] {
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
}

function mapLabel(raw: unknown): GitHubLabel | null {
  const rec = jsonRecord(raw);
  if (!rec || typeof rec.name !== "string" || !rec.name) return null;
  const color = typeof rec.color === "string" ? rec.color.replace(/^#/, "") : "";
  return {
    name: rec.name,
    description: stringOrNull(rec.description),
    // A label with no colour still needs one to draw; grey reads as "unset".
    color: /^[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : "8b949e",
  };
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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
    if (isRepoViewAbsence(error)) return null;
    // A number that doesn't exist is an empty view, not a broken one.
    if (error instanceof GitError && error.kind === "NOT_FOUND") {
      return null;
    }
    throw error;
  }
  const trimmed = out.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    throw new GitError("The GitHub CLI returned unparseable pull request data.", null);
  }
  const rec = jsonRecord(raw);
  if (!rec || !Number.isInteger(Number(rec.number))) return null;

  const isDraft = rec.isDraft === true;
  const mergedAt = stringOrNull(rec.mergedAt);
  const stateRaw = typeof rec.state === "string" ? rec.state : "";
  const state =
    mergedAt !== null || stateRaw === "MERGED"
      ? "merged"
      : stateRaw === "CLOSED"
        ? "closed"
        : "open";
  const createdAt = typeof rec.createdAt === "string" ? rec.createdAt : "";

  const author = actor(rec.author);
  const mergedBy = actor(rec.mergedBy);
  const assignees = arrayOf(rec.assignees)
    .map(actor)
    .filter((p): p is GitHubPerson => p !== null);

  // Who has looked at this, and who is still being waited on. `latestReviews`
  // holds one current verdict per reviewer; a request with no review yet is a
  // person too, and reads as pending rather than being left off the list.
  const reviews: GitHubReview[] = [];
  for (const entry of arrayOf(rec.latestReviews)) {
    const row = jsonRecord(entry);
    if (!row) continue;
    const submittedAt = stringOrNull(row.submittedAt);
    reviews.push({
      author: actor(row.author),
      state: reviewStateOf(row.state),
      body: typeof row.body === "string" ? row.body : "",
      submittedAt,
      relative: submittedAt ? relativeTime(submittedAt) : "",
    });
  }
  const reviewed = new Set(reviews.map((r) => r.author?.login).filter(Boolean));
  for (const entry of arrayOf(rec.reviewRequests)) {
    const person = actor(entry);
    // A team request has no login; there's no face to draw, so it's dropped.
    if (!person || reviewed.has(person.login)) continue;
    reviews.push({ author: person, state: "pending", body: "", submittedAt: null, relative: "" });
  }

  // Minimised comments are GitHub's own "this is spam / off-topic" verdict.
  // Repeating it in a calm surface would be the one thing on the page shouting.
  const comments: GitHubComment[] = [];
  for (const entry of arrayOf(rec.comments)) {
    const row = jsonRecord(entry);
    if (!row || row.isMinimized === true) continue;
    const at = typeof row.createdAt === "string" ? row.createdAt : "";
    comments.push({
      author: actor(row.author),
      body: typeof row.body === "string" ? row.body : "",
      createdAt: at,
      relative: at ? relativeTime(at) : "",
      url: typeof row.url === "string" ? row.url : "",
    });
  }

  const commits: GitHubPrCommit[] = [];
  for (const entry of arrayOf(rec.commits)) {
    const row = jsonRecord(entry);
    if (!row) continue;
    const oid = typeof row.oid === "string" ? row.oid : "";
    if (!oid) continue;
    const first = jsonRecord(arrayOf(row.authors)[0]);
    const date =
      stringOrNull(row.committedDate) ?? stringOrNull(row.authoredDate) ?? createdAt;
    commits.push({
      oid,
      short: oid.slice(0, 7),
      headline: typeof row.messageHeadline === "string" ? row.messageHeadline : "",
      body: typeof row.messageBody === "string" ? row.messageBody : "",
      author:
        (first && typeof first.name === "string" && first.name) ||
        (first && typeof first.login === "string" && first.login) ||
        "",
      date,
      relative: relativeTime(date),
    });
  }

  const files: GitHubPrFile[] = [];
  for (const entry of arrayOf(rec.files)) {
    const row = jsonRecord(entry);
    if (!row || typeof row.path !== "string" || !row.path) continue;
    const change = typeof row.changeType === "string" ? row.changeType.toLowerCase() : "";
    // SAFETY: the includes guard in the literal below narrows change to the
    // union's members; path/additions/deletions are probed above.
    files.push({
      path: row.path,
      additions: nonNegative(row.additions),
      deletions: nonNegative(row.deletions),
      change: (["added", "modified", "removed", "renamed", "copied"].includes(change)
        ? change
        : "changed") as GitHubPrFile["change"],
    });
  }

  const rollup = arrayOf(rec.statusCheckRollup);
  const milestone = jsonRecord(rec.milestone);
  const headOwner = actor(rec.headRepositoryOwner);

  const detail: GitHubPullRequestDetail = {
    number: Number(rec.number),
    title: typeof rec.title === "string" ? rec.title : "",
    state,
    isDraft,
    url: typeof rec.url === "string" ? rec.url : "",
    body: typeof rec.body === "string" ? rec.body : "",
    author,
    branch: typeof rec.headRefName === "string" ? rec.headRefName : "",
    base: typeof rec.baseRefName === "string" ? rec.baseRefName : "",
    forkOwner: headOwner?.login ?? null,
    createdAt,
    relative: createdAt ? relativeTime(createdAt) : "",
    updatedAt: stringOrNull(rec.updatedAt),
    mergedAt,
    closedAt: stringOrNull(rec.closedAt),
    mergedBy,
    additions: nonNegative(rec.additions),
    deletions: nonNegative(rec.deletions),
    changedFiles: nonNegative(rec.changedFiles),
    mergeability: mergeabilityOf(rec.mergeable, rec.mergeStateStatus, isDraft),
    reviewDecision: normalizeReviewDecision(rec.reviewDecision),
    checks: rollupChecks(rollup),
    checkRuns: rollup.map(mapCheck).filter((c): c is GitHubCheck => c !== null),
    labels: arrayOf(rec.labels)
      .map(mapLabel)
      .filter((l): l is GitHubLabel => l !== null),
    assignees,
    reviews,
    comments,
    commits,
    files,
    milestone:
      milestone && typeof milestone.title === "string" && milestone.title
        ? milestone.title
        : null,
  };

  await fillAvatars([
    detail.author,
    detail.mergedBy,
    ...detail.assignees,
    ...detail.reviews.map((r) => r.author),
    ...detail.comments.map((c) => c.author),
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
    if (isRepoViewAbsence(error)) return [];
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
  let raw: unknown;
  try {
    const out = await gh(root, ["api", "repos/{owner}/{repo}/commits?per_page=100"]);
    const trimmed = out.trim();
    if (!trimmed) return null;
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;

  // One entry per address, first sighting wins — the newest commit's account is
  // the current one if an address ever changed hands.
  const byEmail = new Map<string, GitHubPerson>();
  const urls = new Map<string, string>();
  for (const entry of raw) {
    const rec = jsonRecord(entry);
    if (!rec) continue;
    const commit = jsonRecord(rec.commit);
    const committed = jsonRecord(commit?.author);
    const email = typeof committed?.email === "string" ? committed.email.toLowerCase() : "";
    const account = jsonRecord(rec.author);
    const login = typeof account?.login === "string" ? account.login : "";
    if (!email || !login || byEmail.has(email)) continue;
    byEmail.set(email, { login, name: stringOrNull(committed?.name), avatarDataUrl: null });
    if (typeof account?.avatar_url === "string" && account.avatar_url) {
      urls.set(login, account.avatar_url);
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
  const out: GitCommitAuthors = {};
  for (const [email, person] of byEmail) {
    out[email] = { ...person, avatarDataUrl: faces.get(person.login) ?? null };
  }
  return out;
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

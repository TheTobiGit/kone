import { execFile, type ChildProcess } from "node:child_process";

import { z } from "zod";

import { killTree } from "@kone/agent-core/spawn.js";
import { resolveLaunch, withLaunchOptions, type ResolvedLaunch } from "@kone/agent-core/windowsLaunch.js";
import { git, repoRoot } from "@kone/git-core/core.js";
import type {
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
} from "@kone/git-core/types.js";

const MAX_SUMMARY_CHARS = 6_000;
const MAX_PATCH_CHARS = 40_000;
const CLI_TIMEOUT_MS = 25_000;
const CLI_MAX_BUFFER = 2 * 1024 * 1024;

function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return trimmed;

  const start = trimmed.indexOf("{");
  if (start < 0) return trimmed;

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = start; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth++;
      continue;
    }

    if (char === "}") {
      depth--;
      if (depth === 0) {
        return trimmed.slice(start, i + 1);
      }
    }
  }

  return trimmed.slice(start);
}

export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

export function sanitizeBranchFragment(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/^[/-]+|[/-]+$/g, "")
    .slice(0, 50);
}

function summarizePath(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed.length === 0) return "project files";
  const segments = trimmed.split("/").filter((s) => s.length > 0);
  return segments.at(-1) ?? trimmed;
}

export function deriveFallbackCommitSubject(stagedSummary: string): string {
  const lines = stagedSummary
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return "Update project files";
  }

  const firstEntry = lines[0]?.split("\t") ?? lines[0]?.split(/\s+/) ?? [];
  const rawStatus = firstEntry[0]?.trim().toUpperCase() ?? "";
  const firstPath = firstEntry.at(-1)?.trim() ?? "";
  const fileLabel = summarizePath(firstPath);

  if (lines.length === 1) {
    if (rawStatus.startsWith("A")) return `Add ${fileLabel}`;
    if (rawStatus.startsWith("D")) return `Remove ${fileLabel}`;
    if (rawStatus.startsWith("R")) return `Rename ${fileLabel}`;
    return `Update ${fileLabel}`;
  }

  const uniqueTopLevelDirs = Array.from(
    new Set(
      lines
        .map((line) => {
          const entry = line.split("\t");
          const filePath = entry.at(-1)?.trim() ?? "";
          return filePath.split("/")[0]?.trim() ?? "";
        })
        .filter((segment) => segment.length > 0 && segment !== "."),
    ),
  );

  if (uniqueTopLevelDirs.length === 1 && uniqueTopLevelDirs[0]) {
    return `Update ${uniqueTopLevelDirs[0]} files`;
  }

  return "Update project files";
}

export function createFallbackCommitSuggestion(
  stagedSummary: string,
  includeBranch?: boolean,
): CommitMessageGenerationResult {
  const subject = deriveFallbackCommitSubject(stagedSummary);
  const result: CommitMessageGenerationResult = {
    subject,
    body: "",
  };
  if (includeBranch) {
    result.branch = sanitizeBranchFragment(subject);
  }
  return result;
}

export function buildCommitPrompt(input: {
  branch?: string | null;
  stagedSummary: string;
  stagedPatch: string;
  includeBranch?: boolean;
}): string {
  return [
    "You write concise, high quality git commit messages following conventional commits or standard imperative style.",
    input.includeBranch
      ? 'Return a JSON object with exact keys: "subject", "body", "branch".'
      : 'Return a JSON object with exact keys: "subject", "body".',
    "Respond with only the valid JSON object, no Markdown code fences, no conversational prose.",
    "Rules:",
    '- "subject" must be imperative, <= 72 chars, and no trailing period (e.g. "feat(auth): add OAuth login flow" or "Add OAuth login flow")',
    '- "body" can be an empty string or short bullet points describing key changes',
    ...(input.includeBranch
      ? ['- "branch" must be a short semantic git branch slug (e.g. "feat/oauth-login")']
      : []),
    "- capture the primary user-visible or developer-visible changes accurately",
    "",
    `Branch: ${input.branch ?? "(main)"}`,
    "",
    "Staged files:",
    limitSection(input.stagedSummary, MAX_SUMMARY_CHARS),
    "",
    "Staged patch:",
    limitSection(input.stagedPatch, MAX_PATCH_CHARS),
  ].join("\n");
}

const CommitOutputWire = z.object({
  subject: z.string(),
  body: z.string().optional().default(""),
  branch: z.string().optional(),
});

/** The options one CLI candidate is started with. `timeout` is absent for a
 *  Windows batch launch: execFile's timeout would kill only the cmd.exe
 *  wrapper, so that tree is torn down by hand instead (runCliCandidate). */
export type CommitCliExecOptions = {
  cwd: string;
  timeout?: number;
  maxBuffer: number;
  windowsVerbatimArguments?: boolean;
};

/** A CLI candidate in flight: the child — its pid is the only handle to the
 *  tree behind a cmd.exe wrapper — and its buffered stdout. */
export type CommitCliProcess = {
  child: ChildProcess;
  done: Promise<{ stdout: string }>;
};

/** The `execFile` textGen starts a CLI with, promisified but keeping the child
 *  (`promisify(execFile)` resolves stdout/stderr only, and the Windows timeout
 *  needs the pid). */
export type CommitCliExecFile = (
  file: string,
  args: readonly string[],
  options: CommitCliExecOptions,
) => CommitCliProcess;

/** What a CLI call needs from the host: the platform a launch is resolved for,
 *  the environment its PATH is read from, and the execFile that starts it. All
 *  injectable so the Windows rules can be exercised off Windows; production
 *  leaves them out. */
export type CommitCliDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execFile?: CommitCliExecFile;
};

/** `execFile` with its child kept: the promise settles on the callback, while
 *  the child is returned to the caller immediately so a timer can reach it. */
const execFileWithChild: CommitCliExecFile = (file, args, options) => {
  let settle!: (value: { stdout: string }) => void;
  let fail!: (reason: Error) => void;
  const done = new Promise<{ stdout: string }>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const child = execFile(file, args, options, (error, stdout) => {
    if (error) fail(error);
    else settle({ stdout });
  });
  return { child, done };
};

/** Start one resolved candidate. Off Windows (and for a native Windows `.exe`)
 *  this is exactly the execFile call textGen has always made. A Windows batch
 *  shim runs through cmd.exe, so execFile's own `timeout` is left off — it would
 *  kill only the wrapper and orphan the CLI the shim started — and the wrapper's
 *  whole tree is torn down instead. The candidate is abandoned once that
 *  teardown returns, so a child that never reports its exit cannot wedge the
 *  call. */
async function runCliCandidate(
  exec: CommitCliExecFile,
  launch: ResolvedLaunch,
  cwd: string,
): Promise<{ stdout: string }> {
  if (!launch.windowsVerbatimArguments) {
    return exec(launch.file, launch.args, {
      cwd,
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: CLI_MAX_BUFFER,
    }).done;
  }
  const run = exec(
    launch.file,
    launch.args,
    withLaunchOptions({ cwd, maxBuffer: CLI_MAX_BUFFER }, launch),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void killTree(run.child.pid).finally(() => reject(new Error("commit CLI timed out")));
    }, CLI_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run.done, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Ask each installed CLI in turn for a commit message. Returns null when none
 *  answers, so the caller can fall back to the deterministic suggestion.
 *
 *  Each candidate is resolved for the platform first: on Windows an npm install
 *  is a `.cmd` shim that plain execFile cannot start, so it is launched through
 *  cmd.exe. A candidate that cannot be resolved is skipped exactly like one that
 *  fails to start. `deps` is the test seam described by CommitCliDeps. */
export async function tryGenerateWithCli(
  prompt: string,
  cwd: string,
  deps: CommitCliDeps = {},
): Promise<CommitMessageGenerationResult | null> {
  const commands = [
    {
      bin: "codex",
      args: [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "--config",
        'approval_policy="never"',
        prompt,
      ],
    },
    {
      bin: "claude",
      args: ["-p", prompt, "--dangerously-skip-permissions"],
    },
    {
      bin: "opencode",
      args: ["run", "--prompt", prompt],
    },
  ];

  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exec = deps.execFile ?? execFileWithChild;

  for (const cmd of commands) {
    const launch = resolveLaunch(cmd.bin, cmd.args, { env, platform, cwd });
    if (!launch.ok) {
      // Not installed, or an npm shim Windows cannot start: the same "try the
      // next candidate" a spawn failure gets.
      continue;
    }

    let stdout: string;
    try {
      stdout = (await runCliCandidate(exec, launch, cwd)).stdout;
    } catch {
      // CLI candidate failed or is not installed; try next
      continue;
    }

    const jsonStr = extractJsonObject(stdout);
    if (!jsonStr) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(jsonStr);
    } catch {
      // CLI returned malformed JSON; try next
      continue;
    }

    const decoded = CommitOutputWire.safeParse(raw);
    if (!decoded.success || !decoded.data.subject.trim()) continue;

    const result: CommitMessageGenerationResult = {
      subject: sanitizeCommitSubject(decoded.data.subject),
      body: decoded.data.body.trim(),
    };
    if (decoded.data.branch && decoded.data.branch.trim()) {
      result.branch = sanitizeBranchFragment(decoded.data.branch);
    }
    return result;
  }

  return null;
}

/** Generate a concise, structured commit message from staged git changes. */
export async function generateCommitMessage(
  dir: string,
  opts?: Partial<CommitMessageGenerationInput>,
): Promise<CommitMessageGenerationResult> {
  const root = await repoRoot(dir);
  if (!root) {
    return { subject: "Update project files", body: "" };
  }

  let stagedSummary = opts?.stagedSummary ?? "";
  let stagedPatch = opts?.stagedPatch ?? "";
  const branch = opts?.branch ?? null;
  const includeBranch = opts?.includeBranch ?? false;

  if (!stagedSummary) {
    try {
      stagedSummary = await git(root, ["diff", "--cached", "--name-status"]);
    } catch {
      stagedSummary = "";
    }
  }

  // If nothing is staged, inspect working tree changes so the user can generate before staging
  if (!stagedSummary.trim()) {
    try {
      stagedSummary = await git(root, ["diff", "--name-status"]);
    } catch {
      stagedSummary = "";
    }
  }

  if (!stagedPatch) {
    try {
      stagedPatch = await git(root, ["diff", "--cached"]);
      if (!stagedPatch.trim()) {
        stagedPatch = await git(root, ["diff"]);
      }
    } catch {
      stagedPatch = "";
    }
  }

  // If there are literally no changes on disk, return default
  if (!stagedSummary.trim() && !stagedPatch.trim()) {
    return { subject: "Update project files", body: "" };
  }

  const prompt = buildCommitPrompt({
    branch,
    stagedSummary,
    stagedPatch,
    includeBranch,
  });

  const generated = await tryGenerateWithCli(prompt, root);
  if (generated) {
    return generated;
  }

  return createFallbackCommitSuggestion(stagedSummary, includeBranch);
}

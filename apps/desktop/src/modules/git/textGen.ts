import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

import { git, repoRoot } from "./core.js";
import type {
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

const MAX_SUMMARY_CHARS = 6_000;
const MAX_PATCH_CHARS = 40_000;
const CLI_TIMEOUT_MS = 25_000;

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

async function tryGenerateWithCli(
  prompt: string,
  cwd: string,
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

  for (const cmd of commands) {
    let stdout: string;
    try {
      const res = await execFileAsync(cmd.bin, cmd.args, {
        cwd,
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
      });
      stdout = res.stdout;
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

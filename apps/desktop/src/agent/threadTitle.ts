import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildClaudeEnv } from "./claudeHome.js";
import { buildCursorEnv } from "./cursorHome.js";
import { buildDroidEnv, DROID_BINARY } from "./droidHome.js";
import { ANTGRAVITY_BINARY } from "./antigravityHome.js";
import { buildOpenCodeEnv } from "./opencodeHome.js";
import { buildAgentEnv } from "./processEnv.js";
import type { ProviderKind } from "./types.js";

// Thread/conversation naming. Flow:
//   1. First send → deterministic word-cap fallback (instant sidebar label).
//   2. Background one-shot CLI JSON call (Codex or Claude, matching the
//      thread's provider) → compact generated title.
//   3. Replace only while the title is still the generic placeholder or the
//      fallback seed (so a manual rename is never clobbered).
//
// Persistence and IPC live elsewhere; this module is the pure helpers + the
// provider-routed generation. Best-effort: generation failures leave the
// fallback in place.

export const GENERIC_THREAD_TITLE = "New thread";
export const MAX_THREAD_TITLE_WORDS = 6;
const MAX_THREAD_TITLE_LENGTH = 60;

/** Small/fast models for the side-channel rename — same defaults the
 */
const CODEX_TITLE_MODEL = "gpt-5.4-mini";
const CLAUDE_TITLE_MODEL = "claude-haiku-4-5";
const OPENCODE_TITLE_MODEL = "opencode-go/deepseek-v4-flash";
const CURSOR_TITLE_MODEL = "composer-2.5-fast";
const TITLE_GENERATION_TIMEOUT_MS = 45_000;

const TITLE_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
} as const;

function normalizeTitleWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimTitleToken(token: string): string {
  return token.replace(/^[\s"'`([{]+|[\s"'`)\]}:;,.!?]+$/g, "");
}

function titleWords(value: string): string[] {
  return normalizeTitleWhitespace(value)
    .split(" ")
    .map(trimTitleToken)
    .filter((token) => token.length > 0);
}

export function truncateThreadTitle(
  text: string,
  maxLength = MAX_THREAD_TITLE_LENGTH,
): string {
  const trimmed = normalizeTitleWhitespace(text);
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}

/** Short deterministic title while the model-generated rename is pending. */
export function buildPromptThreadTitleFallback(message: string): string {
  const words = titleWords(message).slice(0, MAX_THREAD_TITLE_WORDS);
  if (words.length === 0) return GENERIC_THREAD_TITLE;
  return truncateThreadTitle(words.join(" "));
}

/** Compact a model-produced title so the sidebar never renders a sentence. */
export function sanitizeGeneratedThreadTitle(raw: string): string {
  const unquoted = normalizeTitleWhitespace(raw).replace(/^['"`]+|['"`]+$/g, "");
  const words = titleWords(unquoted).slice(0, MAX_THREAD_TITLE_WORDS);
  if (words.length === 0) return GENERIC_THREAD_TITLE;
  return truncateThreadTitle(words.join(" "));
}

export function isGenericThreadTitle(title: string | null | undefined): boolean {
  return normalizeTitleWhitespace(title ?? "") === GENERIC_THREAD_TITLE;
}

/** True when the current title is still auto-owned (generic or the first-turn
 *  fallback seed). */
export function canReplaceThreadTitle(
  currentTitle: string | null | undefined,
  titleSeed?: string,
): boolean {
  const trimmed = normalizeTitleWhitespace(currentTitle ?? "");
  if (trimmed.length === 0 || isGenericThreadTitle(trimmed)) return true;
  const seed = titleSeed?.trim();
  return seed !== undefined && seed.length > 0 ? trimmed === seed : false;
}

function buildThreadTitlePrompt(message: string): string {
  return [
    "You generate concise chat thread titles.",
    "Return a JSON object with key: title.",
    "Respond with only the JSON object, no prose and no code fences.",
    "Rules:",
    `- Summarize the user's request in 3-${MAX_THREAD_TITLE_WORDS} words.`,
    `- Never exceed ${MAX_THREAD_TITLE_WORDS} words.`,
    "- Be specific: include distinguishing identifiers from the message when present (PR/issue numbers, branch names, file or feature names, error codes).",
    "- Two different requests should never produce the same title if the message contains anything that tells them apart.",
    "- Use a short noun or verb phrase, not a full sentence.",
    "- Avoid quotes, markdown, emoji, and trailing punctuation.",
    "",
    "User message:",
    message.slice(0, 8_000),
  ].join("\n");
}

function extractTitle(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { title?: unknown; structured_output?: unknown; part?: { type?: unknown; text?: unknown } };
    if (parsed.part?.type === "text" && typeof parsed.part.text === "string") {
      return extractTitle(parsed.part.text);
    }
    // Claude `-p --output-format json` wraps the schema result in
    // `{ structured_output: … }`.
    const payload =
      parsed.structured_output !== undefined ? parsed.structured_output : parsed;
    if (payload && typeof payload === "object" && typeof (payload as { title?: unknown }).title === "string") {
      return (payload as { title: string }).title;
    }
    if (typeof parsed.title === "string") return parsed.title;
  } catch {
    // Bare text when schema decode is soft — treat the whole payload as the
    // title candidate.
    return text;
  }
  return null;
}

/** Ask the thread's own provider for a short title. Returns null on any
 *  failure so the caller can keep the fallback. Uses the user's own CLI
 *  login — kone never injects credentials. */
export async function generateThreadTitle(input: {
  cwd: string;
  message: string;
  provider: ProviderKind;
}): Promise<string | null> {
  const prompt = buildThreadTitlePrompt(input.message);
  try {
    const raw =
      input.provider === "claudeAgent"
        ? await generateWithClaude({ cwd: input.cwd, prompt })
        : input.provider === "opencode"
          ? await generateWithOpenCode({ cwd: input.cwd, prompt })
          : input.provider === "cursor"
            ? await generateWithCursor({ cwd: input.cwd, prompt })
            : input.provider === "droid"
              ? await generateWithDroid({ cwd: input.cwd, prompt })
              : input.provider === "antigravity"
                ? await generateWithAntigravity({ cwd: input.cwd, prompt })
                : await generateWithCodex({ cwd: input.cwd, prompt });
    if (!raw) return null;
    const title = extractTitle(raw);
    if (!title?.trim()) return null;
    return sanitizeGeneratedThreadTitle(title);
  } catch (err) {
    console.error(`[thread-title] ${input.provider} generation failed:`, err);
    return null;
  }
}

async function generateWithCodex(input: {
  cwd: string;
  prompt: string;
}): Promise<string | null> {
  const tmp = os.tmpdir();
  const id = randomUUID();
  const schemaPath = path.join(tmp, `kone-title-schema-${id}.json`);
  const outputPath = path.join(tmp, `kone-title-out-${id}.json`);

  try {
    await fs.writeFile(schemaPath, JSON.stringify(TITLE_SCHEMA), "utf8");
    await fs.writeFile(outputPath, "", "utf8");

    const env = await buildAgentEnv();
    const stdout = await runCli({
      command: "codex",
      args: [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "--model",
        CODEX_TITLE_MODEL,
        "--config",
        'model_reasoning_effort="low"',
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "-",
      ],
      cwd: input.cwd,
      env,
      stdin: input.prompt,
      timeoutMs: TITLE_GENERATION_TIMEOUT_MS,
    });
    if (stdout === null) return null;
    const fromFile = (await fs.readFile(outputPath, "utf8")).trim();
    return fromFile || stdout;
  } finally {
    void fs.unlink(schemaPath).catch(() => {});
    void fs.unlink(outputPath).catch(() => {});
  }
}

/** One-shot `claude -p` with structured JSON for titles (not the interactive
 *  Agent SDK). */
async function generateWithClaude(input: {
  cwd: string;
  prompt: string;
}): Promise<string | null> {
  const env = await buildClaudeEnv();
  return runCli({
    command: "claude",
    args: [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(TITLE_SCHEMA),
      "--model",
      CLAUDE_TITLE_MODEL,
      "--effort",
      "low",
      "--dangerously-skip-permissions",
    ],
    cwd: input.cwd,
    env,
    stdin: input.prompt,
    timeoutMs: TITLE_GENERATION_TIMEOUT_MS,
  });
}

async function generateWithOpenCode(input: { cwd: string; prompt: string }): Promise<string | null> {
  const env = await buildOpenCodeEnv();
  return runCli({
    command: "opencode",
    args: ["run", "--format", "json", "-m", OPENCODE_TITLE_MODEL, "--dir", input.cwd, input.prompt],
    cwd: input.cwd,
    env,
    stdin: "",
    timeoutMs: TITLE_GENERATION_TIMEOUT_MS,
  }).then((raw) => {
    if (!raw) return null;
    return raw.split(/\r?\n/).map(extractTitle).find((value): value is string => Boolean(value)) ?? raw;
  });
}

/** One-shot `cursor-agent --print` with plain text. Titles run through Cursor's
 *  cheap in-house model on the print CLI — the interactive ACP protocol is the
 *  turn transport, not a one-shot text surface. */
async function generateWithCursor(input: { cwd: string; prompt: string }): Promise<string | null> {
  const env = await buildCursorEnv();
  return runCli({
    command: "cursor-agent",
    args: ["--print", "--output-format", "text", "--model", CURSOR_TITLE_MODEL, input.prompt],
    cwd: input.cwd,
    env,
    stdin: "",
    timeoutMs: TITLE_GENERATION_TIMEOUT_MS,
  });
}

/** One-shot `droid exec` at its default (read-only) autonomy.
 *
 *  Deliberately passes no `-m`, unlike every sibling above. Droid's model ids
 *  are both per-user — `custom:*` entries come from the user's own
 *  ~/.factory/settings.json — and gated by org policy: asking for a built-in id
 *  on a managed account answers "Model blocked by organization policy", and on
 *  the account this was written against even the *advertised default* was
 *  refused while the user's own custom models worked. There is therefore no id
 *  kone can name that is safe for everyone, and the user's configured default is
 *  the only one guaranteed to be valid for them. A failure here is cheap: the
 *  caller keeps the deterministic word-cap fallback title. */
async function generateWithDroid(input: { cwd: string; prompt: string }): Promise<string | null> {
  const env = await buildDroidEnv();
  return runCli({
    command: DROID_BINARY,
    args: ["exec", "--output-format", "text", "--cwd", input.cwd, input.prompt],
    cwd: input.cwd,
    env,
    stdin: "",
    timeoutMs: TITLE_GENERATION_TIMEOUT_MS,
  });
}

/** One-shot `agy -p` print call at the CLI's default model. The prompt rides
 *  `-p` as a direct spawn arg (no shell quoting involved); the print call runs
 *  with permissions skipped so the one-shot can't block on a terminal, and the
 *  capture plugin's hooks stay inactive (no KONE_ANTIGRAVITY_EVENTS) so the
 *  call behaves exactly like any other terminal `agy -p`. */
async function generateWithAntigravity(input: {
  cwd: string;
  prompt: string;
}): Promise<string | null> {
  const env = await buildAgentEnv();
  return runCli({
    command: ANTGRAVITY_BINARY,
    args: [
      "-p",
      "--dangerously-skip-permissions",
      "--new-project",
      "--print-timeout",
      "5m",
      input.prompt,
    ],
    cwd: input.cwd,
    env,
    stdin: "",
    timeoutMs: TITLE_GENERATION_TIMEOUT_MS,
  });
}

/** Spawn a CLI with the prompt on stdin. Returns stdout on success, null on
 *  spawn failure / non-zero exit / timeout. */
function runCli(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(null);
    }, input.timeoutMs);

    child.stdout.on("data", (buf: Buffer) => {
      stdout += buf.toString();
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      finish(code === 0 ? stdout : null);
    });

    try {
      child.stdin.write(input.stdin);
      child.stdin.end();
    } catch {
      finish(null);
    }
  });
}

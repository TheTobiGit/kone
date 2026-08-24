import { buildAgentEnv } from "./processEnv.js";

// Cursor install/auth detection. Same "bring your own subscription" stance as
// codexHome/opencodeHome: kone never runs `cursor-agent login` and never writes
// a credential — Cursor keeps its login in the OS keychain, which we only ever
// read *through* the CLI's own `status` command.

export const CURSOR_BINARY = "cursor-agent";

/** The `cursor` editor launcher is NOT the agent CLI, but users reach for it
 *  when asked for a binary path; and older installs shipped the agent as a bare
 *  `agent`, a name Grok's CLI also claims. Map both onto the unambiguous one. */
const AMBIGUOUS_CURSOR_BINARIES = new Set(["cursor", "agent"]);

/** Resolve the executable to spawn from the user's configured override. A blank
 *  path — or one of the ambiguous names above — falls back to `cursor-agent`. */
export function resolveCursorBinary(binaryPath: string | null | undefined): string {
  const configured = binaryPath?.trim();
  if (!configured) return CURSOR_BINARY;
  return AMBIGUOUS_CURSOR_BINARIES.has(configured) ? CURSOR_BINARY : configured;
}

/** `cursor-agent` opens a browser tab to finish a login it thinks is missing.
 *  A GUI app spawning a browser mid-turn is never what the user asked for, so
 *  every child we start is told there is no browser to open. */
const CURSOR_BROWSERLESS_ENV = {
  NO_BROWSER: "true",
  BROWSER: "www-browser",
} as const;

/** Env for a long-lived ACP session child. Deliberately *not* `CI=true`: that
 *  flips the CLI into a non-interactive posture that suppresses parts of a real
 *  user turn. Probes get the stricter env below instead. */
export async function buildCursorEnv(): Promise<NodeJS.ProcessEnv> {
  const env = await buildAgentEnv();
  return { ...env, ...CURSOR_BROWSERLESS_ENV };
}

/** Env for short, bounded probes (`--version`, `status`, `models`) — headless
 *  and non-interactive so nothing can block waiting on a human. */
export async function buildCursorProbeEnv(): Promise<NodeJS.ProcessEnv> {
  const env = await buildCursorEnv();
  return { ...env, CI: "true", DEBIAN_FRONTEND: "noninteractive" };
}

/** `cursor-agent --version` prints a calendar version like `2026.07.23-e383d2b`
 *  — not semver, so there's no ordering to gate on, only presence. */
export function parseCursorVersion(stdout: string): string | undefined {
  const calendar = stdout.match(/\b(\d{4}\.\d{2}\.\d{2}[\w.-]*)\b/)?.[1];
  return calendar ?? (stdout.trim().split("\n")[0]?.trim() || undefined);
}

/** The parsed `cursor-agent status` result: whether the CLI is authenticated
 *  and, when it is, the account email it printed. */
export type CursorAuthState = {
  authenticated: boolean;
  label?: string;
};

/** Read `cursor-agent status` output. It prints `✓ Logged in as <email>` when
 *  authenticated and an error/hint line when not. */
export function parseCursorAuth(stdout: string): CursorAuthState {
  const text = stdout.trim();
  const lower = text.toLowerCase();
  if (lower.includes("not logged in") || lower.includes("authentication required") || lower.includes("cursor-agent login")) {
    return { authenticated: false };
  }
  const email = text.match(/logged in as\s+(\S+)/i)?.[1];
  if (email) return { authenticated: true, label: email };
  return { authenticated: lower.includes("logged in") || lower.includes("authenticated") };
}

/** Parse the flat `cursor-agent models` list — `<id> - <label>` lines under an
 *  "Available models" heading. This is the *fallback* catalog: it expands each
 *  model's parameter axes into separate rows (`…-high`, `…-fast`) and pins a
 *  single context window, losing the structure the ACP catalog exposes as real
 *  per-model controls. Used only when the ACP query is unavailable. */
export function parseCursorCliModels(stdout: string): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^([\w.:/-]+)\s+-\s+(.+)$/);
    if (!match?.[1] || !match[2]) continue;
    const label = match[2].replace(/\s*\((?:default|current)\)\s*$/i, "").trim();
    out.push({ id: match[1], label: label || match[1] });
  }
  return out;
}

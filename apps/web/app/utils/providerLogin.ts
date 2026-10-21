// The renderer's one login table: what "Sign in" means for each provider CLI.
//
// The main process resolves the command it will actually run — including a
// custom `binaryPath` — and hands the renderer only its display string (see
// `providerSignIn.command`). This table is the renderer's copy of what each CLI
// documents for its default executable: the string to show for the first frame,
// before the bridge answers, and the honest answer to "does this provider have
// a login command at all?" — which is what gates every entry point into the
// modal.
//
// It mirrors packages/agent-core/src/providerSignIn.ts LOGIN_COMMANDS. The
// renderer can't import that module (it is Node-only, main-process), so the two
// tables are kept in step by hand: same providers, same subcommands, same
// finish. Change one, change the other.

import type { ProviderKind } from "~/types/desktop";

/** The login command each provider's CLI documents, by its default executable —
 *  mirrors packages/agent-core/src/providerSignIn.ts LOGIN_COMMANDS (the
 *  renderer can't import agent-core). Null: no login subcommand (Droid pairs a
 *  device on first run). */
export const PROVIDER_LOGIN = {
  codex: { display: "codex login", finish: "browser" },
  claudeAgent: { display: "claude auth login", finish: "browser" },
  cursor: { display: "cursor-agent login", finish: "browser" },
  opencode: { display: "opencode auth login", finish: "terminal" },
  antigravity: { display: "agy login", finish: "browser" },
  cline: { display: "cline auth", finish: "browser" },
  droid: null,
} as const satisfies Record<
  ProviderKind,
  { display: string; finish: "browser" | "terminal" } | null
>;

/** Whether kone can sign this provider in for the user: its CLI documents a
 *  login subcommand. False for Droid, which pairs a device on first run — every
 *  sign-in entry point is gated on this rather than on a per-surface guess. */
export function canSignIn(provider: ProviderKind): boolean {
  return PROVIDER_LOGIN[provider] !== null;
}

// Policy the model picker and the boot restore have to agree on.
//
// Both the picker (committing a pick to the live session) and the project's
// mount (restoring what was picked last time) read these, and they must read the
// same ones: a storage key spelled differently in the two places is a setting
// that silently stops surviving a relaunch.

import type { InteractionMode, ProviderKind } from "~/types/desktop";
import type { BrandKey } from "~/utils/modelCatalog";

/** The provider + model + reasoning effort are remembered GLOBALLY — one
 *  app-wide "last used" choice that every project opens with, not per-project. */
export const PROVIDER_KEY = "kone:provider";
export const MODEL_KEY = "kone:model";
export const REASONING_KEY = "kone:reasoning";

/** The user's *chosen* default — set only in the Studio settings pane, and never
 *  written by a live session (unlike the "last used" keys above, which every
 *  thread rewrites as it runs). When present these win the boot pick, so a
 *  configured default can't be clobbered by whatever thread ran last. */
export const DEFAULT_PROVIDER_KEY = "kone:default-provider";
export const DEFAULT_MODEL_KEY = "kone:default-model";
export const DEFAULT_REASONING_KEY = "kone:default-reasoning";

/** The permission mode stays PER PROJECT — it's a per-repo trust decision, not
 *  an app-wide preference. */
export function modeKey(projectPath: string): string {
  return `kone:mode:${projectPath}`;
}

/** The app-wide fallback permission mode: what a project opens with the first
 *  time, before it has a per-project mode of its own. Set in the Studio settings
 *  pane; read at boot only when `modeKey(path)` holds nothing yet. */
export const DEFAULT_MODE_KEY = "kone:default-mode";

/** A model change on a provider that bakes model/effort at spawn (Claude,
 *  OpenCode, Antigravity — the effort rides the print `--model` label) can't
 *  apply to a running session; it needs a fresh one. Codex takes model/effort
 *  per turn, so it changes in place. Mirrors each adapter's
 *  `sessionModelSwitch`. */
export const RESTART_ON_MODEL_CHANGE = new Set<ProviderKind>([
  "claudeAgent",
  "opencode",
  "antigravity",
]);

export const PROVIDER_VENDOR = {
  codex: "OpenAI",
  claudeAgent: "Anthropic",
  cursor: "Cursor",
  opencode: "OpenCode",
  droid: "Factory",
  antigravity: "Google",
} satisfies Record<ProviderKind, string>;

/**
 * Which provider a brand-new session opens on.
 *
 * The configured default wins, then whatever ran last, then Codex — and an
 * unrecognised stored value falls through to the same floor, so a key left
 * behind by a provider that no longer exists cannot strand a session on a
 * provider nothing can start. Read at the moment a session is constructed
 * rather than kept in a ref: it is a boot pick, and re-reading it later would
 * quietly re-decide a choice the thread has already made.
 */
export function bootProvider(): ProviderKind {
  if (!import.meta.client) return "codex";
  const stored = localStorage.getItem(DEFAULT_PROVIDER_KEY) ?? localStorage.getItem(PROVIDER_KEY);
  return stored !== null && stored in PROVIDER_VENDOR ? toProviderKind(stored) : "codex";
}

/** Every permission mode there is, so a stored string can be checked against
 *  the set rather than trusted. */
const MODES = ["ask", "accept-edits", "full-access"] as const;

/**
 * The mode a thread in this project should open on, or null when nothing has
 * been decided anywhere and the session's own floor should stand.
 *
 * The project's own mode wins, then the app-wide default — the same order the
 * per-project key implies, since a project that has been given a mode has said
 * something more specific than the default ever did. Read once when a thread is
 * being made, never afterwards: a running thread's mode is the one it is
 * running under, and re-reading storage would change it out from under a turn.
 */
export function bootMode(projectPath: string): InteractionMode | null {
  if (!import.meta.client) return null;
  const stored =
    localStorage.getItem(modeKey(projectPath)) ?? localStorage.getItem(DEFAULT_MODE_KEY);
  if (stored === null || !MODES.some((m) => m === stored)) return null;
  // SAFETY: the check above passes only for an exact member of MODES, which is
  // exactly InteractionMode.
  return stored as InteractionMode;
}

/** The `in PROVIDER_VENDOR` check above is the parse; this only carries the
 *  result across, and every caller is that check. */
function toProviderKind(checked: string): ProviderKind {
  // SAFETY: reached only when `checked in PROVIDER_VENDOR`, and that object's
  // keys are exactly ProviderKind.
  return checked as ProviderKind;
}

export const PROVIDER_BRAND = {
  codex: "codex",
  claudeAgent: "claude",
  cursor: "cursor",
  opencode: "opencode",
  droid: "droid",
  antigravity: "antigravity",
} satisfies Record<ProviderKind, BrandKey>;

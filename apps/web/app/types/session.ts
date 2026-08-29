import type { ProviderKind } from "~/types/desktop";
import type { BrandKey } from "~/utils/modelCatalog";

// A single line in the Project Home "recent conversations" list (the PINNED /
// agent thread, flattened into the handful of fields the row renders.
//
// The main-process ConversationStore persists id / provider / model / title /
// timestamps plus optional branch / diffstat / tokens. Rows render the optional
// columns only when a value is present (the browser-dev mock carries the full
// set so the design is demoable).

/** Vendor logomark for a thread row / sticky chat title — OpenAI's blossom for
 *  Codex (not the Codex product C), Claude's mark for Claude. */
export const SESSION_BRAND = {
  codex: "gpt",
  claudeAgent: "claude",
  cursor: "cursor",
  opencode: "opencode",
  droid: "droid",
  antigravity: "antigravity",
} satisfies Record<ProviderKind, BrandKey>;

export type SessionSummary = {
  threadId: string;
  /** Agent-named (or first-turn word-fallback) working title. */
  title: string;
  provider: ProviderKind;
  /** Vendor logomark to show (OpenAI blossom / Anthropic Claude / …). */
  brand: BrandKey;
  /** The model the thread last ran on, if known — shown when there's no diff. */
  model?: string;
  /** The branch the session worked on, when a source can attribute one. */
  branch?: string | null;
  added?: number;
  removed?: number;
  /** Total tokens spent across the thread, when known. */
  tokens?: number;
  /** Estimated or recorded USD cost across the thread, when known. */
  costUsd?: number;
  /** Epoch ms of the last turn — drives the "2d ago" stamp and the sort. */
  updatedAt: number;
  /** Kept in front of the list under a PINNED header. */
  pinned?: boolean;
  /** You are finished with this thread's claim on you. Derived from the stored
   *  stamp and the thread's own activity, never read off the stamp alone — see
   *  isThreadDone. */
  done?: boolean;
  /** True when this thread is a side chat (forked from another conversation) —
   *  rows wear the temporary chip instead of reading as a main conversation. */
  sideChat?: boolean;
  /** The project this thread belongs to. Only set on the App Home aggregate
   *  list (which spans every project); the in-project block leaves it undefined
   *  since the project is implied. Drives the project chip on the row. */
  projectPath?: string;
  projectName?: string;
};

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
export const SESSION_BRAND: Record<ProviderKind, BrandKey> = {
  codex: "gpt",
  claudeAgent: "claude",
};

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
  /** Epoch ms of the last turn — drives the "2d ago" stamp and the sort. */
  updatedAt: number;
  /** Kept in front of the list under a PINNED header. */
  pinned?: boolean;
};

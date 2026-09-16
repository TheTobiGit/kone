// What an appearance tool call did to the window, kept so the turn that made it
// can say so.
//
// The tool runs in the main process and the change lands on the window, so the
// transcript is left with a sentence and no palette. A receipt is the missing
// half: the theme before, the theme after, and the colours of both as the window
// actually painted them.
//
// A receipt belongs to a TURN, and is placed by POSITION within it. The gateway
// knows the turn a call ran in but never the provider's tool-use id, so the nth
// appearance call of a turn takes the nth receipt of that turn. Position is the
// one thing that cannot drift: unlike claiming a receipt when a row mounts, it
// does not care that the live feed only mounts its last few rows, and unlike
// matching on kind it does not have to tell two calls of the same kind apart.
//
// In memory only, and deliberately: a receipt describes a moment this window was
// there for, and a transcript loaded after a restart was not. Every line falls
// back to `parseThemeSummary`, which reads both ends of the change back out of
// the sentence the tool stored against the call.

import { ref } from "vue";
import type { AppearanceMode, ThemeColors, ThemeScheme } from "~/theme/roles";
import { canonicalToolName } from "~/utils/toolName";

/** One side of a change: what the window looked like at that moment. */
export interface ThemeFacet {
  themeId: string;
  label: string;
  mode: AppearanceMode;
  /** The scheme actually painted — a fixed theme ignores the mode, so this is
   *  the only thing that says which face was on screen. */
  scheme: ThemeScheme;
  /** The role table as resolved for that scheme. */
  colors: ThemeColors;
}

/** Which appearance tool wrote this. `cancel` is a preview taken back down,
 *  which still owes its line a reading of what returned. */
export type ThemeReceiptKind = "set" | "preview" | "create" | "cancel";

export interface ThemeReceipt {
  id: string;
  threadId: string;
  /** The turn the call ran in; null for a write with no live turn, which can
   *  never be placed and reads from its summary instead. */
  turnId: string | null;
  kind: ThemeReceiptKind;
  before: ThemeFacet;
  after: ThemeFacet;
  /** Previews only: still the thing on screen. A cancelled preview is history,
   *  and its line stops calling itself the current state. */
  previewLive: boolean;
}

/** Enough receipts to cover a long session's worth of fiddling; past that the
 *  oldest are dropped and their turns read from their summaries. Nothing else
 *  holds a reference to a receipt, so eviction leaks nothing. */
const LIMIT = 100;

const receipts = ref<ThemeReceipt[]>([]);

let seq = 0;

export interface ThemeReceiptDraft {
  threadId: string;
  turnId: string | null;
  kind: ThemeReceiptKind;
  before: ThemeFacet;
  after: ThemeFacet;
}

export function recordThemeReceipt(draft: ThemeReceiptDraft): ThemeReceipt {
  seq += 1;
  const receipt: ThemeReceipt = {
    id: `tr-${seq}`,
    threadId: draft.threadId,
    turnId: draft.turnId,
    kind: draft.kind,
    before: draft.before,
    after: draft.after,
    previewLive: draft.kind === "preview",
  };
  const next = [...receipts.value, receipt];
  receipts.value = next.length > LIMIT ? next.slice(next.length - LIMIT) : next;
  return receipt;
}

/** The receipts one turn produced, oldest first. */
export function themeReceiptsForTurn(
  threadId: string | null | undefined,
  turnId: string | null | undefined,
): ThemeReceipt[] {
  if (!threadId || !turnId) return [];
  return receipts.value.filter((r) => r.threadId === threadId && r.turnId === turnId);
}

/** Every live preview in a thread is settled at once when the agent cancels one:
 *  a cancel restores the saved theme wholesale, so no earlier preview survives
 *  it either. */
export function settleThreadPreviews(threadId: string): void {
  receipts.value = receipts.value.map((r) =>
    r.threadId === threadId && r.previewLive ? { ...r, previewLive: false } : r,
  );
}

/**
 * The receipt kinds one appearance tool can produce, or null for a tool that
 * changes nothing on screen.
 *
 * The name is canonicalized here rather than at each call site: providers spell
 * kone's tools three different ways, and a vocabulary that answers only to one
 * of them is a vocabulary every new caller has to remember to wrap.
 */
export function themeToolKinds(name: string | undefined): readonly ThemeReceiptKind[] | null {
  const key = canonicalToolName(name);
  if (key === "app_set_theme") return ["set"];
  if (key === "app_create_custom_theme") return ["create"];
  // One call takes a preview down and another puts one up; the argument that
  // tells them apart never reaches the renderer, only the event each produces.
  if (key === "app_preview_theme_override") return ["preview", "cancel"];
  return null;
}

/** The shape `assignThemeReceipts` needs of a turn's parts — a subset of
 *  RuntimeItem, so the assignment can be tested without one. */
export interface AssignableItem {
  itemId: string;
  kind: string;
  status: string;
  name?: string | undefined;
}

/** True for a settled call that changed the appearance. A failed call changed
 *  nothing and a running one has not emitted its change yet, so neither takes a
 *  position in the sequence. */
export function isSettledThemeCall(item: AssignableItem): boolean {
  return item.kind === "tool_call" && item.status === "completed" && !!themeToolKinds(item.name);
}

/**
 * Which receipt belongs to which call, for one turn.
 *
 * Both sequences come off the same turn in the same order, so the nth call takes
 * the nth receipt of a kind it could have produced. A call whose receipt never
 * arrived — the store evicted it, or the window was not open — takes nothing and
 * leaves the receipts after it where they are, so one gap cannot shift the rest.
 */
export function assignThemeReceipts(
  items: readonly AssignableItem[],
  turnReceipts: readonly ThemeReceipt[],
): Map<string, ThemeReceipt> {
  const out = new Map<string, ThemeReceipt>();
  let next = 0;
  for (const item of items) {
    if (!isSettledThemeCall(item)) continue;
    const kinds = themeToolKinds(item.name);
    if (!kinds) continue;
    const receipt = turnReceipts[next];
    if (!receipt || !kinds.includes(receipt.kind)) continue;
    out.set(item.itemId, receipt);
    next += 1;
  }
  return out;
}

/** Drop every receipt — a test's reset, and nothing else's. */
export function resetThemeReceiptsForTests(): void {
  receipts.value = [];
  seq = 0;
}

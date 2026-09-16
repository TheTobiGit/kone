// The sentence an appearance tool leaves behind, written and read in one place.
//
// A theme change lands on the window, where the transcript cannot see it. What
// survives the call is its summary line — stored against the item, re-read by
// the agent resuming the thread and by the thread's own UI long after the event
// that carried the change has gone. That makes the line a contract between two
// packages: agent-core writes it, the renderer reads it back.
//
// Both halves live here so neither can be changed alone. A reworded summary on
// one side and a regex on the other is the shape this exists to prevent.

/** Theme ids are slugs (`CreateCustomThemeInputSchema`), which is what makes
 *  them safe to find in a sentence: labels are free text and may hold quotes,
 *  parentheses, anything. */
const ID = "[a-z0-9_-]+";

/** The replaced clause closes the sentence. It is found from the END of the
 *  line rather than by scanning forward, because a label is free to contain the
 *  very same words — and a forward scan would then read the label's copy as the
 *  real clause and cut the sentence in the wrong place. */
const REPLACED_LEAD = ', replacing "';
const REPLACED = new RegExp(`^,\\s+replacing\\s+"(.*)"\\s+\\((${ID})\\)\\.?$`);

/** With the replaced clause removed, the applied theme's id is the last one in
 *  `"label" (id)` form — greedy, so a label carrying its own quotes is spanned
 *  rather than cut short at the first of them. */
const APPLIED = new RegExp(`"(.*)"\\s+\\(\`?(${ID})\`?\\)`);

export interface ThemeRef {
  id: string;
  label: string;
}

export interface ThemeAppliedSummary {
  applied: ThemeRef;
  /** The appearance asked for, when the call named one. */
  mode?: string | null;
  /** The face the window ended up painting, when it is knowable. */
  scheme?: "light" | "dark" | null;
  /** What the change displaced, when it displaced anything. */
  replaced?: ThemeRef | null;
}

/** `Applied theme "Nocturne" (nocturne) in dark mode (dark scheme), replacing "Moss" (moss).` */
export function formatThemeApplied(summary: ThemeAppliedSummary): string {
  const mode = summary.mode ? ` in ${summary.mode} mode` : "";
  const scheme = summary.scheme ? ` (${summary.scheme} scheme)` : "";
  return `Applied theme "${summary.applied.label}" (${summary.applied.id})${mode}${scheme}${replacedClause(summary.replaced)}.`;
}

/** The same sentence for a bare appearance change, which names no theme. */
export function formatModeApplied(mode: string, scheme?: "light" | "dark" | null): string {
  return `Applied appearance mode in ${mode} mode${scheme ? ` (${scheme} scheme)` : ""}.`;
}

/** `Created and applied custom theme "Brand" (`brand-01`) with accent #f97316, replacing "Kone" (kone).` */
export function formatCustomThemeCreated(
  created: ThemeRef,
  accent: string,
  replaced?: ThemeRef | null,
): string {
  return `Created and applied custom theme "${created.label}" (\`${created.id}\`) with accent ${accent}${replacedClause(replaced)}.`;
}

function replacedClause(replaced: ThemeRef | null | undefined): string {
  return replaced ? `, replacing "${replaced.label}" (${replaced.id})` : "";
}

/** Both ends of a change, read back out of the sentence. */
export interface ThemeSummaryReading {
  /** Where the change landed. */
  to: string;
  /** What it displaced, or null when it displaced nothing. */
  from: string | null;
}

/**
 * The themes a summary line names, or null for a line that names none — a
 * failed call, a bare mode change, or a sentence this module did not write.
 *
 * The replaced clause is taken off the end first: only then is the applied
 * theme's id the last `"label" (id)` in what remains, which is what lets a
 * label hold quotes and parentheses without corrupting either end.
 */
export function parseThemeSummary(text: string | null | undefined): ThemeSummaryReading | null {
  if (!text) return null;
  const lead = text.lastIndexOf(REPLACED_LEAD);
  const replaced = lead === -1 ? null : REPLACED.exec(text.slice(lead));
  const head = replaced ? text.slice(0, lead) : text;
  const applied = APPLIED.exec(head);
  if (!applied?.[2]) return null;
  const to = applied[2];
  const from = replaced?.[2] ?? null;
  return { to, from: from === to ? null : from };
}

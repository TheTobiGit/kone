// The record an appearance tool leaves behind, written and read in one place.
//
// A theme change lands on the window, where the transcript cannot see it. What
// survives the call is its tool result — stored against the item, re-read by
// the agent resuming the thread and by the thread's own UI long after the
// event that carried the change has gone. That makes the result a contract
// between two packages: agent-core writes it, the renderer reads it back.
//
// Both halves live here so neither can be changed alone. The result text is a
// JSON record (both ends of the change as ids, plus the human sentence), which
// is what lets either side evolve without the other misreading free text.

import { z } from "zod";

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

/** Both ends of an appearance change, as stored against the tool call's item.
 *
 * `to` is always named when a record exists — a bare mode change or a
 * cancelled preview names no theme and stays a plain sentence, which this
 * never parses. `summary` is the sentence above, kept for the model reading
 * the result and the agent resuming the thread. `preview` marks a
 * non-destructive preview; `colors` carries its custom role overrides, the one
 * palette no library holds. */
const ThemeChangeDataSchema = z.object({
  /** Where the change landed. */
  to: z.string().min(1),
  /** What it displaced, or null when it displaced nothing. */
  from: z.string().min(1).nullable(),
  /** The human sentence for this change. */
  summary: z.string().min(1),
  /** True for a live (non-destructive) preview of the theme. */
  preview: z.boolean().optional(),
  /** Custom role overrides the preview was painted with, when any. */
  colors: z.record(z.string(), z.string()).optional(),
});

export type ThemeChangeData = z.infer<typeof ThemeChangeDataSchema>;

/** Encode a change as the tool result text the item stores. */
export function formatThemeChange(data: ThemeChangeData): string {
  return JSON.stringify(data);
}

/** The change a result text records, or null for anything that records none —
 * a failed call's error, a bare mode change, a cancel message, a sentence
 * written before results carried data, or an in-progress input dump. Reads
 * data only: the sentence inside is never interpreted. */
export function parseThemeChange(text: string | null | undefined): ThemeChangeData | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    // SAFETY: JSON.parse yields whatever the text held; the zod schema below
    // is the only gate before the value is trusted.
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const result = ThemeChangeDataSchema.safeParse(parsed);
  if (!result.success) return null;
  return result.data;
}

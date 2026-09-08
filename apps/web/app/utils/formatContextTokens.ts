// Compact human token counts for context surfaces (`48k`, `1.4k`, `2.0m`) —
// the meter popover, the thread-info panel and the timeline's compaction
// markers share this voice so one feature never spells the same number two
// ways. This is deliberately NOT the protocol `formatTokens` (uppercase
// `K`/`M` Intl magnitudes for spend surfaces): context fill reads as a
// lowercase range, spend reads as a precise count, and unifying them would
// change one surface's visible strings to match the other's.
export function formatContextTokens(value: number | null | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "0";
  if (value < 1_000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

// Display-only window percent on the 0–100 scale: one decimal under 10%
// (5.8% — a bare 6%, not 6.0% — so small fills stay legible),
// integer-rounded at/above. Deliberately NOT the protocol `formatPercent`,
// which takes a 0–1 share — same word, different contract, so it gets its
// own name rather than a second meaning.
export function formatWindowPercent(value: number): string {
  if (value < 10) return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(value)}%`;
}

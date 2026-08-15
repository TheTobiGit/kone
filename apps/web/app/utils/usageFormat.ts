
const CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INTEGER = new Intl.NumberFormat("en-US");

export function formatUsd(value: number): string {
  if (value <= 0) return "$0";
  if (value < 0.01) return "<$0.01";
  return CURRENCY.format(value);
}

export function formatCount(value: number): string {
  return INTEGER.format(Math.round(value));
}

/** Three significant figures with a unit suffix (`19.9B`, `804K`). */
export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  const magnitudes = [1e12, 1e9, 1e6, 1e3] as const;
  const suffix: Record<number, string> = { 1e12: "T", 1e9: "B", 1e6: "M", 1e3: "K" };
  for (const magnitude of magnitudes) {
    if (abs < magnitude) continue;
    // A value that trims to "1000" (e.g. 999.95K) belongs to the next magnitude
    // up — print 1M, not a four-digit "1000K" that reads as a counting error.
    if (trim(value / magnitude) === "1000") {
      const rolled = magnitude * 1000;
      if (suffix[rolled]) return `${trim(value / rolled)}${suffix[rolled]}`;
    }
    return `${trim(value / magnitude)}${suffix[magnitude]}`;
  }
  return INTEGER.format(Math.round(value));
}

function trim(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}

export function formatPercent(share: number, digits = 1): string {
  return `${(share * 100).toFixed(digits)}%`;
}

/** `2026-08-07` → `Aug 7`. */
export function formatDayShort(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

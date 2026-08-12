
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
  if (abs >= 1e12) return `${trim(value / 1e12)}T`;
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
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

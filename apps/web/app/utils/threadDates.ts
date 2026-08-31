/**
 * Deterministic local calendar day key (e.g. "2026-08-29") for comparing whether
 * two timestamps land on different calendar days.
 */
export function dayKey(timestamp: number): string {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Format a timestamp into a calendar day separator label for conversation threads:
 * - "Today" if the timestamp is within the current local calendar day.
 * - "Yesterday" if within the previous local calendar day.
 * - Formatted date (e.g. "August 24, 2026" or "August 24") otherwise.
 */
export function formatDayDivider(timestamp: number, nowMs: number = Date.now()): string {
  const d = new Date(timestamp);
  const now = new Date(nowMs);

  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  if (isToday) return "Today";

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();

  if (isYesterday) return "Yesterday";

  const isSameYear = d.getFullYear() === now.getFullYear();

  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: isSameYear ? undefined : "numeric",
  });
}

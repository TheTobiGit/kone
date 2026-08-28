/**
 * A timestamp as a glanceable age — "just now", "4m ago", "2d ago".
 *
 * Coarse on purpose. These stamps sit in a meta line the eye skims past, so the
 * useful information is the order of magnitude, not the minute: anything under
 * three quarters of a minute is "just now", and past a week the unit steps up
 * rather than the number growing.
 */
export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.floor(d / 365)}y ago`;
}

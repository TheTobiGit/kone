// Derived context-window state for the meter: every number the ring, the
// popover rows and the Compact control read, in one place so the thin ring
// view never recomputes them. Pure derivations off the live usage snapshot,
// plus the compact gating the actions card reads. Popover open/close state
// stays in the component — it owns the outside-click detector.
import { computed } from "vue";
import { useSound } from "~/composables/useSound";
import type { TokenUsage } from "~/types/desktop";
import type { MeterCompactProps } from "~/types/session";
import { formatContextTokens, formatWindowPercent } from "~/utils/formatContextTokens";

export type ContextMeterLevel = "calm" | "warm" | "full";

export type ContextMeterRow = { label: string; value: string };

export function useContextMeter(input: {
  /** The live usage snapshot the meter reads. */
  usage: () => TokenUsage;
  /** The Compact control props the host spread on. Absent compact props (no
   *  onCompact) means the provider has no such concept and the actions card
   *  stays hidden — the meter is then a pure read-out. */
  compact: () => MeterCompactProps;
}) {
  const { cue } = useSound();

  // A usable numerator: the live window fill alone, never the spend tally.
  // `total` is cumulative lifetime spend after a reload, so letting it pose as
  // fill would pin the ring at 100% red on reopened threads. An explicit 0
  // counts, since "nothing consumed yet" is a real answer; when contextUsed is
  // absent we don't know the fill, and a fallback of 0 would read as "nothing
  // consumed", which is false — the ring stays hidden instead.
  const usedKnown = computed(() => {
    const n = input.usage().contextUsed;
    return n !== undefined && n !== null && Number.isFinite(n) ? n : undefined;
  });
  const max = computed(() => input.usage().contextWindow);
  const hasWindow = computed(
    () => max.value !== undefined && max.value !== null && Number.isFinite(max.value) && max.value > 0,
  );
  // A ring is a fraction — "x of a window" — so it needs BOTH halves. A window
  // with no reported fill would otherwise sit forever on an empty 0% arc that
  // claims "nothing consumed" when we simply don't know.
  const showRing = computed(() => hasWindow.value && usedKnown.value !== undefined);
  // Clamped at 0: one bad provider event must not render negative rows or
  // percents. The arc clamps low on its own; the text rows read this value.
  const used = computed(() => Math.max(0, usedKnown.value ?? 0));
  const percentage = computed(() =>
    max.value && max.value > 0 ? Math.min(100, Math.max(0, (used.value / max.value) * 100)) : 0,
  );

  // Calm terracotta while there's room, leaning to full accent as it fills, then
  // the delete-red only once the window is genuinely near-capacity. Graded, not a
  // binary alarm — the colour cross-fades as the arc grows.
  const level = computed<ContextMeterLevel>(() =>
    percentage.value >= 90 ? "full" : percentage.value >= 70 ? "warm" : "calm",
  );

  const usageLabel = computed(() => {
    const usedText = formatContextTokens(used.value);
    if (!max.value || max.value <= 0) return `${usedText} tokens used`;
    return `${formatWindowPercent(percentage.value)} used · ${usedText} of ${formatContextTokens(max.value)} tokens`;
  });
  // Names the auto-compact threshold when the window is known, so the note
  // answers "when does it compact"; without a window there is no threshold to
  // name, so it falls back to the generic wording.
  const compactNote = computed(() =>
    hasWindow.value
      ? `Auto-compacts at ~${formatContextTokens(max.value)}.`
      : "Auto-compacts when full.",
  );
  const tooltip = computed(() =>
    input.usage().compactsAutomatically ? `${usageLabel.value}. ${compactNote.value}` : usageLabel.value,
  );

  // Absent state with a handler reads as available — the strip always passes an
  // explicit state, so this only covers future callers that pass onCompact
  // alone rather than leaving them with a control that can never enable.
  const compactReady = computed(() => (input.compact().compactState ?? "available") === "available");
  const compactBusy = computed(() => input.compact().compactState === "compacting");

  function pressCompact(): void {
    const control = input.compact();
    if (!compactReady.value || !control.onCompact) return;
    cue("press");
    control.onCompact();
  }

  const rows = computed(() => {
    const u = input.usage();
    const out: ContextMeterRow[] = [];
    const m = max.value;
    if (usedKnown.value !== undefined && m !== undefined && m > 0) {
      out.push({
        label: "Used",
        value: `${formatWindowPercent(percentage.value)} · ${formatContextTokens(used.value)}`,
      });
      const remaining = m - used.value;
      if (remaining > 0) out.push({ label: "Remaining", value: formatContextTokens(remaining) });
    }
    if (u.input !== undefined && u.input !== null && Number.isFinite(u.input)) {
      out.push({ label: "Input", value: formatContextTokens(u.input) });
    }
    if (u.output !== undefined && u.output !== null && Number.isFinite(u.output)) {
      out.push({ label: "Output", value: formatContextTokens(u.output) });
    }
    if (u.total !== undefined && u.total !== null && Number.isFinite(u.total)) {
      out.push({ label: "Total", value: formatContextTokens(u.total) });
    }
    if (m !== undefined && m > 0) out.push({ label: "Window", value: formatContextTokens(m) });
    return out;
  });
  const note = computed(() => (input.usage().compactsAutomatically ? compactNote.value : ""));

  return {
    usedKnown,
    max,
    hasWindow,
    showRing,
    used,
    percentage,
    level,
    usageLabel,
    compactNote,
    tooltip,
    rows,
    note,
    compactReady,
    compactBusy,
    pressCompact,
  };
}

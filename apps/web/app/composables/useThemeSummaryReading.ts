import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { parseThemeSummary } from "@kone/protocol/theme-summary";
import { useTheme } from "./useTheme";
import { findTheme } from "~/theme/library";
import { colorsFor } from "~/theme/roles";
import type { RuntimeItem } from "~/types/desktop";
import { themeToolKinds } from "~/utils/themeReceipts";

// An appearance change read back out of the call's own stored sentence.
//
// The durable half, and the only half a transcript loaded after a restart has:
// the tool wrote both ends of the change into its summary (see
// @kone/protocol/theme-summary), so the themes are recoverable from the item
// alone — no event, no record, no matching.
//
// Colours are resolved against the scheme on screen now rather than the one the
// change was painted in, which is the honest answer: the reader is looking at
// this window, and the one that made the change is gone.

export function useThemeSummaryReading(item: MaybeRefOrGetter<RuntimeItem | null | undefined>) {
  const themes = computed(() => {
    const it = toValue(item);
    if (!it || !themeToolKinds(it.name)) return null;
    return parseThemeSummary(it.detail) ?? parseThemeSummary(it.text);
  });

  const toTheme = computed(() => {
    const named = themes.value;
    return named ? findTheme(named.to) : null;
  });

  const fromTheme = computed(() => {
    const from = themes.value?.from;
    return from ? findTheme(from) : null;
  });

  const { scheme } = useTheme();
  const toColors = computed(() => (toTheme.value ? colorsFor(toTheme.value, scheme.value) : null));
  const fromColors = computed(() =>
    fromTheme.value ? colorsFor(fromTheme.value, scheme.value) : null,
  );

  /** Whether the call named a theme this build still holds. */
  const has = computed(() => !!toTheme.value);

  return { toTheme, fromTheme, toColors, fromColors, has };
}

import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { parseThemeChange, type ThemeChangeData } from "@kone/protocol/theme-summary";
import { useTheme } from "./useTheme";
import { findTheme } from "~/theme/library";
import { colorsFor, type ThemeColors } from "~/theme/roles";
import type { RuntimeItem } from "~/types/desktop";
import { canonicalToolName } from "~/utils/toolName";

// An appearance change read back out of the call's own stored record.
//
// The durable half, and the only half a transcript loaded after a restart has:
// the tool wrote both ends of the change into its result as data (see
// @kone/protocol/theme-summary), so the themes are recoverable from the item
// alone — no event, no record, no matching.
//
// Colours are resolved against the scheme on screen now rather than the one the
// change was painted in, which is the honest answer: the reader is looking at
// this window, and the one that made the change is gone. The one exception is
// a preview's custom overrides, which belong to no library theme — those are
// laid over the resolved table so the preview's own bead can still be drawn.

/** The tool names that can leave a change record, in canonical spelling. */
const APPEARANCE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "app_set_theme",
  "app_create_custom_theme",
  "app_preview_theme_override",
]);

export function isAppearanceToolName(name: string | undefined): boolean {
  return APPEARANCE_TOOL_NAMES.has(canonicalToolName(name));
}

/** The shape the turn-level pairing needs of a turn's parts — a subset of
 *  RuntimeItem, so the pairing can be tested without one. */
export interface AppearanceCallItem {
  kind: string;
  status: string;
  name?: string | undefined;
  detail?: string | undefined;
}

/** True for a settled call that left a change record. A failed call changed
 *  nothing, a running one has no result yet, and a settled call without a
 *  record (a bare mode change, a cancel) has no themes to draw. */
export function isRecordedAppearanceCall(item: AppearanceCallItem): boolean {
  if (item.kind !== "tool_call" || item.status !== "completed") return false;
  if (!isAppearanceToolName(item.name)) return false;
  return parseThemeChange(item.detail) !== null;
}

/** A resolved table with a preview's custom overrides laid over it. Blank
 *  entries change nothing: a role the preview did not name keeps the library
 *  value, and an empty override is not a colour. */
function overlayTokens(base: ThemeColors, tokens: Record<string, string>): ThemeColors {
  const out: Record<string, string> = { ...base };
  for (const [role, tone] of Object.entries(tokens)) {
    if (role.trim().length > 0 && tone.trim().length > 0) out[role] = tone;
  }
  // SAFETY: `out` starts as a complete role table and only named roles are
  // overwritten, so every role still holds a colour.
  return out as ThemeColors;
}

export function useThemeSummaryReading(item: MaybeRefOrGetter<RuntimeItem | null | undefined>) {
  const change = computed<ThemeChangeData | null>(() => {
    const it = toValue(item);
    if (!it || !isAppearanceToolName(it.name)) return null;
    return parseThemeChange(it.detail);
  });

  const toTheme = computed(() => {
    const to = change.value?.to;
    return to ? findTheme(to) : null;
  });

  const fromTheme = computed(() => {
    const from = change.value?.from;
    return from ? findTheme(from) : null;
  });

  const { scheme } = useTheme();
  const toColors = computed(() => {
    const theme = toTheme.value;
    if (!theme) return null;
    const base = colorsFor(theme, scheme.value);
    const tokens = change.value?.colors;
    return tokens ? overlayTokens(base, tokens) : base;
  });
  const fromColors = computed(() =>
    fromTheme.value ? colorsFor(fromTheme.value, scheme.value) : null,
  );

  /** Whether the call named a theme this build still holds. */
  const has = computed(() => !!toTheme.value);

  return { change, toTheme, fromTheme, toColors, fromColors, has };
}

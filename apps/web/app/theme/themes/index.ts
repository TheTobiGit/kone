import type { ThemeDefinition, ThemeKind, ThemeScheme } from "../roles";
import { KONE_THEME } from "./kone";
import { GROVE_THEME } from "./grove";
import { OCEAN_THEME } from "./ocean";
import { EMBER_THEME } from "./ember";
import { IRIS_THEME } from "./iris";
import { NOCTURNE_THEME } from "./nocturne";
import { FORGE_THEME } from "./forge";
import { MOSS_THEME } from "./moss";
import { TIDE_THEME } from "./tide";
import { PRESS_THEME } from "./press";
import { ATELIER_THEME } from "./atelier";
import { NORTHLIGHT_THEME } from "./northlight";
import { HERBARIUM_THEME } from "./herbarium";
import { FRESCO_THEME } from "./fresco";
import { CIRRUS_THEME } from "./cirrus";

/**
 * Every theme kone ships, in the order the appearance pane lists them: the app's
 * own appearance first, then the themes that carry both schemes, then the ones
 * designed as a single appearance.
 */
export const BUILT_IN_THEMES: readonly ThemeDefinition[] = [
  KONE_THEME,
  GROVE_THEME,
  OCEAN_THEME,
  EMBER_THEME,
  IRIS_THEME,
  NOCTURNE_THEME,
  FORGE_THEME,
  MOSS_THEME,
  TIDE_THEME,
  PRESS_THEME,
  ATELIER_THEME,
  NORTHLIGHT_THEME,
  HERBARIUM_THEME,
  FRESCO_THEME,
  CIRRUS_THEME,
];

export const DEFAULT_THEME_ID = KONE_THEME.id;

export function findTheme(id: string | null | undefined): ThemeDefinition | null {
  if (!id) return null;
  return BUILT_IN_THEMES.find((theme) => theme.id === id) ?? null;
}

/** The theme to render when the stored preference names one kone no longer ships. */
export function resolveTheme(id: string | null | undefined): ThemeDefinition {
  return findTheme(id) ?? KONE_THEME;
}

/**
 * The list split the way it is presented. Grouping is part of the choice rather
 * than decoration: a fixed theme behaves differently from an adaptive one, and
 * the only honest place to say so is next to the themes it applies to.
 */
export type ThemeGroup = {
  key: string;
  label: string;
  /** One line explaining what selecting anything in this group does. */
  note: string;
  themes: readonly ThemeDefinition[];
};

function byKind(kind: ThemeKind, appearance?: ThemeScheme): readonly ThemeDefinition[] {
  return BUILT_IN_THEMES.filter(
    (t) => t.kind === kind && (appearance === undefined || t.appearance === appearance),
  );
}

export function themeGroups(): readonly ThemeGroup[] {
  return [
    {
      key: "adaptive",
      label: "Adaptive",
      note: "A designed light palette and a designed dark one. Follows your appearance setting.",
      themes: byKind("adaptive"),
    },
    {
      key: "dark",
      label: "Dark",
      note: "Designed as dark. Stays dark whatever your system is set to.",
      themes: byKind("fixed", "dark"),
    },
    {
      key: "light",
      label: "Light",
      note: "Designed as light. Stays light whatever your system is set to.",
      themes: byKind("fixed", "light"),
    },
  ].filter((group) => group.themes.length > 0);
}

/**
 * The minimum a theme needs for the first painted frame, for the blocking boot
 * script in the Nuxt config. It is generated from the shipped themes rather than
 * hand-copied, which is what keeps a new theme from flashing kone's colours
 * before the bundle loads.
 */
export type ThemeBootEntry = {
  kind: ThemeKind;
  appearance: ThemeScheme;
  light?: readonly string[];
  dark?: readonly string[];
};

/** The five properties the boot script sets, in order. */
export const BOOT_ROLES = ["ground", "ink", "sunken", "accent", "raised"] as const;

export function themeBootTable(): Record<string, ThemeBootEntry> {
  const table: Record<string, ThemeBootEntry> = {};
  for (const theme of BUILT_IN_THEMES) {
    const entry: ThemeBootEntry = { kind: theme.kind, appearance: theme.appearance };
    for (const scheme of ["light", "dark"] as const) {
      const colors = theme.colors[scheme];
      if (!colors) continue;
      // A relational value can't be resolved before the stylesheet exists, so a
      // boot colour has to be something the browser can paint on its own. The
      // few that aren't literal fall back to the ground, which is always literal
      // and is the only one of the five that would be visible as a flash anyway.
      entry[scheme] = BOOT_ROLES.map((role) => {
        const value = colors[role];
        return value.startsWith("#") ? value : colors.ground;
      });
    }
    table[theme.id] = entry;
  }
  return table;
}

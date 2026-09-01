import { watch } from "vue";
import { initTheme, useTheme } from "~/composables/useTheme";
import { initAppSteering } from "~/composables/useAppSteering";
import { isCustom, isImported } from "~/theme/library";
import { colorsFor, type ThemeDefinition, type ThemeScheme } from "~/theme/roles";
import type { KoneThemeRosterEntry } from "~/types/desktop";

/** A theme's two defining colours, flattened for the shell.
 *
 * A role can hold a relational value rather than a literal, and the shell has
 * no stylesheet to resolve one against — so a non-literal accent falls back to
 * the ground, which is always literal. The same substitution the boot table
 * makes, for the same reason. */
function definingColors(theme: ThemeDefinition, scheme: ThemeScheme) {
  const colors = colorsFor(theme, scheme);
  return {
    accent: colors.accent.startsWith("#") ? colors.accent : colors.ground,
    ground: colors.ground,
  } satisfies Pick<KoneThemeRosterEntry, "accent" | "ground">;
}

function rosterEntry(theme: ThemeDefinition): KoneThemeRosterEntry {
  const schemes = (["light", "dark"] as const).filter((scheme) => theme.colors[scheme]);
  return {
    id: theme.id,
    label: theme.label,
    blurb: theme.blurb,
    kind: theme.kind,
    appearance: theme.appearance,
    schemes: schemes.length > 0 ? [...schemes] : [theme.appearance],
    ...definingColors(theme, theme.appearance),
    origin: isCustom(theme.id) ? "custom" : isImported(theme.id) ? "imported" : "built-in",
  };
}

export default defineNuxtPlugin(() => {
  initTheme();
  initAppSteering();

  // In the browser there is no shell to tell; only the desktop build carries the
  // bridge, so the push is conditional rather than assumed.
  const bridge = window.koneDesktop;
  if (!bridge?.setTheme) return;

  const { mode, modeLocked, scheme, themeId, theme, themes } = useTheme();

  // The shell needs the appearance it should actually dress the window in. That
  // is the mode while the theme follows it, but a fixed theme overrides the mode
  // — pushing `mode` there would leave a light titlebar over a dark interface,
  // so a locked theme reports its concrete scheme instead.
  //
  // The second argument is the full picture rather than the window's dressing:
  // the agent gateway reads it back to describe the interface the user is
  // looking at and to change it. The roster rides along because the library is
  // the renderer's alone — an imported or user-authored theme exists nowhere
  // else, and an agent that can't see one can neither offer it nor apply it.
  const push = () => {
    void bridge.setTheme(modeLocked.value ? scheme.value : mode.value, {
      themeId: themeId.value,
      themeLabel: theme.value.label,
      mode: mode.value,
      scheme: scheme.value,
      locked: modeLocked.value,
      themes: themes.value.map(rosterEntry),
    });
  };

  push();
  watch([mode, modeLocked, scheme, themeId, themes], push);
});

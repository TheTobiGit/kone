import { THEME_VARIABLES } from "./roles";
import type { ThemeColors, ThemeScheme } from "./roles";

/**
 * Pure DOM application of a theme — no Vue. The runtime writes role colours as
 * inline custom properties on <html>, so they beat any stylesheet declaration
 * and a swap is a reflow of data, not a cascade of overrides.
 */
export function applyThemeColors(
  colors: ThemeColors,
  scheme: ThemeScheme,
  themeId: string,
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  // Suppress transitions for the swap so every surface lands on its new colour
  // in the same frame instead of visibly cross-fading. The class is removed two
  // frames later so any *new* transitions scheduled by the swap still animate.
  root.classList.add("theme-swapping");
  void root.offsetHeight;

  // SAFETY: Object.keys lists THEME_VARIABLES' own roles, so every key names one of them.
  for (const role of Object.keys(THEME_VARIABLES) as (keyof typeof THEME_VARIABLES)[]) {
    root.style.setProperty(THEME_VARIABLES[role], colors[role]);
  }
  root.dataset.theme = themeId;
  root.dataset.scheme = scheme;
  root.classList.toggle("dark", scheme === "dark");

  requestAnimationFrame(() => {
    requestAnimationFrame(() => root.classList.remove("theme-swapping"));
  });
}

/**
 * Remove every runtime-owned colour and attribute, handing the surface back to
 * the stylesheet fallback. The seam for user themes: a custom theme applies its
 * own table here and nothing else needs to know about it.
 */
export function clearThemeColors(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  for (const variable of Object.values(THEME_VARIABLES)) {
    root.style.removeProperty(variable);
  }
  delete root.dataset.theme;
  delete root.dataset.scheme;
  root.classList.remove("dark");
}

import { PAGE_THEME_VARIABLES, type PageTheme } from "@kone/protocol/page-render";

// The theme on screen, as an agent's page receives it: the computed value of
// every variable a page is promised, read off the root element. Computed rather
// than looked up, because a theme role can be relational (a mix of two others)
// and a theme being edited live exists only in the window's own styles.

/** The theme on screen right now, as a page's variables. */
export function readRootPageTheme(): PageTheme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const variables: Record<string, string> = {};
  for (const name of PAGE_THEME_VARIABLES) {
    const value = style.getPropertyValue(name).trim();
    if (value) variables[name] = value;
  }
  return { appearance: root.dataset.scheme === "light" ? "light" : "dark", variables };
}

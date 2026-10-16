import { VISUAL_THEME_VARIABLES, type VisualTheme } from "@kone/protocol/visual-render";

// The theme on screen, as an agent's visual receives it: the computed value of
// every variable a visual is promised, read off the root element. Computed rather
// than looked up, because a theme role can be relational (a mix of two others)
// and a theme being edited live exists only in the window's own styles.

/** The reply's text size. A visual's text sits at the size of the words
 *  around it, which the reply sets in px of its own rather than from a root
 *  variable. */
const REPLY_FONT_SIZE = "14px";
/** How much more open the reply's leading is than the body's. */
const REPLY_LEADING_EXTRA = 0.09;

/** The theme on screen right now, as a visual's variables. */
export function readRootVisualTheme(): VisualTheme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const variables: Record<string, string> = {};
  for (const name of VISUAL_THEME_VARIABLES) {
    const value = style.getPropertyValue(name).trim();
    if (value) variables[name] = value;
  }
  variables["--font-size"] = REPLY_FONT_SIZE;
  const leading = Number.parseFloat(style.getPropertyValue("--line-height-body"));
  if (Number.isFinite(leading)) variables["--line-height"] = String(Math.round((leading + REPLY_LEADING_EXTRA) * 100) / 100);
  return { appearance: root.dataset.scheme === "light" ? "light" : "dark", variables };
}

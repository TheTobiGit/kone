import { computed, ref } from "vue";
import { useWindowSize } from "@vueuse/core";

// Which settings pane is showing, and how far the launcher has to slide aside to
// reveal it.
//
// This lives outside SettingsDrawer because the reveal is not the drawer's to
// perform: index.vue translates the whole stage by exactly the drawer's width
// (the X account-drawer gesture), so the two have to agree on one number. When
// the pane that's open needs a page rather than a column, both change together.
//
// Module-scope state, like useStripPrefs — one source, read by the drawer and the
// stage without threading a prop between them.

export type SettingsPane =
  | "root"
  | "profile"
  | "shortcuts"
  | "motion"
  | "providers"
  | "agentsUsage"
  | "providerLimits";

/** The drawer as a list: a column beside the launcher, which stays the subject. */
const COLUMN_WIDTH = 320;
/** How much of the launcher stays uncovered when a pane takes the page. Enough
 *  to keep it legible as the place you came from, not enough to compete. */
const STAGE_REMAINDER = 300;
/** Past this the page stops growing — the same measure the git space caps at,
 *  because a 1600px-wide settings page is just a long line of text. */
const PAGE_MAX = 1040;

const pane = ref<SettingsPane>("root");

/** Panes that are pages rather than lists. Everything else keeps the column. */
const PAGE_PANES: SettingsPane[] = ["providers", "motion", "profile", "agentsUsage", "providerLimits"];

export function useSettingsSurface() {
  const { width } = useWindowSize();

  const isPage = computed(() => PAGE_PANES.includes(pane.value));

  /** The drawer's width, and so the distance the stage slides. On the server (or
   *  before the first measurement) the window is 0 wide, which falls through to
   *  the column — the narrow case is always the safe one to render first. */
  const revealWidth = computed(() => {
    if (!isPage.value) return COLUMN_WIDTH;

    // Every page takes the same measure. Thread strip used to be capped narrower on
    // the grounds that a single column of options would strand its prose at an
    // unreadable line length — but that page carries no prose now beyond one capped
    // line, and what it does carry is three miniatures of the strip, which get more
    // honest the closer they run to the width they're modelling. The only line long
    // enough to need protecting sets its own `max-width`.
    return Math.round(Math.min(PAGE_MAX, Math.max(COLUMN_WIDTH, width.value - STAGE_REMAINDER)));
  });

  function openPane(target: SettingsPane) {
    pane.value = target;
  }

  return { pane, isPage, revealWidth, COLUMN_WIDTH, openPane };
}

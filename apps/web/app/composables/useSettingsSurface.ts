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

export type SettingsPane = "root" | "shortcuts" | "motion" | "providers";

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
const PAGE_PANES: SettingsPane[] = ["providers"];

export function useSettingsSurface() {
  const { width } = useWindowSize();

  const isPage = computed(() => PAGE_PANES.includes(pane.value));

  /** The drawer's width, and so the distance the stage slides. On the server (or
   *  before the first measurement) the window is 0 wide, which falls through to
   *  the column — the narrow case is always the safe one to render first. */
  const revealWidth = computed(() => {
    if (!isPage.value) return COLUMN_WIDTH;
    return Math.round(Math.min(PAGE_MAX, Math.max(COLUMN_WIDTH, width.value - STAGE_REMAINDER)));
  });

  return { pane, isPage, revealWidth, COLUMN_WIDTH };
}

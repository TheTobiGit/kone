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
  | "appearance"
  | "providers"
  | "agentsUsage"
  | "providerLimits"
  | "agentSkills"
  | "agentRoster"
  | "agentPresets";

/** The drawer as a list: a column beside the launcher, which stays the subject. */
const COLUMN_WIDTH = 320;
/** How much of the launcher stays uncovered when a pane takes the page. Enough
 *  to keep it legible as the place you came from, not enough to compete. */
const STAGE_REMAINDER = 300;
/** Past this the page stops growing — the same measure the git space caps at,
 *  because a 1600px-wide settings page is just a long line of text. */
const PAGE_MAX = 1040;
/** A reading rather than a board: one agent's facts and its brief. Past this
 *  the values sit in a void, and the launcher they came from is pushed too far
 *  aside for a page that is still a list of rows. */
const COMPACT_MAX = 640;

const pane = ref<SettingsPane>("root");
/** When true, the open page uses COMPACT_MAX instead of PAGE_MAX. The agent
 *  detail sets this for as long as it is on screen; everything else leaves it. */
const compact = ref(false);

/** Panes that are pages rather than lists. Everything else keeps the column. */
const PAGE_PANES: SettingsPane[] = [
  "providers",
  "motion",
  "appearance",
  "profile",
  "shortcuts",
  "agentsUsage",
  "providerLimits",
  "agentSkills",
  "agentRoster",
  "agentPresets",
];

export function useSettingsSurface() {
  const { width } = useWindowSize();

  const isPage = computed(() => PAGE_PANES.includes(pane.value));

  /** The drawer's width, and so the distance the stage slides. On the server (or
   *  before the first measurement) the window is 0 wide, which falls through to
   *  the column — the narrow case is always the safe one to render first. */
  const revealWidth = computed(() => {
    if (!isPage.value) return COLUMN_WIDTH;

    // Most pages take the full measure. A compact page (one agent's details) is
    // a facts table, so it stops earlier — the same formula, a tighter cap.
    const cap = compact.value ? COMPACT_MAX : PAGE_MAX;
    return Math.round(Math.min(cap, Math.max(COLUMN_WIDTH, width.value - STAGE_REMAINDER)));
  });

  function openPane(target: SettingsPane) {
    pane.value = target;
  }

  return { pane, isPage, compact, revealWidth, COLUMN_WIDTH, openPane };
}

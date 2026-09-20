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
  | "typography"
  | "studio"
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

/** Every pane's measure, in one place.
 *
 *  A table over the pane union rather than lists of panes. The width used to be
 *  two overlapping arrays — one naming the pages, one naming the pages that stay
 *  narrow — and a pane had to appear in *both* to come out narrow, because the
 *  column case returned before the narrow case was ever consulted. A pane added
 *  to one list and not the other silently took the wrong width. Here the
 *  compiler will not accept a new pane until it has been given a measure.
 *
 *  `column` is the drawer as a list beside the launcher, which stays the
 *  subject. `page` takes the full measure. `compact` is a page that stops
 *  earlier — a short list of one-line settings, or cards that read top to bottom
 *  in a single vertical column, where the full measure would leave a label and
 *  its value at opposite ends of the line. */
const PANE_MEASURE = {
  root: "column",
  profile: "page",
  shortcuts: "page",
  motion: "page",
  appearance: "page",
  typography: "compact",
  studio: "compact",
  providers: "page",
  agentsUsage: "page",
  providerLimits: "compact",
  agentSkills: "page",
  agentRoster: "page",
  agentPresets: "page",
} satisfies Record<SettingsPane, "column" | "page" | "compact">;

const pane = ref<SettingsPane>("root");
/** When true, the open page uses COMPACT_MAX instead of PAGE_MAX. The agent
 *  detail sets this for as long as it is on screen; everything else leaves it. */
const compact = ref(false);
/** Whether the settings drawer is open. */
const isOpen = ref(false);

export function useSettingsSurface() {
  const { width } = useWindowSize();

  const isPage = computed(() => PANE_MEASURE[pane.value] !== "column");

  /** The drawer's width, and so the distance the stage slides. On the server (or
   *  before the first measurement) the window is 0 wide, which falls through to
   *  the column — the narrow case is always the safe one to render first. */
  const revealWidth = computed(() => {
    const measure = PANE_MEASURE[pane.value];
    if (measure === "column") return COLUMN_WIDTH;

    // `compact` is the runtime half of the same decision: the agent and subagent
    // readings are sub-views rather than panes of their own, so they cannot be
    // named in the table and instead raise this flag for as long as they are on
    // screen.
    const tight = measure === "compact" || compact.value;
    const cap = tight ? COMPACT_MAX : PAGE_MAX;
    return Math.round(Math.min(cap, Math.max(COLUMN_WIDTH, width.value - STAGE_REMAINDER)));
  });

  function openPane(target: SettingsPane) {
    pane.value = target;
  }

  function openDrawer(target?: SettingsPane) {
    if (target) pane.value = target;
    isOpen.value = true;
  }

  function closeDrawer() {
    isOpen.value = false;
  }

  return { pane, isPage, compact, isOpen, revealWidth, COLUMN_WIDTH, openPane, openDrawer, closeDrawer };
}

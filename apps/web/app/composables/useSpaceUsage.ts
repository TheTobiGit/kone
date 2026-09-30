import { useAgentSettings } from "~/composables/useAgentSettings";
import { useSpaceRefresh } from "~/composables/useSpaceRefresh";
import { USAGE_RANGE_IDS } from "~/utils/usageRanges";

// The usage reads behind the project Space: every window (today, 7 and 30
// days, all time) for one project, kept fresh while the tab is on screen. The
// board makes one and hands it to each card, so two cards over the same
// windows never pay for the same scan twice.
//
// The windows sit side by side on the board, so a stale one reads as a wrong
// number (7 days below today). Each arrival re-reads all four in one pass,
// today first — it is the figure the eye lands on — and the windows fill in as
// they arrive. The pass is `ensureRanges`' to sequence; the backend's scan cache
// keeps a return trip cheap, and the gap in `useSpaceRefresh` stops a quick tab
// flip from paying for it twice. The windows are cached per project, so a new
// project starts cold: `settled` drops and the cards shimmer until they land.

/** The slice of the settings state the usage board reads. A parameter (rather
 *  than a call the board makes itself) so a test can hand over a stub whose
 *  reads it opens and finishes by hand; the board defaults to the real one. */
export type SpaceUsageSource = Pick<
  ReturnType<typeof useAgentSettings>,
  "ensureRanges" | "usageFor"
>;

export function useSpaceUsage(
  projectPath: () => string,
  visible: () => boolean,
  space: SpaceUsageSource = useAgentSettings(projectPath),
) {

  // `settled` here is the first full pass being done: a window still without a
  // report past it has nothing to read (no desktop bridge).
  const { settled } = useSpaceRefresh(projectPath, visible, () =>
    space.ensureRanges(USAGE_RANGE_IDS, { revalidate: true }),
  );

  return {
    usageFor: space.usageFor,
    settled,
  };
}

export type SpaceUsage = ReturnType<typeof useSpaceUsage>;

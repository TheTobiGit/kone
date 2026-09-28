import { onMounted, readonly, ref, watch } from "vue";
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
// keeps a return trip cheap, and the gap here stops a quick tab flip from
// paying for it twice.

const REVISIT_MS = 30_000;

export function useSpaceUsage(projectPath: () => string, visible: () => boolean) {
  const space = useAgentSettings(projectPath);

  let lastRead = 0;
  /** The newest read, so one a project change has overtaken can't declare the
   *  board settled. */
  let latest = 0;
  /** The first full pass is done — a window still without a report past this
   *  point has nothing to read (no desktop bridge), so it stops shimmering. */
  const settled = ref(false);

  async function read(): Promise<void> {
    lastRead = Date.now();
    const mine = ++latest;
    await space.ensureRanges(USAGE_RANGE_IDS, { revalidate: true });
    if (mine === latest) settled.value = true;
  }

  onMounted(() => void read());
  watch(visible, (on) => {
    if (on && Date.now() - lastRead > REVISIT_MS) void read();
  });
  // The board can stay mounted while the project under it changes. The windows
  // are cached per project, so the new one starts cold: start over — shimmer,
  // then read now if the tab is on screen, or on the next arrival if not.
  watch(projectPath, () => {
    lastRead = 0;
    settled.value = false;
    if (visible()) void read();
  });

  return {
    usageFor: space.usageFor,
    settled: readonly(settled),
  };
}

export type SpaceUsage = ReturnType<typeof useSpaceUsage>;

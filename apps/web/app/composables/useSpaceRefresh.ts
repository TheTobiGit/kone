import { onMounted, readonly, ref, watch } from "vue";

// When a Space board read runs. Every read behind the board (usage, skills,
// instruction files) is kept fresh the same way: once when the board mounts,
// again when the tab comes back after a while, and again when the project under
// a mounted board changes. This is that schedule, with the read itself left to
// the caller.
//
// A read can walk the disk, so it runs when the tab arrives, not on a timer; a
// quick flip back to the tab reuses what it has.

/** How long a read stays good for a tab that comes back. */
const REVISIT_MS = 30_000;

export interface SpaceRefreshOptions {
  /** How long a finished read is reused when the tab comes back. 0 reads on
   *  every arrival. */
  revisitMs?: number;
  /** Runs when the project changes, before the re-read: what the board holds
   *  belongs to the old project, so it goes at once rather than passing for the
   *  new one's until the read lands. */
  reset?: () => void;
}

/**
 * `read` does the work and resolves when everything it fetches has landed. It is
 * handed `current`, which turns false once a newer read (a project change) has
 * overtaken it, so a slow read can hold back what it would have applied.
 *
 * `settled` is true once the first read of the current project has finished: a
 * board still empty past that point has nothing to show, and stops shimmering.
 * `refresh` runs a read now, outside the schedule.
 */
export function useSpaceRefresh(
  projectPath: () => string,
  visible: () => boolean,
  read: (current: () => boolean) => Promise<void>,
  { revisitMs = REVISIT_MS, reset }: SpaceRefreshOptions = {},
) {
  let lastRead = 0;
  /** The newest read, so one a project change has overtaken can't declare the
   *  board settled. */
  let latest = 0;
  const settled = ref(false);

  async function refresh(): Promise<void> {
    lastRead = Date.now();
    const mine = ++latest;
    await read(() => mine === latest);
    if (mine === latest) settled.value = true;
  }

  onMounted(() => void refresh());
  watch(visible, (on) => {
    if (on && Date.now() - lastRead >= revisitMs) void refresh();
  });
  // The board can stay mounted while the project under it changes: start over,
  // then read now if the tab is on screen, or on the next arrival if not.
  watch(projectPath, () => {
    lastRead = 0;
    settled.value = false;
    reset?.();
    if (visible()) void refresh();
  });

  return { settled: readonly(settled), refresh };
}

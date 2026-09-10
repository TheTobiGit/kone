import { describe, expect, test } from "bun:test";
import { ref } from "vue";
import { PORTAL_FADE_MS, PORTAL_HANDOFF_MS, usePortals } from "./usePortals";
import type { PortalClock } from "./usePortals";
import type { Cue } from "./useSound";

interface ScheduledTask {
  run: () => void;
  /** The requested wait, or null for a next-frame task. */
  wait: number | null;
  cancelled: boolean;
}

interface ManualClock {
  clock: PortalClock;
  timers: ScheduledTask[];
  frames: ScheduledTask[];
  runTimers: () => void;
  runFrames: () => void;
}

// A clock the test drives by hand: nothing fires unless runTimers/runFrames
// says so, so every mid-handoff assertion observes the held state, not a race.
function manualClock(): ManualClock {
  const timers: ScheduledTask[] = [];
  const frames: ScheduledTask[] = [];
  function drain(list: ScheduledTask[]): void {
    const due = list.splice(0, list.length);
    for (const task of due) {
      if (!task.cancelled) task.run();
    }
  }
  return {
    timers,
    frames,
    clock: {
      after(run: () => void, ms: number): () => void {
        const task: ScheduledTask = { run, wait: ms, cancelled: false };
        timers.push(task);
        return () => {
          task.cancelled = true;
        };
      },
      frame(run: () => void): () => void {
        const task: ScheduledTask = { run, wait: null, cancelled: false };
        frames.push(task);
        return () => {
          task.cancelled = true;
        };
      },
    },
    runTimers(): void {
      drain(timers);
    },
    runFrames(): void {
      drain(frames);
    },
  };
}

interface PortalHarness extends ManualClock {
  cued: Cue[];
  portals: ReturnType<typeof usePortals>;
}

function harness(reduced = false): PortalHarness {
  const ctl = manualClock();
  const cued: Cue[] = [];
  const portals = usePortals({
    clock: ctl.clock,
    cue: (name: Cue): void => {
      cued.push(name);
    },
    reducedMotion: ref(reduced),
  });
  return { ...ctl, cued, portals };
}

function liveTimers(ctl: { timers: ScheduledTask[] }): ScheduledTask[] {
  return ctl.timers.filter((t) => !t.cancelled);
}

describe("usePortals — summon from the page", () => {
  test("summoning a closed portal opens it at once with a cue", () => {
    const { portals, cued, timers, frames } = harness();
    portals.summon("studio");
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(false);
    expect(cued).toEqual(["expand"]);
    expect(liveTimers({ timers }).length).toBe(0);
    expect(frames.length).toBe(0);
  });

  test("summoning the open portal is a no-op (no second cue, no timer)", () => {
    const { portals, cued, timers } = harness();
    portals.summon("inbox");
    portals.summon("inbox");
    expect(cued).toEqual(["expand"]);
    expect(liveTimers({ timers }).length).toBe(0);
  });

  test("dismissing with nothing open is a no-op", () => {
    const { portals, cued } = harness();
    portals.dismiss();
    expect(portals.activePortal.value).toBeNull();
    expect(cued).toEqual([]);
  });
});

describe("usePortals — upward handoff (studio to inbox)", () => {
  test("the inbox opens over the plane, which leaves a frame past the fade", () => {
    const { portals, timers, runTimers } = harness();
    portals.summon("studio");
    portals.summon("inbox");

    // Both flags up: the page is covered for the whole switch.
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(true);

    const pending = liveTimers({ timers });
    expect(pending.length).toBe(1);
    expect(pending[0]?.wait).toBe(PORTAL_HANDOFF_MS);

    runTimers();
    expect(portals.inboxOpen.value).toBe(true);
    expect(portals.studioOpen.value).toBe(false);
  });

  test("dismissing the inbox mid-handoff lands on the still-open plane", () => {
    const { portals, timers, runTimers } = harness();
    portals.summon("studio");
    portals.summon("inbox");
    portals.dismiss();

    expect(portals.inboxOpen.value).toBe(false);
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.activePortal.value).toBe("studio");

    // The abandoned timer can never carry through to the page.
    expect(liveTimers({ timers }).length).toBe(0);
    runTimers();
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(false);
  });

  test("dismissing the covered plane mid-handoff leaves the inbox up", () => {
    const { portals, runTimers } = harness();
    portals.summon("studio");
    portals.summon("inbox");
    portals.dismiss("studio");

    expect(portals.studioOpen.value).toBe(false);
    expect(portals.inboxOpen.value).toBe(true);
    runTimers();
    expect(portals.inboxOpen.value).toBe(true);
  });
});

describe("usePortals — downward handoff (inbox to studio)", () => {
  test("the plane appears instantly and the inbox leaves on the next frame", () => {
    const { portals, timers, frames, runFrames } = harness();
    portals.summon("inbox");
    portals.summon("studio");

    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(true);
    expect(liveTimers({ timers }).length).toBe(0);
    expect(frames.filter((f) => !f.cancelled).length).toBe(1);

    runFrames();
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(false);
  });

  test("dismissing mid-handoff reveals the plane, never the page", () => {
    const { portals, frames, runFrames } = harness();
    portals.summon("inbox");
    portals.summon("studio");
    portals.dismiss();

    expect(portals.inboxOpen.value).toBe(false);
    expect(portals.studioOpen.value).toBe(true);

    expect(frames.filter((f) => !f.cancelled).length).toBe(0);
    runFrames();
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(false);
  });
});

describe("usePortals — pre-emption", () => {
  test("a new summon abandons the previous switch", () => {
    const { portals, timers, runTimers, runFrames } = harness();
    portals.summon("studio");
    portals.summon("inbox");
    expect(liveTimers({ timers }).length).toBe(1);

    // Reversing mid-handoff cancels the upward timer and starts the downward frame.
    portals.summon("studio");
    expect(liveTimers({ timers }).length).toBe(0);
    runTimers();
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(true);

    runFrames();
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(false);
  });

  test("the studio key mid-handoff means go to the studio", () => {
    const { portals, runFrames } = harness();
    portals.summon("studio");
    portals.summon("inbox");
    portals.toggleStudio();
    runFrames();
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(false);
  });

  test("the inbox key mid-handoff lands back on the plane", () => {
    const { portals, runTimers } = harness();
    portals.summon("studio");
    portals.summon("inbox");
    portals.toggleInbox();
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(false);
    runTimers();
    expect(portals.studioOpen.value).toBe(true);
  });

  test("dispose cancels a pending switch, like an unmount", () => {
    const { portals, timers, runTimers } = harness();
    portals.summon("studio");
    portals.summon("inbox");
    portals.dispose();
    expect(liveTimers({ timers }).length).toBe(0);
    runTimers();
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(true);
  });
});

describe("usePortals — frontmost naming and CSS sync", () => {
  test("activePortal names the frontmost open portal; isCovered names the one under it", () => {
    const { portals } = harness();
    expect(portals.activePortal.value).toBeNull();

    portals.summon("studio");
    expect(portals.activePortal.value).toBe("studio");
    expect(portals.isCovered("studio")).toBe(false);
    expect(portals.isCovered("inbox")).toBe(false);

    portals.summon("inbox");
    expect(portals.activePortal.value).toBe("inbox");
    expect(portals.isCovered("studio")).toBe(true);
    expect(portals.isCovered("inbox")).toBe(false);
  });

  test("fadeStyle carries the fade length as the CSS var", () => {
    const { portals } = harness();
    expect(portals.fadeStyle.value).toEqual({
      "--portal-fade-ms": `${PORTAL_FADE_MS}ms`,
    });
    expect(PORTAL_HANDOFF_MS).toBe(PORTAL_FADE_MS + 10);
  });

  test("reduced motion sends the plane away at once — no fade to wait out", () => {
    const { portals, timers, runTimers } = harness(true);
    portals.summon("studio");
    portals.summon("inbox");

    const pending = liveTimers({ timers });
    expect(pending.length).toBe(1);
    expect(pending[0]?.wait).toBe(0);

    runTimers();
    expect(portals.studioOpen.value).toBe(false);
    expect(portals.inboxOpen.value).toBe(true);
  });
});

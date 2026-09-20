import { describe, expect, test } from "bun:test";
import { PORTAL_FADE_MS, usePortals } from "./usePortals";
import type { PortalClock } from "./usePortals";
import type { Cue } from "./useSound";

interface ScheduledTask {
  run: () => void;
  cancelled: boolean;
}

interface ManualClock {
  clock: PortalClock;
  frames: ScheduledTask[];
  runFrames: () => void;
}

// A clock the test drives by hand: nothing fires unless runFrames says so, so
// every mid-handoff assertion observes the held state, not a race.
function manualClock(): ManualClock {
  const frames: ScheduledTask[] = [];

  function drain(list: ScheduledTask[]): void {
    const due = list.splice(0, list.length);

    for (const task of due) {
      if (!task.cancelled) task.run();
    }
  }

  return {
    frames,
    clock: {
      frame(run: () => void): () => void {
        const task: ScheduledTask = { run, cancelled: false };
        frames.push(task);

        return () => {
          task.cancelled = true;
        };
      },
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

function harness(): PortalHarness {
  const ctl = manualClock();
  const cued: Cue[] = [];

  const portals = usePortals({
    clock: ctl.clock,
    cue: (name: Cue): void => {
      cued.push(name);
    },
  });

  return { ...ctl, cued, portals };
}

function liveFrames(ctl: { frames: ScheduledTask[] }): ScheduledTask[] {
  return ctl.frames.filter((t) => !t.cancelled);
}

describe("usePortals — summon from the page", () => {
  test("summoning a closed portal opens it at once with a cue", () => {
    const { portals, cued, frames } = harness();
    portals.summon("studio");
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(false);
    expect(cued).toEqual(["expand"]);
    expect(frames.length).toBe(0);
  });

  test("summoning the frontmost portal is a no-op (no second cue, no frame)", () => {
    const { portals, cued, frames } = harness();
    portals.summon("inbox");
    portals.summon("inbox");
    expect(cued).toEqual(["expand"]);
    expect(liveFrames({ frames }).length).toBe(0);
  });

  test("re-summoning the frontmost portal over a covered one keeps the stack", () => {
    const { portals, cued, frames } = harness();
    portals.summon("studio");
    portals.summon("inbox");
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(true);
    portals.summon("inbox");
    expect(cued).toEqual(["expand", "expand"]);
    expect(liveFrames({ frames }).length).toBe(0);
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(true);
  });

  test("dismissing with nothing open is a no-op", () => {
    const { portals, cued } = harness();
    portals.dismiss();
    expect(portals.activePortal.value).toBeNull();
    expect(cued).toEqual([]);
  });
});

describe("usePortals — going up keeps where you came from", () => {
  test("the inbox opens over the plane, which stays open underneath", () => {
    const { portals, frames } = harness();
    portals.summon("studio");
    portals.summon("inbox");

    // Both stay up: leaving the inbox reveals the plane, not the page.
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(true);
    expect(portals.activePortal.value).toBe("inbox");
    expect(portals.isCovered("studio")).toBe(true);
    expect(liveFrames({ frames }).length).toBe(0);
  });

  test("leaving the inbox goes back to the studio, not home", () => {
    const { portals } = harness();
    portals.summon("studio");
    portals.summon("inbox");
    portals.toggleInbox();

    expect(portals.inboxOpen.value).toBe(false);
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.activePortal.value).toBe("studio");
  });

  test("dismissing the inbox reveals the studio", () => {
    const { portals } = harness();
    portals.summon("studio");
    portals.summon("inbox");
    portals.dismiss();

    expect(portals.inboxOpen.value).toBe(false);
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.activePortal.value).toBe("studio");
  });

  test("dismissing the covered plane leaves the inbox up", () => {
    const { portals } = harness();
    portals.summon("studio");
    portals.summon("inbox");
    portals.dismiss("studio");

    expect(portals.studioOpen.value).toBe(false);
    expect(portals.inboxOpen.value).toBe(true);
    expect(portals.activePortal.value).toBe("inbox");
  });

  test("leaving the inbox from home goes home (nothing underneath)", () => {
    const { portals } = harness();
    portals.summon("inbox");
    portals.toggleInbox();

    expect(portals.inboxOpen.value).toBe(false);
    expect(portals.activePortal.value).toBeNull();
  });
});

describe("usePortals — going down to a fresh portal", () => {
  test("the plane appears instantly and the inbox leaves on the next frame", () => {
    const { portals, frames, runFrames } = harness();
    portals.summon("inbox");
    portals.summon("studio");

    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(true);
    expect(portals.portalState("studio")).toBe("covered");
    expect(portals.portalState("inbox")).toBe("active");
    expect(liveFrames({ frames }).length).toBe(1);

    runFrames();
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(false);
    expect(portals.activePortal.value).toBe("studio");
  });

  test("dismissing mid-handoff reveals the plane, never the page", () => {
    const { portals, frames, runFrames } = harness();
    portals.summon("inbox");
    portals.summon("studio");
    portals.dismiss();

    expect(portals.inboxOpen.value).toBe(false);
    expect(portals.studioOpen.value).toBe(true);

    expect(liveFrames({ frames }).length).toBe(0);
    runFrames();
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(false);
  });

  test("going down to an already-open portal closes the cover at once", () => {
    const { portals, frames } = harness();
    portals.summon("studio");
    portals.summon("inbox");
    portals.summon("studio");

    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(false);
    expect(portals.activePortal.value).toBe("studio");
    expect(liveFrames({ frames }).length).toBe(0);
  });

  test("leaving a fresh studio goes back to the inbox, not home", () => {
    const { portals, runFrames } = harness();
    portals.summon("inbox");
    portals.summon("studio");
    runFrames();
    expect(portals.activePortal.value).toBe("studio");

    portals.toggleStudio();
    runFrames();

    expect(portals.studioOpen.value).toBe(false);
    expect(portals.inboxOpen.value).toBe(true);
    expect(portals.activePortal.value).toBe("inbox");
  });

  test("leaving a fresh studio goes back to the bench", () => {
    const { portals, runFrames } = harness();
    portals.summon("bench");
    portals.summon("studio");
    runFrames();

    portals.toggleStudio();
    runFrames();

    expect(portals.activePortal.value).toBe("bench");
  });

  test("leaving a fresh inbox goes back to the bench", () => {
    const { portals, runFrames } = harness();
    portals.summon("bench");
    portals.summon("inbox");
    runFrames();

    portals.toggleInbox();
    runFrames();

    expect(portals.activePortal.value).toBe("bench");
  });

  test("a downward chain rewinds in order before reaching home", () => {
    const { portals, runFrames } = harness();
    portals.summon("inbox");
    portals.summon("bench");
    portals.summon("studio");
    runFrames();
    expect(portals.activePortal.value).toBe("studio");

    portals.dismiss();
    runFrames();
    expect(portals.activePortal.value).toBe("bench");

    portals.dismiss();
    runFrames();
    expect(portals.activePortal.value).toBe("inbox");

    portals.dismiss();
    runFrames();
    expect(portals.activePortal.value).toBeNull();
  });

  test("travelling back within the stack drops the covers from the trail", () => {
    const { portals, runFrames } = harness();
    portals.summon("studio");
    portals.summon("inbox");
    portals.summon("bench");
    portals.summon("studio");
    runFrames();
    expect(portals.activePortal.value).toBe("studio");

    // The bench and the inbox were left by travelling back, not stacked
    // underneath, so leaving the studio reaches home rather than reopening
    // one of them.
    portals.dismiss();
    runFrames();
    expect(portals.activePortal.value).toBeNull();
  });

  test("re-summoning mid-handoff keeps the way back", () => {
    const { portals, runFrames } = harness();
    portals.summon("inbox");
    portals.summon("studio");
    portals.summon("studio");
    runFrames();
    expect(portals.activePortal.value).toBe("studio");

    portals.toggleStudio();
    runFrames();
    expect(portals.activePortal.value).toBe("inbox");
  });
});

describe("usePortals — pre-emption", () => {
  test("a new summon abandons the pending downward close", () => {
    const { portals, frames, runFrames } = harness();
    portals.summon("inbox");
    portals.summon("studio");
    expect(liveFrames({ frames }).length).toBe(1);

    // The bench arrives over both of them; the pending inbox close is dropped
    // so the inbox stays open underneath the bench.
    portals.summon("bench");
    expect(liveFrames({ frames }).length).toBe(0);
    runFrames();
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(true);
    expect(portals.benchOpen.value).toBe(true);
    expect(portals.activePortal.value).toBe("bench");
  });

  test("the studio key mid-handoff means go to the studio", () => {
    const { portals, runFrames } = harness();
    portals.summon("inbox");
    portals.summon("studio");
    portals.toggleStudio();
    runFrames();
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(false);
  });

  test("the inbox key mid-handoff lands back on the plane", () => {
    const { portals, runFrames } = harness();
    portals.summon("inbox");
    portals.summon("studio");
    portals.toggleInbox();
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(false);
    runFrames();
    expect(portals.studioOpen.value).toBe(true);
  });

  test("re-summoning the frontmost mid-handoff settles instead of leaving", () => {
    const { portals, frames, runFrames } = harness();
    portals.summon("inbox");
    portals.summon("studio");
    expect(liveFrames({ frames }).length).toBe(1);
    portals.summon("inbox");
    expect(liveFrames({ frames }).length).toBe(0);
    runFrames();
    expect(portals.inboxOpen.value).toBe(true);
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.activePortal.value).toBe("inbox");
  });

  test("dispose cancels a pending switch, like an unmount", () => {
    const { portals, frames, runFrames } = harness();
    portals.summon("inbox");
    portals.summon("studio");
    portals.dispose();
    expect(liveFrames({ frames }).length).toBe(0);
    runFrames();
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
  });
});

describe("usePortals — the bench as a third portal", () => {
  test("the bench opens over the inbox, which stays open underneath", () => {
    const { portals, frames } = harness();
    portals.summon("inbox");
    portals.summon("bench");

    expect(portals.benchOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(true);
    expect(portals.activePortal.value).toBe("bench");
    expect(liveFrames({ frames }).length).toBe(0);
  });

  test("leaving the bench goes back to the inbox", () => {
    const { portals } = harness();
    portals.summon("inbox");
    portals.summon("bench");
    portals.toggleBench();

    expect(portals.benchOpen.value).toBe(false);
    expect(portals.inboxOpen.value).toBe(true);
    expect(portals.activePortal.value).toBe("inbox");
  });

  test("studio, inbox, bench stack three deep and unwind in order", () => {
    const { portals } = harness();
    portals.summon("studio");
    portals.summon("inbox");
    portals.summon("bench");

    expect(portals.activePortal.value).toBe("bench");
    portals.dismiss();
    expect(portals.activePortal.value).toBe("inbox");
    portals.dismiss();
    expect(portals.activePortal.value).toBe("studio");
    portals.dismiss();
    expect(portals.activePortal.value).toBeNull();
  });

  test("going down from the bench to a fresh plane closes on the next frame", () => {
    const { portals, frames, runFrames } = harness();
    portals.summon("bench");
    portals.summon("studio");

    expect(portals.studioOpen.value).toBe(true);
    expect(portals.benchOpen.value).toBe(true);
    expect(liveFrames({ frames }).length).toBe(1);

    runFrames();
    expect(portals.benchOpen.value).toBe(false);
    expect(portals.activePortal.value).toBe("studio");
  });

  test("going down to an already-open inbox closes the bench at once", () => {
    const { portals, frames } = harness();
    portals.summon("inbox");
    portals.summon("bench");
    portals.summon("inbox");

    expect(portals.inboxOpen.value).toBe(true);
    expect(portals.benchOpen.value).toBe(false);
    expect(portals.activePortal.value).toBe("inbox");
    expect(liveFrames({ frames }).length).toBe(0);
  });

  test("a switch that skips a rung keeps everything below the arrival", () => {
    const { portals, runFrames } = harness();
    portals.summon("studio");
    portals.summon("bench");

    expect(portals.benchOpen.value).toBe(true);
    expect(portals.studioOpen.value).toBe(true);
    expect(portals.inboxOpen.value).toBe(false);

    runFrames();
    expect(portals.activePortal.value).toBe("bench");
  });

  test("the bench key puts the bench away only when it is frontmost", () => {
    const { portals, runFrames } = harness();
    portals.toggleBench();
    expect(portals.benchOpen.value).toBe(true);

    portals.toggleBench();
    expect(portals.benchOpen.value).toBe(false);

    // From under another portal, the key means "go to the bench".
    portals.summon("bench");
    portals.summon("inbox");
    runFrames();
    expect(portals.activePortal.value).toBe("inbox");
    portals.toggleBench();
    expect(portals.activePortal.value).toBe("bench");
  });

  test("going down, the arriving portal is the covered one until the frame runs", () => {
    const { portals, runFrames } = harness();
    portals.summon("bench");
    portals.summon("studio");

    // The plane is already painted underneath; the bench is still the
    // frontmost thing, fading out over it.
    expect(portals.portalState("studio")).toBe("covered");
    expect(portals.portalState("bench")).toBe("active");
    expect(portals.portalState("inbox")).toBe("hidden");

    runFrames();
    expect(portals.portalState("studio")).toBe("active");
    expect(portals.portalState("bench")).toBe("hidden");
  });
});

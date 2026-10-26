import { describe, expect, test } from "bun:test";
import {
  placeReferencePreview,
  REFERENCE_PREVIEW_GAP,
  REFERENCE_PREVIEW_MARGIN,
  REFERENCE_PREVIEW_MAX_HEIGHT,
  REFERENCE_PREVIEW_MAX_WIDTH,
  useReferencePreview,
  type ReferencePreview,
  type ReferencePreviewTimers,
} from "./useReferencePreview";

/** A timer queue the test advances by hand, so the hover gap is deterministic
 *  instead of depending on wall-clock timing. */
function manualTimers() {
  let next = 0;
  const jobs = new Map<number, () => void>();
  const timers: ReferencePreviewTimers = {
    set(fn) {
      const id = ++next;
      jobs.set(id, fn);
      return id;
    },
    clear(handle) {
      jobs.delete(handle);
    },
  };
  return {
    timers,
    pending: () => jobs.size,
    run() {
      const due = [...jobs.values()];
      jobs.clear();
      for (const fn of due) fn();
    },
  };
}

function anchor(overrides: Partial<ReferencePreview> = {}): ReferencePreview {
  return {
    id: "ref_a",
    text: "the exact selection\nwith its line breaks",
    anchor: { left: 120, top: 120, bottom: 136 },
    trigger: null,
    ...overrides,
  };
}

describe("the reference preview's hover and focus state", () => {
  test("crossing the six-pixel gap keeps it open, then leaving both closes it", () => {
    const clock = manualTimers();
    const preview = useReferencePreview({ timers: clock.timers });
    preview.enter("chip");
    preview.open(anchor());

    expect(preview.preview.value?.id).toBe("ref_a");

    // Pointer leaves the chip for the gap: the close is only pending.
    preview.leave("chip");
    expect(preview.preview.value?.id).toBe("ref_a");
    expect(clock.pending()).toBe(1);

    // Pointer arrives on the panel before the delay: the pending close is gone.
    preview.enter("panel");
    expect(clock.pending()).toBe(0);
    expect(preview.preview.value?.id).toBe("ref_a");

    // Leaving the panel is the end of the hover, so the delay closes it.
    preview.leave("panel");
    expect(clock.pending()).toBe(1);
    clock.run();
    expect(preview.preview.value).toBeNull();
  });

  test("focus keeps it open after the pointer leaves, and vice versa", async () => {
    const clock = manualTimers();
    const preview = useReferencePreview({ timers: clock.timers });
    preview.focusEnter("chip");
    preview.open(anchor());

    // Pointer leaves, but focus is still on the chip.
    preview.enter("chip");
    preview.leave("chip");
    expect(clock.pending()).toBe(0);

    // Focus moves into the panel; the chip's blur must not queue a close that
    // the panel's focus cannot cancel.
    preview.focusLeave("chip");
    expect(clock.pending()).toBe(1);
    preview.focusEnter("panel");
    expect(clock.pending()).toBe(0);

    // Focus leaves the panel while the pointer is gone: close.
    preview.focusLeave("panel");
    expect(clock.pending()).toBe(1);
    clock.run();
    expect(preview.preview.value).toBeNull();
  });

  test("switching chips ignores the previous chip's pending close", () => {
    const clock = manualTimers();
    const preview = useReferencePreview({ timers: clock.timers });
    preview.enter("chip");
    preview.open(anchor());
    preview.leave("chip");

    preview.enter("chip");
    preview.open(anchor({ id: "ref_b" }));
    clock.run();

    expect(preview.preview.value?.id).toBe("ref_b");

    preview.leave("chip");
    clock.run();
    expect(preview.preview.value).toBeNull();
  });
});

describe("the reference preview's dismissal", () => {
  test("Escape returns focus to the trigger without the focus reopening it", () => {
    const preview = useReferencePreview();
    const focusOpenChecks: boolean[] = [];
    const trigger = {
      isConnected: true,
      closest: () => null,
      focus() {
        focusOpenChecks.push(preview.allowsFocusOpen());
      },
    };
    preview.open(anchor({ trigger }));

    preview.focusTrigger();

    expect(preview.preview.value).toBeNull();
    expect(focusOpenChecks).toEqual([false]);
    // The suppression is one-shot; the next real focus may open it again.
    expect(preview.allowsFocusOpen()).toBe(true);
  });

  test("an outside or composer close resets stale panel state", () => {
    const clock = manualTimers();
    const preview = useReferencePreview({ timers: clock.timers });
    preview.enter("panel");
    preview.open(anchor());
    preview.close();

    // A stale "pointer is in the panel" flag would keep the next preview open
    // forever, because the unmounted panel never sends a mouseleave.
    preview.enter("chip");
    preview.open(anchor({ id: "ref_b" }));
    preview.leave("chip");
    clock.run();
    expect(preview.preview.value).toBeNull();
  });

  test("removal closes only the preview it names", () => {
    const preview = useReferencePreview();
    preview.open(anchor());

    preview.hideIf("ref_other");
    expect(preview.preview.value?.id).toBe("ref_a");

    preview.hideIf("ref_a");
    expect(preview.preview.value).toBeNull();

    preview.open(anchor());
    preview.hideMissing(["ref_b"]);
    expect(preview.preview.value).toBeNull();

    preview.open(anchor());
    preview.hideMissing(["ref_a", "ref_b"]);
    expect(preview.preview.value?.id).toBe("ref_a");
  });
});

describe("placing the preview inside the viewport", () => {
  const viewport = { width: 1000, height: 800 };

  test("prefers the space above and clamps to the left edge", () => {
    const placed = placeReferencePreview(
      { left: 900, top: 700, bottom: 716 },
      viewport,
    );
    expect(placed.left).toBe(viewport.width - REFERENCE_PREVIEW_MARGIN - REFERENCE_PREVIEW_MAX_WIDTH);
    expect(placed.top).toBeNull();
    expect(placed.bottom).toBe(viewport.height - 700 + REFERENCE_PREVIEW_GAP);
    expect(placed.maxHeight).toBe(REFERENCE_PREVIEW_MAX_HEIGHT);
  });

  test("opens below a chip near the top and stays inside the right edge", () => {
    const placed = placeReferencePreview(
      { left: -30, top: 40, bottom: 60 },
      viewport,
    );
    expect(placed.left).toBe(REFERENCE_PREVIEW_MARGIN);
    expect(placed.top).toBe(60 + REFERENCE_PREVIEW_GAP);
    expect(placed.bottom).toBeNull();
    expect(placed.maxHeight).toBe(REFERENCE_PREVIEW_MAX_HEIGHT);
  });

  test("shrinks to the shorter side on a short viewport", () => {
    const placed = placeReferencePreview(
      { left: 100, top: 140, bottom: 180 },
      { width: 1000, height: 260 },
    );
    expect(placed.top).toBeNull();
    expect(placed.bottom).toBe(260 - 140 + REFERENCE_PREVIEW_GAP);
    expect(placed.maxHeight).toBe(140 - REFERENCE_PREVIEW_GAP - REFERENCE_PREVIEW_MARGIN);
  });

  test("falls back to the margins when the chip covers the viewport", () => {
    const placed = placeReferencePreview(
      { left: 0, top: 0, bottom: 800 },
      { width: 400, height: 800 },
    );
    expect(placed.left).toBe(REFERENCE_PREVIEW_MARGIN);
    expect(placed.top).toBe(REFERENCE_PREVIEW_MARGIN);
    expect(placed.bottom).toBeNull();
    expect(placed.maxHeight).toBe(800 - REFERENCE_PREVIEW_MARGIN * 2);
  });
});

import { describe, expect, test } from "bun:test";

import { useContextMeter } from "./useContextMeter";
import type { TokenUsage } from "~/types/desktop";
import type { MeterCompactProps } from "~/types/session";

// Direct tests for the meter's pure derivations: every number the ring, the
// popover rows and the Compact control read. Fixtures spell out the exact
// visible strings (via formatContextTokens/formatWindowPercent: 5k, 1.5k,
// 10k, 50%) so a formatting drift fails loudly here rather than in a shot.

function meter(usage: TokenUsage, compact: MeterCompactProps = {}) {
  return useContextMeter({ usage: () => usage, compact: () => compact });
}

describe("useContextMeter — percentage and level thresholds", () => {
  test("an empty window reads calm at 0%", () => {
    const m = meter({ contextUsed: 0, contextWindow: 10000 });

    expect(m.percentage.value).toBe(0);
    expect(m.level.value).toBe("calm");
    expect(m.showRing.value).toBe(true);
    expect(m.usageLabel.value).toBe("0% used · 0 of 10k tokens");
  });

  test("69% is calm, 70% tips warm", () => {
    expect(meter({ contextUsed: 6999, contextWindow: 10000 }).level.value).toBe("calm");
    expect(meter({ contextUsed: 7000, contextWindow: 10000 }).level.value).toBe("warm");
    expect(meter({ contextUsed: 7000, contextWindow: 10000 }).percentage.value).toBe(70);
  });

  test("89% is warm, 90% tips full", () => {
    expect(meter({ contextUsed: 8999, contextWindow: 10000 }).level.value).toBe("warm");
    expect(meter({ contextUsed: 9000, contextWindow: 10000 }).level.value).toBe("full");
  });

  test("fill past the window clamps at 100% full and drops the Remaining row", () => {
    const m = meter({ contextUsed: 12000, contextWindow: 10000 });

    expect(m.percentage.value).toBe(100);
    expect(m.level.value).toBe("full");
    expect(m.rows.value).toEqual([
      { label: "Used", value: "100% · 12k" },
      { label: "Window", value: "10k" },
    ]);
  });

  test("a negative fill clamps to zero rather than rendering negative rows", () => {
    const m = meter({ contextUsed: -50, contextWindow: 10000 });

    expect(m.used.value).toBe(0);
    expect(m.percentage.value).toBe(0);
    expect(m.level.value).toBe("calm");
  });
});

describe("useContextMeter — unknown-window handling", () => {
  test("no window hides the ring and falls back to a bare token label", () => {
    const m = meter({ contextUsed: 100 });

    expect(m.hasWindow.value).toBe(false);
    expect(m.showRing.value).toBe(false);
    expect(m.usageLabel.value).toBe("100 tokens used");
    expect(m.compactNote.value).toBe("Auto-compacts when full.");
    expect(m.rows.value).toEqual([]);
  });

  test("no usage at all hides the ring without claiming an empty window", () => {
    const m = meter({});

    expect(m.usedKnown.value).toBeUndefined();
    expect(m.showRing.value).toBe(false);
    expect(m.percentage.value).toBe(0);
    expect(m.level.value).toBe("calm");
    expect(m.usageLabel.value).toBe("0 tokens used");
    expect(m.rows.value).toEqual([]);
  });

  test("a zero window is no window", () => {
    const m = meter({ contextUsed: 50, contextWindow: 0 });

    expect(m.hasWindow.value).toBe(false);
    expect(m.showRing.value).toBe(false);
    expect(m.usageLabel.value).toBe("50 tokens used");
  });

  test("a window with no reported fill hides the ring but still names the window", () => {
    const m = meter({ contextWindow: 10000 });

    expect(m.usedKnown.value).toBeUndefined();
    expect(m.showRing.value).toBe(false);
    expect(m.rows.value).toEqual([{ label: "Window", value: "10k" }]);
  });
});

describe("useContextMeter — rows, note, and tooltip", () => {
  const full = {
    contextUsed: 5000,
    contextWindow: 10000,
    input: 3000,
    output: 1500,
    total: 4500,
    compactsAutomatically: true,
  };

  test("a full snapshot spells every popover row", () => {
    const m = meter(full);

    expect(m.rows.value).toEqual([
      { label: "Used", value: "50% · 5k" },
      { label: "Remaining", value: "5k" },
      { label: "Input", value: "3k" },
      { label: "Output", value: "1.5k" },
      { label: "Total", value: "4.5k" },
      { label: "Window", value: "10k" },
    ]);
  });

  test("the note names the auto-compact threshold only when one is known", () => {
    expect(meter(full).note.value).toBe("Auto-compacts at ~10k.");
    expect(meter({ ...full, compactsAutomatically: false }).note.value).toBe("");
    expect(meter({ contextUsed: 100 }).note.value).toBe("");
  });

  test("the tooltip appends the threshold note for auto-compacting providers", () => {
    expect(meter(full).tooltip.value).toBe("50% used · 5k of 10k tokens. Auto-compacts at ~10k.");
    expect(meter({ ...full, compactsAutomatically: false }).tooltip.value).toBe(
      "50% used · 5k of 10k tokens",
    );
  });
});

describe("useContextMeter — compact gating", () => {
  const usage = { contextUsed: 1000, contextWindow: 10000 };

  test("absent compact props read as a pure read-out: ready, never busy", () => {
    const m = meter(usage, {});

    expect(m.compactReady.value).toBe(true);
    expect(m.compactBusy.value).toBe(false);
  });

  test("a compacting thread is busy and not ready", () => {
    const m = meter(usage, { compactState: "compacting" });

    expect(m.compactReady.value).toBe(false);
    expect(m.compactBusy.value).toBe(true);
  });

  test("an unavailable thread is neither ready nor busy", () => {
    const m = meter(usage, { compactState: "unavailable" });

    expect(m.compactReady.value).toBe(false);
    expect(m.compactBusy.value).toBe(false);
  });

  test("pressCompact runs the handler when ready", () => {
    let calls = 0;
    const m = meter(usage, {
      compactState: "available",
      onCompact: () => {
        calls += 1;
      },
    });

    m.pressCompact();

    expect(calls).toBe(1);
  });

  test("an absent compact state with a handler still reads as available", () => {
    let calls = 0;
    const m = meter(usage, {
      onCompact: () => {
        calls += 1;
      },
    });

    expect(m.compactReady.value).toBe(true);
    m.pressCompact();
    expect(calls).toBe(1);
  });

  test("pressCompact stays quiet while compacting or without a handler", () => {
    let calls = 0;
    const busy = meter(usage, {
      compactState: "compacting",
      onCompact: () => {
        calls += 1;
      },
    });
    busy.pressCompact();

    const noHandler = meter(usage, { compactState: "available" });
    noHandler.pressCompact();

    expect(calls).toBe(0);
  });
});

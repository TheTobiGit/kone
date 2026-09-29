import { describe, expect, test } from "bun:test";
import { EDGE_REACH, LOOK_AHEAD, edgeFades, sectionAt, type ColumnSpan } from "./spaceSections";

type Section = "telemetry" | "models" | "instructions";

// The board as laid out on a wide window: Activity, Models, then AGENTS.md and
// CLAUDE.md, which are one section.
const spans: ColumnSpan<Section>[] = [
  { section: "telemetry", left: 0, right: 1024 },
  { section: "models", left: 1024, right: 1444 },
  { section: "instructions", left: 1444, right: 1904 },
  { section: "instructions", left: 1904, right: 2364 },
];

describe("sectionAt", () => {
  test("at the start of the row the camera is on Telemetry, however much else is in view", () => {
    // A 1336px track shows all of Activity and all of Models at once. Models
    // was being called current here, because it was as visible as Activity.
    expect(sectionAt(spans, 0)).toBe("telemetry");
  });

  test("a column landed flush against the pane is the current one", () => {
    expect(sectionAt(spans, 0)).toBe("telemetry");
    expect(sectionAt(spans, 1024)).toBe("models");
    expect(sectionAt(spans, 1444)).toBe("instructions");
  });

  test("the next column takes over as its leading edge comes within reach of the pane", () => {
    const edge = 1024 - LOOK_AHEAD; // Models' left edge is exactly LOOK_AHEAD from the pane
    expect(sectionAt(spans, edge - 1)).toBe("telemetry");
    expect(sectionAt(spans, edge)).toBe("models");
  });

  test("half way through a column it is still the current one", () => {
    expect(sectionAt(spans, 400)).toBe("telemetry");
    expect(sectionAt(spans, 1200)).toBe("models");
  });

  test("both columns of a section are the section", () => {
    expect(sectionAt(spans, 1444)).toBe("instructions");
    expect(sectionAt(spans, 1904)).toBe("instructions");
  });

  test("room scrolled past the last column is still the last section", () => {
    expect(sectionAt(spans, 2364)).toBe("instructions");
    expect(sectionAt(spans, 5000)).toBe("instructions");
  });

  test("an overscroll before the start is the first section", () => {
    expect(sectionAt(spans, -80)).toBe("telemetry");
  });

  test("a track that has not been measured has no section", () => {
    expect(sectionAt([], 0)).toBeNull();
  });

  test("a narrow window, where one column fills the track, walks the row in order", () => {
    const narrow: ColumnSpan<Section>[] = [
      { section: "telemetry", left: 0, right: 360 },
      { section: "models", left: 360, right: 720 },
      { section: "instructions", left: 720, right: 1080 },
    ];
    const seen = [0, 360, 720].map((at) => sectionAt(narrow, at));
    expect(seen).toEqual(["telemetry", "models", "instructions"]);
  });
});

describe("edgeFades", () => {
  // A 1336px track over the same board.
  const VIEW = 1336;

  test("at the start nothing fades on the left; the right edge is cutting into Models", () => {
    expect(edgeFades(spans, 0, VIEW)).toEqual({ left: 0, right: EDGE_REACH });
  });

  test("a column landed flush against the pane has nothing over it", () => {
    expect(edgeFades(spans, 1024, VIEW).left).toBe(0);
    expect(edgeFades(spans, 1444, VIEW).left).toBe(0);
  });

  test("the left fade never runs into the column that is arriving", () => {
    // 24px short of Models: the edge is in Activity's last 24px, so the fade is
    // 24px long and ends where Activity does, not over Models.
    const { left } = edgeFades(spans, 1000, VIEW);
    expect(left).toBe(24);
    expect(1000 + left).toBeLessThanOrEqual(1024);
    // ... and at the moment of landing it is gone, with nothing to snap from.
    expect(edgeFades(spans, 1023, VIEW).left).toBe(1);
    expect(edgeFades(spans, 1024, VIEW).left).toBe(0);
  });

  test("the fade grows as the edge moves into a column, up to its reach", () => {
    expect(edgeFades(spans, 10, VIEW).left).toBe(10);
    expect(edgeFades(spans, 400, VIEW).left).toBe(EDGE_REACH);
    expect(edgeFades(spans, 1030, VIEW).left).toBe(6);
  });

  test("an edge in the gap between two columns' content has no fade", () => {
    // Content sits 6px in from each column edge: Activity's ends at 1018 and
    // Models' begins at 1030.
    expect(edgeFades(spans, 1020, VIEW, 6).left).toBe(0);
    expect(edgeFades(spans, 1000, VIEW, 6).left).toBe(18);
  });

  test("an edge exactly on a column boundary cuts nothing on the right", () => {
    expect(edgeFades(spans, 1444 - VIEW, VIEW).right).toBe(0);
  });

  test("the right fade shrinks as the last of a column comes into view", () => {
    // 10px of Models still hidden beyond the edge.
    expect(edgeFades(spans, 1434 - VIEW, VIEW).right).toBe(10);
  });

  test("scrolled to the end, with the last column's room beyond it, nothing fades on the right", () => {
    expect(edgeFades(spans, 3000, VIEW).right).toBe(0);
    expect(edgeFades(spans, 2364 - VIEW, VIEW).right).toBe(0);
  });

  test("an overscroll before the start fades nothing on the left", () => {
    expect(edgeFades(spans, -80, VIEW).left).toBe(0);
  });

  test("a track that has not been measured fades nothing", () => {
    expect(edgeFades([], 500, VIEW)).toEqual({ left: 0, right: 0 });
  });
});

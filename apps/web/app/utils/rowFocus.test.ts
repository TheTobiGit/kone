import { describe, expect, test } from "bun:test";
import {
  planeDestinations,
  recordsStanding,
  renderPlaneRows,
  resolveLandingProject,
  resolveRowFocus,
  type FocusRow,
  type RenderRow,
} from "./rowFocus";

const A = "/Developer/kone";
const B = "/Developer/opensource/synara";
const C = "/Developer/opensource/t3code";

function rows(...spec: [string, boolean?][]): FocusRow[] {
  return spec.map(([projectPath, transient]) => ({ projectPath, transient: !!transient }));
}

// The whole reason this module exists. Closing the last pane in the row you are
// standing in must not move the camera into another project.
describe("closing the last pane in the row you are standing in", () => {
  test("keeps the camera on your project, which is now the transient row", () => {
    // B's last pane closed: it left the axis, and AppStudio re-added it as the
    // transient row for the open project. The axis has fallen back to C.
    expect(
      resolveRowFocus({
        rows: rows([A], [C], [B, true]),
        transientFocus: null,
        standing: B,
        axisPath: C,
      }),
    ).toBe(B);
  });

  test("still holds when the axis falls back to the row above instead", () => {
    expect(
      resolveRowFocus({
        rows: rows([A], [B, true]),
        transientFocus: null,
        standing: B,
        axisPath: A,
      }),
    ).toBe(B);
  });

  test("releases on its own once the row has work again", () => {
    // The first new pane makes B persisted again; the pin no longer applies and
    // the axis — which now names B — resolves it.
    expect(
      resolveRowFocus({
        rows: rows([A], [B]),
        transientFocus: null,
        standing: B,
        axisPath: B,
      }),
    ).toBe(B);
  });

  test("does not follow a project that is no longer open", () => {
    // B emptied and its project was closed too, so there is no transient row for
    // it. Nothing to stand in; the axis decides.
    expect(
      resolveRowFocus({
        rows: rows([A], [C]),
        transientFocus: null,
        standing: B,
        axisPath: C,
      }),
    ).toBe(C);
  });
});

describe("what the pin must not shadow", () => {
  test("a deliberate move to another row wins", () => {
    // Travelling records the new row, so a stale pin can never outrank it.
    expect(
      resolveRowFocus({
        rows: rows([A], [B], [C]),
        transientFocus: null,
        standing: C,
        axisPath: C,
      }),
    ).toBe(C);
  });

  test("a newly-born row takes focus while you stand in a persisted row", () => {
    // standing names a row that is still persisted, so the pin does not apply
    // and the axis's choice of the new row stands.
    expect(
      resolveRowFocus({
        rows: rows([A], [B], [C]),
        transientFocus: null,
        standing: A,
        axisPath: C,
      }),
    ).toBe(C);
  });

  test("an explicit transient focus outranks a stale standing row", () => {
    expect(
      resolveRowFocus({
        rows: rows([A], [C, true]),
        transientFocus: C,
        standing: A,
        axisPath: A,
      }),
    ).toBe(C);
  });
});

describe("fallbacks", () => {
  test("an empty plane has no focus", () => {
    expect(
      resolveRowFocus({ rows: [], transientFocus: null, standing: A, axisPath: A }),
    ).toBeNull();
  });

  test("an axis pointing at a row that is gone falls to the last row", () => {
    expect(
      resolveRowFocus({ rows: rows([A], [C]), transientFocus: null, standing: null, axisPath: B }),
    ).toBe(C);
  });

  test("no axis focus at all falls to the last row, where a new one is born", () => {
    expect(
      resolveRowFocus({ rows: rows([A], [B]), transientFocus: null, standing: null, axisPath: null }),
    ).toBe(B);
  });
});

describe("recording where we stand", () => {
  test("records a persisted row", () => {
    expect(recordsStanding(rows([A], [B]), B)).toBe(true);
  });

  test("refuses a transient row, so the pin survives the transition", () => {
    expect(recordsStanding(rows([A], [B, true]), B)).toBe(false);
  });

  test("refuses a row that is not on the plane, and refuses nothing at all", () => {
    expect(recordsStanding(rows([A]), C)).toBe(false);
    expect(recordsStanding(rows([A]), null)).toBe(false);
  });
});

// The three cases that decide whether the studio opens at all, and where.
describe("which project the studio lands in", () => {
  const kone = { path: "/Developer/kone", name: "kone" };
  const synara = { path: "/Developer/opensource/synara", name: "synara" };
  const t3code = { path: "/Developer/opensource/t3code", name: "t3code" };

  test("no projects in the app at all — there is no studio to enter", () => {
    expect(resolveLandingProject(null, [])).toBeNull();
  });

  test("one project, no work on it — the studio opens on that one", () => {
    expect(resolveLandingProject(null, [kone])).toEqual(kone);
  });

  test("several projects, no work on any — the studio opens on the most recent", () => {
    expect(resolveLandingProject(null, [t3code, synara, kone])).toEqual(t3code);
  });

  test("a project page is open — that one wins over recency", () => {
    expect(resolveLandingProject(synara, [t3code, kone])).toEqual(synara);
  });

  test("an open project that is not in recents yet is still where we land", () => {
    expect(resolveLandingProject(kone, [])).toEqual(kone);
  });
});

// The transient rows the plane conjures. The case that keeps going wrong is a
// row conjured for one project wearing another project's name, which is what
// happens the moment the pin stops carrying its own label.
describe("renderPlaneRows", () => {
  const persisted = [
    { projectPath: A, name: "kone" },
    { projectPath: B, name: "synara" },
  ];

  test("passes the persisted rows through untouched when nothing is pinned", () => {
    expect(renderPlaneRows(persisted, null, null)).toEqual([
      { projectPath: A, name: "kone", transient: false },
      { projectPath: B, name: "synara", transient: false },
    ]);
  });

  test("puts an emptied row back in the slot it held, under its own name", () => {
    // C's last pane closed, so the axis dropped it — it sat between A and B.
    expect(
      renderPlaneRows(persisted, { path: C, name: "t3code", index: 1 }, null),
    ).toEqual([
      { projectPath: A, name: "kone", transient: false },
      { projectPath: C, name: "t3code", transient: true },
      { projectPath: B, name: "synara", transient: false },
    ]);
  });

  test("a project travelled to that never had a row lands at the foot", () => {
    const rows = renderPlaneRows(
      persisted,
      { path: C, name: "t3code", index: persisted.length },
      null,
    );
    expect(rows[rows.length - 1]).toEqual({
      projectPath: C,
      name: "t3code",
      transient: true,
    });
    // And it does not take another project's name or another project's slot
    // with it — the whole reason the pin carries its own label.
    expect(rows.filter((r) => r.name === "t3code")).toHaveLength(1);
    expect(rows.map((r) => r.projectPath)).toEqual([A, B, C]);
  });

  test("an index past the end clamps to the foot rather than dropping the row", () => {
    const rows = renderPlaneRows(persisted, { path: C, name: "t3code", index: 99 }, null);
    expect(rows.map((r) => r.projectPath)).toEqual([A, B, C]);
  });

  test("the pin stops applying the moment the project persists a row again", () => {
    // The conjured row opened its first pane, so the axis owns it now. One row
    // for it, not two, and not a transient one.
    const rows = renderPlaneRows(
      [...persisted, { projectPath: C, name: "t3code" }],
      { path: C, name: "t3code", index: 2 },
      null,
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => !r.transient)).toBe(true);
  });

  test("the landing project gets a row when it has none, and none when it has one", () => {
    expect(
      renderPlaneRows(persisted, null, { path: C, name: "t3code" }),
    ).toHaveLength(3);
    expect(renderPlaneRows(persisted, null, { path: A, name: "kone" })).toHaveLength(2);
  });

  test("standing on the landing project conjures one row, not two", () => {
    const rows = renderPlaneRows(
      persisted,
      { path: C, name: "t3code", index: 2 },
      { path: C, name: "t3code" },
    );
    expect(rows.filter((r) => r.projectPath === C)).toHaveLength(1);
  });
});

// The list behind the strip's project drop-down. It has to agree with the rule
// above about where travel lands, because it is what offers the travel.
describe("planeDestinations", () => {
  const rows: RenderRow[] = [
    { projectPath: A, name: "kone", transient: false },
    { projectPath: B, name: "synara", transient: false },
  ];
  const persisted = [
    { projectPath: A, paneCount: 3 },
    { projectPath: B, paneCount: 1 },
  ];

  test("lists the rows in camera order, with the work waiting in each", () => {
    expect(planeDestinations(rows, persisted, [])).toEqual([
      { projectPath: A, name: "kone", columns: 3 },
      { projectPath: B, name: "synara", columns: 1 },
    ]);
  });

  test("a project with no row yet joins the foot, where travel would land it", () => {
    const list = planeDestinations(rows, persisted, [
      { path: B, name: "synara" },
      { path: C, name: "t3code" },
    ]);
    expect(list.map((d) => d.projectPath)).toEqual([A, B, C]);
    expect(list[2]).toEqual({ projectPath: C, name: "t3code", columns: 0 });
  });

  // A transient row is on screen precisely because nothing is open in it, so
  // the count it shows is the count it has: none.
  test("a transient row is listed, and counts no columns", () => {
    const list = planeDestinations(
      [...rows, { projectPath: C, name: "t3code", transient: true }],
      persisted,
      [{ path: C, name: "t3code" }],
    );
    expect(list.filter((d) => d.projectPath === C)).toEqual([
      { projectPath: C, name: "t3code", columns: 0 },
    ]);
  });

  test("a row the axis kept a count for but stopped rendering is not listed", () => {
    const list = planeDestinations(
      [{ projectPath: A, name: "kone", transient: false }],
      persisted,
      [],
    );
    expect(list.map((d) => d.projectPath)).toEqual([A]);
  });

  test("nothing anywhere is an empty list rather than a throw", () => {
    expect(planeDestinations([], [], [])).toEqual([]);
  });
});

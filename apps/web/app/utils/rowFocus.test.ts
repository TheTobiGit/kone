import { describe, expect, test } from "bun:test";
import {
  recordsStanding,
  resolveLandingProject,
  resolveRowFocus,
  type FocusRow,
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

import { beforeEach, describe, expect, test } from "bun:test";
import {
  resetStudioPlane,
  setFocusedRow,
  studioPlane,
  useStudioPersistence,
} from "./useStudioPersistence";
import type { PaneEntry } from "~/types/studio";

// The plane is module state, so each test starts from an empty one. Rows are
// written through the real save path: the focus rule under test lives there.
function pane(id: string): PaneEntry {
  return { id, kind: "thread", anchor: { kind: "thread", threadId: null }, width: 0 };
}

function save(projectPath: string, paneIds: string[]): void {
  useStudioPersistence(projectPath).saveRow({
    projectPath,
    panes: paneIds.map(pane),
    focusedId: paneIds[0] ?? null,
  });
}

const A = "/Developer/kone";
const B = "/Developer/opensource/synara";
const C = "/Developer/opensource/t3code";

beforeEach(() => {
  resetStudioPlane();
});

describe("saving a row", () => {
  test("the first row on an empty plane takes focus", () => {
    save(A, ["p1"]);
    expect(studioPlane().value?.focusedRow).toBe(A);
  });

  test("a row being edited keeps the focus the plane already has", () => {
    save(A, ["p1"]);
    save(A, ["p1", "p2"]);
    expect(studioPlane().value?.focusedRow).toBe(A);
  });

  // The interleaving this rule exists for: a row born while the user was
  // looking at it, saved by a debounce that lands after they moved on. The save
  // is not a visit, so it must not drag the camera back.
  test("a later save of a new row does not override newer travel", () => {
    save(A, ["p1"]);
    save(C, ["p1"]);
    setFocusedRow(C); // the user has since travelled to C
    save(B, ["p1"]); // B's first save arrives late
    expect(studioPlane().value?.rows.map((r) => r.projectPath)).toEqual([A, C, B]);
    expect(studioPlane().value?.focusedRow).toBe(C);
  });

  test("a new row takes focus when the remembered row is gone", () => {
    save(A, ["p1"]);
    save(A, []); // A's last pane closed; the remembered row no longer exists
    save(B, ["p1"]);
    expect(studioPlane().value?.focusedRow).toBe(B);
  });

  test("an empty save leaves the remembered focus alone", () => {
    save(A, ["p1"]);
    save(C, ["p1"]);
    setFocusedRow(C);
    save(C, []);
    expect(studioPlane().value?.focusedRow).toBe(C);
  });
});

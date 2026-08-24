import { beforeEach, describe, expect, test } from "bun:test";
import { nextTick } from "vue";
import { useStudioPlane, __basename } from "./useStudioPlane";
import { useStudioPersistence, resetStudioPlane } from "./useStudioPersistence";
import type { PaneEntry } from "~/types/studio";

// The plane is module state, so each test starts from an empty one. Rows are
// seeded through the real write path rather than by poking the ref — a row born
// any other way would not prove the axis derives its set from the work.
function pane(id: string): PaneEntry {
  return { id, kind: "thread", anchor: { kind: "thread", threadId: null }, width: 0 };
}

function seed(projectPath: string, paneIds: string[]): void {
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

describe("row set", () => {
  test("an empty plane has no rows and no focus", () => {
    const plane = useStudioPlane();
    expect(plane.rows.value).toEqual([]);
    expect(plane.focusedPath.value).toBeNull();
    expect(plane.focusedIndex.value).toBe(-1);
  });

  test("a row appears with its first pane and carries its name and weight", () => {
    seed(A, ["p1", "p2"]);
    const plane = useStudioPlane();
    expect(plane.rows.value).toHaveLength(1);
    expect(plane.rows.value[0]).toMatchObject({
      projectPath: A,
      name: "kone",
      paneCount: 2,
      focusedId: "p1",
    });
  });

  test("a row dies with its last pane", () => {
    seed(A, ["p1"]);
    seed(B, ["p1"]);
    const plane = useStudioPlane();
    expect(plane.rows.value.map((r) => r.name)).toEqual(["kone", "synara"]);

    seed(A, []); // its last pane closed
    expect(plane.rows.value.map((r) => r.name)).toEqual(["synara"]);
  });
});

describe("travel", () => {
  test("stepping moves one row at a time and stops at both ends", () => {
    seed(A, ["p1"]);
    seed(B, ["p1"]);
    seed(C, ["p1"]);
    const plane = useStudioPlane();

    expect(plane.focusRow(A)).toBe(true);
    expect(plane.focusedIndex.value).toBe(0);

    // Up from the top row refuses rather than wrapping to the bottom.
    expect(plane.stepRow(-1)).toBe(false);
    expect(plane.focusedIndex.value).toBe(0);

    expect(plane.stepRow(1)).toBe(true);
    expect(plane.focusedPath.value).toBe(B);
    expect(plane.stepRow(1)).toBe(true);
    expect(plane.focusedPath.value).toBe(C);

    // And down from the bottom row likewise.
    expect(plane.stepRow(1)).toBe(false);
    expect(plane.focusedPath.value).toBe(C);
  });

  test("focusing a project with no row is refused, not invented", () => {
    seed(A, ["p1"]);
    const plane = useStudioPlane();
    expect(plane.focusRow("/Developer/nothing-here")).toBe(false);
    expect(plane.focusedPath.value).toBe(A);
    expect(plane.rows.value).toHaveLength(1);
  });

  test("stepping an empty plane is a no-op", () => {
    const plane = useStudioPlane();
    expect(plane.stepRow(1)).toBe(false);
    expect(plane.stepRow(-1)).toBe(false);
  });
});

describe("focus handoff when a row dies", () => {
  test("focus lands on the row that took its place", async () => {
    seed(A, ["p1"]);
    seed(B, ["p1"]);
    seed(C, ["p1"]);
    const plane = useStudioPlane();

    plane.focusRow(B);
    await nextTick(); // the axis records the index it is sitting at
    expect(plane.focusedIndex.value).toBe(1);

    seed(B, []); // the focused row's last pane closed
    // C slid up into index 1 — the row now under the eye.
    expect(plane.focusedPath.value).toBe(C);
    expect(plane.focusedIndex.value).toBe(1);
  });

  test("losing the last row clamps to the new end instead of pointing past it", async () => {
    seed(A, ["p1"]);
    seed(B, ["p1"]);
    const plane = useStudioPlane();

    plane.focusRow(B);
    await nextTick();
    expect(plane.focusedIndex.value).toBe(1);

    seed(B, []);
    expect(plane.focusedPath.value).toBe(A);
    expect(plane.focusedIndex.value).toBe(0);
  });

  test("the last row dying leaves the plane with no focus at all", async () => {
    seed(A, ["p1"]);
    const plane = useStudioPlane();
    plane.focusRow(A);
    await nextTick();

    seed(A, []);
    expect(plane.rows.value).toEqual([]);
    expect(plane.focusedPath.value).toBeNull();
    expect(plane.focusedIndex.value).toBe(-1);
  });
});

describe("row names", () => {
  test("a trailing separator does not produce an empty name", () => {
    expect(__basename("/Developer/kone/")).toBe("kone");
    expect(__basename("/Developer/kone")).toBe("kone");
    expect(__basename("kone")).toBe("kone");
  });
});

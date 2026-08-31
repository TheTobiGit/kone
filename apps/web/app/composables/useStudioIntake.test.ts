import { beforeEach, describe, expect, test } from "bun:test";
import { useStudioIntake } from "./useStudioIntake";
import { useStudioPersistence, resetStudioPlane, studioPlane } from "./useStudioPersistence";
import { useStudioRowRegistry } from "./useStudioRowRegistry";
import type { StudioRowApi } from "./useStudioRowRegistry";
import type { PaneEntry } from "~/types/studio";

const A = "/Developer/kone";
const B = "/Developer/opensource/synara";

function pane(id: string, threadId: string | null): PaneEntry {
  return { id, kind: "thread", anchor: { kind: "thread", threadId }, width: 0 };
}

function rowFor(projectPath: string) {
  return studioPlane().value?.rows.find((r) => r.projectPath === projectPath) ?? null;
}

function threadIdsOn(projectPath: string): (string | null)[] {
  return (rowFor(projectPath)?.panes ?? []).map((p) =>
    p.anchor.kind === "thread" ? p.anchor.threadId : null,
  );
}

/** A row that records what it was handed, standing in for a mounted one. */
function fakeRow(): StudioRowApi & { adopted: string[] } {
  const adopted: string[] = [];
  return {
    adopted,
    adoptThread: (threadId: string) => adopted.push(threadId),
    openSession: () => {},
    revealThread: async () => {},
    archiveSession: () => {},
    removeSession: () => {},
    sessionBusy: () => false,
    openThread: () => {},
    newThread: () => {},
    openTerminal: () => {},
    openScratchpad: () => {},
    flush: () => {},
    interruptIfRunning: () => {},
  };
}

const registry = useStudioRowRegistry();

beforeEach(() => {
  resetStudioPlane();
  registry.unregister(A);
  registry.unregister(B);
});

describe("no row mounted", () => {
  test("a thread brings its project's row into being", async () => {
    await useStudioIntake().adoptThread(A, "t-1");
    expect(threadIdsOn(A)).toEqual(["t-1"]);
  });

  test("a second thread joins the right edge of the row it already has", async () => {
    const intake = useStudioIntake();
    await intake.adoptThread(A, "t-1");
    await intake.adoptThread(A, "t-2");
    expect(threadIdsOn(A)).toEqual(["t-1", "t-2"]);
  });

  test("panes already on the row keep their place and their focus", async () => {
    useStudioPersistence(A).saveRow({
      projectPath: A,
      panes: [pane("p1", "t-old"), pane("p2", null)],
      focusedId: "p2",
    });
    await useStudioIntake().adoptThread(A, "t-new");
    expect(threadIdsOn(A)).toEqual(["t-old", null, "t-new"]);
    expect(rowFor(A)?.focusedId).toBe("p2");
  });

  test("one conversation, one pane — adopting twice adds nothing", async () => {
    const intake = useStudioIntake();
    await intake.adoptThread(A, "t-1");
    await intake.adoptThread(A, "t-1");
    expect(threadIdsOn(A)).toEqual(["t-1"]);
  });

  test("the thread lands on its own project's row, not another's", async () => {
    const intake = useStudioIntake();
    await intake.adoptThread(A, "t-a");
    await intake.adoptThread(B, "t-b");
    expect(threadIdsOn(A)).toEqual(["t-a"]);
    expect(threadIdsOn(B)).toEqual(["t-b"]);
  });
});

describe("row mounted", () => {
  test("the row is handed the thread and the document is left to it", async () => {
    const row = fakeRow();
    registry.register(A, row);
    await useStudioIntake().adoptThread(A, "t-1");
    expect(row.adopted).toEqual(["t-1"]);
    // A mounted row is the only writer of its own layout — writing behind it
    // would be clobbered by its next save.
    expect(rowFor(A)).toBeNull();
  });

  test("a row that mounts while the plane is being read still gets the thread", async () => {
    const row = fakeRow();
    const pending = useStudioIntake().adoptThread(A, "t-1");
    registry.register(A, row);
    await pending;
    expect(row.adopted).toEqual(["t-1"]);
    expect(rowFor(A)).toBeNull();
  });
});

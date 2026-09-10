import { describe, expect, test } from "bun:test";
import {
  createInboxReadingPaneState,
  openThread,
  pickThread,
  resolveInboxReadingPane,
  threadStarted,
} from "./inboxReadingPane";
import type { SessionSummary } from "~/types/session";

function row(threadId: string, extra?: Partial<SessionSummary>): SessionSummary {
  return {
    threadId,
    title: `Thread ${threadId}`,
    provider: "codex",
    brand: "gpt",
    updatedAt: 1,
    ...extra,
  };
}

describe("resolveInboxReadingPane", () => {
  test("an unvisited portal with nothing picked is idle, not the composer", () => {
    // Mounting the composer claims a live session, and the portal mounts at
    // boot — so before the first visit the pane must stay blank rather than
    // naming a composer nobody asked for.
    const pane = resolveInboxReadingPane(createInboxReadingPaneState());
    expect(pane).toEqual({ kind: "idle" });
    expect(pane.kind !== "reader").toBe(true);
  });

  test("the empty state is the composer once visited", () => {
    // Nothing picked and nothing being composed: with nowhere to read, the
    // pane rests on the composer rather than rendering a blank hole.
    const state = createInboxReadingPaneState();
    state.visited = true;
    const pane = resolveInboxReadingPane(state);
    expect(pane).toEqual({ kind: "composer" });
    expect(pane.kind !== "reader").toBe(true);
  });

  test("compose hands over to the reader once the thread starts", () => {
    const state = createInboxReadingPaneState();
    state.visited = true;
    state.composing = true;
    expect(resolveInboxReadingPane(state)).toEqual({ kind: "composer" });

    const started = row("t-1", { projectPath: "/work/alpha", projectName: "alpha" });
    threadStarted(state, started, "session-1");
    const pane = resolveInboxReadingPane(state);
    expect(pane).toEqual({ kind: "reader", row: started, sessionKey: "session-1" });
    expect(pane.kind !== "reader").toBe(false);
  });

  test("starting to compose keeps the selection underneath", () => {
    const state = createInboxReadingPaneState();
    state.visited = true;
    const kept = row("t-kept");
    threadStarted(state, kept, "session-1");
    state.composing = true;
    expect(resolveInboxReadingPane(state)).toEqual({ kind: "composer" });
    expect(state.selected).toBe(kept);
  });

  test("picking a thread drops the composer's session key", () => {
    const state = createInboxReadingPaneState();
    state.visited = true;
    threadStarted(state, row("t-1"), "session-1");

    // The newly picked row arrives through the list binding just before the
    // pick runs; the handover key belonged to the composer's thread and must
    // not leak onto one that opens the ordinary way.
    state.selected = row("t-2");
    pickThread(state);
    const pane = resolveInboxReadingPane(state);
    expect(pane).toEqual({ kind: "reader", row: state.selected, sessionKey: null });
    expect(pane.kind !== "reader").toBe(false);
  });

  test("opening a resolved thread shows it the ordinary way", () => {
    const state = createInboxReadingPaneState();
    state.visited = true;
    state.composing = true;
    const summary = row("t-parked", { projectPath: "/work/beta" });
    openThread(state, summary);
    expect(resolveInboxReadingPane(state)).toEqual({
      kind: "reader",
      row: summary,
      sessionKey: null,
    });
  });

  test("switching views preserves the selection", () => {
    // The resolver takes no view: the selection is portal-level, so swapping
    // the list on screen cannot disturb the thread being read.
    const state = createInboxReadingPaneState();
    state.visited = true;
    const reading = row("t-1");
    threadStarted(state, reading, "session-1");
    expect(resolveInboxReadingPane(state)).toEqual({
      kind: "reader",
      row: reading,
      sessionKey: "session-1",
    });
    expect(resolveInboxReadingPane(state)).toEqual({
      kind: "reader",
      row: reading,
      sessionKey: "session-1",
    });
    expect(state.selected).toBe(reading);
  });

  test("a visited portal never resolves idle", () => {
    // Once latched, the pane always has somewhere to be: the composer with
    // nothing picked, the reader with something picked.
    const state = createInboxReadingPaneState();
    state.visited = true;
    expect(resolveInboxReadingPane(state).kind).toBe("composer");
    openThread(state, row("t-1"));
    expect(resolveInboxReadingPane(state).kind).toBe("reader");
    state.selected = null;
    expect(resolveInboxReadingPane(state).kind).toBe("composer");
  });
});

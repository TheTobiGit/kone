import { describe, expect, it } from "bun:test";
import {
  VIEW_SELECTION_MAX,
  VIEW_TEXT_MAX,
  focusedTerminalOf,
  focusedThreadOf,
  renderViewSnapshot,
  parseViewSnapshot,
  viewSignature,
  type ViewSnapshot,
} from "./viewContext";

const kone = { name: "kone", path: "/home/u/kone" };

/** A push as it might arrive over IPC: any shape at all. Deliberately broad,
 *  since the malformed ones are what these tests exist to feed the parser. */
// eslint-disable-next-line anti-slop/no-object-parameters
function wire(value: object): Partial<ViewSnapshot> {
  // SAFETY: the parser under test checks every field; this only lets a test
  // hand it the malformed payloads it exists to refuse.
  return value as Partial<ViewSnapshot>;
}

function snapshot(partial: Partial<ViewSnapshot> = {}): ViewSnapshot {
  return {
    version: 1,
    at: 1_000_000,
    layers: [],
    assistantOpen: true,
    selection: null,
    ...partial,
  };
}

const studioOnThread = snapshot({
  layers: [
    {
      surface: "studio",
      mode: "row",
      row: {
        project: kone,
        panes: [
          { kind: "terminal", focused: false, terminalId: "t1", cwd: "/home/u/kone", status: "running", running: "bun dev" },
          {
            kind: "thread",
            focused: true,
            threadId: "th-1",
            title: "Fix titles",
            status: "waiting-for-approval",
            provider: "claudeAgent",
            model: "opus",
            waitingOn: { kind: "approval", summary: "rm -rf dist" },
          },
        ],
      },
      rows: [
        { ...kone, panes: 2, focused: true },
        { name: "api", path: "/home/u/api", panes: 1, focused: false },
      ],
    },
    { surface: "project", covered: true, project: kone, tab: "overview", branch: "main" },
  ],
});

describe("parseViewSnapshot", () => {
  it("keeps a well-formed snapshot as it was sent", () => {
    expect(parseViewSnapshot(studioOnThread)).toEqual(studioOnThread);
  });

  it("refuses anything that is not a snapshot of this version", () => {
    expect(parseViewSnapshot(null)).toBeNull();
    expect(parseViewSnapshot(wire({ version: 2, layers: [] }))).toBeNull();
    expect(parseViewSnapshot(wire({ version: 1 }))).toBeNull();
  });

  it("drops a layer naming a surface this build does not know, keeping the rest", () => {
    const out = parseViewSnapshot(
      wire({
        version: 1,
        at: 5,
        layers: [{ surface: "hologram" }, { surface: "settings", pane: "typography" }],
      }),
    );
    expect(out?.layers).toEqual([{ surface: "settings", pane: "typography" }]);
  });

  it("clips long strings and long selections", () => {
    const out = parseViewSnapshot(
      wire({
        version: 1,
        at: 5,
        layers: [{ surface: "search", query: "q".repeat(VIEW_TEXT_MAX * 2) }],
        selection: { text: "s".repeat(VIEW_SELECTION_MAX * 2), surface: "studio", at: 4 },
      }),
    );
    const layer = out?.layers[0];
    expect(layer?.surface === "search" && layer.query.length).toBe(VIEW_TEXT_MAX);
    expect(out?.selection?.text.length).toBe(VIEW_SELECTION_MAX);
  });

  it("treats a blank selection as none", () => {
    const out = parseViewSnapshot(wire({ version: 1, at: 5, layers: [], selection: { text: "  \n " } }));
    expect(out?.selection).toBeNull();
  });
});

describe("focus readers", () => {
  it("names the focused thread column of a visible studio row", () => {
    expect(focusedThreadOf(studioOnThread)).toEqual({
      threadId: "th-1",
      title: "Fix titles",
      projectPath: "/home/u/kone",
      status: "waiting-for-approval",
    });
    expect(focusedTerminalOf(studioOnThread)).toBeNull();
  });

  it("prefers the inbox's thread when the inbox is in front", () => {
    const s = snapshot({
      layers: [
        { surface: "inbox", list: "Inbox", pane: "reader", thread: { threadId: "th-9", title: "Other" } },
        { ...studioOnThread.layers[0]!, covered: true },
      ],
    });
    expect(focusedThreadOf(s)?.threadId).toBe("th-9");
  });

  it("names a focused terminal, and no thread when the terminal has focus", () => {
    const layer = studioOnThread.layers[0]!;
    if (layer.surface !== "studio" || !layer.row) throw new Error("fixture");
    const s = snapshot({
      layers: [
        {
          ...layer,
          row: { ...layer.row, panes: layer.row.panes.map((p) => ({ ...p, focused: p.kind === "terminal" })) },
        },
      ],
    });
    expect(focusedTerminalOf(s)).toEqual({ terminalId: "t1", cwd: "/home/u/kone", running: "bun dev" });
    expect(focusedThreadOf(s)).toBeNull();
  });
});

describe("renderViewSnapshot", () => {
  it("describes the front surface, its columns, and what is hidden behind it", () => {
    const text = renderViewSnapshot(studioOnThread, 1_000_000);
    expect(text).toContain('The studio, on the row for "kone" (/home/u/kone) with 2 columns');
    expect(text).toContain('- terminal in /home/u/kone: running "bun dev"');
    expect(text).toContain(
      '- thread "Fix titles" [focused]: waiting for the user\'s approval, on approving "rm -rf dist", claudeAgent / opus, id th-1',
    );
    expect(text).toContain("Other rows: api (1).");
    expect(text).toContain("Open but hidden behind that:");
    expect(text).toContain('- The project page for "kone" (/home/u/kone)');
  });

  it("includes the selection with its age", () => {
    const text = renderViewSnapshot(
      snapshot({ selection: { text: "TypeError: x is undefined", surface: "studio", at: 1_000_000 - 12_000 } }),
      1_000_000,
    );
    expect(text).toContain("Text the user selected (on the studio), 12s ago:");
    expect(text).toContain("TypeError: x is undefined");
  });

  it("says so when nothing is on screen", () => {
    expect(renderViewSnapshot(snapshot())).toBe("Nothing kone can describe is on screen.");
  });

  it("briefly: the focused column in full, the rest a count, nothing hidden", () => {
    const text = renderViewSnapshot(studioOnThread, 1_000_000, { brief: true });
    expect(text).toContain('The studio, on the row for "kone" (/home/u/kone) with 2 columns.');
    expect(text).toContain(
      'Focused column: thread "Fix titles": waiting for the user\'s approval, on approving "rm -rf dist", claudeAgent / opus, id th-1',
    );
    expect(text).toContain("1 other column not described here; app_get_view lists them.");
    expect(text).not.toContain("terminal in");
    expect(text).toContain("Other rows: api (1).");
    expect(text).not.toContain("hidden behind");
    expect(text).not.toContain("project page");
  });

  it("briefly, with no column focused: just the count", () => {
    const [studio] = studioOnThread.layers;
    if (studio?.surface !== "studio" || !studio.row) throw new Error("fixture");
    const unfocused = snapshot({
      layers: [{ ...studio, row: { ...studio.row, panes: studio.row.panes.map((p) => ({ ...p, focused: false })) } }],
    });
    const text = renderViewSnapshot(unfocused, 1_000_000, { brief: true });
    expect(text).not.toContain("Focused column");
    expect(text).toContain("2 columns not described here; app_get_view lists them.");
  });

  it("briefly, still carries the selection", () => {
    const text = renderViewSnapshot(
      snapshot({ selection: { text: "TypeError: x is undefined", surface: "studio", at: 1_000_000 - 12_000 } }),
      1_000_000,
      { brief: true },
    );
    expect(text).toContain("TypeError: x is undefined");
  });
});

describe("viewSignature", () => {
  it("ignores the clock", () => {
    expect(viewSignature({ ...studioOnThread, at: 1 })).toBe(viewSignature({ ...studioOnThread, at: 2 }));
  });

  it("briefly, ignores what the brief wording leaves out", () => {
    const [studio] = studioOnThread.layers;
    if (studio?.surface !== "studio" || !studio.row) throw new Error("fixture");
    // The unfocused terminal's command changes and the hidden project page goes.
    const moved = snapshot({
      layers: [
        {
          ...studio,
          row: {
            ...studio.row,
            panes: studio.row.panes.map((p) => (p.kind === "terminal" ? { ...p, running: null } : p)),
          },
        },
      ],
    });
    expect(viewSignature(moved, { brief: true })).toBe(viewSignature(studioOnThread, { brief: true }));
    expect(viewSignature(moved)).not.toBe(viewSignature(studioOnThread));
  });
});

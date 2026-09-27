import { describe, expect, it } from "bun:test";
import { effectScope, ref } from "vue";
import { readStudioRowPanes, stackViewLayers, useStudioRowView, useViewFacet } from "./useViewContext";

describe("stackViewLayers", () => {
  it("stacks surfaces frontmost first and covers what a full-screen one hides", () => {
    const scope = effectScope();
    scope.run(() => {
      useViewFacet("project", () => ({ surface: "project", project: { name: "kone", path: "/k" }, tab: "overview", branch: "main" }));
      useViewFacet("studio", () => ({ surface: "studio", mode: "row", row: null, rows: [] }));
      useViewFacet("settings", () => ({ surface: "settings", pane: "typography" }));
    });

    expect(stackViewLayers().map((l) => [l.surface, l.covered === true])).toEqual([
      // The drawer shares the screen with what it slid aside; the studio fills
      // it, so the page under the studio is open but hidden.
      ["settings", false],
      ["studio", false],
      ["project", true],
    ]);

    scope.stop();
    expect(stackViewLayers()).toEqual([]);
  });

  it("leaves out a surface whose getter says it is away", () => {
    const open = ref(false);
    const scope = effectScope();
    scope.run(() => useViewFacet("search", () => (open.value ? { surface: "search", query: "x" } : null)));
    expect(stackViewLayers()).toEqual([]);
    open.value = true;
    expect(stackViewLayers()).toEqual([{ surface: "search", query: "x" }]);
    scope.stop();
  });

  it("keeps a remounted surface's facet when the old one is disposed after it", () => {
    const first = effectScope();
    const second = effectScope();
    first.run(() => useStudioRowView("/k", () => [{ kind: "scratchpad", focused: false, title: "old" }]));
    second.run(() => useStudioRowView("/k", () => [{ kind: "scratchpad", focused: true, title: "new" }]));
    first.stop();
    expect(readStudioRowPanes("/k")).toEqual([{ kind: "scratchpad", focused: true, title: "new" }]);
    second.stop();
    expect(readStudioRowPanes("/k")).toEqual([]);
  });
});

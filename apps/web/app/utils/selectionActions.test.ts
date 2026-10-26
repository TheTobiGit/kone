import { describe, expect, test } from "bun:test";
import type {
  SelectionCapture,
  SelectionLike,
  SelectionNode,
  SelectionRange,
  SelectionRect,
  ToolbarPlacementInput,
} from "./selectionActions";
import {
  captureSelection,
  captureSelectionReference,
  consumeToolbarEscape,
  copySelectionText,
  enrichTextReference,
  isSelectionToolbarTarget,
  isToolbarEntryKey,
  measureSelectionToolbar,
  nextToolbarIndex,
  placeSelectionToolbar,
  restoreToolbarFocus,
  sameSelection,
  SELECTION_TOOLBAR_MEASURE_ORIGIN,
  selectionToolbarCap,
} from "./selectionActions";

// These tests drive the real admission, geometry and routing helpers with a
// tiny structural DOM. Bun has no document, so the fakes stand in for the DOM
// surface the helpers actually read (node type, parent chain, attributes,
// editable state and measured rects) rather than asserting source text.

const rect = (top: number, left: number, width: number, height: number): SelectionRect => ({
  top,
  left,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

type FakeElement = {
  nodeType: 1;
  tagName: string;
  textContent: string | null;
  parentElement: FakeElement | null;
  isContentEditable: boolean;
  getAttribute: (name: string) => string | null;
  attrs: Record<string, string>;
};

type FakeText = {
  nodeType: 3;
  textContent: string;
  parentElement: FakeElement;
};

function makeElement(
  tagName: string,
  attrs: Record<string, string> = {},
  parent: FakeElement | null = null,
  opts: { editable?: boolean; text?: string } = {},
): FakeElement {
  const el: FakeElement = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    textContent: opts.text ?? null,
    parentElement: parent,
    isContentEditable: opts.editable ?? false,
    attrs,
    getAttribute: (name: string) => attrs[name] ?? null,
  };
  return el;
}

function text(value: string, parent: FakeElement): FakeText {
  return { nodeType: 3, textContent: value, parentElement: parent };
}

function makeSelection(
  start: SelectionNode,
  end: SelectionNode,
  value: string,
  rects: SelectionRect[] = [rect(100, 200, 120, 20)],
): SelectionLike {
  const range: SelectionRange = {
    startContainer: start,
    endContainer: end,
    commonAncestorContainer: start,
    getClientRects: () => rects,
    getBoundingClientRect: () => rects[0] ?? rect(0, 0, 0, 0),
  };
  return {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => value,
    getRangeAt: () => range,
  };
}

/** A thread column: section.col > div.col__body > div.turn > p */
function threadColumn(paneId: string, turnIds: string[] = ["turn-1"]) {
  const col = makeElement("section", { "data-column-key": paneId, class: "col" });
  const body = makeElement("div", { "data-column-type": "thread" }, col);
  const turns = turnIds.map((id) => makeElement("div", { "data-turn-id": id }, body));
  return { col, body, turns };
}

describe("selection admission — only real message text in one thread pane", () => {
  test("captures the exact selected text, preserving indentation and line breaks", () => {
    const { turns } = threadColumn("pane-a");
    const paragraph = makeElement("p", {}, turns[0]!);
    const value = "const answer = 42;\n    return answer;\n";

    const capture = captureSelection(makeSelection(text("const", paragraph), text("answer;", paragraph), value));

    expect(capture).not.toBeNull();
    expect(capture!.text).toBe(value);
    expect(capture!.paneId).toBe("pane-a");
  });

  test("rejects a whitespace-only selection", () => {
    const { turns } = threadColumn("pane-a");
    const paragraph = makeElement("p", {}, turns[0]!);

    expect(captureSelection(makeSelection(text("  ", paragraph), text("\n", paragraph), " \n\t "))).toBeNull();
  });

  test("rejects a collapsed selection", () => {
    const { turns } = threadColumn("pane-a");
    const paragraph = makeElement("p", {}, turns[0]!);
    const selection = makeSelection(text("a", paragraph), text("a", paragraph), "a");
    selection.isCollapsed = true;

    expect(captureSelection(selection)).toBeNull();
  });

  test("rejects selections inside an editable control", () => {
    const { turns } = threadColumn("pane-a");
    const editor = makeElement("div", { contenteditable: "true" }, turns[0]!, { editable: true });
    const field = makeElement("span", {}, editor);

    expect(captureSelection(makeSelection(text("draft", field), text("draft", field), "draft"))).toBeNull();
  });

  test("rejects selections inside a button or form control", () => {
    const { turns } = threadColumn("pane-a");
    const button = makeElement("button", {}, turns[0]!);
    const label = makeElement("span", {}, button);
    expect(captureSelection(makeSelection(text("Copy", label), text("Copy", label), "Copy"))).toBeNull();

    const input = makeElement("input", {}, turns[0]!);
    expect(captureSelection(makeSelection(input, input, "value"))).toBeNull();
  });

  test("rejects a terminal body", () => {
    const col = makeElement("section", { "data-column-key": "pane-term" });
    const body = makeElement("div", { "data-column-type": "terminal" }, col);
    const line = makeElement("pre", {}, body);

    expect(captureSelection(makeSelection(text("$ ls", line), text("$ ls", line), "$ ls"))).toBeNull();
  });

  test("rejects a selection that crosses two panes", () => {
    const left = threadColumn("pane-a");
    const right = threadColumn("pane-b");
    const leftLine = makeElement("p", {}, left.turns[0]!);
    const rightLine = makeElement("p", {}, right.turns[0]!);

    expect(captureSelection(makeSelection(text("left", leftLine), text("right", rightLine), "left right"))).toBeNull();
  });

  test("keeps a selection crossing messages in one pane and omits the single message id", () => {
    const { turns } = threadColumn("pane-a", ["turn-1", "turn-2"]);
    const first = makeElement("p", {}, turns[0]!);
    const second = makeElement("p", {}, turns[1]!);

    const capture = captureSelection(makeSelection(text("one", first), text("two", second), "one\n\ntwo"));

    expect(capture).not.toBeNull();
    expect(capture!.paneId).toBe("pane-a");
    expect(capture!.messageId).toBeUndefined();
  });

  test("records the message id when the whole selection sits in one message", () => {
    const { turns } = threadColumn("pane-a", ["turn-7"]);
    const first = makeElement("span", {}, turns[0]!);
    const second = makeElement("span", {}, turns[0]!);

    const capture = captureSelection(makeSelection(text("hello", first), text("world", second), "hello world"));

    expect(capture!.messageId).toBe("turn-7");
  });

  test("rejects selections that leave the message containers inside the pane", () => {
    const { body, turns } = threadColumn("pane-a");
    const first = makeElement("p", {}, turns[0]!);
    const loading = makeElement("p", {}, body);

    expect(captureSelection(makeSelection(text("loading", loading), text("loading", loading), "loading"))).toBeNull();
    expect(captureSelection(makeSelection(text("message", first), text("loading", loading), "message loading"))).toBeNull();
  });

  test("captures the union of nonempty line boxes for placement", () => {
    const { turns } = threadColumn("pane-a");
    const line = makeElement("p", {}, turns[0]!);
    const last = rect(140, 90, 60, 18);

    const capture = captureSelection(makeSelection(text("a", line), text("b", line), "a b", [rect(100, 20, 80, 20), last, rect(200, 500, 0, 18)]));

    expect(capture!.rect).toEqual(rect(100, 20, 130, 58));
  });
});

describe("toolbar placement — measured, inside the visual viewport", () => {
  const base: ToolbarPlacementInput = {
    anchor: rect(300, 400, 120, 24),
    toolbar: { width: 280, height: 36 },
    viewport: { width: 1200, height: 900 },
  };

  test("sits above the selection when there is room", () => {
    const placed = placeSelectionToolbar(base);
    expect(placed.top + base.toolbar.height).toBeLessThanOrEqual(base.anchor.top);
  });

  test("flips below when the selection is near the top edge", () => {
    const anchor = rect(20, 400, 120, 24);
    const placed = placeSelectionToolbar({ ...base, anchor });
    expect(placed.top).toBeGreaterThanOrEqual(anchor.bottom);
  });

  test("forward pointer selection places actions below the entire selected block", () => {
    const anchor = rect(150, 300, 240, 160);
    const placed = placeSelectionToolbar({
      ...base, anchor, releasePoint: { x: 520, y: 300 },
    });
    expect(placed.top).toBe(anchor.bottom + 8);
    expect(placed.left).toBe(520 - base.toolbar.width / 2);
  });

  test("backward pointer selection places actions above the entire selected block", () => {
    const anchor = rect(150, 300, 240, 160);
    const placed = placeSelectionToolbar({
      ...base, anchor, releasePoint: { x: 310, y: 155 },
    });
    expect(placed.top + base.toolbar.height).toBe(anchor.top - 8);
    expect(placed.left).toBe(310 - base.toolbar.width / 2);
  });

  test("flips a forward selection above when the pane has no space below", () => {
    const anchor = rect(250, 300, 240, 160);
    const placed = placeSelectionToolbar({
      ...base, anchor, releasePoint: { x: 520, y: 400 },
      bounds: rect(100, 250, 400, 340),
    });
    expect(placed.top + base.toolbar.height).toBe(anchor.top - 8);
  });

  test("contains actions in the intersection of their pane and visual viewport", () => {
    const placed = placeSelectionToolbar({
      ...base,
      anchor: rect(200, 390, 120, 24),
      releasePoint: { x: 400, y: 220 },
      bounds: rect(100, 350, 200, 500),
      viewport: { width: 480, height: 400 },
    });
    expect(placed.width).toBe(114);
    expect(placed.left).toBe(358);
    expect(placed.left + placed.width).toBe(472);
    expect(placed.top).toBeGreaterThanOrEqual(108);
    expect(placed.top + base.toolbar.height).toBeLessThanOrEqual(392);
  });

  test("keeps actions visible when the selected block spans beyond the viewport", () => {
    const placed = placeSelectionToolbar({
      ...base, anchor: rect(-100, 200, 240, 1200),
      releasePoint: { x: 300, y: 800 },
    });
    expect(placed.top).toBeGreaterThanOrEqual(8);
    expect(placed.top + base.toolbar.height).toBeLessThanOrEqual(892);
  });

  test("contains the real 301.5px content at a 320px visual viewport", () => {
    const placed = placeSelectionToolbar({
      ...base,
      anchor: rect(300, 0, 40, 24),
      toolbar: { width: 301.5, height: 34 },
      viewport: { width: 320, height: 700 },
    });

    // 320 - 16 leaves 304px, so the toolbar keeps its full natural width.
    expect(placed.width).toBe(301.5);
    expect(placed.left).toBeGreaterThanOrEqual(8);
    expect(placed.left + 301.5).toBeLessThanOrEqual(320 - 8);
  });

  test("caps the box to 284px at a 300px viewport so wrapped content fits", () => {
    const placed = placeSelectionToolbar({
      ...base,
      anchor: rect(300, 0, 40, 24),
      toolbar: { width: 301.5, height: 34 },
      viewport: { width: 300, height: 700 },
    });

    expect(placed.width).toBe(284);
    expect(placed.left).toBe(8);
    expect(placed.left + placed.width).toBeLessThanOrEqual(300 - 8);
  });

  test("honours a zoomed visual viewport's offsets", () => {
    // Verified in Chromium (CDP pinch/pan emulation, not hardware): at page
    // scale 2 with `visualViewport.offsetLeft = 151`, a `position: fixed` box
    // whose `left` is 100 still reported `rect.left = 100`. The box stays in
    // layout coordinates and does not follow the visual viewport, so the
    // visible bounds — not the box — carry the offsets.
    const placed = placeSelectionToolbar({
      ...base,
      anchor: rect(300, 100, 40, 24),
      viewport: { width: 320, height: 600, offsetLeft: 200, offsetTop: 100 },
    });

    expect(placed.left).toBeGreaterThanOrEqual(208);
    expect(placed.top).toBeGreaterThanOrEqual(108);
  });
});

describe("toolbar measurement — the first render is never capped to zero", () => {
  test("the viewport cap is the visible width minus both margins", () => {
    expect(selectionToolbarCap(1280)).toBe(1264);
    expect(selectionToolbarCap(320)).toBe(304);
  });

  test("measures wrapped actions against pane width and preserves pointer placement", async () => {
    let cap = 0;
    const placed = await measureSelectionToolbar({
      anchor: rect(200, 400, 120, 100),
      releasePoint: { x: 500, y: 290 },
      bounds: rect(100, 350, 220, 500),
      viewport: { width: 1200, height: 900 },
      measurement: {
        applyCap: (value) => { cap = value; },
        measure: () => ({ width: cap, height: 58 }),
      },
    });
    expect(cap).toBe(204);
    expect(placed.width).toBe(204);
    expect(placed.left).toBe(358);
    expect(placed.top).toBe(308);
  });

  test("measures the natural width after clearing an earlier 8px measurement", async () => {
    // Reproduces the shipped defect: the element was rendered under an 8px
    // max-width, so every later measurement read 8px back and kept shrinking.
    let cap = 8;
    let measured = 0;
    const placement = await measureSelectionToolbar({
      anchor: rect(300, 400, 120, 24),
      viewport: { width: 1280, height: 900 },
      measurement: {
        applyCap: (maxWidth) => {
          cap = maxWidth;
        },
        measure: () => {
          measured = Math.min(301.5, cap);
          return { width: measured, height: 34 };
        },
      },
    });

    expect(cap).toBe(1264);
    expect(measured).toBe(301.5);
    expect(placement.width).toBe(301.5);
    expect(placement.left + placement.width).toBeLessThanOrEqual(1264 + 8);
  });

  test("re-measures a wider Copy result instead of ratcheting down the old cap", async () => {
    let cap = 0;
    let natural = 301.5;
    const measurement = {
      applyCap: (maxWidth: number) => {
        cap = maxWidth;
      },
      measure: () => ({ width: Math.min(natural, cap), height: 34 }),
    };

    const first = await measureSelectionToolbar({
      anchor: rect(300, 400, 120, 24),
      viewport: { width: 1280, height: 900 },
      measurement,
    });
    natural = 326;
    const second = await measureSelectionToolbar({
      anchor: rect(300, 400, 120, 24),
      viewport: { width: 1280, height: 900 },
      measurement,
    });

    expect(first.width).toBe(301.5);
    expect(second.width).toBe(326);
  });

  test("a re-show after desktop → 320 measures at the neutral origin, not the old remainder", async () => {
    // Reproduces the shipped defect: a fixed, auto-width box shrinks to fit the
    // space right of its `left`, so reading it where the desktop toolbar stood
    // measured 149.5px and the placement then rendered ~149.5px wide.
    const viewport = { width: 320, height: 700 };
    let left = 170.5;
    let prepared = false;
    let cap = 0;
    const placement = await measureSelectionToolbar({
      anchor: rect(300, 40, 40, 24),
      viewport,
      measurement: {
        prepare: () => {
          prepared = true;
          left = SELECTION_TOOLBAR_MEASURE_ORIGIN.left;
        },
        applyCap: (maxWidth) => {
          cap = maxWidth;
        },
        measure: () => {
          if (!prepared) throw new Error("measured before the origin was neutralised");
          // Shrink-to-fit: never wider than the space to the right of `left`.
          const available = viewport.width - left;
          return { width: Math.max(141.5, Math.min(301.5, cap, available)), height: 58 };
        },
      },
    });

    expect(cap).toBe(304);
    expect(placement.width).toBe(301.5);
    expect(placement.left).toBe(8);
    // 8px on both sides, as on the first show at this width.
    expect(placement.left + placement.width).toBeLessThanOrEqual(320 - 8);
  });

  test("uses the measured wrapped height rather than a single-row constant", async () => {
    let cap = 0;
    const placement = await measureSelectionToolbar({
      anchor: rect(300, 100, 40, 24),
      viewport: { width: 300, height: 700 },
      measurement: {
        applyCap: (maxWidth) => {
          cap = maxWidth;
        },
        measure: () => {
          // Below the 301.5px natural width the buttons wrap to two rows; the
          // 58px here is the observed two-row height (4 + 24 + 2 + 24 + 4). The
          // property under test is that placement uses what `measure` reports.
          const wrapped = cap < 301.5;
          return { width: Math.min(301.5, cap), height: wrapped ? 58 : 34 };
        },
      },
    });

    expect(cap).toBe(284);
    expect(placement.width).toBe(284);
    // Placed above the anchor using the measured wrapped height, not 34px.
    expect(placement.top).toBe(300 - 8 - 58);
    expect(placement.left).toBe(8);
  });
});

describe("toolbar interaction decisions", () => {
  test("a Tab press enters the toolbar only from outside it", () => {
    expect(isToolbarEntryKey({ key: "Tab", shiftKey: false }, false)).toBe(true);
    expect(isToolbarEntryKey({ key: "Tab", shiftKey: true }, false)).toBe(false);
    expect(isToolbarEntryKey({ key: "Tab", shiftKey: false }, true)).toBe(false);
    expect(isToolbarEntryKey({ key: "Enter", shiftKey: false }, false)).toBe(false);
  });

  test("after leaving the toolbar, Tab keeps navigating the page", () => {
    // Tab enters once, then the same Tab (now inside) leaves natively. If focus
    // has already left but the surface is still on screen, `entered` keeps the
    // handler from yanking focus back to Copy.
    const tab = { key: "Tab", shiftKey: false };
    let entered = false;

    expect(isToolbarEntryKey(tab, false, entered)).toBe(true);
    entered = true;
    expect(isToolbarEntryKey(tab, true, entered)).toBe(false);
    expect(isToolbarEntryKey(tab, false, entered)).toBe(false);
  });

  test("Escape returns focus to the pre-entry element; other dismissals leave it alone", () => {
    const focused: Array<{ target: string; preventScroll?: boolean }> = [];
    const origin = {
      focus: (options?: { preventScroll?: boolean }) =>
        focused.push({ target: "origin", preventScroll: options?.preventScroll }),
    };

    expect(restoreToolbarFocus("escape", origin)).toBe(true);
    expect(focused).toEqual([{ target: "origin", preventScroll: true }]);
    expect(restoreToolbarFocus("outside", origin)).toBe(false);
    expect(restoreToolbarFocus("action", origin)).toBe(false);
    expect(restoreToolbarFocus("scroll", origin)).toBe(false);
    expect(focused).toHaveLength(1);
  });

  test("focusout that lands on nothing returns, while Tab landing on a control does not", () => {
    const focused: string[] = [];
    const origin = { focus: () => focused.push("origin") };

    // The teleported toolbar is the last focusable subtree in body; without a
    // return, Tab-out leaves the reader at the top of the page.
    expect(restoreToolbarFocus("focusout", origin)).toBe(true);
    expect(focused).toEqual(["origin"]);
  });

  test("a detached pre-entry element falls back to the source pane body", () => {
    const focused: string[] = [];
    const removed = { isConnected: false, focus: () => focused.push("removed") };
    const pane = { isConnected: true, focus: () => focused.push("pane") };

    expect(restoreToolbarFocus("escape", removed, pane)).toBe(true);
    expect(focused).toEqual(["pane"]);
    expect(restoreToolbarFocus("escape", null, null)).toBe(false);
  });

  test("Escape is consumed before the window-level board binding sees it", () => {
    const calls: string[] = [];
    const event = {
      key: "Escape",
      preventDefault: () => calls.push("preventDefault"),
      stopPropagation: () => calls.push("stopPropagation"),
      stopImmediatePropagation: () => calls.push("stopImmediatePropagation"),
    };

    expect(consumeToolbarEscape(event)).toBe(true);
    expect(calls).toEqual(["preventDefault", "stopPropagation", "stopImmediatePropagation"]);
  });

  test("an Escape a higher layer already claimed is left to that layer", () => {
    const calls: string[] = [];
    const claimed = {
      key: "Escape",
      defaultPrevented: true,
      preventDefault: () => calls.push("preventDefault"),
      stopPropagation: () => calls.push("stopPropagation"),
      stopImmediatePropagation: () => calls.push("stopImmediatePropagation"),
    };

    expect(consumeToolbarEscape(claimed)).toBe(false);
    expect(
      consumeToolbarEscape({
        ...claimed,
        key: "Tab",
        defaultPrevented: false,
      }),
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  test("arrow and Home/End navigation wraps across the three actions", () => {
    expect(nextToolbarIndex("ArrowRight", 0, 3)).toBe(1);
    expect(nextToolbarIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextToolbarIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(nextToolbarIndex("Home", 2, 3)).toBe(0);
    expect(nextToolbarIndex("End", 0, 3)).toBe(2);
    expect(nextToolbarIndex("Escape", 1, 3)).toBeNull();
  });

  test("a pointer inside the toolbar does not dismiss it; anywhere else does", () => {
    const toolbar = makeElement("div", { "data-selection-toolbar": "" });
    const button = makeElement("button", {}, toolbar);
    const label = makeElement("span", {}, button);
    const thread = makeElement("p");

    expect(isSelectionToolbarTarget(text("x", label))).toBe(true);
    expect(isSelectionToolbarTarget(button)).toBe(true);
    expect(isSelectionToolbarTarget(thread)).toBe(false);
    expect(isSelectionToolbarTarget(null)).toBe(false);
  });
});

describe("copy feedback", () => {
  test("a re-reported, unchanged selection keeps the toolbar's copy result", () => {
    const first: SelectionCapture = {
      text: "same text",
      paneId: "pane-a",
      messageId: "turn-1",
      rect: rect(10, 10, 100, 20),
    };
    const again: SelectionCapture = { ...first, rect: rect(12, 10, 100, 20) };

    expect(sameSelection(first, again)).toBe(true);
    expect(sameSelection(first, { ...again, text: "same text " })).toBe(false);
    expect(sameSelection(first, { ...again, paneId: "pane-b" })).toBe(false);
    expect(sameSelection(first, { ...again, messageId: "turn-2" })).toBe(false);
    expect(sameSelection(null, again)).toBe(false);
  });

  test("reports success only after the clipboard promise resolves, with exact text", async () => {
    let resolveWrite!: () => void;
    let written = "";
    const clipboard = {
      writeText: (value: string) => {
        written = value;
        return new Promise<void>((resolve) => {
          resolveWrite = resolve;
        });
      },
    };

    let resolved = false;
    const pending = copySelectionText("  exact\n\ttext", clipboard).then((result) => {
      resolved = true;
      return result;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(written).toBe("  exact\n\ttext");

    resolveWrite();
    expect(await pending).toBe("copied");
    expect(resolved).toBe(true);
  });

  test("reports a failure when the clipboard refuses", async () => {
    const result = await copySelectionText("text", {
      writeText: () => Promise.reject(new Error("denied")),
    });
    expect(result).toBe("failed");
  });

  test("reports a failure when no clipboard exists", async () => {
    expect(await copySelectionText("text", null)).toBe("failed");
  });
});

describe("reference provenance", () => {
  test("adds the source thread and title without replacing the message id", () => {
    const reference = enrichTextReference(
      { text: "exact\n    text", sourcePaneId: "pane-a", sourceMessageId: "turn-1" },
      { threadId: "thread-1", title: "Refactor the parser" },
    );

    expect(reference).toEqual({
      text: "exact\n    text",
      sourcePaneId: "pane-a",
      sourceMessageId: "turn-1",
      sourceThreadId: "thread-1",
      sourceTitle: "Refactor the parser",
    });
  });

  test("omits empty provenance instead of writing blank fields", () => {
    const reference = enrichTextReference(
      { text: "text", sourcePaneId: "pane-a" },
      { threadId: null, title: "   " },
    );

    expect(reference).toEqual({ text: "text", sourcePaneId: "pane-a" });
  });

  test("a capture becomes a reference carrying the pane and optional message", () => {
    const capture: SelectionCapture = {
      text: "quoted",
      paneId: "pane-a",
      messageId: "turn-2",
      rect: rect(0, 0, 10, 10),
    };

    expect(captureSelectionReference(capture)).toEqual({
      text: "quoted",
      sourcePaneId: "pane-a",
      sourceMessageId: "turn-2",
    });
  });
});

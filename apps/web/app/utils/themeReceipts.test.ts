import { beforeEach, describe, expect, it } from "bun:test";
import {
  assignThemeReceipts,
  recordThemeReceipt,
  resetThemeReceiptsForTests,
  settleThreadPreviews,
  themeReceiptsForTurn,
  themeToolKinds,
  type AssignableItem,
  type ThemeFacet,
  type ThemeReceiptDraft,
} from "./themeReceipts";
import type { ThemeColors } from "~/theme/roles";

function facet(themeId: string): ThemeFacet {
  // SAFETY: nothing in the store reads a role off a facet — it carries the table
  // through to the drawing — so the tests only need the ones they assert on.
  const colors: ThemeColors = { accent: "#f97316" } as ThemeColors;
  return { themeId, label: themeId, mode: "dark", scheme: "dark", colors };
}

function draft(fields: Partial<ThemeReceiptDraft> = {}): ThemeReceiptDraft {
  return {
    threadId: "t1",
    turnId: "turn-1",
    kind: "set",
    before: facet("kone"),
    after: facet("midnight"),
    ...fields,
  };
}

function call(itemId: string, name: string, status = "completed"): AssignableItem {
  return { itemId, kind: "tool_call", status, name };
}

beforeEach(() => {
  resetThemeReceiptsForTests();
});

describe("themeReceiptsForTurn", () => {
  it("hands back only the receipts of the turn asked for, in order", () => {
    recordThemeReceipt(draft({ after: facet("one") }));
    recordThemeReceipt(draft({ after: facet("two") }));
    recordThemeReceipt(draft({ turnId: "turn-2", after: facet("three") }));
    recordThemeReceipt(draft({ threadId: "t2", after: facet("four") }));

    expect(themeReceiptsForTurn("t1", "turn-1").map((r) => r.after.themeId)).toEqual(["one", "two"]);
    expect(themeReceiptsForTurn("t1", "turn-2").map((r) => r.after.themeId)).toEqual(["three"]);
    expect(themeReceiptsForTurn("t2", "turn-1").map((r) => r.after.themeId)).toEqual(["four"]);
  });

  it("hands back nothing for a turn-less write, which can never be placed", () => {
    recordThemeReceipt(draft({ turnId: null }));
    expect(themeReceiptsForTurn("t1", null)).toEqual([]);
  });
});

describe("assignThemeReceipts", () => {
  it("pairs each call with the receipt at its own position", () => {
    const first = recordThemeReceipt(draft({ after: facet("one") }));
    const second = recordThemeReceipt(draft({ after: facet("two") }));
    const items = [call("a", "app_set_theme"), call("b", "app_set_theme")];

    const out = assignThemeReceipts(items, themeReceiptsForTurn("t1", "turn-1"));

    expect(out.get("a")?.id).toBe(first.id);
    expect(out.get("b")?.id).toBe(second.id);
  });

  // The failure the claim-on-mount protocol had: the live feed windows its rows,
  // so a row that never mounted used to leave the next one holding its receipt.
  // Position does not move when a row is absent.
  it("pairs by position even when only the later rows are rendered", () => {
    recordThemeReceipt(draft({ after: facet("one") }));
    const second = recordThemeReceipt(draft({ after: facet("two") }));
    const items = [call("a", "app_set_theme"), call("b", "app_set_theme")];

    const out = assignThemeReceipts(items, themeReceiptsForTurn("t1", "turn-1"));

    expect(out.get("b")?.id).toBe(second.id);
  });

  it("keeps a preview and the cancel that took it down apart", () => {
    const preview = recordThemeReceipt(draft({ kind: "preview" }));
    const cancel = recordThemeReceipt(draft({ kind: "cancel" }));
    const items = [
      call("a", "app_preview_theme_override"),
      call("b", "app_preview_theme_override"),
    ];

    const out = assignThemeReceipts(items, themeReceiptsForTurn("t1", "turn-1"));

    expect(out.get("a")?.id).toBe(preview.id);
    expect(out.get("b")?.id).toBe(cancel.id);
  });

  it("passes over the calls that changed nothing", () => {
    const receipt = recordThemeReceipt(draft());
    const items = [
      call("read", "app_get_theme_state"),
      call("failed", "app_set_theme", "failed"),
      call("running", "app_set_theme", "in-progress"),
      call("a", "app_set_theme"),
    ];

    const out = assignThemeReceipts(items, themeReceiptsForTurn("t1", "turn-1"));

    expect(out.size).toBe(1);
    expect(out.get("a")?.id).toBe(receipt.id);
  });

  // A receipt evicted, or recorded before this window opened, must not shift the
  // ones after it onto the wrong calls.
  it("assigns nothing rather than mispairing when a kind does not line up", () => {
    recordThemeReceipt(draft({ kind: "create" }));
    const items = [call("a", "app_set_theme")];

    expect(assignThemeReceipts(items, themeReceiptsForTurn("t1", "turn-1")).size).toBe(0);
  });

  it("assigns nothing when the turn produced no receipts at all", () => {
    expect(assignThemeReceipts([call("a", "app_set_theme")], []).size).toBe(0);
  });
});

describe("previews", () => {
  it("starts a preview live and every other kind settled", () => {
    expect(recordThemeReceipt(draft({ kind: "preview" })).previewLive).toBe(true);
    expect(recordThemeReceipt(draft({ kind: "set" })).previewLive).toBe(false);
    expect(recordThemeReceipt(draft({ kind: "create" })).previewLive).toBe(false);
  });

  it("settles every live preview in the thread a cancel came from", () => {
    recordThemeReceipt(draft({ kind: "preview" }));
    recordThemeReceipt(draft({ kind: "preview", threadId: "t2" }));

    settleThreadPreviews("t1");

    expect(themeReceiptsForTurn("t1", "turn-1")[0]?.previewLive).toBe(false);
    expect(themeReceiptsForTurn("t2", "turn-1")[0]?.previewLive).toBe(true);
  });
});

describe("themeToolKinds", () => {
  it("answers with the kinds each appearance tool can produce", () => {
    expect(themeToolKinds("app_set_theme")).toEqual(["set"]);
    expect(themeToolKinds("app_create_custom_theme")).toEqual(["create"]);
    expect(themeToolKinds("app_preview_theme_override")).toEqual(["preview", "cancel"]);
  });

  // The spellings providers actually report. Canonicalizing inside is what lets
  // every call site pass the raw name.
  it("answers to the name a provider reports, raw", () => {
    expect(themeToolKinds("kone_app_set_theme")).toEqual(["set"]);
    expect(themeToolKinds("mcp__kone__app_create_custom_theme")).toEqual(["create"]);
  });

  it("answers with nothing for a tool that changes no appearance", () => {
    expect(themeToolKinds("app_get_theme_state")).toBeNull();
    expect(themeToolKinds("read_file")).toBeNull();
    expect(themeToolKinds(undefined)).toBeNull();
  });
});

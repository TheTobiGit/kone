import { describe, expect, test } from "bun:test";

import { PAGE_CONTENT_SECURITY_POLICY } from "@kone/protocol/page-render";

import { holdPreviewPage, pageResponse, previewPageHtml, resolvePageTarget, servePage } from "./pageProtocol.js";

describe("resolvePageTarget", () => {
  test("names a stored page by its attachment id", () => {
    expect(resolvePageTarget("kone-page://att_0f3c-11aa/")).toEqual({ kind: "stored", attachmentId: "att_0f3c-11aa" });
    expect(resolvePageTarget("kone-page://att_0f3c-11aa/#kone-theme=%7B%7D")).toEqual({
      kind: "stored",
      attachmentId: "att_0f3c-11aa",
    });
  });

  test("names a held preview by its token", () => {
    expect(resolvePageTarget("kone-page://preview-1b2c-3d4e/")).toEqual({ kind: "preview", token: "1b2c-3d4e" });
  });

  test("serves the document alone, never a path inside it", () => {
    expect(resolvePageTarget("kone-page://att_0f3c-11aa/style.css")).toBeNull();
    expect(resolvePageTarget("kone-page://att_0f3c-11aa/../../etc/passwd")).toBeNull();
  });

  test("refuses anything that is not a page address", () => {
    expect(resolvePageTarget("attachment://att_0f3c-11aa/")).toBeNull();
    expect(resolvePageTarget("kone-page://not-an-id/")).toBeNull();
    expect(resolvePageTarget("not a url")).toBeNull();
  });
});

describe("previews", () => {
  test("are held until released", () => {
    const held = holdPreviewPage("<p>x</p>");
    const target = resolvePageTarget(held.url);
    expect(target?.kind).toBe("preview");
    const token = target?.kind === "preview" ? target.token : "";
    expect(previewPageHtml(token)).toBe("<p>x</p>");
    held.release();
    expect(previewPageHtml(token)).toBeNull();
  });
});

describe("pageResponse", () => {
  test("serves the page sandboxed, with the bootstrap ahead of it", async () => {
    const response = pageResponse("<p>x</p>");
    expect(response.headers.get("Content-Security-Policy")).toStartWith("sandbox allow-scripts allow-forms");
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const body = await response.text();
    expect(body.startsWith('<style id="kone-page-theme">')).toBe(true);
    expect(body.endsWith("<p>x</p>")).toBe(true);
  });
});

describe("servePage", () => {
  test("serves a held preview under the page's sandbox", async () => {
    const held = holdPreviewPage("<p>held</p>");
    try {
      const response = await servePage(held.url);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Security-Policy")).toBe(PAGE_CONTENT_SECURITY_POLICY);
      expect(await response.text()).toContain("<p>held</p>");
    } finally {
      held.release();
    }
  });

  test("answers 404 for a released preview, a path inside a page, or no page address at all", async () => {
    const held = holdPreviewPage("<p>gone</p>");
    held.release();
    for (const url of [held.url, "kone-page://att_0f3c-11aa/style.css", "not a url"]) {
      expect((await servePage(url)).status).toBe(404);
    }
  });
});

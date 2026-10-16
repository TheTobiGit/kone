import { describe, expect, test } from "bun:test";

import { VISUAL_CONTENT_SECURITY_POLICY, VISUAL_UNAVAILABLE_HTML } from "@kone/protocol/visual-render";


import {
  holdPreviewVisual,
  previewVisualHtml,
  resolveVisualTarget,
  serveVisual,
  visualHtml,
  visualResponse,
} from "./visualProtocol.js";

describe("resolveVisualTarget", () => {
  test("names a stored visual by its attachment id", () => {
    expect(resolveVisualTarget("kone-visual://att_0f3c-11aa/")).toEqual({ kind: "stored", attachmentId: "att_0f3c-11aa" });
    expect(resolveVisualTarget("kone-visual://att_0f3c-11aa/#kone-theme=%7B%7D")).toEqual({
      kind: "stored",
      attachmentId: "att_0f3c-11aa",
    });
  });

  test("names a held preview by its token", () => {
    expect(resolveVisualTarget("kone-visual://preview-1b2c-3d4e/")).toEqual({ kind: "preview", token: "1b2c-3d4e" });
  });

  test("serves the document alone, never a path inside it", () => {
    expect(resolveVisualTarget("kone-visual://att_0f3c-11aa/style.css")).toBeNull();
    expect(resolveVisualTarget("kone-visual://att_0f3c-11aa/../../etc/passwd")).toBeNull();
  });

  test("refuses anything that is not a visual address", () => {
    expect(resolveVisualTarget("attachment://att_0f3c-11aa/")).toBeNull();
    expect(resolveVisualTarget("kone-visual://not-an-id/")).toBeNull();
    expect(resolveVisualTarget("not a url")).toBeNull();
  });
});

describe("previews", () => {
  test("are held until released", () => {
    const held = holdPreviewVisual("<p>x</p>");
    const target = resolveVisualTarget(held.url);
    expect(target?.kind).toBe("preview");
    const token = target?.kind === "preview" ? target.token : "";
    expect(previewVisualHtml(token)).toBe("<p>x</p>");
    held.release();
    expect(previewVisualHtml(token)).toBeNull();
  });
});

describe("visualResponse", () => {
  test("serves the visual sandboxed, with the bootstrap ahead of it", async () => {
    const response = visualResponse("<p>x</p>");
    expect(response.headers.get("Content-Security-Policy")).toStartWith("sandbox allow-scripts allow-forms");
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const body = await response.text();
    expect(body.startsWith('<style id="kone-visual-theme">')).toBe(true);
    expect(body.endsWith("<p>x</p>")).toBe(true);
  });
});

describe("serveVisual", () => {
  test("serves a held preview under the visual's sandbox", async () => {
    const held = holdPreviewVisual("<p>held</p>");
    try {
      const response = await serveVisual(held.url);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Security-Policy")).toBe(VISUAL_CONTENT_SECURITY_POLICY);
      expect(await response.text()).toContain("<p>held</p>");
    } finally {
      held.release();
    }
  });

  test("serves a stand-in that says so for a stored visual that is gone", async () => {
    const target = resolveVisualTarget("kone-visual://att_0f3c-11aa/");
    expect(await visualHtml(target, async () => null)).toBe(VISUAL_UNAVAILABLE_HTML);
    expect(await visualHtml(target, async () => "<p>kept</p>")).toBe("<p>kept</p>");
  });

  test("answers 404 for a released preview, a path inside a visual, or no visual address at all", async () => {
    const held = holdPreviewVisual("<p>gone</p>");
    held.release();
    for (const url of [held.url, "kone-visual://att_0f3c-11aa/style.css", "not a url"]) {
      expect((await serveVisual(url)).status).toBe(404);
    }
  });
});

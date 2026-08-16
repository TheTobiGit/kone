import { describe, expect, test } from "bun:test";

import {
  isRendererOriginNavigation,
  parseSafeExternalUrl,
} from "./safeExternalUrl.js";

describe("parseSafeExternalUrl", () => {
  test("passes an https URL through unchanged", () => {
    expect(parseSafeExternalUrl("https://example.com/path")).toBe(
      "https://example.com/path",
    );
  });

  test("allows http URLs (local dev servers)", () => {
    expect(parseSafeExternalUrl("http://localhost:4173/")).toBe(
      "http://localhost:4173/",
    );
  });

  test("canonicalizes per WHATWG: host lowercased, path case kept", () => {
    expect(parseSafeExternalUrl("HTTPS://Example.COM/Path")).toBe(
      "https://example.com/Path",
    );
  });

  test("refuses file: URLs", () => {
    expect(parseSafeExternalUrl("file:///etc/passwd")).toBeNull();
  });

  test("refuses javascript: URLs", () => {
    expect(parseSafeExternalUrl("javascript:alert(1)")).toBeNull();
  });

  test("refuses unknown custom protocols", () => {
    expect(parseSafeExternalUrl("smb://server/share")).toBeNull();
  });

  test("refuses an empty string", () => {
    expect(parseSafeExternalUrl("")).toBeNull();
  });

  test("refuses non-string inputs", () => {
    for (const input of [42, null, undefined, {}]) {
      expect(parseSafeExternalUrl(input)).toBeNull();
    }
  });

  test("refuses a bare scheme with no URL", () => {
    expect(parseSafeExternalUrl("https://")).toBeNull();
  });

  test("refuses input that is not a URL at all", () => {
    expect(parseSafeExternalUrl("not a url")).toBeNull();
  });
});

describe("isRendererOriginNavigation", () => {
  test("matches the same protocol and host as the application URL", () => {
    expect(
      isRendererOriginNavigation(
        "http://localhost:3001",
        "http://localhost:3001/project/foo",
      ),
    ).toBe(true);
  });

  test("rejects a different host entirely", () => {
    expect(
      isRendererOriginNavigation("http://localhost:3001", "https://github.com"),
    ).toBe(false);
  });

  test("matches the custom app: scheme against itself", () => {
    expect(
      isRendererOriginNavigation("app://./", "app://./project/foo"),
    ).toBe(true);
  });

  test("rejects a file: navigation from the app: origin", () => {
    expect(isRendererOriginNavigation("app://./", "file:///etc/passwd")).toBe(
      false,
    );
  });

  test("rejects a javascript: navigation from the app: origin", () => {
    expect(isRendererOriginNavigation("app://./", "javascript:alert(1)")).toBe(
      false,
    );
  });

  test("rejects a navigation target that is not a URL", () => {
    expect(isRendererOriginNavigation("app://./", "not a url")).toBe(false);
  });

  test("a different port is a different host, so it is rejected", () => {
    expect(
      isRendererOriginNavigation("http://localhost:3001", "http://localhost:3002/x"),
    ).toBe(false);
  });
});

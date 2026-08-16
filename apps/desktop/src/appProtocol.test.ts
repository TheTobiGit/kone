import { describe, expect, test } from "bun:test";
import path from "node:path";

const ROOT = path.resolve("/virtual/kone-renderer");

// Faithful copy of the current, unfixed handler: decode the pathname, default
// it to /index.html, then join straight onto the renderer root. It is the
// "before" algorithm the fixed helper replaces.
function unfixedResolve(rendererRoot: string, requestUrl: string): string {
  const url = new URL(requestUrl);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/" || pathname === "") pathname = "/index.html";
  return path.join(rendererRoot, pathname);
}

// Lazy import so this file still loads and the red test can run while
// appProtocol.ts is being written; if the module is absent the fixed tests
// fail here with a clear cannot-find-module error.
async function resolveFixed(requestUrl: string): Promise<string | null> {
  const { resolveAppProtocolPath } = await import("./appProtocol.js");
  return resolveAppProtocolPath(ROOT, requestUrl);
}

describe("resolveAppProtocolPath", () => {
  test("unfixed path.join after decodeURIComponent escapes the renderer root", () => {
    const filePath = path.resolve(unfixedResolve(ROOT, "app://./..%2F..%2Fetc/passwd"));

    // The encoded ..%2F segments decode to ../.. and path.join resolves them
    // straight out of the renderer root and onto /etc/passwd.
    expect(filePath).toBe("/etc/passwd");
    expect(filePath.startsWith(ROOT + path.sep) || filePath === ROOT).toBe(false);
  });

  test("maps app://./ and empty pathname to renderer index.html", async () => {
    // app://./ parses to pathname "/" and app://. to an empty pathname; both
    // must default to the renderer entry file.
    expect(await resolveFixed("app://./")).toBe(path.join(ROOT, "index.html"));
    expect(await resolveFixed("app://.")).toBe(path.join(ROOT, "index.html"));
  });

  test("maps a renderer asset under the root", async () => {
    expect(await resolveFixed("app://./_nuxt/foo.js")).toBe(
      path.join(ROOT, "_nuxt/foo.js"),
    );
  });

  test("refuses encoded-slash traversal to a host file", async () => {
    expect(await resolveFixed("app://./..%2F..%2Fetc/passwd")).toBeNull();
  });

  test("refuses leftover .. segments", async () => {
    // Encoded slashes survive URL parsing, so the decoded pathname still
    // contains a `..` segment (`/foo/bar/../secret`). Literal `%2E%2E` with
    // real slashes is resolved away by the URL parser before we see it.
    expect(await resolveFixed("app://./foo/bar%2F..%2Fsecret")).toBeNull();
    expect(await resolveFixed("app://./foo/bar%2F..%2F..%2Fetc/passwd")).toBeNull();
  });

  test("malformed percent-encoding fails closed", async () => {
    // %E0%A4%A is not valid UTF-8, so decodeURIComponent throws; we fail
    // closed because we cannot verify what path the request actually names.
    expect(await resolveFixed("app://./%E0%A4%A")).toBeNull();
  });

  test("NUL in the pathname fails closed", async () => {
    expect(await resolveFixed("app://./foo%00bar")).toBeNull();
  });

  test("unparseable URL fails closed", async () => {
    let result: string | null = "unreachable";
    try {
      result = await resolveFixed("not a url");
    } catch (error) {
      throw new Error("unparseable URL must fail closed with null, not throw", {
        cause: error,
      });
    }
    expect(result).toBeNull();
  });

  test("contained path is never a prefix-sibling of the renderer root", async () => {
    // -evil/x is the closest craftable probe for the classic prefix bug: a
    // naive root.concat(relative) with no separator would yield the sibling
    // /virtual/kone-renderer-evil/x, which shares the ROOT string but sits
    // outside ROOT + path.sep and must never count as contained. The helper
    // must either refuse it (null) or return a real descendant under
    // ROOT + path.sep; a prefix-sibling is always wrong.
    const result = await resolveFixed("app://./-evil/x");
    if (result !== null) {
      expect(result.startsWith(ROOT + path.sep)).toBe(true);
    }
  });
});

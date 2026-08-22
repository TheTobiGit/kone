import { afterAll, afterEach, describe, expect, test } from "bun:test";
import JSZip from "jszip";
import {
  importOpenVsxThemeExtension,
  popularThemes,
  searchOpenVsxThemes,
  type OpenVsxThemeExtension,
} from "./openvsx";

const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});


// The registry side of the flow is mocked with a tiny fetch router; the
// package side is real — VSIXes are built with JSZip and the importer must
// verify and extract them exactly as it would a downloaded file.

const ASSET_ROOT = "https://open-vsx.org/api/demo/theme/1.0.0/file";

function extension(overrides: Partial<OpenVsxThemeExtension> = {}): OpenVsxThemeExtension {
  return {
    id: "demo.theme",
    name: "Demo Theme",
    publisher: "demo",
    description: "A nice theme",
    downloadCount: 123456,
    sourceUrl: "https://github.com/demo/theme",
    manifestUrl: `${ASSET_ROOT}/package.json`,
    sha256Url: `${ASSET_ROOT}/demo.theme-1.0.0.sha256`,
    vsixUrl: `${ASSET_ROOT}/demo.theme-1.0.0.vsix`,
    version: "1.0.0",
    license: "MIT",
    ...overrides,
  };
}

const DARK_COLORS = {
  "editor.background": "#1e1e1e",
  "editor.foreground": "#d4d4d4",
  "focusBorder": "#007fd4",
};

const LIGHT_COLORS = {
  "editor.background": "#fafafa",
  "editor.foreground": "#333333",
  "focusBorder": "#0066b8",
};

const MANIFEST = {
  publisher: "demo",
  name: "theme",
  version: "1.0.0",
  license: "MIT",
  contributes: {
    themes: [
      { label: "Demo Dark", uiTheme: "vs-dark", path: "./themes/demo-dark.json" },
      { label: "Demo Light", uiTheme: "vs", path: "./themes/demo-light.json" },
    ],
  },
};

async function buildVsix(files: Record<string, unknown>): Promise<{ bytes: Uint8Array; sha256: string }> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, typeof content === "string" ? content : JSON.stringify(content));
  }
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { bytes, sha256 };
}

/** A vsix holding one dark theme, plus the answers the registry must give. */
async function happyPackage() {
  const pkg = await buildVsix({
    "extension/package.json": MANIFEST,
    "extension/themes/demo-dark.json": { name: "Demo Dark", type: "dark", colors: DARK_COLORS },
    "extension/themes/demo-light.json": { name: "Demo Light", type: "light", colors: LIGHT_COLORS },
  });
  return pkg;
}

type Route =
  | { kind: "search"; body: unknown }
  | { kind: "json"; body: unknown }
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "text"; text: string }
  | { kind: "head"; length?: number }
  | { kind: "status"; status: number };

function installFetch(routes: (url: string, init?: RequestInit) => Route | null): void {
  // A mock request handler can't satisfy `fetch`'s full overload set; this
  // stands one in for the duration of a test.
  // SAFETY: the stand-in implements exactly the fetch surface these routes hit.
  // eslint-disable-next-line anti-slop/no-chained-type-assertions
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const route = routes(String(input), init);
    if (!route) return new Response("not found", { status: 404 });
    if (route.kind === "status") return new Response("nope", { status: route.status });
    if (route.kind === "head") {
      return new Response(null, {
        status: 200,
        headers: route.length !== undefined ? { "content-length": String(route.length) } : {},
      });
    }
    if (route.kind === "search") {
      return new Response(JSON.stringify(route.body), { status: 200 });
    }
    if (route.kind === "json") return new Response(JSON.stringify(route.body), { status: 200 });
    if (route.kind === "text") return new Response(route.text, { status: 200 });
    // SAFETY: a Uint8Array is a valid BodyInit.
    return new Response(Uint8Array.from(route.bytes) as BodyInit, { status: 200 });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  // fetch is reassigned per test; restoring to a no-op is enough because every
  // test installs its own router.
  // SAFETY: a no-op fetch is enough between tests; each test installs its own.
  // eslint-disable-next-line anti-slop/no-chained-type-assertions
  globalThis.fetch = (() => Promise.resolve(new Response("unrouted", { status: 500 }))) as unknown as typeof fetch;
});

describe("Open VSX theme import", () => {
  /** The standard happy-path router: manifest, checksum, and package. */
  function installPackageFetch(pkg: { bytes: Uint8Array; sha256: string }, manifest: unknown = MANIFEST) {
    // SAFETY: the stand-in implements exactly the fetch surface this test hits.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${ASSET_ROOT}/package.json`) return new Response(JSON.stringify(manifest), { status: 200 });
      if (url === `${ASSET_ROOT}/demo.theme-1.0.0.sha256`) return new Response(`${pkg.sha256}\n`, { status: 200 });
      if (url === `${ASSET_ROOT}/demo.theme-1.0.0.vsix`) {
        if (init?.method === "HEAD") return new Response(null, { status: 200 });
        // SAFETY: a Uint8Array is a valid BodyInit.
        return new Response(Uint8Array.from(pkg.bytes) as BodyInit, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  }

  test("imports every theme in an extension with deterministic ids", async () => {
    const pkg = await happyPackage();
    installPackageFetch(pkg);

    const themes = await importOpenVsxThemeExtension(extension());
    expect(themes.length).toBe(1);
    const theme = themes[0]!;
    expect(theme.kind).toBe("adaptive");
    expect(theme.label).toBe("Demo");
    expect(theme.blurb).toBe("A nice theme");
    expect(theme.source).toBe("demo.theme");
    expect(theme.id).toMatch(/^ovx-[0-9a-f]{12}$/);
    expect(theme.colors.light!.ground).toBe("#fafafa");
    expect(theme.colors.dark!.ground).toBe("#1e1e1e");
  });

  test("re-importing the same extension yields the same ids", async () => {
    const pkg = await happyPackage();
    installPackageFetch(pkg);

    const first = await importOpenVsxThemeExtension(extension());
    const second = await importOpenVsxThemeExtension(extension());
    expect(second.map((t) => t.id)).toEqual(first.map((t) => t.id));
  });

  test("keeps a theme whose family name strips to nothing as singles", async () => {
    const singleWordManifest = {
      ...MANIFEST,
      contributes: {
        themes: [
          { label: "Dark", uiTheme: "vs-dark", path: "./themes/demo-dark.json" },
          { label: "Light", uiTheme: "vs", path: "./themes/demo-light.json" },
        ],
      },
    };
    const pkg = await buildVsix({
      "extension/package.json": singleWordManifest,
      "extension/themes/demo-dark.json": { name: "Dark", type: "dark", colors: DARK_COLORS },
      "extension/themes/demo-light.json": { name: "Light", type: "light", colors: LIGHT_COLORS },
    });
    installPackageFetch(pkg, singleWordManifest);

    const themes = await importOpenVsxThemeExtension(extension());
    expect(themes.length).toBe(2);
    expect(themes.every((t) => t.kind === "fixed")).toBe(true);
  });

  test("fails the import when the checksum does not match", async () => {
    const pkg = await happyPackage();
    installPackageFetch(pkg);
    const original = globalThis.fetch;
    // SAFETY: wraps the standard router, serving only a wrong checksum.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `${ASSET_ROOT}/demo.theme-1.0.0.sha256`) {
        return new Response(`${"0".repeat(64)}\n`, { status: 200 });
      }
      return original(input, init);
    }) as unknown as typeof fetch;

    await expect(importOpenVsxThemeExtension(extension())).rejects.toThrow(/integrity/);
  });

  test("rejects a package whose manifest does not match the registry's", async () => {
    const pkg = await buildVsix({
      "extension/package.json": { ...MANIFEST, version: "9.9.9" },
      "extension/themes/demo-dark.json": { name: "Demo Dark", type: "dark", colors: DARK_COLORS },
    });
    installPackageFetch(pkg);

    await expect(importOpenVsxThemeExtension(extension())).rejects.toThrow(/does not match/);
  });

  test("rejects a package that mislabels its license", async () => {
    const pkg = await buildVsix({
      "extension/package.json": { ...MANIFEST, license: "Proprietary" },
      "extension/themes/demo-dark.json": { name: "Demo Dark", type: "dark", colors: DARK_COLORS },
    });
    installPackageFetch(pkg);

    await expect(importOpenVsxThemeExtension(extension())).rejects.toThrow(/license/);
  });

  test("refuses a theme path that escapes the package", async () => {
    const escapingManifest = {
      ...MANIFEST,
      contributes: { themes: [{ label: "Evil", uiTheme: "vs-dark", path: "../../etc/passwd.json" }] },
    };
    const pkg = await buildVsix({
      "extension/package.json": escapingManifest,
      "extension/themes/demo-dark.json": { name: "Demo Dark", type: "dark", colors: DARK_COLORS },
    });
    installPackageFetch(pkg, escapingManifest);

    await expect(importOpenVsxThemeExtension(extension())).rejects.toThrow(/could not be imported safely/);
  });

  test("resolves include chains and merges the base colours", async () => {
    const includingManifest = {
      ...MANIFEST,
      contributes: { themes: [{ label: "Extended", uiTheme: "vs-dark", path: "./themes/extended.json" }] },
    };
    const pkg = await buildVsix({
      "extension/package.json": includingManifest,
      "extension/themes/base.json": { name: "Base", type: "dark", colors: DARK_COLORS },
      "extension/themes/extended.json": {
        name: "Extended",
        type: "dark",
        include: "./base.json",
        colors: { "sideBar.background": "#141414" },
      },
    });
    installPackageFetch(pkg, includingManifest);

    const themes = await importOpenVsxThemeExtension(extension());
    expect(themes.length).toBe(1);
    const c = themes[0]!.colors.dark!;
    expect(c.ground).toBe("#1e1e1e"); // from the base
    expect(c.strip).toBe("#141414"); // from the extending file
  });

  test("refuses an archive with an unsafe compression ratio", async () => {
    const zip = new JSZip();
    zip.file("extension/package.json", JSON.stringify(MANIFEST));
    zip.file("extension/themes/demo-dark.json", JSON.stringify({ name: "Demo Dark", type: "dark", colors: DARK_COLORS }));
    zip.file("extension/padding.bin", new Uint8Array(12 * 1024 * 1024)); // ~12MB of zeros
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    installPackageFetch({ bytes, sha256 });

    await expect(importOpenVsxThemeExtension(extension())).rejects.toThrow(/compression ratio/);
  });
});

describe("Open VSX search", () => {
  test("keeps supported licenses and drops the rest", async () => {
    const detail = (namespace: string, license: string) => ({
      namespace,
      name: "theme",
      displayName: "Theme",
      version: "1.0.0",
      license,
      downloadCount: 10,
      files: {
        manifest: `https://open-vsx.org/api/${namespace}/theme/1.0.0/file/package.json`,
        sha256: `https://open-vsx.org/api/${namespace}/theme/1.0.0/file/theme-1.0.0.sha256`,
        download: `https://open-vsx.org/api/${namespace}/theme/1.0.0/file/theme-1.0.0.vsix`,
      },
    });
    installFetch((url, init) => {
      if (url.includes("/-/search?")) {
        return {
          kind: "search",
          body: {
            extensions: [
              { namespace: "free", name: "theme" },
              { namespace: "closed", name: "theme" },
            ],
          },
        };
      }
      if (url.endsWith("/api/free/theme")) return { kind: "json", body: detail("free", "MIT") };
      if (url.endsWith("/api/closed/theme")) {
        return { kind: "json", body: detail("closed", "Proprietary") };
      }
      if (url.includes("/file/package.json")) {
        return { kind: "json", body: { license: "MIT", contributes: { themes: [{ label: "T", path: "./t.json" }] } } };
      }
      if (url.includes(".vsix") && init?.method === "HEAD") return { kind: "head" };
      return null;
    });

    const results = await searchOpenVsxThemes("theme");
    expect(results.map((r) => r.id)).toEqual(["free.theme"]);
  });

  test("drops an extension whose manifest license disagrees with its detail", async () => {
    installFetch((url, init) => {
      if (url.includes("/-/search?")) {
        return { kind: "search", body: { extensions: [{ namespace: "liar", name: "theme" }] } };
      }
      if (url.endsWith("/api/liar/theme")) {
        return {
          kind: "json",
          body: {
            namespace: "liar",
            name: "theme",
            version: "1.0.0",
            license: "MIT",
            files: {
              manifest: "https://open-vsx.org/api/liar/theme/1.0.0/file/package.json",
              sha256: "https://open-vsx.org/api/liar/theme/1.0.0/file/theme-1.0.0.sha256",
              download: "https://open-vsx.org/api/liar/theme/1.0.0/file/theme-1.0.0.vsix",
            },
          },
        };
      }
      if (url.includes("/file/package.json")) {
        return { kind: "json", body: { license: "ISC", contributes: { themes: [{ label: "T", path: "./t.json" }] } } };
      }
      if (url.includes(".vsix") && init?.method === "HEAD") return { kind: "head" };
      return null;
    });

    const results = await searchOpenVsxThemes("theme");
    expect(results).toEqual([]);
  });

  test("the popular catalog answers an empty query and is cached across opens", async () => {
    let searchCalls = 0;
    installFetch((url, init) => {
      if (url.includes("/-/search?")) {
        searchCalls += 1;
        return { kind: "search", body: { extensions: [{ namespace: "free", name: "theme" }] } };
      }
      if (url.endsWith("/api/free/theme")) {
        return {
          kind: "json",
          body: {
            namespace: "free",
            name: "theme",
            displayName: "Free Theme",
            version: "1.0.0",
            license: "MIT",
            downloadCount: 42,
            files: {
              manifest: "https://open-vsx.org/api/free/theme/1.0.0/file/package.json",
              sha256: "https://open-vsx.org/api/free/theme/1.0.0/file/theme-1.0.0.sha256",
              download: "https://open-vsx.org/api/free/theme/1.0.0/file/theme-1.0.0.vsix",
            },
          },
        };
      }
      if (url.includes("/file/package.json")) {
        return { kind: "json", body: { license: "MIT", contributes: { themes: [{ label: "T", path: "./t.json" }] } } };
      }
      if (url.includes(".vsix") && init?.method === "HEAD") return { kind: "head" };
      return null;
    });

    const first = await popularThemes();
    const second = await popularThemes();
    expect(first.map((r) => r.id)).toEqual(["free.theme"]);
    expect(second).toBe(first);
    expect(searchCalls).toBe(1);
  });
});

import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  ALL_DEFAULT_SERVERS,
  decodeLspConfigFile,
  GO_DEFAULT_SERVERS,
  languageIdForFile,
  localBinCandidates,
  mergeServerConfig,
  projectLspConfigPath,
  PYTHON_DEFAULT_SERVERS,
  resolveServerBinary,
  RUST_DEFAULT_SERVERS,
  serversForFile,
  TS_DEFAULT_SERVERS,
} from "./serverRegistry.js";
import type { ServerBinaryDeps } from "./serverRegistry.js";
import type { ServerConfig } from "./types.js";

const TYPESCRIPT = "typescript-language-server";

function fakeDeps(
  present: readonly string[],
  pathResult: string | null = null,
): ServerBinaryDeps & { lookups: string[] } {
  const existing = new Set(present);
  const lookups: string[] = [];
  return {
    lookups,
    existsSync: (candidate) => existing.has(candidate),
    lookupOnPath: (command) => {
      lookups.push(command);
      return pathResult;
    },
  };
}

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: "typescript",
    command: TYPESCRIPT,
    args: ["--stdio"],
    fileTypes: ["ts", "tsx"],
    rootMarkers: ["tsconfig.json"],
    ...overrides,
  };
}

describe("TS_DEFAULT_SERVERS", () => {
  test("ships typescript-language-server and only it", () => {
    expect(TS_DEFAULT_SERVERS.length).toBe(1);
    const only = TS_DEFAULT_SERVERS[0];
    expect(only?.command).toBe(TYPESCRIPT);
    expect(only?.args).toEqual(["--stdio"]);
    expect(only?.fileTypes).toContain("ts");
    expect(only?.fileTypes).toContain("tsx");
    expect(only?.fileTypes).toContain("js");
    expect(only?.rootMarkers).toContain("tsconfig.json");
    expect(only?.rootMarkers).toContain("package.json");
    expect(only?.disabled).not.toBe(true);
  });
});

describe("GO_DEFAULT_SERVERS", () => {
  test("ships gopls with no args", () => {
    expect(GO_DEFAULT_SERVERS.length).toBe(1);
    const only = GO_DEFAULT_SERVERS[0];
    expect(only?.name).toBe("go");
    expect(only?.command).toBe("gopls");
    expect(only?.args).toEqual([]);
    expect(only?.fileTypes).toEqual(["go"]);
    expect(only?.rootMarkers).toEqual(["go.mod", "go.work"]);
    expect(only?.disabled).not.toBe(true);
  });
});

describe("PYTHON_DEFAULT_SERVERS", () => {
  test("ships pyright over stdio", () => {
    expect(PYTHON_DEFAULT_SERVERS.length).toBe(1);
    const only = PYTHON_DEFAULT_SERVERS[0];
    expect(only?.name).toBe("python");
    expect(only?.command).toBe("pyright-langserver");
    expect(only?.args).toEqual(["--stdio"]);
    expect(only?.fileTypes).toEqual(["py"]);
    expect(only?.rootMarkers).toEqual([
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "pyrightconfig.json",
    ]);
    expect(only?.disabled).not.toBe(true);
  });
});

describe("RUST_DEFAULT_SERVERS", () => {
  test("ships rust-analyzer with no args", () => {
    expect(RUST_DEFAULT_SERVERS.length).toBe(1);
    const only = RUST_DEFAULT_SERVERS[0];
    expect(only?.name).toBe("rust");
    expect(only?.command).toBe("rust-analyzer");
    expect(only?.args).toEqual([]);
    expect(only?.fileTypes).toEqual(["rs"]);
    expect(only?.rootMarkers).toEqual(["Cargo.toml"]);
    expect(only?.disabled).not.toBe(true);
  });
});

describe("ALL_DEFAULT_SERVERS", () => {
  test("combines every bundled server in match order", () => {
    expect(ALL_DEFAULT_SERVERS.map((entry) => entry.name)).toEqual([
      "typescript",
      "go",
      "python",
      "rust",
    ]);
  });

  test("leaves bundled extensions disjoint so first-wins never triggers yet", () => {
    const probes = ["/proj/a.ts", "/proj/main.go", "/proj/app.py", "/proj/lib.rs"];
    for (const probe of probes) {
      expect(serversForFile(ALL_DEFAULT_SERVERS, probe).length).toBe(1);
    }
  });
});

describe("serversForFile new languages", () => {
  test("routes go, python, and rust files to their server", () => {
    expect(serversForFile(ALL_DEFAULT_SERVERS, "/proj/main.go").map((e) => e.name)).toEqual([
      "go",
    ]);
    expect(serversForFile(ALL_DEFAULT_SERVERS, "/proj/app.py").map((e) => e.name)).toEqual([
      "python",
    ]);
    expect(serversForFile(ALL_DEFAULT_SERVERS, "/proj/lib.rs").map((e) => e.name)).toEqual([
      "rust",
    ]);
  });

  test("matches new extensions case-insensitively", () => {
    expect(serversForFile(ALL_DEFAULT_SERVERS, "/proj/MAIN.GO").map((e) => e.name)).toEqual([
      "go",
    ]);
    expect(serversForFile(ALL_DEFAULT_SERVERS, "/proj/APP.PY").map((e) => e.name)).toEqual([
      "python",
    ]);
  });

  test("resolves nothing for unknown extensions", () => {
    expect(serversForFile(ALL_DEFAULT_SERVERS, "/proj/notes.md")).toEqual([]);
    expect(serversForFile(ALL_DEFAULT_SERVERS, "/proj/Main.java")).toEqual([]);
    expect(serversForFile(ALL_DEFAULT_SERVERS, "/proj/Makefile")).toEqual([]);
  });
});

describe("mergeServerConfig new servers", () => {
  test("keeps disabled true sticky for a new server", () => {
    const merged = mergeServerConfig(
      ALL_DEFAULT_SERVERS,
      { servers: { go: { disabled: true } } },
      { servers: { go: { disabled: false } } },
    );
    const go = merged.find((entry) => entry.name === "go");
    expect(go?.disabled).toBe(true);
  });

  test("replaces a default's args wholesale by server name", () => {
    const merged = mergeServerConfig(
      ALL_DEFAULT_SERVERS,
      { servers: { python: { args: ["--stdio", "--threads=4"] } } },
      null,
    );
    const python = merged.find((entry) => entry.name === "python");
    expect(python?.args).toEqual(["--stdio", "--threads=4"]);
    expect(python?.command).toBe("pyright-langserver");
    expect(python?.fileTypes).toEqual(["py"]);
  });
});

describe("resolveServerBinary", () => {
  test("prefers the project-local bin over PATH", () => {
    const deps = fakeDeps(["/proj/node_modules/.bin/" + TYPESCRIPT], "/usr/bin/" + TYPESCRIPT);
    const found = resolveServerBinary(server(), "/proj", deps);
    expect(found).toBe("/proj/node_modules/.bin/" + TYPESCRIPT);
    expect(deps.lookups).toEqual([]);
  });

  test("walks up to ancestor node_modules/.bin dirs", () => {
    const deps = fakeDeps(["/proj/node_modules/.bin/" + TYPESCRIPT]);
    expect(resolveServerBinary(server(), "/proj/packages/app", deps)).toBe(
      "/proj/node_modules/.bin/" + TYPESCRIPT,
    );
  });

  test("prefers the nearest ancestor bin", () => {
    const deps = fakeDeps([
      "/proj/node_modules/.bin/" + TYPESCRIPT,
      "/proj/packages/app/node_modules/.bin/" + TYPESCRIPT,
    ]);
    expect(resolveServerBinary(server(), "/proj/packages/app", deps)).toBe(
      "/proj/packages/app/node_modules/.bin/" + TYPESCRIPT,
    );
  });

  test("falls back to PATH when no local bin exists", () => {
    const deps = fakeDeps([], "/usr/local/bin/" + TYPESCRIPT);
    expect(resolveServerBinary(server(), "/proj", deps)).toBe("/usr/local/bin/" + TYPESCRIPT);
    expect(deps.lookups).toEqual([TYPESCRIPT]);
  });

  test("returns null when neither local bins nor PATH provide the server", () => {
    expect(resolveServerBinary(server(), "/proj", fakeDeps([]))).toBeNull();
  });

  test("resolves absolute commands without consulting PATH", () => {
    const absolute = server({ command: "/opt/lsp/bin/custom" });
    const deps = fakeDeps(["/opt/lsp/bin/custom"], "/usr/bin/other");
    expect(resolveServerBinary(absolute, "/proj", deps)).toBe("/opt/lsp/bin/custom");
    expect(deps.lookups).toEqual([]);
    expect(resolveServerBinary(absolute, "/proj", fakeDeps([]))).toBeNull();
  });

  test("resolves separator-carrying commands against cwd", () => {
    const relative = server({ command: "tools/lsp/bin/custom" });
    const deps = fakeDeps(["/proj/tools/lsp/bin/custom"]);
    expect(resolveServerBinary(relative, "/proj", deps)).toBe("/proj/tools/lsp/bin/custom");
    expect(resolveServerBinary(relative, "/proj", fakeDeps([]))).toBeNull();
  });
});

describe("localBinCandidates", () => {
  test("lists cwd first, then ancestors up to the root", () => {
    const candidates = localBinCandidates("/proj/packages/app", TYPESCRIPT, "darwin");
    expect(candidates[0]).toBe("/proj/packages/app/node_modules/.bin/" + TYPESCRIPT);
    expect(candidates).toContain("/proj/packages/node_modules/.bin/" + TYPESCRIPT);
    expect(candidates).toContain("/proj/node_modules/.bin/" + TYPESCRIPT);
    expect(candidates[candidates.length - 1]).toBe("/node_modules/.bin/" + TYPESCRIPT);
  });

  test("adds .cmd shims on windows only", () => {
    const windows = localBinCandidates("/proj", TYPESCRIPT, "win32");
    expect(windows).toContain("/proj/node_modules/.bin/" + TYPESCRIPT);
    expect(windows).toContain("/proj/node_modules/.bin/" + TYPESCRIPT + ".cmd");
    const posix = localBinCandidates("/proj", TYPESCRIPT, "darwin");
    expect(posix).not.toContain("/proj/node_modules/.bin/" + TYPESCRIPT + ".cmd");
  });
});

describe("decodeLspConfigFile", () => {
  test("rejects missing and misshapen documents", () => {
    expect(decodeLspConfigFile(null)).toBeNull();
    expect(decodeLspConfigFile("lsp.json")).toBeNull();
    expect(decodeLspConfigFile(42)).toBeNull();
    expect(decodeLspConfigFile([])).toBeNull();
    expect(decodeLspConfigFile({ servers: [] })).toBeNull();
  });

  test("decodes an empty document to no overrides", () => {
    expect(decodeLspConfigFile({})).toEqual({ servers: {} });
  });

  test("decodes a full server entry", () => {
    const decoded = decodeLspConfigFile({
      servers: {
        typescript: {
          command: "custom-tsserver",
          args: ["--stdio", "--log"],
          fileTypes: ["ts"],
          rootMarkers: ["tsconfig.json"],
          initOptions: { hostInfo: "kone" },
          settings: { typescript: { inlayHints: true } },
          disabled: true,
          warmupTimeoutMs: 5000,
        },
      },
    });
    expect(decoded?.servers["typescript"]).toEqual({
      command: "custom-tsserver",
      args: ["--stdio", "--log"],
      fileTypes: ["ts"],
      rootMarkers: ["tsconfig.json"],
      initOptions: { hostInfo: "kone" },
      settings: { typescript: { inlayHints: true } },
      disabled: true,
      warmupTimeoutMs: 5000,
    });
  });

  test("drops unusable entries and values", () => {
    const decoded = decodeLspConfigFile({
      servers: {
        typescript: {
          command: "  ",
          args: ["--stdio", 42, true],
          fileTypes: "ts",
          settings: ["not", "a", "record"],
          disabled: "yes",
          warmupTimeoutMs: -10,
          bogusField: "ignored",
        },
        nonsense: "not-a-record",
      },
    });
    expect(decoded?.servers["typescript"]).toEqual({ args: ["--stdio"] });
    expect("nonsense" in (decoded?.servers ?? {})).toBe(false);
  });
});

describe("mergeServerConfig", () => {
  test("returns defaults untouched when both files are missing", () => {
    const merged = mergeServerConfig(TS_DEFAULT_SERVERS, null, null);
    expect(merged).toEqual([...TS_DEFAULT_SERVERS]);
    expect(merged[0]).not.toBe(TS_DEFAULT_SERVERS[0]);
  });

  test("does not mutate the input defaults", () => {
    const defaults = [server()];
    mergeServerConfig(defaults, { servers: { typescript: { command: "other" } } }, null);
    expect(defaults).toEqual([server()]);
  });

  test("lets the project file win over the global file", () => {
    const merged = mergeServerConfig(
      TS_DEFAULT_SERVERS,
      { servers: { typescript: { command: "global-bin", warmupTimeoutMs: 1000 } } },
      { servers: { typescript: { command: "project-bin" } } },
    );
    expect(merged[0]?.command).toBe("project-bin");
    expect(merged[0]?.warmupTimeoutMs).toBe(1000);
  });

  test("replaces object fields wholesale instead of merging keys", () => {
    const merged = mergeServerConfig(
      [server({ settings: { a: 1, b: 2 } })],
      { servers: { typescript: { settings: { a: 1, b: 2 } } } },
      { servers: { typescript: { settings: { b: 3 } } } },
    );
    expect(merged[0]?.settings).toEqual({ b: 3 });
  });

  test("lets disabled true win over an explicit false", () => {
    const globalDisabled = mergeServerConfig(
      TS_DEFAULT_SERVERS,
      { servers: { typescript: { disabled: true } } },
      { servers: { typescript: { disabled: false } } },
    );
    expect(globalDisabled[0]?.disabled).toBe(true);

    const projectDisabled = mergeServerConfig(
      TS_DEFAULT_SERVERS,
      null,
      { servers: { typescript: { disabled: true } } },
    );
    expect(projectDisabled[0]?.disabled).toBe(true);

    const explicitFalse = mergeServerConfig(
      TS_DEFAULT_SERVERS,
      null,
      { servers: { typescript: { disabled: false } } },
    );
    expect(explicitFalse[0]?.disabled).toBe(false);

    const untouched = mergeServerConfig(TS_DEFAULT_SERVERS, null, null);
    expect(untouched[0]?.disabled).toBeUndefined();
  });

  test("ignores entries naming unknown servers", () => {
    const merged = mergeServerConfig(
      TS_DEFAULT_SERVERS,
      { servers: { imaginary: { command: "nope", args: [] } } },
      null,
    );
    expect(merged.length).toBe(1);
    expect(merged[0]?.command).toBe(TYPESCRIPT);
  });
});

describe("serversForFile", () => {
  test("matches by extension, case-insensitively", () => {
    const matched = serversForFile(TS_DEFAULT_SERVERS, "/proj/src/App.TSX");
    expect(matched.map((entry) => entry.name)).toEqual(["typescript"]);
  });

  test("tolerates dotted fileType spellings", () => {
    const matched = serversForFile([server({ fileTypes: [".ts"] })], "/proj/a.ts");
    expect(matched.length).toBe(1);
  });

  test("returns nothing for unknown or missing extensions", () => {
    expect(serversForFile(TS_DEFAULT_SERVERS, "/proj/notes.md")).toEqual([]);
    expect(serversForFile(TS_DEFAULT_SERVERS, "/proj/Makefile")).toEqual([]);
  });

  test("returns every matching server in registry order", () => {
    const both = serversForFile(
      [server({ name: "first" }), server({ name: "second" })],
      "/proj/a.ts",
    );
    expect(both.map((entry) => entry.name)).toEqual(["first", "second"]);
  });
});

describe("projectLspConfigPath", () => {
  test("points at .kone/lsp.json under the checkout", () => {
    expect(projectLspConfigPath("/proj/app")).toBe(path.join("/proj/app", ".kone", "lsp.json"));
  });
});

describe("languageIdForFile", () => {
  test("the typescript server tags each side of the language under its own name", () => {
    expect(languageIdForFile(TS_DEFAULT_SERVERS, "/proj/a.ts")).toBe("typescript");
    expect(languageIdForFile(TS_DEFAULT_SERVERS, "/proj/a.tsx")).toBe("typescript");
    expect(languageIdForFile(TS_DEFAULT_SERVERS, "/proj/a.js")).toBe("javascript");
    expect(languageIdForFile(TS_DEFAULT_SERVERS, "/proj/a.mjs")).toBe("javascript");
  });

  test("every bundled server tags its own files", () => {
    expect(languageIdForFile(GO_DEFAULT_SERVERS, "/proj/main.go")).toBe("go");
    expect(languageIdForFile(PYTHON_DEFAULT_SERVERS, "/proj/main.py")).toBe("python");
    expect(languageIdForFile(RUST_DEFAULT_SERVERS, "/proj/main.rs")).toBe("rust");
  });

  test("an untagged extension falls back to itself, and a missing one to plaintext", () => {
    expect(languageIdForFile([server()], "/proj/notes.md")).toBe("md");
    expect(languageIdForFile(TS_DEFAULT_SERVERS, "/proj/Makefile")).toBe("plaintext");
  });

  test("a config override replaces the tag map wholesale", () => {
    const merged = mergeServerConfig(
      TS_DEFAULT_SERVERS,
      { servers: { typescript: { languageIds: { ts: "typescriptreact" } } } },
      null,
    );
    expect(languageIdForFile(merged, "/proj/a.ts")).toBe("typescriptreact");
    // Wholesale, like every other override field: js is no longer tagged.
    expect(languageIdForFile(merged, "/proj/a.js")).toBe("js");
  });

  test("the enabled owner wins when two servers claim one extension", () => {
    const servers = [
      server({ name: "first", languageIds: { ts: "first-tag" }, disabled: true }),
      server({ name: "second", languageIds: { ts: "second-tag" } }),
    ];
    expect(languageIdForFile(servers, "/proj/a.ts")).toBe("second-tag");
  });
});

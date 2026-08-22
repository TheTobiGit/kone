import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyGhError } from "./ghError.js";

// github.ts imports electron's shell at module top (used only on PR-link
// clicks); stand in for it before the module loads.
mock.module("electron", () => ({ shell: { openExternal: () => {} } }));

// eslint-disable-next-line anti-slop/no-chained-type-assertions
const { me } = (await import("./github.js")) as typeof import("./github.js");

describe("classifyGhError", () => {
  test("maps gh auth failures to NOT_AUTHENTICATED", () => {
    expect(classifyGhError("gh: To get started with GitHub CLI, please run:  gh auth login")).toBe(
      "NOT_AUTHENTICATED",
    );
    expect(classifyGhError("HTTP 401: Bad credentials")).toBe("NOT_AUTHENTICATED");
    expect(classifyGhError("not logged in to any servers")).toBe("NOT_AUTHENTICATED");
    expect(classifyGhError("HTTP 403: forbidden")).toBe("NOT_AUTHENTICATED");
  });

  test("maps missing-remote failures to NO_GITHUB_REMOTE", () => {
    expect(classifyGhError("gh: no git remotes found")).toBe("NO_GITHUB_REMOTE");
    expect(classifyGhError("the 'origin' remote do not point to a known GitHub host")).toBe(
      "NO_GITHUB_REMOTE",
    );
    expect(classifyGhError("could not determine the default repository to query")).toBe(
      "NO_GITHUB_REMOTE",
    );
  });

  test("maps missing-PR failures to NOT_FOUND", () => {
    expect(classifyGhError("could not resolve to a pull request with the number '999'")).toBe(
      "NOT_FOUND",
    );
    expect(classifyGhError("no pull requests found")).toBe("NOT_FOUND");
    expect(classifyGhError("could not resolve to a repository with the name 'foo/bar'")).toBe(
      "NOT_FOUND",
    );
  });

  test("maps connection failures to NETWORK", () => {
    expect(classifyGhError("gh: could not resolve host api.github.com")).toBe("NETWORK");
    expect(classifyGhError("dial tcp: connect: connection refused")).toBe("NETWORK");
    expect(classifyGhError("connection reset by peer")).toBe("NETWORK");
    expect(classifyGhError("connection timed out")).toBe("NETWORK");
    expect(classifyGhError("network is unreachable")).toBe("NETWORK");
    expect(classifyGhError("Temporary failure in name resolution")).toBe("NETWORK");
    expect(classifyGhError("operation timed out")).toBe("NETWORK");
    expect(classifyGhError("early EOF")).toBe("NETWORK");
    expect(classifyGhError("failed to connect to github.com port 443")).toBe("NETWORK");
  });

  test("returns null for unrecognized stderr lines", () => {
    expect(classifyGhError("Some unrelated stderr line")).toBeNull();
    expect(classifyGhError("gh: fork must be created first")).toBeNull();
    expect(classifyGhError("")).toBeNull();
  });
});

// The JSON-record parsing behind every gh surface, exercised through `me()`
// with a fake `gh` on PATH — the same trick clone.test.ts plays on `git`.
const savedPath = process.env.PATH;
const tempDirs: string[] = [];

afterEach(() => {
  if (savedPath !== undefined) process.env.PATH = savedPath;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

/** Put a fake `gh` first on PATH; it answers every invocation with `stdout`. */
function installFakeGh(stdout: string): void {
  const bin = mkdtempSync(path.join(os.tmpdir(), "kone-gh-bin-"));
  tempDirs.push(bin);
  const ghPath = path.join(bin, "gh");
  writeFileSync(ghPath, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(${stdout}));\n`);
  chmodSync(ghPath, 0o755);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
}

describe("me (record parsing)", () => {
  test("maps a gh user record onto the flat shape", async () => {
    installFakeGh(`{ login: "octo", name: "Octo Cat", bio: null }`);
    expect(await me()).toMatchObject({ login: "octo", name: "Octo Cat" });
  });

  test("a non-object answer reads as no user, never a crash", async () => {
    installFakeGh(`[1, 2]`);
    expect(await me()).toBeNull();
  });

  test("a record without a login reads as no user", async () => {
    installFakeGh(`{ name: "Ghost" }`);
    expect(await me()).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";

import { classifyGhError } from "./ghError.js";

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

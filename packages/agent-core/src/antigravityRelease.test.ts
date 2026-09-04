import { describe, expect, test } from "bun:test";

import {
  ANTIGRAVITY_ACP_RELEASE_VERSION,
  resolveAntigravityReleaseAsset,
} from "./antigravityRelease.js";

describe("resolveAntigravityReleaseAsset", () => {
  test("resolves the pinned release for supported hosts", () => {
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["linux", "x64"],
      ["linux", "arm64"],
      ["win32", "x64"],
      ["win32", "arm64"],
    ] as const) {
      const asset = resolveAntigravityReleaseAsset(platform, arch);
      expect(asset?.version).toBe(ANTIGRAVITY_ACP_RELEASE_VERSION);
      expect(asset?.url).toMatch(/^https:\/\/dl\.google\.com\//);
      expect(asset?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(asset && asset.archiveBytes > 0).toBe(true);
      expect(asset && asset.executable.bytes > 0).toBe(true);
      expect(asset && asset.harness.bytes > 0).toBe(true);
    }
  });

  test("windows builds are exes, posix builds are extensionless helpers", () => {
    expect(resolveAntigravityReleaseAsset("win32", "x64")?.executable.name).toEndWith(".exe");
    expect(resolveAntigravityReleaseAsset("win32", "x64")?.harness.name).toEndWith(".exe");
    expect(resolveAntigravityReleaseAsset("darwin", "arm64")?.executable.name).not.toEndWith(".exe");
    expect(resolveAntigravityReleaseAsset("darwin", "arm64")?.harness.name).toBe(
      "localharness_external",
    );
  });

  test("returns null where no runtime is published", () => {
    expect(resolveAntigravityReleaseAsset("darwin", "x64")).toBeNull();
    expect(resolveAntigravityReleaseAsset("freebsd", "x64")).toBeNull();
  });
});

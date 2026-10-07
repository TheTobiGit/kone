import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createLocalImageGrants, isPathInside } from "./localImageProtocol.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

let base: string;
let workspace: string;
let fakeTmp: string;
let outside: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), "kone-local-image-")));
  workspace = path.join(base, "ws");
  fakeTmp = path.join(base, "tmp");
  outside = path.join(base, "outside");
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await mkdir(path.join(workspace, "src", "shots"), { recursive: true });
  await mkdir(fakeTmp, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(workspace, "src", "shots", "a.png"), PNG);
  await writeFile(path.join(fakeTmp, "shot.png"), PNG);
  await writeFile(path.join(fakeTmp, "notes.txt"), "hello");
  await writeFile(path.join(outside, "secret.png"), PNG);
  await symlink(path.join(outside, "secret.png"), path.join(workspace, "escape.png"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Main's record of each thread's working directory. */
function threadCwds(): Record<string, string> {
  return {
    "t-ws": workspace,
    "t-sub": path.join(workspace, "src"),
    "t-root": path.parse(base).root,
  };
}

function grants(now: () => number = Date.now) {
  const cwds = threadCwds();
  return createLocalImageGrants({ now, tmpRoots: () => [fakeTmp], threadCwd: (id) => cwds[id] ?? null });
}

describe("isPathInside", () => {
  test("accepts a descendant and refuses the root, a sibling and a parent", () => {
    expect(isPathInside("/a/b", "/a/b/c.png")).toBe(true);
    expect(isPathInside("/a/b", "/a/b")).toBe(false);
    expect(isPathInside("/a/b", "/a/bc/x.png")).toBe(false);
    expect(isPathInside("/a/b", "/a/x.png")).toBe(false);
  });

  test("a file whose name starts with dots is still inside", () => {
    expect(isPathInside("/a/b", "/a/b/..hidden.png")).toBe(true);
  });
});

describe("local image grants", () => {
  test("a file in the workspace is allowed, from a subfolder cwd too", async () => {
    const g = grants();
    const url = await g.grant(path.join(workspace, "src", "shots", "a.png"), "t-sub");
    expect(url).toMatch(/^local-image:\/\/[0-9a-f-]{36}$/);
    expect(await g.resolve(url!)).toBe(path.join(workspace, "src", "shots", "a.png"));
  });

  test("a file in the temp folder is allowed without a cwd", async () => {
    const g = grants();
    const url = await g.grant(path.join(fakeTmp, "shot.png"));
    expect(await g.resolve(url!)).toBe(path.join(fakeTmp, "shot.png"));
  });

  test("the real system temp folder is allowed by default", async () => {
    const g = createLocalImageGrants();
    expect(await g.grant(path.join(fakeTmp, "shot.png"))).not.toBeNull();
  });

  test("a folder named in place of a thread opens nothing", async () => {
    // The renderer names a thread, and main reads that thread's folder from
    // its own records. Passing the folder of an otherwise refused image — or
    // any id main has no record of — must not widen what it may show.
    const g = grants();
    expect(await g.grant(path.join(outside, "secret.png"), outside)).toBeNull();
    expect(await g.grant(path.join(outside, "secret.png"), "t-unknown")).toBeNull();
    expect(await g.grant(path.join(workspace, "src", "shots", "a.png"), outside)).toBeNull();
  });

  test("a .txt in the temp folder is refused", async () => {
    expect(await grants().grant(path.join(fakeTmp, "notes.txt"))).toBeNull();
  });

  test("a file outside every allowed folder is refused", async () => {
    expect(await grants().grant(path.join(outside, "secret.png"), "t-ws")).toBeNull();
  });

  test("a symlink in the workspace pointing outside it is refused", async () => {
    expect(await grants().grant(path.join(workspace, "escape.png"), "t-ws")).toBeNull();
  });

  test("relative, empty, NUL-bearing and missing paths are refused", async () => {
    const g = grants();
    expect(await g.grant("shot.png", "t-ws")).toBeNull();
    expect(await g.grant("", "t-ws")).toBeNull();
    expect(await g.grant(`${fakeTmp}/shot.png\0.png`)).toBeNull();
    expect(await g.grant(path.join(fakeTmp, "missing.png"))).toBeNull();
  });

  test("a folder is refused even with an image extension", async () => {
    await mkdir(path.join(fakeTmp, "dir.png"), { recursive: true });
    expect(await grants().grant(path.join(fakeTmp, "dir.png"))).toBeNull();
  });

  test("a cwd at the filesystem root opens nothing", async () => {
    expect(await grants().grant(path.join(outside, "secret.png"), "t-root")).toBeNull();
  });

  test("a file replaced after the grant is not served", async () => {
    const file = path.join(fakeTmp, "swap.png");
    await writeFile(file, PNG);
    const g = grants();
    const url = await g.grant(file);
    expect(url).not.toBeNull();
    // A new inode at the same path: written while the old one still exists, so
    // the filesystem can't hand the same number back, then renamed over it.
    await writeFile(path.join(fakeTmp, "swap-new.png"), PNG);
    await rename(path.join(fakeTmp, "swap-new.png"), file);
    expect(await g.resolve(url!)).toBeNull();
  });

  test("an expired token is not served", async () => {
    let t = 1_000;
    const g = grants(() => t);
    const url = await g.grant(path.join(fakeTmp, "shot.png"));
    t += 10 * 60 * 1000;
    expect(await g.resolve(url!)).toBeNull();
  });

  test("unknown tokens and other schemes are not served", async () => {
    const g = grants();
    expect(await g.resolve("local-image://00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await g.resolve(`file://${path.join(fakeTmp, "shot.png")}`)).toBeNull();
    expect(await g.resolve("not a url")).toBeNull();
  });
});

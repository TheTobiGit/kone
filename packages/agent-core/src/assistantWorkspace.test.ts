import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { GLOBAL_ASSISTANT_PROJECT_PATH } from "./conversationStoreTypes.js";
import { setUserDataDir } from "./userDataDir.js";
import {
  assistantWorkingDir,
  isAssistantProjectPath,
  resetAssistantWorkingDirForTests,
  workingDirFor,
} from "./assistantWorkspace.js";

// The resolved directory is memoised for the life of the process, and the whole
// suite shares one process — so each case re-claims the state directory and
// clears the memo rather than reading whatever another file resolved first.
const stateDir = mkdtempSync(path.join(tmpdir(), "kone-assistant-ws-test-"));

beforeEach(() => {
  setUserDataDir(stateDir);
  resetAssistantWorkingDirForTests();
});

describe("assistantWorkingDir", () => {
  test("is a directory that exists, under the state dir", () => {
    const dir = assistantWorkingDir();
    expect(dir).toBe(path.join(stateDir, "assistant"));
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  // Not the state dir itself: a session rooted there would be sitting on top of
  // kone's own database.
  test("is not the state directory", () => {
    expect(assistantWorkingDir()).not.toBe(stateDir);
  });
});

describe("workingDirFor", () => {
  test("resolves the assistant's sentinel to its directory", () => {
    expect(workingDirFor(GLOBAL_ASSISTANT_PROJECT_PATH)).toBe(assistantWorkingDir());
  });

  // Every other project path is already a place, so it has to come back
  // untouched — this wraps a cwd on its way to a spawn.
  test("hands back a real project path unchanged", () => {
    expect(workingDirFor("/Users/someone/code/thing")).toBe("/Users/someone/code/thing");
  });
});

describe("isAssistantProjectPath", () => {
  test("recognises the sentinel and nothing else", () => {
    expect(isAssistantProjectPath(GLOBAL_ASSISTANT_PROJECT_PATH)).toBe(true);
    expect(isAssistantProjectPath("/Users/someone/code/thing")).toBe(false);
    expect(isAssistantProjectPath(null)).toBe(false);
    expect(isAssistantProjectPath(undefined)).toBe(false);
  });
});

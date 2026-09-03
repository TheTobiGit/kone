import { describe, expect, test } from "bun:test";
import { resolveInboxDefaultProject } from "./inboxDefaultProject";

describe("resolveInboxDefaultProject", () => {
  test("runs where work has been when a newest thread exists", () => {
    const result = resolveInboxDefaultProject({
      newestProjectPath: "/projects/work",
      activeProjectPath: "/projects/other",
      recents: [{ path: "/projects/other", name: "other" }],
      loading: false,
    });
    expect(result).toBe("/projects/work");
  });

  test("uses the single only project when no threads have run anywhere", () => {
    const result = resolveInboxDefaultProject({
      newestProjectPath: null,
      activeProjectPath: null,
      recents: [{ path: "/projects/only-one", name: "only-one" }],
      loading: false,
    });
    expect(result).toBe("/projects/only-one");
  });

  test("uses the single only project immediately even while loading", () => {
    const result = resolveInboxDefaultProject({
      newestProjectPath: null,
      activeProjectPath: null,
      recents: [{ path: "/projects/only-one", name: "only-one" }],
      loading: true,
    });
    expect(result).toBe("/projects/only-one");
  });

  test("waits for session queries to settle when multiple projects exist", () => {
    const result = resolveInboxDefaultProject({
      newestProjectPath: null,
      activeProjectPath: null,
      recents: [
        { path: "/projects/first", name: "first" },
        { path: "/projects/second", name: "second" },
      ],
      loading: true,
    });
    expect(result).toBeNull();
  });

  test("prefers the active open project when no threads exist", () => {
    const result = resolveInboxDefaultProject({
      newestProjectPath: null,
      activeProjectPath: "/projects/second",
      recents: [
        { path: "/projects/first", name: "first" },
        { path: "/projects/second", name: "second" },
      ],
      loading: false,
    });
    expect(result).toBe("/projects/second");
  });

  test("falls back to the most recent project when no threads and no active project", () => {
    const result = resolveInboxDefaultProject({
      newestProjectPath: null,
      activeProjectPath: null,
      recents: [
        { path: "/projects/first", name: "first" },
        { path: "/projects/second", name: "second" },
      ],
      loading: false,
    });
    expect(result).toBe("/projects/first");
  });

  test("returns null when no projects exist in the app", () => {
    const result = resolveInboxDefaultProject({
      newestProjectPath: null,
      activeProjectPath: null,
      recents: [],
      loading: false,
    });
    expect(result).toBeNull();
  });

  test("returns active project if recents is temporarily empty", () => {
    const result = resolveInboxDefaultProject({
      newestProjectPath: null,
      activeProjectPath: "/projects/standalone",
      recents: [],
      loading: false,
    });
    expect(result).toBe("/projects/standalone");
  });
});

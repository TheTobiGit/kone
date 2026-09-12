import { describe, expect, test } from "bun:test";
import { buildIntentMenu, resolveIntentTitle } from "./useIntentMenu";
import type { IntentContext } from "./useIntentMenu";

function ctx(over: Partial<IntentContext> = {}): IntentContext {
  return {
    view: "launcher",
    currentPath: null,
    recents: [],
    sessions: [],
    studioHasRows: false,
    settingsOpen: false,
    ...over,
  };
}

function ids(view: IntentContext["view"], over: Partial<IntentContext> = {}): string[] {
  return buildIntentMenu(ctx({ view, ...over })).flatMap((s) => s.items.map((i) => i.id));
}

describe("buildIntentMenu", () => {
  test("launcher with no history still offers go-tos plus entry points", () => {
    const sections = buildIntentMenu(ctx());
    expect(sections[0]?.key).toBe("goto");
    expect(ids("launcher")).toContain("goto-inbox");
    expect(ids("launcher")).toContain("create-project");
    expect(ids("launcher")).toContain("open-local");
    expect(ids("launcher")).toContain("clone-github");
  });

  test("launcher hides the studio go-to until the plane holds rows", () => {
    expect(ids("launcher")).not.toContain("goto-studio");
    expect(ids("launcher", { studioHasRows: true })).toContain("goto-studio");
  });

  test("project overview names git/studio/inbox/launcher, never itself", () => {
    const list = ids("project-overview", {
      git: { repo: true, dirtyFiles: 0, branch: "main" },
    });
    expect(list).toContain("goto-git");
    expect(list).toContain("goto-studio");
    expect(list).toContain("goto-inbox");
    expect(list).toContain("goto-launcher");
    expect(list).not.toContain("goto-overview");
  });

  test("project git offers the way back, not a second git row", () => {
    const list = ids("project-git");
    expect(list).toContain("goto-overview");
    expect(list).not.toContain("goto-git");
  });

  test("studio and inbox lead with back-to-page plus the sibling portal", () => {
    expect(ids("studio").slice(0, 2)).toEqual(["back-to-page", "goto-inbox"]);
    expect(ids("inbox", { studioHasRows: true }).slice(0, 2)).toEqual([
      "back-to-page",
      "goto-studio",
    ]);
  });

  test("dirty git earns a review row on project views only", () => {
    const git = { repo: true, dirtyFiles: 4, branch: "feat/x" };
    const overview = buildIntentMenu(ctx({ view: "project-overview", git }));
    expect(overview.find((s) => s.key === "now")?.items[0]?.label).toBe("Review 4 changes");
    expect(buildIntentMenu(ctx({ view: "launcher", git })).find((s) => s.key === "now")).toBeUndefined();
    const single = buildIntentMenu(ctx({ view: "project-git", git: { ...git, dirtyFiles: 1 } }));
    expect(single.find((s) => s.key === "now")?.items[0]?.label).toBe("Review 1 change");
  });

  test("recents skip the open project and cap at three", () => {
    const recents = [1, 2, 3, 4, 5].map((n) => ({
      path: `/p/${n}`,
      name: `p${n}`,
    }));
    const list = ids("project-overview", { currentPath: "/p/1", recents });
    expect(list.filter((id) => id.startsWith("open-project:"))).toEqual([
      "open-project:/p/2",
      "open-project:/p/3",
      "open-project:/p/4",
    ]);
  });

  test("untargeted launcher keeps the full picture, one cutout each", () => {
    const sections = buildIntentMenu(
      ctx({
        recents: [{ path: "/p/1", name: "one" }],
        sessions: [
          { threadId: "t1", title: "Fix it", projectPath: "/p/1", projectName: "one" },
        ],
      }),
    );
    expect(sections.map((s) => s.key)).toEqual(["goto", "recents", "sessions", "entry"]);
    expect(sections.find((s) => s.key === "recents")?.items[0]?.id).toBe("open-project:/p/1");
    expect(sections.find((s) => s.key === "sessions")?.items[0]?.id).toBe(
      "open-session:/p/1::t1",
    );
    expect(sections.find((s) => s.key === "entry")?.items.map((i) => i.id)).toEqual([
      "create-project",
      "open-local",
      "clone-github",
    ]);
    expect(sections.find((s) => s.key === "target")).toBeUndefined();
  });

  test("a targeted tile leads with Open and carries its own actions", () => {
    const sections = buildIntentMenu(
      ctx({
        recents: [
          { path: "/p/1", name: "one" },
          { path: "/p/2", name: "two" },
        ],
        sessions: [
          { threadId: "t1", title: "Fix it", projectPath: "/p/1", projectName: "one" },
          { threadId: "t2", title: "Other", projectPath: "/p/2", projectName: "two" },
        ],
        targetProject: { path: "/p/1", name: "one", pinned: true },
      }),
    );
    // Go-tos still first, but Open leads them.
    expect(sections[0]?.key).toBe("goto");
    expect(sections[0]?.items[0]?.id).toBe("open-project:/p/1");
    // Then the tile's own actions, in the tile's own words.
    const target = sections.find((s) => s.key === "target");
    expect(target?.items.map((i) => i.label)).toEqual([
      "Unpin project",
      "Reveal in Finder",
      "Remove from recents",
    ]);
    expect(target?.items[0]?.payload).toEqual({ path: "/p/1", name: "one" });
    // History narrows to the tile: its sessions in their own cutout, no
    // recents card, no entry points.
    expect(sections.find((s) => s.key === "recents")).toBeUndefined();
    expect(sections.find((s) => s.key === "entry")).toBeUndefined();
    const sessions = sections.find((s) => s.key === "sessions");
    expect(sessions?.items.map((i) => i.id)).toEqual(["open-session:/p/1::t1"]);
  });

  test("an unpinned targeted tile offers Pin to top", () => {
    const sections = buildIntentMenu(
      ctx({ targetProject: { path: "/p/1", name: "one" } }),
    );
    expect(sections.find((s) => s.key === "target")?.items[0]?.label).toBe("Pin to top");
  });

  test("every goto card closes with Settings — unless it is already open", () => {
    for (const view of ["launcher", "project-overview", "project-git", "studio", "inbox"] as const) {
      const sections = buildIntentMenu(ctx({ view }));
      const goto = sections.find((s) => s.key === "goto");
      expect(goto?.items[goto.items.length - 1]?.id).toBe("open-settings");
    }
    const open = buildIntentMenu(ctx({ view: "launcher", settingsOpen: true }));
    expect(open.flatMap((s) => s.items.map((i) => i.id))).not.toContain("open-settings");
  });

  test("unknown or absent git hides the Git go-to on project views", () => {
    expect(ids("project-overview")).not.toContain("goto-git");
    expect(ids("project-overview", { git: null })).not.toContain("goto-git");
    expect(
      ids("project-overview", {
        git: { repo: false, dirtyFiles: 0, branch: null },
      }),
    ).not.toContain("goto-git");
    expect(
      ids("project-overview", {
        git: { repo: true, dirtyFiles: 0, branch: "main" },
      }),
    ).toContain("goto-git");
  });

  test("a session beats a tile when both are under the pointer", () => {
    const sections = buildIntentMenu(
      ctx({
        recents: [
          { path: "/p/1", name: "one" },
          { path: "/p/2", name: "two" },
        ],
        sessions: [
          { threadId: "t1", title: "Fix the crash", projectPath: "/p/1", projectName: "one" },
          { threadId: "t2", title: "Polish pass", projectPath: "/p/1", projectName: "one" },
          { threadId: "t3", title: "Elsewhere", projectPath: "/p/2", projectName: "two" },
        ],
        targetProject: { path: "/p/2", name: "two" },
        targetSession: {
          threadId: "t1",
          title: "Fix the crash",
          projectPath: "/p/1",
          projectName: "one",
        },
      }),
    );
    // The session wins the lead and the target card; the tile is ignored.
    expect(sections[0]?.key).toBe("goto");
    const lead = sections[0]?.items[0];
    expect(lead?.id).toBe("open-session:/p/1::t1");
    expect(lead?.label).toBe("Open Fix the crash");
    expect(lead?.payload).toEqual({ path: "/p/1", name: "one", threadId: "t1" });
    const target = sections.find((s) => s.key === "target");
    expect(target?.items.map((i) => i.label)).toEqual([
      "Pin conversation",
      "Archive conversation",
    ]);
    // Siblings card: same project, itself dropped, other projects out.
    const siblings = sections.find((s) => s.key === "sessions");
    expect(siblings?.items.map((i) => i.id)).toEqual(["open-session:/p/1::t2"]);
    expect(sections.find((s) => s.key === "recents")).toBeUndefined();
    expect(sections.find((s) => s.key === "entry")).toBeUndefined();
  });

  test("a pinned session offers Unpin, and long titles cut to one line", () => {
    const sections = buildIntentMenu(
      ctx({
        targetSession: {
          threadId: "t1",
          title: "A very long conversation title that would wrap the row twice over",
          projectPath: "/p/1",
          projectName: "one",
          pinned: true,
        },
      }),
    );
    const target = sections.find((s) => s.key === "target");
    expect(target?.items[0]?.label).toBe("Unpin conversation");
    const lead = sections[0]?.items[0];
    expect(lead?.label).toBe("Open A very long conversation title that wou…");
    expect(lead?.label.length).toBeLessThanOrEqual(46);
  });

  test("targeting is a launcher affair — project views ignore it", () => {
    const sections = buildIntentMenu(
      ctx({
        view: "project-overview",
        currentPath: "/p/1",
        recents: [{ path: "/p/1", name: "one" }],
        targetProject: { path: "/p/2", name: "two" },
      }),
    );
    expect(sections.find((s) => s.key === "target")).toBeUndefined();
  });

  test("sessions carry their thread payload and fall back to untitled", () => {
    const sections = buildIntentMenu(
      ctx({
        sessions: [
          { threadId: "t1", title: "  ", projectPath: "/p/1", projectName: "one" },
          { threadId: "t2", title: "Fix it", projectPath: "/p/2", projectName: "two" },
        ],
      }),
    );
    const sessions = sections.find((s) => s.key === "sessions");
    const rows = sessions?.items.filter((i) => i.id.startsWith("open-session:")) ?? [];
    expect(rows[0]?.label).toBe("Untitled session");
    expect(rows[1]?.payload).toEqual({ path: "/p/2", name: "two", threadId: "t2" });
  });

  test("every item carries a typed action matching its id", () => {
    const targeted = buildIntentMenu(
      ctx({ targetProject: { path: "/p/1", name: "one", pinned: true } }),
    );
    const target = targeted.find((s) => s.key === "target");
    expect(target?.items[0]?.id).toBe("pin-project:/p/1");
    expect(target?.items[0]?.action).toEqual({ kind: "pin-project", path: "/p/1" });
    expect(target?.items[1]?.action).toEqual({ kind: "reveal-project", path: "/p/1" });
    expect(target?.items[2]?.action).toEqual({ kind: "forget-project", path: "/p/1" });
  });

  test("targeted session lead and row actions carry open/pin actions", () => {
    const sections = buildIntentMenu(
      ctx({
        targetSession: {
          threadId: "t1",
          title: "Fix the crash",
          projectPath: "/p/1",
          projectName: "one",
        },
      }),
    );
    const lead = sections[0]?.items[0];
    expect(lead?.id).toBe("open-session:/p/1::t1");
    expect(lead?.action).toEqual({
      kind: "open-session",
      path: "/p/1",
      name: "one",
      threadId: "t1",
    });
    const target = sections.find((s) => s.key === "target");
    expect(target?.items[0]?.id).toBe("pin-session:t1");
    expect(target?.items[0]?.action).toEqual({ kind: "pin-session", threadId: "t1" });
    expect(target?.items[1]?.action).toEqual({ kind: "archive-session", threadId: "t1" });
  });

  test("goto, entry and review rows carry typed actions", () => {
    const launcher = buildIntentMenu(ctx({ view: "launcher", studioHasRows: true }));
    const goto = launcher.find((s) => s.key === "goto");
    expect(goto?.items.find((i) => i.id === "goto-studio")?.action).toEqual({
      kind: "goto",
      view: "studio",
    });
    expect(goto?.items.find((i) => i.id === "goto-inbox")?.action).toEqual({
      kind: "goto",
      view: "inbox",
    });
    expect(goto?.items.find((i) => i.id === "open-settings")?.action).toEqual({
      kind: "open-settings",
    });
    const entry = launcher.find((s) => s.key === "entry");
    expect(entry?.items.find((i) => i.id === "create-project")?.action).toEqual({
      kind: "start",
      key: "create",
    });
    expect(entry?.items.find((i) => i.id === "open-local")?.action).toEqual({
      kind: "start",
      key: "open",
    });
    expect(entry?.items.find((i) => i.id === "clone-github")?.action).toEqual({
      kind: "start",
      key: "clone",
    });

    const git = { repo: true, dirtyFiles: 2, branch: "main" };
    const overview = buildIntentMenu(ctx({ view: "project-overview", git }));
    expect(overview.find((s) => s.key === "now")?.items[0]?.id).toBe("review-changes");
    expect(overview.find((s) => s.key === "now")?.items[0]?.action).toEqual({
      kind: "review-changes",
    });
  });
});

describe("resolveIntentTitle", () => {
  test("a session title beats a tile beats the view", () => {
    expect(
      resolveIntentTitle(
        "launcher",
        { threadId: "t1", title: "Fix the crash", projectPath: "/p/1", projectName: "one" },
        { path: "/p/2", name: "two" },
        null,
      ),
    ).toBe("Fix the crash");
    expect(resolveIntentTitle("launcher", null, { path: "/p/2", name: "two" }, null)).toBe(
      "two",
    );
  });

  test("the view names itself when nothing is under the pointer", () => {
    expect(resolveIntentTitle("studio", null, null, null)).toBe("Studio");
    expect(resolveIntentTitle("inbox", null, null, null)).toBe("Inbox");
    expect(resolveIntentTitle("project-overview", null, null, "Nova")).toBe("Nova");
    expect(resolveIntentTitle("launcher", null, null, null)).toBe("Kone");
  });

  test("blank session titles fall through, long ones shorten", () => {
    expect(
      resolveIntentTitle(
        "launcher",
        { threadId: "t1", title: "   ", projectPath: "/p/1", projectName: "one" },
        { path: "/p/1", name: "one" },
        null,
      ),
    ).toBe("one");
    expect(
      resolveIntentTitle(
        "launcher",
        {
          threadId: "t1",
          title: "A very long conversation title that would wrap the row twice over",
          projectPath: "/p/1",
          projectName: "one",
        },
        null,
        null,
      ),
    ).toBe("A very long conversation title that wou…");
  });
});

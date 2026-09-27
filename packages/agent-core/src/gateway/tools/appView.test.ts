import { describe, expect, test } from "bun:test";
import type { ViewSnapshot } from "@kone/protocol/view-context";
import type { StoredThread } from "../../types.js";
import type { GatewayToolContext } from "../registry.js";
import { createAppViewTools, type AppViewToolOptions } from "./appView.js";

const ctx: GatewayToolContext = {
  threadId: "assistant-thread",
  turnId: "turn-1",
  provider: "claudeAgent",
  cwd: "__kone_assistant__",
  requestId: 1,
};

const kone = { name: "kone", path: "/home/u/kone" };

function studio(focus: "thread" | "terminal"): ViewSnapshot {
  return {
    version: 1,
    at: Date.now(),
    assistantOpen: true,
    selection: null,
    layers: [
      {
        surface: "studio",
        mode: "row",
        rows: [{ ...kone, panes: 2, focused: true }],
        row: {
          project: kone,
          panes: [
            { kind: "thread", focused: focus === "thread", threadId: "th-1", title: "Fix build", status: "idle" },
            { kind: "terminal", focused: focus === "terminal", terminalId: "pty-1", cwd: kone.path, status: "ready", running: null },
          ],
        },
      },
    ],
  };
}

function thread(): StoredThread {
  // SAFETY: the tool reads `title` and `blocks` only; the rest of the stored
  // row is irrelevant to it and left out of the fixture.
  // eslint-disable-next-line anti-slop/no-chained-type-assertions
  return {
    title: "Fix build",
    blocks: [
      { id: "b1", role: "user", text: "why does the build fail?", at: 1 },
      {
        id: "b2",
        role: "assistant",
        at: 2,
        items: [{ kind: "assistant_text", text: "A missing import in main.ts." }],
      },
    ],
  } as unknown as StoredThread;
}

function tool(options: Partial<AppViewToolOptions>) {
  const [entry] = createAppViewTools({
    store: { loadThread: (id) => (id === "th-1" ? thread() : null) },
    ...options,
  });
  if (!entry) throw new Error("no tool");
  return entry;
}

function text(result: { content: Array<{ text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("app_get_view", () => {
  test("says the screen is unknown before the renderer has reported it", async () => {
    const result = await tool({ readView: () => null }).handler(ctx, {});
    expect(text(result)).toContain("has not reported what is on screen");
    expect(result.structuredContent).toEqual({ known: false });
  });

  test("describes the screen", async () => {
    const result = await tool({ readView: () => studio("thread") }).handler(ctx, {});
    expect(text(result)).toContain('The studio, on the row for "kone"');
    expect(result.structuredContent?.known).toBe(true);
  });

  test("reads the focused thread's latest messages", async () => {
    const result = await tool({ readView: () => studio("thread") }).handler(ctx, { include: ["thread"] });
    const out = text(result);
    expect(out).toContain('Focused thread "Fix build" (id th-1), its last 2 messages');
    expect(out).toContain("[user]\nwhy does the build fail?");
    expect(out).toContain("[agent]\nA missing import in main.ts.");
  });

  test("reads the focused terminal's screen", async () => {
    const asked: Array<[string, number]> = [];
    const result = await tool({
      readView: () => studio("terminal"),
      readTerminalScreen: async (id, lines) => {
        asked.push([id, lines]);
        return { cwd: kone.path, status: "exited", running: null, exitCode: 1, lines: ["$ bun build", "error: nope"] };
      },
    }).handler(ctx, { include: ["terminal"], lines: 20 });
    expect(asked).toEqual([["pty-1", 20]]);
    const out = text(result);
    expect(out).toContain("Focused terminal in /home/u/kone, exited with code 1.");
    expect(out).toContain("```\n$ bun build\nerror: nope\n```");
  });

  test("says so when what was asked for does not have focus", async () => {
    const onTerminal = await tool({ readView: () => studio("terminal") }).handler(ctx, { include: ["thread"] });
    expect(text(onTerminal)).toContain("No thread has focus on screen");
    const onThread = await tool({ readView: () => studio("thread") }).handler(ctx, { include: ["terminal"] });
    expect(text(onThread)).toContain("No terminal has focus on screen.");
  });
});

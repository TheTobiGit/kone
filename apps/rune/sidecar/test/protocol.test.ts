import { expect, test } from "bun:test";
import { sessionSchema, studioLayoutSchema, turnSchema } from "../src/protocol.js";

test("native composer null model becomes an omitted provider default", () => {
  const session = sessionSchema.parse({ threadId: "one", provider: "codex", cwd: "/tmp/project", model: null, mode: "ask", effort: "medium", gatewayConnection: { url: "untrusted" } });
  expect(session.model).toBeUndefined();
  expect("gatewayConnection" in session).toBe(false);
});

test("invalid optional turn settings cannot reach adapters", () => {
  const turn = { threadId: "one", input: "hello" };
  expect(turnSchema.safeParse({ ...turn, mode: "unrestricted" }).success).toBe(false);
  expect(turnSchema.safeParse({ ...turn, effort: { value: "medium" } }).success).toBe(false);
  expect(turnSchema.safeParse({ ...turn, fallbacks: [{ provider: "missing" }] }).success).toBe(false);
  expect(turnSchema.safeParse({ ...turn, attachments: [{ type: "image", id: "x", name: "x", mimeType: "image/png", sizeBytes: -1 }] }).success).toBe(false);
});

test("session paths stay absolute and workspaces use a supported mode", () => {
  const session = { threadId: "one", provider: "codex", cwd: "/tmp/project" };
  expect(sessionSchema.safeParse({ ...session, cwd: "relative" }).success).toBe(false);
  expect(sessionSchema.safeParse({ ...session, workspace: { mode: "arbitrary" } }).success).toBe(false);
});

test("older empty Studio documents normalize focus while malformed rows fail", () => {
  expect(studioLayoutSchema.parse({ version: 2, rows: [] })).toEqual({ version: 2, rows: [], focusedRow: null });
  expect(studioLayoutSchema.safeParse({ version: 2, rows: [{ projectPath: "/tmp", panes: "broken" }] }).success).toBe(false);
});

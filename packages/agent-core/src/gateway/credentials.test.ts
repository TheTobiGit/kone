import { describe, expect, test } from "bun:test";

import { GatewayCredentials } from "./credentials.js";

const CONN = { threadId: "thread-1", provider: "claudeAgent" as const, model: "sonnet" };

describe("GatewayCredentials", () => {
  test("issue → verify round-trips, unknown token is null", () => {
    const credentials = new GatewayCredentials();
    const token = credentials.issueSessionToken(CONN.threadId, CONN.provider, CONN.model);
    expect(credentials.verifySessionToken(token)).toEqual({
      threadId: "thread-1",
      provider: "claudeAgent",
      model: "sonnet",
    });
    expect(credentials.verifySessionToken("bogus")).toBeNull();
  });

  test("issueSessionToken revokes the thread's prior token (session restart)", () => {
    const credentials = new GatewayCredentials();
    const first = credentials.issueSessionToken("t", "codex");
    credentials.issueSessionToken("t", "codex");
    expect(credentials.verifySessionToken(first)).toBeNull();
    expect(credentials.tokensForThread("t")).toHaveLength(1);
  });

  test("connectionForThread returns endpoint + live token", () => {
    const credentials = new GatewayCredentials();
    credentials.setListeningPort(4123);
    const conn = credentials.connectionForThread("t", "opencode");
    expect(conn.url).toBe("http://127.0.0.1:4123/mcp");
    expect(credentials.verifySessionToken(conn.bearerToken)).not.toBeNull();
  });

  test("revokeSessionToken kills the token and its authority", () => {
    const credentials = new GatewayCredentials();
    const token = credentials.issueSessionToken("t", "cursor");
    credentials.bindWriteAuthority(token, "turn-1");
    credentials.revokeSessionToken(token);
    expect(credentials.verifySessionToken(token)).toBeNull();
    expect(credentials.verifyWriteAuthority(token)).toBeNull();
  });

  test("revokeThread kills every token a thread owns", () => {
    const credentials = new GatewayCredentials();
    const a = credentials.issueSessionToken("t", "codex");
    const b = credentials.issueSessionToken("t", "codex");
    const other = credentials.issueSessionToken("other", "claudeAgent");
    credentials.revokeThread("t");
    expect(credentials.verifySessionToken(a)).toBeNull();
    expect(credentials.verifySessionToken(b)).toBeNull();
    expect(credentials.verifySessionToken(other)).not.toBeNull();
  });

  describe("write authority / turn binding", () => {
    test("first bind sticks; same turn rebinds", () => {
      const credentials = new GatewayCredentials();
      const token = credentials.issueSessionToken("t", "claudeAgent");
      expect(credentials.bindWriteAuthority(token, "turn-1")).toBe(true);
      expect(credentials.bindWriteAuthority(token, "turn-1")).toBe(true);
      expect(credentials.verifyWriteAuthority(token)).toEqual({ turnId: "turn-1" });
    });

    test("retireSessionTurn stales the binding; the next turn rebinds", () => {
      const credentials = new GatewayCredentials();
      const token = credentials.issueSessionToken("t", "claudeAgent");
      credentials.bindWriteAuthority(token, "turn-1");
      credentials.retireSessionTurn(token, "turn-1");
      expect(credentials.verifyWriteAuthority(token)).toBeNull();
      expect(credentials.bindWriteAuthority(token, "turn-2")).toBe(true);
      expect(credentials.verifyWriteAuthority(token)).toEqual({ turnId: "turn-2" });
    });

    test("multi-turn session: write works every turn, not just the first", () => {
      const credentials = new GatewayCredentials();
      const token = credentials.issueSessionToken("t", "claudeAgent");
      expect(credentials.bindWriteAuthority(token, "turn-1")).toBe(true);
      credentials.retireSessionTurn(token, "turn-1");
      expect(credentials.bindWriteAuthority(token, "turn-2")).toBe(true);
      credentials.retireSessionTurn(token, "turn-2");
      expect(credentials.bindWriteAuthority(token, "turn-3")).toBe(true);
      expect(credentials.verifyWriteAuthority(token)).toEqual({ turnId: "turn-3" });
    });

    test("a STILL-LIVE binding refuses a different turn (no authority inheritance)", () => {
      const credentials = new GatewayCredentials();
      const token = credentials.issueSessionToken("t", "claudeAgent");
      credentials.bindWriteAuthority(token, "turn-1");
      expect(credentials.bindWriteAuthority(token, "turn-2")).toBe(false);
      expect(credentials.verifyWriteAuthority(token)).toEqual({ turnId: "turn-1" });
    });

    test("retiring a different turn does not disturb the bound one", () => {
      const credentials = new GatewayCredentials();
      const token = credentials.issueSessionToken("t", "claudeAgent");
      credentials.bindWriteAuthority(token, "turn-1");
      credentials.retireSessionTurn(token, "turn-0");
      expect(credentials.verifyWriteAuthority(token)).toEqual({ turnId: "turn-1" });
    });

    test("a read-only session never binds and holds no authority", () => {
      const credentials = new GatewayCredentials();
      const token = credentials.issueSessionToken("t", "claudeAgent");
      expect(credentials.verifyWriteAuthority(token)).toBeNull();
    });
  });
});

import { describe, expect, test } from "bun:test";

import {
  isRetryableOpenCodeServerFailure,
  OPENCODE_SERVER_RETRY_DELAYS_MS,
} from "./opencodeServer.js";

describe("isRetryableOpenCodeServerFailure", () => {
  test("matches the sqlite-busy / locked-database class", () => {
    expect(isRetryableOpenCodeServerFailure("database is locked")).toBe(true);
    expect(isRetryableOpenCodeServerFailure("database is busy")).toBe(true);
    expect(isRetryableOpenCodeServerFailure("SQLITE_BUSY: database is locked")).toBe(true);
    expect(
      isRetryableOpenCodeServerFailure('failed query: update "credential" set ...'),
    ).toBe(true);
    expect(
      isRetryableOpenCodeServerFailure("failed query: update `credential` set ..."),
    ).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isRetryableOpenCodeServerFailure("Database Is Locked")).toBe(true);
    expect(isRetryableOpenCodeServerFailure("FAILED QUERY: UPDATE \"credential\" SET")).toBe(true);
  });

  test("rejects unrelated failures", () => {
    expect(isRetryableOpenCodeServerFailure("EADDRINUSE: address already in use")).toBe(false);
    expect(isRetryableOpenCodeServerFailure("opencode: command not found")).toBe(false);
    expect(isRetryableOpenCodeServerFailure("timed out waiting for the server")).toBe(false);
    expect(isRetryableOpenCodeServerFailure("")).toBe(false);
  });
});

describe("OPENCODE_SERVER_RETRY_DELAYS_MS", () => {
  test("is the bounded 500ms/1500ms ladder", () => {
    expect(OPENCODE_SERVER_RETRY_DELAYS_MS).toEqual([500, 1_500]);
  });
});

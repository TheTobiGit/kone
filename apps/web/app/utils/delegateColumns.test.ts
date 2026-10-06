import { beforeEach, describe, expect, it } from "bun:test";
import { claimDelegateColumn, resetDelegateColumns } from "./delegateColumns";

const since = 1_000;

describe("claimDelegateColumn", () => {
  beforeEach(() => resetDelegateColumns());

  it("opens a delegate handed off during this run, once", () => {
    const child = { threadId: "d1", handOff: "delegation" as const, createdAt: since + 1 };
    expect(claimDelegateColumn(child, since)).toBe(true);
    expect(claimDelegateColumn(child, since)).toBe(false);
  });

  it("opens a contractor the same way", () => {
    expect(claimDelegateColumn({ threadId: "c1", handOff: "contract", createdAt: since }, since)).toBe(true);
  });

  it("never reopens a delegate re-seeded from an earlier run", () => {
    expect(claimDelegateColumn({ threadId: "old", handOff: "delegation", createdAt: since - 1 }, since)).toBe(false);
  });

  it("leaves workers in the dock", () => {
    expect(claimDelegateColumn({ threadId: "w1", handOff: "worker", createdAt: since + 1 }, since)).toBe(false);
    expect(claimDelegateColumn({ threadId: "w2", createdAt: since + 1 }, since)).toBe(false);
  });
});

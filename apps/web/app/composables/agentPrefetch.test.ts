import { describe, expect, test } from "bun:test";

import { adoptStoredBlocks } from "./agentPrefetch";
import type { ThreadBlock } from "./agentTypes";

function user(id: string, effort?: string): ThreadBlock {
  const block: ThreadBlock = { id, role: "user", text: "hello", at: 0 };
  if (effort !== undefined) {
    // SAFETY: the store journals the tier verbatim, so the stamp arrives as a
    // raw string the ThreadBlock type cannot see — this mirrors that read.
    (block as ThreadBlock & { effort?: string }).effort = effort;
  }
  return block;
}

describe("adoptStoredBlocks effort stamps", () => {
  test("a known tier survives the adopt", () => {
    const [adopted] = adoptStoredBlocks([user("u1", "high")]);
    expect(adopted?.role).toBe("user");
    if (adopted?.role === "user") expect(adopted.effort).toBe("high");
  });

  test("an unknown tier degrades to unstamped rather than rendering wrong", () => {
    const [adopted] = adoptStoredBlocks([user("u1", "ultra-max")]);
    expect(adopted?.role).toBe("user");
    if (adopted?.role === "user") expect(adopted.effort).toBeUndefined();
  });

  test("a block without a stamp stays without one", () => {
    const [adopted] = adoptStoredBlocks([user("u1")]);
    expect(adopted?.role).toBe("user");
    if (adopted?.role === "user") expect(adopted.effort).toBeUndefined();
  });

  test("adopted blocks still mount historical", () => {
    const [adopted] = adoptStoredBlocks([user("u1", "medium")]);
    expect(adopted?.historical).toBe(true);
  });
});

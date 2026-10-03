import { describe, expect, test } from "bun:test";
import { steeredBlockIds } from "./steerSplit.js";

describe("steeredBlockIds", () => {
  test("a batch names every block, in order", () => {
    expect(steeredBlockIds({ userBlockId: "b", userBlockIds: ["a", "b"] })).toEqual(["a", "b"]);
  });

  test("a single steer names its one block", () => {
    expect(steeredBlockIds({ userBlockId: "a" })).toEqual(["a"]);
  });

  test("a steer with no block names none", () => {
    expect(steeredBlockIds({})).toEqual([]);
    expect(steeredBlockIds({ userBlockIds: [] })).toEqual([]);
  });
});

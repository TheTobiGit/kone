import { describe, expect, test } from "bun:test";

import {
  TITLE_CONTEXT_MAX_CHARS,
  TITLE_CONTEXT_MAX_MESSAGE_CHARS,
  formatThreadTitleContext,
  limitTitleMessage,
  type ThreadTitleMessage,
} from "./threadTitleContext.js";

const user = (text: string): ThreadTitleMessage => ({ role: "user", text });
const assistant = (text: string): ThreadTitleMessage => ({ role: "assistant", text });

describe("limitTitleMessage", () => {
  test("keeps a message under budget whole", () => {
    expect(limitTitleMessage("short request", 100)).toBe("short request");
  });

  test("keeps head and tail of an oversized message", () => {
    const text = `HEAD${"x".repeat(500)}TAIL`;
    const limited = limitTitleMessage(text, 100);
    expect(limited.startsWith("HEAD")).toBe(true);
    expect(limited.endsWith("TAIL")).toBe(true);
    expect(limited).toContain("[Content truncated]");
  });

  test("drops a message with no room for the marker", () => {
    expect(limitTitleMessage("anything", 5)).toBe("");
  });
});

describe("formatThreadTitleContext", () => {
  test("returns empty for no meaningful messages", () => {
    expect(formatThreadTitleContext([])).toBe("");
    expect(formatThreadTitleContext([user("   "), assistant("")])).toBe("");
  });

  test("drops reasoning and system messages", () => {
    const context = formatThreadTitleContext([
      { role: "system", text: "system preamble" },
      user("rename the parser"),
      { role: "reasoning", text: "I should think about parsers" },
      assistant("Renamed it"),
    ]);
    expect(context).not.toContain("system preamble");
    expect(context).not.toContain("think about parsers");
    expect(context).toContain("rename the parser");
    expect(context).toContain("Renamed it");
  });

  test("reserves the first user message and preserves conversation order", () => {
    const context = formatThreadTitleContext([
      user("original request about auth"),
      assistant("done"),
      user("actually make it OAuth"),
    ]);
    // Selection order differs from output order: the transcript stays in order.
    expect(context.indexOf("original request about auth")).toBeLessThan(
      context.indexOf("actually make it OAuth"),
    );
    expect(context.startsWith("USER:")).toBe(true);
  });

  test("assistant answers cannot evict user intent", () => {
    const hugeAnswer = assistant("a".repeat(TITLE_CONTEXT_MAX_CHARS));
    const context = formatThreadTitleContext([user("the real request"), hugeAnswer]);
    expect(context).toContain("the real request");
  });

  test("marks the context when anything was left out", () => {
    const messages = [user("first request")];
    for (let i = 0; i < 20; i++) messages.push(assistant("b".repeat(TITLE_CONTEXT_MAX_MESSAGE_CHARS)));
    const context = formatThreadTitleContext(messages);
    expect(context.startsWith("[Earlier content truncated]")).toBe(true);
  });

  test("never exceeds the total budget", () => {
    const messages: ThreadTitleMessage[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push(user(`request ${i} ${"u".repeat(500)}`));
      messages.push(assistant(`answer ${i} ${"a".repeat(500)}`));
    }
    expect(formatThreadTitleContext(messages).length).toBeLessThanOrEqual(TITLE_CONTEXT_MAX_CHARS);
  });
});

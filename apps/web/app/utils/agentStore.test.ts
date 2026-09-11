import { describe, expect, test } from "bun:test";

import { ref } from "vue";

import { sendable } from "./agentStore";

// What a pane collects lives in refs, and a ref holding an object hands out a
// reactive proxy — which the bridge's serializer refuses outright. Every
// payload leaving the renderer goes through sendable first, so the guarantee
// is pinned here, beside the function that makes it.
describe("sendable", () => {
  test("sendable strips reactivity for structuredClone", () => {
    const draft = ref({
      name: "Researcher",
      instructions: "Explore codebase",
      model: { provider: "codex", model: "gpt-5", label: "GPT-5" },
      modelFallbacks: [{ provider: "claudeAgent", model: "haiku", label: "Haiku" }],
    });
    expect(() => structuredClone(draft.value)).toThrow();
    const payload = sendable(draft.value);
    expect(() => structuredClone(payload)).not.toThrow();
    expect(payload).toEqual({
      name: "Researcher",
      instructions: "Explore codebase",
      model: { provider: "codex", model: "gpt-5", label: "GPT-5" },
      modelFallbacks: [{ provider: "claudeAgent", model: "haiku", label: "Haiku" }],
    });
  });
});

import { describe, expect, test } from "bun:test";
import { ref } from "vue";

import { useKeyedWorkspaceChoice, useWorkspaceChoice } from "./useWorkspaceChoice";

describe("useWorkspaceChoice", () => {
  test("starts in the checkout: its branch shows and nothing is requested", () => {
    const ws = useWorkspaceChoice({ fallbackBranch: () => "main" });

    expect(ws.choice.value).toEqual({ mode: "local", base: null });
    expect(ws.branch.value).toBe("main");
    expect(ws.request()).toBeUndefined();
  });

  test("a worktree from another branch names that branch and requests it", () => {
    const ws = useWorkspaceChoice({ fallbackBranch: () => "main" });
    ws.pick({ mode: "worktree", base: "release" });

    expect(ws.branch.value).toBe("release");
    expect(ws.request()).toEqual({ mode: "worktree", base: "release" });
  });

  test("a worktree from the current branch shows the checkout's branch", () => {
    const ws = useWorkspaceChoice({ fallbackBranch: () => "main" });
    ws.pick({ mode: "worktree", base: null });

    expect(ws.branch.value).toBe("main");
    expect(ws.request()).toEqual({ mode: "worktree" });
  });

  test("only a local pick re-reads the checkout; reset does not", () => {
    let reads = 0;
    const ws = useWorkspaceChoice({ fallbackBranch: () => null, onLocal: () => reads++ });

    ws.pick({ mode: "worktree", base: null });
    expect(reads).toBe(0);
    ws.pick({ mode: "local", base: null });
    expect(reads).toBe(1);
    ws.pick({ mode: "worktree", base: "dev" });
    ws.reset();
    expect(reads).toBe(1);
    expect(ws.request()).toBeUndefined();
    expect(ws.branch.value).toBeUndefined();
  });
});

describe("useKeyedWorkspaceChoice", () => {
  test("each draft keeps its own choice", () => {
    const key = ref<string | null>("a");
    const ws = useKeyedWorkspaceChoice({
      key: () => key.value,
      drafting: () => true,
      fallbackBranch: () => "main",
    });

    ws.pick({ mode: "worktree", base: "dev" });
    key.value = "b";
    expect(ws.choice.value.mode).toBe("local");
    expect(ws.branch.value).toBe("main");
    key.value = "a";
    expect(ws.request()).toEqual({ mode: "worktree", base: "dev" });
  });

  test("a draft that has started reads as the checkout", () => {
    const drafting = ref(true);
    const ws = useKeyedWorkspaceChoice({
      key: () => "a",
      drafting: () => drafting.value,
      fallbackBranch: () => "main",
    });

    ws.pick({ mode: "worktree", base: "dev" });
    drafting.value = false;
    expect(ws.request()).toBeUndefined();
    expect(ws.branch.value).toBe("main");
  });

  test("with nothing focused a pick is dropped", () => {
    const ws = useKeyedWorkspaceChoice({
      key: () => null,
      drafting: () => true,
      fallbackBranch: () => "main",
    });

    ws.pick({ mode: "worktree", base: "dev" });
    expect(ws.request()).toBeUndefined();
  });
});

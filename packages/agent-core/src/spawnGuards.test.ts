import { describe, expect, test } from "bun:test";

import {
  SPAWN_REFUSAL_EMPTY_PROMPT,
  checkSpawn,
  spawnRefusalDepth,
  spawnRefusalModelNotFound,
} from "./spawnGuards.js";
import type { SpawnGuardInput } from "./spawnGuards.js";
import {
  MAX_LIVE_CHILDREN_PER_PARENT,
  MAX_LIVE_SPAWNED_THREADS,
  MAX_SPAWN_DEPTH,
} from "./types.js";

describe("checkSpawn", () => {
  function base(overrides: Partial<SpawnGuardInput> = {}): SpawnGuardInput {
    return {
      prompt: "Fix the flaky test.",
      target: { provider: "codex" },
      parentMode: "full-access",
      parentDepth: 0,
      liveChildrenOfParent: 0,
      liveSpawnedTotal: 0,
      ...overrides,
    };
  }

  test("refuses an empty or whitespace prompt with invalid_input", () => {
    for (const prompt of ["", "   ", "\n\t"]) {
      expect(checkSpawn(base({ prompt }))).toEqual({
        ok: false,
        code: "invalid_input",
        message: SPAWN_REFUSAL_EMPTY_PROMPT,
      });
    }
  });

  test("refuses when the child would land deeper than MAX_SPAWN_DEPTH", () => {
    const result = checkSpawn(base({ parentDepth: MAX_SPAWN_DEPTH }));
    expect(result).toEqual({
      ok: false,
      code: "capability_denied",
      message: spawnRefusalDepth(MAX_SPAWN_DEPTH),
    });
  });

  test("refuses a parent at its live-children cap", () => {
    const result = checkSpawn(base({ liveChildrenOfParent: MAX_LIVE_CHILDREN_PER_PARENT }));
    expect(result).toMatchObject({ ok: false, code: "capability_denied" });
  });

  test("refuses at the app-wide spawn cap", () => {
    const result = checkSpawn(base({ liveSpawnedTotal: MAX_LIVE_SPAWNED_THREADS }));
    expect(result).toMatchObject({ ok: false, code: "capability_denied" });
  });

  test("an undefined provider status passes (cold launch)", () => {
    const result = checkSpawn(base({ providerStatus: undefined }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.adjustments).toEqual([]);
    }
  });

  test("a known unavailable provider refuses and carries the error", () => {
    const result = checkSpawn(base({ providerStatus: { available: false, error: "not logged in" } }));
    expect(result).toEqual({
      ok: false,
      code: "provider_unavailable",
      message: expect.stringContaining("not logged in"),
      details: { error: "not logged in" },
    });
  });

  test("an unknown catalog passes an arbitrary model through untouched", () => {
    const result = checkSpawn(base({ target: { provider: "codex", model: "gpt-5" }, catalog: undefined }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model).toBe("gpt-5");
      expect(result.adjustments).toEqual([]);
    }
  });

  test("a known catalog refuses an unknown model, carrying availableModels", () => {
    const catalog = [
      { id: "gpt-5", label: "GPT-5" },
      { id: "gpt-5-mini", label: "GPT-5 mini" },
    ];
    const result = checkSpawn(base({ target: { provider: "codex", model: "claude-4" }, catalog }));
    expect(result).toEqual({
      ok: false,
      code: "not_found",
      message: spawnRefusalModelNotFound("codex", "claude-4", ["gpt-5", "gpt-5-mini"]),
      details: { availableModels: ["gpt-5", "gpt-5-mini"] },
    });
  });

  test("a known catalog accepts a model it contains", () => {
    const catalog = [{ id: "gpt-5", label: "GPT-5" }];
    const result = checkSpawn(base({ target: { provider: "codex", model: "gpt-5" }, catalog }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model).toBe("gpt-5");
      expect(result.adjustments).toEqual([]);
    }
  });

  test('drops the renderer-internal "base" effort with an adjustment', () => {
    const result = checkSpawn(base({ target: { provider: "codex", effort: "base" } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.effort).toBeUndefined();
      expect(result.adjustments).toEqual([
        { field: "effort", requested: "base", applied: null, reason: expect.any(String) },
      ]);
    }
  });

  test("drops an effort the model's reasoningEfforts doesn't list", () => {
    const catalog = [{ id: "gpt-5", label: "GPT-5", reasoningEfforts: ["low", "high"] }];
    const result = checkSpawn(
      base({ target: { provider: "codex", model: "gpt-5", effort: "med" }, catalog }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.effort).toBeUndefined();
      expect(result.adjustments).toEqual([
        { field: "effort", requested: "med", applied: null, reason: expect.any(String) },
      ]);
    }
  });

  test("keeps a supported effort with no adjustment", () => {
    const catalog = [{ id: "gpt-5", label: "GPT-5", reasoningEfforts: ["low", "high"] }];
    const result = checkSpawn(
      base({ target: { provider: "codex", model: "gpt-5", effort: "high" }, catalog }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.effort).toBe("high");
      expect(result.adjustments).toEqual([]);
    }
  });

  test("a model with no reasoningEfforts accepts any tier", () => {
    const catalog = [{ id: "gpt-5", label: "GPT-5" }];
    const result = checkSpawn(
      base({ target: { provider: "codex", model: "gpt-5", effort: "turbo" }, catalog }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.effort).toBe("turbo");
      expect(result.adjustments).toEqual([]);
    }
  });

  test("an effort is kept when no model was chosen (nothing to check against)", () => {
    const result = checkSpawn(base({ target: { provider: "codex", effort: "high" } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.effort).toBe("high");
      expect(result.adjustments).toEqual([]);
    }
  });

  test("an unset target effort inherits the parent's, with no adjustment", () => {
    const result = checkSpawn(base({ target: { provider: "codex" }, parentEffort: "high" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.effort).toBe("high");
      expect(result.adjustments).toEqual([]);
    }
  });

  test("an inherited effort the child's model doesn't list is dropped with an adjustment, still ok", () => {
    const catalog = [{ id: "gpt-5", label: "GPT-5", reasoningEfforts: ["low", "high"] }];
    const result = checkSpawn(
      base({ target: { provider: "codex", model: "gpt-5" }, parentEffort: "med", catalog }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.effort).toBeUndefined();
      expect(result.adjustments).toEqual([
        { field: "effort", requested: "med", applied: null, reason: expect.any(String) },
      ]);
    }
  });

  test("an explicit target effort still wins over the inherited parent's", () => {
    const catalog = [{ id: "gpt-5", label: "GPT-5", reasoningEfforts: ["low", "high"] }];
    const result = checkSpawn(
      base({
        target: { provider: "codex", model: "gpt-5", effort: "low" },
        parentEffort: "high",
        catalog,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.effort).toBe("low");
      expect(result.adjustments).toEqual([]);
    }
  });

  test("an explicit full-access request under an ask parent is refused, not clamped", () => {
    const result = checkSpawn(base({ requestedMode: "full-access", parentMode: "ask" }));
    expect(result).toEqual({
      ok: false,
      code: "permission_denied",
      message: expect.stringContaining("full-access"),
      details: { requestedMode: "full-access", parentMode: "ask" },
    });
  });

  test("an explicit equal request is kept, no adjustment", () => {
    const result = checkSpawn(base({ requestedMode: "ask", parentMode: "ask" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("ask");
      expect(result.adjustments).toEqual([]);
    }
  });

  test("keeps a downgrade with no adjustment", () => {
    const result = checkSpawn(base({ requestedMode: "ask", parentMode: "full-access" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("ask");
      expect(result.adjustments).toEqual([]);
    }
  });

  test("defaults the child to the parent's mode when none is requested", () => {
    const result = checkSpawn(base({ requestedMode: undefined, parentMode: "accept-edits" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("accept-edits");
      expect(result.adjustments).toEqual([]);
    }
  });

  test("an Antigravity child below full access is refused (print mode floor)", () => {
    // The child's mode is capped at the parent's, so a parent at accept-edits
    // (or ask) simply cannot host an Antigravity child — refusing beats
    // silently promoting, which would escalate privilege across the spawn.
    for (const parentMode of ["ask", "accept-edits"] as const) {
      const result = checkSpawn(
        base({ target: { provider: "antigravity" }, requestedMode: undefined, parentMode }),
      );
      expect(result).toMatchObject({
        ok: false,
        code: "capability_denied",
        details: { provider: "antigravity", mode: parentMode },
      });
    }
    // An explicit full-access request from a full-access parent is fine.
    const ok = checkSpawn(
      base({
        target: { provider: "antigravity" },
        requestedMode: "full-access",
        parentMode: "full-access",
      }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.mode).toBe("full-access");
  });

  test("an Antigravity child below full access is allowed when ACP serves it", () => {
    // The print-mode floor doesn't apply to an ACP transport: approvals pause
    // in-protocol at any rung, so an accept-edits child of an accept-edits
    // parent spawns normally.
    const result = checkSpawn(
      base({
        target: { provider: "antigravity" },
        requestedMode: undefined,
        parentMode: "accept-edits",
        antigravityAcpAvailable: true,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mode).toBe("accept-edits");
  });

  test("depth wins over breadth in the check order", () => {
    const result = checkSpawn(
      base({
        parentDepth: MAX_SPAWN_DEPTH,
        liveChildrenOfParent: MAX_LIVE_CHILDREN_PER_PARENT,
      }),
    );
    expect(result).toEqual({
      ok: false,
      code: "capability_denied",
      message: spawnRefusalDepth(MAX_SPAWN_DEPTH),
    });
  });
});

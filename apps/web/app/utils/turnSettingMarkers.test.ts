import { describe, expect, test } from "bun:test";

import type { ThreadBlock } from "~/composables/agentTypes";
import { buildModelCatalog } from "~/utils/modelCatalog";
import {
  deriveTurnSettingMarks,
  turnSettingChangeLabel,
  turnSettingLeg,
} from "./turnSettingMarkers";

function user(
  id: string,
  stamps?: { effort?: "low" | "medium" | "high"; model?: string },
): ThreadBlock {
  const block: ThreadBlock = { id, role: "user", text: "hello", at: 0 };
  if (stamps?.effort) block.effort = stamps.effort;
  if (stamps?.model) block.model = stamps.model;
  return block;
}

function exchange(key: string, blocks: ThreadBlock[]) {
  return { key, blocks };
}

describe("deriveTurnSettingMarks", () => {
  test("the first stamped request sets the baseline silently", () => {
    const marks = deriveTurnSettingMarks([
      exchange("a", [user("u1", { effort: "medium", model: "claude-opus-5" })]),
    ]);
    expect(marks.size).toBe(0);
  });

  test("a changed tier marks the new exchange with both ends", () => {
    const marks = deriveTurnSettingMarks([
      exchange("a", [user("u1", { effort: "medium" })]),
      exchange("b", [user("u2", { effort: "high" })]),
    ]);
    expect(marks.get("b")).toEqual({ key: "b", effort: { from: "medium", to: "high" } });
    expect(marks.get("a")).toBeUndefined();
  });

  test("a changed model marks the new exchange with both ends", () => {
    const marks = deriveTurnSettingMarks([
      exchange("a", [user("u1", { model: "claude-opus-5" })]),
      exchange("b", [user("u2", { model: "claude-sonnet-5" })]),
    ]);
    expect(marks.get("b")).toEqual({
      key: "b",
      model: { from: "claude-opus-5", to: "claude-sonnet-5" },
    });
  });

  test("a turn that changes both is one mark, not two", () => {
    const marks = deriveTurnSettingMarks([
      exchange("a", [user("u1", { effort: "medium", model: "claude-opus-5" })]),
      exchange("b", [user("u2", { effort: "high", model: "claude-sonnet-5" })]),
    ]);
    expect(marks.size).toBe(1);
    expect(marks.get("b")).toEqual({
      key: "b",
      effort: { from: "medium", to: "high" },
      model: { from: "claude-opus-5", to: "claude-sonnet-5" },
    });
  });

  test("the axes keep their own baselines", () => {
    // The model moves first, the tier two turns later: neither change drags
    // the other onto its marker.
    const marks = deriveTurnSettingMarks([
      exchange("a", [user("u1", { effort: "medium", model: "claude-opus-5" })]),
      exchange("b", [user("u2", { effort: "medium", model: "claude-sonnet-5" })]),
      exchange("c", [user("u3", { effort: "high", model: "claude-sonnet-5" })]),
    ]);
    expect(marks.get("b")).toEqual({
      key: "b",
      model: { from: "claude-opus-5", to: "claude-sonnet-5" },
    });
    expect(marks.get("c")).toEqual({ key: "c", effort: { from: "medium", to: "high" } });
  });

  test("an unchanged pair marks nothing", () => {
    const marks = deriveTurnSettingMarks([
      exchange("a", [user("u1", { effort: "medium", model: "claude-opus-5" })]),
      exchange("b", [user("u2", { effort: "medium", model: "claude-opus-5" })]),
    ]);
    expect(marks.size).toBe(0);
  });

  test("unstamped history neither marks nor moves the baseline", () => {
    const marks = deriveTurnSettingMarks([
      exchange("a", [user("u1")]),
      exchange("b", [user("u2", { effort: "medium" })]),
      exchange("c", [user("u3", { effort: "high" })]),
    ]);
    expect(marks.size).toBe(1);
    expect(marks.get("c")).toEqual({ key: "c", effort: { from: "medium", to: "high" } });
  });

  test("a request with no model keeps the model baseline where it was", () => {
    // A turn sent on the provider's own default stamps no model — it is not a
    // switch away from the one before it, and the one after it is measured
    // against that same baseline.
    const marks = deriveTurnSettingMarks([
      exchange("a", [user("u1", { model: "claude-opus-5" })]),
      exchange("b", [user("u2", { effort: "high" })]),
      exchange("c", [user("u3", { model: "claude-sonnet-5" })]),
    ]);
    expect(marks.get("b")).toBeUndefined();
    expect(marks.get("c")).toEqual({
      key: "c",
      model: { from: "claude-opus-5", to: "claude-sonnet-5" },
    });
  });

  test("a gap of unstamped blocks keeps the earlier baseline", () => {
    const marks = deriveTurnSettingMarks([
      exchange("a", [user("u1", { effort: "low" })]),
      exchange("b", [user("u2")]),
      exchange("c", [user("u3", { effort: "low" })]),
      exchange("d", [user("u4", { effort: "high" })]),
    ]);
    expect(marks.size).toBe(1);
    expect(marks.get("d")).toEqual({ key: "d", effort: { from: "low", to: "high" } });
  });

  test("empty inputs mark nothing", () => {
    expect(deriveTurnSettingMarks([]).size).toBe(0);
  });

  test("a placeholder model stamp reads as unstamped, not as a switch", () => {
    // A request running the provider's own default spells it `default` rather
    // than omitting the stamp — naming it would render a model that points at
    // nothing, so the first real model after it sets the baseline silently.
    const marks = deriveTurnSettingMarks([
      exchange("a", [user("u1", { model: "default" })]),
      exchange("b", [user("u2", { model: "claude-sonnet-5" })]),
    ]);
    expect(marks.size).toBe(0);
  });

  test("switching back to the provider default marks nothing", () => {
    const marks = deriveTurnSettingMarks([
      exchange("a", [user("u1", { model: "claude-opus-5" })]),
      exchange("b", [user("u2", { model: "default" })]),
    ]);
    expect(marks.size).toBe(0);
  });

  test("a placeholder between two real models does not move the baseline", () => {
    const marks = deriveTurnSettingMarks([
      exchange("a", [user("u1", { model: "claude-opus-5" })]),
      exchange("b", [user("u2", { model: "default" })]),
      exchange("c", [user("u3", { model: "claude-sonnet-5" })]),
    ]);
    expect(marks.size).toBe(1);
    expect(marks.get("c")).toEqual({
      key: "c",
      model: { from: "claude-opus-5", to: "claude-sonnet-5" },
    });
  });

  test("effort on a placeholder-stamped request still marks on its own axis", () => {
    const marks = deriveTurnSettingMarks([
      exchange("a", [user("u1", { effort: "medium", model: "default" })]),
      exchange("b", [user("u2", { effort: "high", model: "default" })]),
    ]);
    expect(marks.get("b")).toEqual({ key: "b", effort: { from: "medium", to: "high" } });
  });
});

describe("turnSettingChangeLabel", () => {
  test("an effort switch reads in the picker's own vocabulary", () => {
    expect(turnSettingChangeLabel({ key: "a", effort: { from: "medium", to: "high" } })).toBe(
      "Reasoning effort Medium → High",
    );
  });

  test("a model switch reads as display names, not raw ids", () => {
    const label = turnSettingChangeLabel({
      key: "a",
      model: { from: "claude-opus-5", to: "claude-sonnet-5" },
    });
    expect(label.startsWith("Model ")).toBe(true);
    expect(label).toContain("→");
    expect(label).not.toContain("claude-opus-5");
  });

  test("a switch of both puts each leg's model and tier together", () => {
    const label = turnSettingChangeLabel({
      key: "a",
      effort: { from: "medium", to: "high" },
      model: { from: "claude-opus-5", to: "claude-sonnet-5" },
    });
    expect(label.startsWith("Model & effort ")).toBe(true);
    expect(label).toContain("· Medium →");
    expect(label.endsWith("· High")).toBe(true);
  });

  test("a stale stamp prettifies instead of borrowing the live catalog's first name", () => {
    const catalog = buildModelCatalog([{ id: "claude-opus-5", label: "Claude Opus 5" }]);
    const change = { key: "a", model: { from: "claude-opus-5", to: "gpt-9-futura" } };
    expect(turnSettingLeg(change, "from", catalog).model).toEqual({
      brand: "claude",
      name: "Claude Opus 5",
    });
    expect(turnSettingLeg(change, "to", catalog).model).toEqual({
      brand: "gpt",
      name: "GPT 9 Futura",
    });
  });

  test("the spoken name and the rendered leg come from one resolver", () => {
    // The marker renders turnSettingLeg; the accessible name is built from the
    // same call, so a catalog rename can never move one without the other.
    const change = {
      key: "a",
      effort: { from: "medium", to: "high" } as const,
      model: { from: "claude-opus-5", to: "claude-sonnet-5" },
    };
    const label = turnSettingChangeLabel(change);
    for (const side of ["from", "to"] as const) {
      const { model, effort } = turnSettingLeg(change, side);
      expect(label).toContain(model!.name);
      expect(label).toContain(effort!.label);
    }
  });
});


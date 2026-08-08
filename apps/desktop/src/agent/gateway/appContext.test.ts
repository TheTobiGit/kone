import { describe, expect, test } from "bun:test";

import {
  buildCodexTurnCollaborationMode,
  claudeSystemPromptAppend,
  codexDeveloperInstructions,
  CODEX_ENVELOPE_DEFAULT_MODEL,
  koneHostContextForFirstRun,
  KONE_HOST_CONTEXT_MARKER,
  KONE_HOST_CONTEXT_VERSION,
  prependKoneHostContext,
  renderKoneHostContext,
} from "./appContext.js";

describe("kone host context (app-context injection)", () => {
  test("carries a versioned marker so a block in a transcript can be dated", () => {
    expect(KONE_HOST_CONTEXT_MARKER).toBe(`[kone host context ${KONE_HOST_CONTEXT_VERSION}]`);
    expect(renderKoneHostContext(true)).toContain(KONE_HOST_CONTEXT_MARKER);
  });

  test("with the gateway: identity + both tools + when-to-use, MCP-prefix note", () => {
    const block = renderKoneHostContext(true);
    expect(block).toContain("You are running inside kone");
    expect(block).toContain("kone_scratchpad_read");
    expect(block).toContain("kone_scratchpad_write");
    expect(block).toContain("mcp__kone__kone_scratchpad_read");
    expect(block).toContain("part of your job");
    expect(block).toContain("user sees live on kone's project page");
    expect(block).toContain("persists across sessions");
  });

  test("without the gateway: identity only, no tool promises", () => {
    const block = renderKoneHostContext(false);
    expect(block).toContain("You are running inside kone");
    expect(block).toContain("no kone_* tools are installed");
    expect(block).not.toContain("kone_scratchpad_read");
    expect(block).not.toContain("kone_scratchpad_write");
  });

  test("claude channel: block when connected, empty append when not", () => {
    expect(claudeSystemPromptAppend(true)).toBe(renderKoneHostContext(true));
    expect(claudeSystemPromptAppend(false)).toBe("");
  });

  test("codex channel: full developer_instructions with a Default collaboration-mode block", () => {
    const block = codexDeveloperInstructions(true);
    expect(block).toBeDefined();
    expect(block!.startsWith("<collaboration_mode># Collaboration Mode: Default")).toBe(true);
    expect(block).toContain("</collaboration_mode>");
    // The app context rides after the mode tags, outside them — like both
    // Take the LAST closing tag: the block's prose quotes the tags literally.
    const appContext = block!.split("</collaboration_mode>").pop() ?? "";
    expect(appContext).toContain(KONE_HOST_CONTEXT_MARKER);
    expect(appContext).toContain("kone_scratchpad_read");
    expect(codexDeveloperInstructions(false)).toBeUndefined();
  });

  test("codex turn envelope: gated on the gateway, carries model/effort, envelopes default when unknown", () => {
    expect(
      buildCodexTurnCollaborationMode({ model: "gpt-5.6-terra", effort: "high", gatewayControlAvailable: false }),
    ).toBeUndefined();

    expect(
      buildCodexTurnCollaborationMode({ model: "gpt-5.6-terra", effort: "high", gatewayControlAvailable: true }),
    ).toEqual({
      mode: "default",
      settings: {
        model: "gpt-5.6-terra",
        reasoning_effort: "high",
        developer_instructions: codexDeveloperInstructions(true),
      },
    });

    // The app-server schema requires settings.model; provider-default sessions
    // get the envelope fallback slug (the top-level turn `model` kone sends
    // whenever one is known stays authoritative).
    expect(
      buildCodexTurnCollaborationMode({ gatewayControlAvailable: true }).settings,
    ).toMatchObject({ model: CODEX_ENVELOPE_DEFAULT_MODEL, reasoning_effort: "medium" });
  });

  test("phase-B first-prompt channel wraps so the block can't be mistaken for user text", () => {
    const wrapped = prependKoneHostContext("do the thing");
    expect(wrapped).toContain("<kone_host_context>");
    expect(wrapped).toContain(KONE_HOST_CONTEXT_MARKER);
    expect(wrapped).toContain("</kone_host_context>\n\n<user_request>\ndo the thing\n</user_request>");
  });

  test("phase-B first-prompt helper fires once per session, on runOrdinal 1 only", () => {
    expect(koneHostContextForFirstRun({ prompt: "p", runOrdinal: 1, gatewayControlAvailable: true })).toBe(
      prependKoneHostContext("p"),
    );
    expect(koneHostContextForFirstRun({ prompt: "p", runOrdinal: 2, gatewayControlAvailable: true })).toBe("p");
    expect(koneHostContextForFirstRun({ prompt: "p", runOrdinal: 1, gatewayControlAvailable: false })).toBe("p");
  });
});

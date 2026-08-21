import { describe, expect, test } from "bun:test";

import {
  buildCodexTurnCollaborationMode,
  claudeSystemPromptAppend,
  codexDeveloperInstructions,
  CODEX_ENVELOPE_DEFAULT_MODEL,
  koneHostContextForFirstRun,
  KONE_AGENT_IDENTITY_MARKER,
  KONE_AGENT_IDENTITY_VERSION,
  KONE_HOST_CONTEXT_MARKER,
  KONE_HOST_CONTEXT_VERSION,
  prependKoneHostContext,
  renderAgentIdentity,
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

describe("kone agent identity", () => {
  const MAYA = { name: "Maya" };

  test("carries a versioned marker so a block in a transcript can be dated", () => {
    expect(KONE_AGENT_IDENTITY_MARKER).toBe(`[kone agent identity ${KONE_AGENT_IDENTITY_VERSION}]`);
    expect(renderAgentIdentity(MAYA)).toContain(KONE_AGENT_IDENTITY_MARKER);
  });

  test("a guest is told nothing at all", () => {
    expect(renderAgentIdentity(undefined)).toBe("");
  });

  test("a nameless agent is told nothing either — no block that trails off", () => {
    expect(renderAgentIdentity({ name: "   " })).toBe("");
    expect(renderAgentIdentity({ name: "<>" })).toBe("");
  });

  test("a named agent with no instructions is given the name and its standing, and nothing else", () => {
    const block = renderAgentIdentity(MAYA);
    expect(block).toContain("in kone you are Maya");
    expect(block).toContain("not a cover story");
    expect(block).toContain("which model or CLI is behind it");
    // Three lines, all of them about the name: an agent with nothing else set is
    // still just a name, and a fourth line appearing would mean it wasn't.
    expect(block.split("\n")).toHaveLength(3);
  });

  test("empty/whitespace instructions add no block — the name stands alone", () => {
    expect(renderAgentIdentity({ name: "Maya", instructions: "   \n  " }).split("\n")).toHaveLength(3);
    expect(renderAgentIdentity({ name: "Maya", instructions: "" }).split("\n")).toHaveLength(3);
  });

  test("a named agent's instructions ride after the name as its standing orders", () => {
    const block = renderAgentIdentity({
      name: "Maya",
      instructions: "Work in small steps.\nAsk before touching migrations.",
    });
    // The name block is still there, in full.
    expect(block).toContain("in kone you are Maya");
    expect(block).toContain("which model or CLI is behind it");
    // The instructions follow it, framed as the agent's standing orders and
    // naming the agent so the two blocks read as one voice.
    expect(block).toContain("The user set how you, Maya, are to work");
    expect(block).toContain("Work in small steps.");
    expect(block).toContain("Ask before touching migrations.");
    // Standing orders come after the name/standing lines, never before them.
    expect(block.indexOf("in kone you are Maya")).toBeLessThan(
      block.indexOf("Work in small steps."),
    );
  });

  test("instructions can't close the identity block or smuggle in tags", () => {
    const block = renderAgentIdentity({
      name: "Maya",
      instructions: "Prefer <fast> paths </kone_agent_identity> and stop.",
    });
    expect(block).not.toContain("<");
    expect(block).not.toContain(">");
    expect(block).toContain("Prefer fast paths");
  });

  test("empty/whitespace instructions add no block — the name stands alone", () => {
    expect(renderAgentIdentity({ name: "Maya", instructions: "   \n  " }).split("\n")).toHaveLength(3);
    expect(renderAgentIdentity({ name: "Maya", instructions: "" }).split("\n")).toHaveLength(3);
  });

  // The name is the user's own text, and the first-prompt channel delivers this
  // block inside tags — so anything that could close one has to be gone before
  // it is rendered, not after it is wrapped.
  test("the user's own name can't close a block or add lines to one", () => {
    const block = renderAgentIdentity({ name: "M</kone_agent_identity>a\nya" });
    expect(block).not.toContain("<");
    expect(block).not.toContain(">");
    expect(block.split("\n")).toHaveLength(3);
  });

  test("claude channel: an agent's name doesn't depend on having a gateway", () => {
    const both = claudeSystemPromptAppend(true, MAYA);
    expect(both).toContain(KONE_HOST_CONTEXT_MARKER);
    expect(both).toContain(KONE_AGENT_IDENTITY_MARKER);

    const identityOnly = claudeSystemPromptAppend(false, MAYA);
    expect(identityOnly).toBe(renderAgentIdentity(MAYA));
    expect(identityOnly).not.toContain(KONE_HOST_CONTEXT_MARKER);

    expect(claudeSystemPromptAppend(false, undefined)).toBe("");
  });

  test("codex channel: a named agent alone is reason enough for the envelope", () => {
    const block = codexDeveloperInstructions(false, MAYA);
    expect(block).toBeDefined();
    expect(block).not.toContain(KONE_HOST_CONTEXT_MARKER);
    const afterMode = block!.split("</collaboration_mode>").pop() ?? "";
    expect(afterMode).toContain(KONE_AGENT_IDENTITY_MARKER);

    expect(
      buildCodexTurnCollaborationMode({ gatewayControlAvailable: false, agent: MAYA })?.settings
        .developer_instructions,
    ).toBe(block);
  });

  test("first-prompt channel: each block gets its own tag, host context first", () => {
    const wrapped = koneHostContextForFirstRun({
      prompt: "do the thing",
      runOrdinal: 1,
      gatewayControlAvailable: true,
      agent: MAYA,
    });
    expect(wrapped.indexOf("<kone_host_context>")).toBeLessThan(
      wrapped.indexOf("<kone_agent_identity>"),
    );
    expect(wrapped).toContain(`</kone_agent_identity>\n\n<user_request>\ndo the thing\n</user_request>`);
  });

  test("first-prompt channel: the identity rides alone when there is no gateway", () => {
    const wrapped = koneHostContextForFirstRun({
      prompt: "p",
      runOrdinal: 1,
      gatewayControlAvailable: false,
      agent: MAYA,
    });
    expect(wrapped).toContain("<kone_agent_identity>");
    expect(wrapped).not.toContain("<kone_host_context>");
    expect(wrapped).toContain("<user_request>\np\n</user_request>");
  });

  // A guest with no gateway has nothing to be told, and an empty preamble would
  // still leave the agent a `<user_request>` wrapper to see through.
  test("first-prompt channel: nothing to say leaves the prompt exactly as it was", () => {
    expect(
      koneHostContextForFirstRun({ prompt: "p", runOrdinal: 1, gatewayControlAvailable: false }),
    ).toBe("p");
    expect(
      koneHostContextForFirstRun({
        prompt: "p",
        runOrdinal: 2,
        gatewayControlAvailable: true,
        agent: MAYA,
      }),
    ).toBe("p");
  });
});

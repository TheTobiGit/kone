import { describe, expect, test } from "bun:test";

import {
  buildContextWindowFallback,
  contextWindowTokens,
  parseAcpPlan,
  parseConfigOptions,
  parseStoredCursorContext,
  resolveContextWindow,
  resolveModeId,
  toModelDescriptor,
  toolCallDetail,
  toolCallStatus,
  toolCallTarget,
} from "./adapters/CursorAdapter.js";
import { parseCursorAuth, parseCursorCliModels, parseCursorVersion, resolveCursorBinary } from "./cursorHome.js";

// Every fixture below is a verbatim shape captured from a live `cursor-agent
// acp` session (2026.07.23), not one invented from the ACP spec — the two
// disagree in exactly the places that broke the first draft of the adapter.

describe("Cursor install detection", () => {
  test("maps the ambiguous binary names onto the agent CLI, keeps a real path", () => {
    expect(resolveCursorBinary(undefined)).toBe("cursor-agent");
    expect(resolveCursorBinary("  ")).toBe("cursor-agent");
    expect(resolveCursorBinary("cursor")).toBe("cursor-agent");
    expect(resolveCursorBinary("agent")).toBe("cursor-agent");
    expect(resolveCursorBinary("/opt/homebrew/bin/cursor-agent")).toBe("/opt/homebrew/bin/cursor-agent");
  });

  test("reads the calendar version and the login line", () => {
    expect(parseCursorVersion("2026.07.23-e383d2b\n")).toBe("2026.07.23-e383d2b");
    expect(parseCursorAuth("✓ Logged in as dev@example.com\n")).toEqual({
      authenticated: true,
      label: "dev@example.com",
    });
    expect(parseCursorAuth("Not logged in. Run `cursor-agent login`.")).toEqual({ authenticated: false });
  });

  test("parses the flat CLI fallback catalog", () => {
    const output = ["Available models:", "  composer-2.5 - Composer 2.5 (default)", "  claude-opus-5 - Claude Opus 5", "", "footer text"].join("\n");
    expect(parseCursorCliModels(output)).toEqual([
      { id: "composer-2.5", label: "Composer 2.5" },
      { id: "claude-opus-5", label: "Claude Opus 5" },
    ]);
  });
});

describe("Cursor model catalog", () => {
  test("projects config options onto kone's effort / context / tier axes", () => {
    const model = toModelDescriptor({
      value: "claude-opus-5",
      name: "Claude Opus 5",
      configOptions: [
        {
          id: "effort",
          name: "Effort",
          currentValue: "medium",
          options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
        },
        {
          id: "context",
          currentValue: "300k",
          options: [
            { value: "300k", name: "300K" },
            { value: "1m", name: "1M" },
          ],
        },
        { id: "fast", options: [{ value: "false" }, { value: "true" }] },
        // `thinking` has no ModelDescriptor axis — it must not leak anywhere.
        { id: "thinking", options: [{ value: "false" }, { value: "true" }] },
      ],
    });
    expect(model).toEqual({
      id: "claude-opus-5",
      label: "Claude Opus 5",
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
      contextWindows: [
        { id: "300k", label: "300K", tokens: 300_000, isDefault: true },
        { id: "1m", label: "1M", tokens: 1_000_000 },
      ],
      contextWindowTokens: 300_000,
      serviceTiers: [{ id: "fast", label: "Fast", description: "Significantly faster, consumes more usage" }],
    });
  });

  test("treats OpenAI's `reasoning` as the same axis as `effort`", () => {
    const model = toModelDescriptor({
      value: "gpt-5",
      name: "GPT-5",
      configOptions: [{ id: "reasoning", currentValue: "high", options: [{ value: "high" }, { value: "max" }] }],
    });
    expect(model?.reasoningEfforts).toEqual(["high", "max"]);
    expect(model?.defaultReasoningEffort).toBe("high");
  });

  test("only a `fast=true` option becomes a service tier", () => {
    expect(
      toModelDescriptor({ value: "m", configOptions: [{ id: "fast", options: [{ value: "true" }] }] })?.serviceTiers,
    ).toEqual([{ id: "fast", label: "Fast", description: "Significantly faster, consumes more usage" }]);
    expect(
      toModelDescriptor({ value: "m", configOptions: [{ id: "fast", options: [{ value: "false" }] }] })?.serviceTiers,
    ).toBeUndefined();
  });

  test("falls back to the id as a label and drops an entry with no id", () => {
    expect(toModelDescriptor({ value: "composer-2.5" })).toEqual({ id: "composer-2.5", label: "composer-2.5" });
    expect(toModelDescriptor({ name: "No id" })).toBeUndefined();
  });

  test("reads Cursor's context-window spellings", () => {
    expect([contextWindowTokens("300k"), contextWindowTokens("272K"), contextWindowTokens("1m")]).toEqual([
      300_000, 272_000, 1_000_000,
    ]);
    expect(contextWindowTokens("unlimited")).toBeUndefined();
  });

  test("tolerates a malformed config-option payload", () => {
    expect(parseConfigOptions([{ name: "no id" }, { id: "effort", options: [{ name: "no value" }, { value: "low" }] }])).toEqual([
      { id: "effort", name: undefined, category: undefined, currentValue: undefined, options: [{ value: "low", name: undefined }] },
    ]);
    expect(parseConfigOptions(undefined)).toEqual([]);
  });
});

describe("Cursor session modes", () => {
  test("maps kone's ladder onto the modes the session actually advertises", () => {
    const modes = ["agent", "plan", "ask"];
    expect(resolveModeId("ask", modes)).toBe("ask");
    expect(resolveModeId("accept-edits", modes)).toBe("agent");
    expect(resolveModeId("full-access", modes)).toBe("agent");
  });

  test("degrades to a related mode rather than guessing a spelling", () => {
    // No read-only mode on offer — the ask rung still has to land somewhere.
    expect(resolveModeId("ask", ["agent"])).toBe("agent");
    expect(resolveModeId("accept-edits", ["plan"])).toBe("plan");
    expect(resolveModeId("accept-edits", ["something-new"])).toBe("something-new");
    expect(resolveModeId("ask", [])).toBeUndefined();
  });
});

describe("Cursor tool-call translation", () => {
  test("prefers the command, then the path, then the query as the inline target", () => {
    expect(toolCallTarget({ kind: "execute", rawInput: { command: "bun test" }, title: "Shell" })).toBe("bun test");
    expect(toolCallTarget({ kind: "read", rawInput: { path: "src/app.ts" } })).toBe("src/app.ts");
    expect(toolCallTarget({ kind: "search", rawInput: { query: "TODO" } })).toBe("TODO");
    expect(toolCallTarget({ title: "Thinking" })).toBe("Thinking");
    expect(toolCallTarget({})).toBe("");
  });

  test("summarizes a multi-location edit instead of naming only the first file", () => {
    expect(toolCallTarget({ kind: "edit", locations: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }] })).toBe(
      "a.ts +2 more",
    );
    expect(toolCallTarget({ kind: "edit", locations: [{ path: "a.ts" }] })).toBe("a.ts");
  });

  test("collects the result body from content blocks and rawOutput", () => {
    expect(
      toolCallDetail({
        content: [{ type: "content", content: { type: "text", text: "line one" } }, { text: "line two" }],
      }),
    ).toBe("line one\nline two");
    expect(toolCallDetail({ rawOutput: { output: "done" } })).toBe("done");
    expect(toolCallDetail({ rawOutput: { exitCode: 0 } })).toBe(JSON.stringify({ exitCode: 0 }, null, 2));
    expect(toolCallDetail({})).toBe("");
  });

  test("anything that is not a terminal status is still running", () => {
    expect(["pending", "in_progress", undefined, "completed", "failed"].map(toolCallStatus)).toEqual([
      "in-progress",
      "in-progress",
      "in-progress",
      "completed",
      "failed",
    ]);
  });
});

describe("Cursor plan translation", () => {
  test("re-spells ACP's `in_progress` and drops empty entries", () => {
    expect(
      parseAcpPlan({
        entries: [
          { content: "Read the adapter", status: "completed" },
          { content: "Wire the events", status: "in_progress" },
          { content: "Ship", status: "pending" },
          { content: "   ", status: "pending" },
        ],
      }),
    ).toEqual([
      { content: "Read the adapter", status: "completed" },
      { content: "Wire the events", status: "in-progress" },
      { content: "Ship", status: "pending" },
    ]);
  });

  test("an empty plan is no plan at all", () => {
    expect(parseAcpPlan({ entries: [] })).toBeUndefined();
    expect(parseAcpPlan({})).toBeUndefined();
  });
});

// Cursor 2026.07.23 emits NO usage over ACP — the `usage_update` notification
// never fired across five live sessions (multi-tool turns, big contexts,
// follow-up turns), so there is no verbatim usage_update payload to paste here.
// The only real usage Cursor exposes is the one-shot `--print --output-format
// stream-json` result event: `usage: { inputTokens, outputTokens,
// cacheReadTokens, cacheWriteTokens }` — a transport ACP doesn't carry. So the
// adapter's token-usage event is an honest fallback built from the selected
// model's context window. The config matrices below are verbatim from the
// probe dumps (acp-usage-dump5.jsonl / acp-usage-dump.jsonl).
describe("Cursor context-window fallback", () => {
  // The live `session/set_config_option` response matrix for claude-opus-5
  // after fast=false, context=1m, effort=low — the session's own configOptions,
  // which is what the adapter stores and reads the active window from.
  const opus5ConfigOptions = [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: "agent",
      options: [
        { value: "agent", name: "Agent" },
        { value: "plan", name: "Plan" },
        { value: "ask", name: "Ask" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "claude-opus-5",
      options: [
        { value: "default", name: "Auto" },
        { value: "claude-opus-5", name: "Opus 5" },
      ],
    },
    {
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: "true",
      options: [
        { value: "false", name: "Off" },
        { value: "true", name: "On" },
      ],
    },
    {
      id: "context",
      name: "Context",
      category: "model_config",
      type: "select",
      currentValue: "1m",
      options: [
        { value: "300k", name: "300K" },
        { value: "1m", name: "1M" },
      ],
    },
    {
      id: "effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "low",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Extra High" },
        { value: "max", name: "Max" },
      ],
    },
    {
      id: "fast",
      name: "Fast",
      category: "model_config",
      type: "select",
      currentValue: "false",
      options: [
        { value: "false", name: "Off" },
        { value: "true", name: "Fast" },
      ],
    },
  ];

  // The `session/new` matrix for the CLI's default model (composer-2.5): no
  // context axis at all, so the window must come from the model catalog.
  const defaultSessionConfigOptions = [
    { id: "mode", category: "mode", currentValue: "agent", options: [{ value: "agent" }, { value: "plan" }, { value: "ask" }] },
    { id: "model", category: "model", currentValue: "composer-2.5", options: [{ value: "default" }, { value: "composer-2.5" }] },
    { id: "fast", category: "model_config", currentValue: "true", options: [{ value: "false" }, { value: "true" }] },
  ];

  test("reads the active window from the live `context` config option", () => {
    // Live config says 1m even though the catalog default is 300k — the live
    // value wins, and no `used`/`total` is ever invented.
    expect(resolveContextWindow(opus5ConfigOptions, new Map([["claude-opus-5", 300_000]]), "claude-opus-5")).toBe(
      1_000_000,
    );
    expect(buildContextWindowFallback(opus5ConfigOptions, new Map([["claude-opus-5", 300_000]]), "claude-opus-5")).toEqual({
      contextWindow: 1_000_000,
      compactsAutomatically: true,
    });
  });

  test("falls back to the catalog's default window when the session config has no context axis", () => {
    const catalog = new Map([["claude-opus-5", 300_000]]);
    expect(resolveContextWindow(defaultSessionConfigOptions, catalog, "claude-opus-5")).toBe(300_000);
    expect(buildContextWindowFallback(defaultSessionConfigOptions, catalog, "claude-opus-5")).toEqual({
      contextWindow: 300_000,
      compactsAutomatically: true,
    });
  });

  test("emits nothing when no window is knowable", () => {
    expect(resolveContextWindow(defaultSessionConfigOptions, undefined, "composer-2.5")).toBeUndefined();
    expect(resolveContextWindow(defaultSessionConfigOptions, new Map(), undefined)).toBeUndefined();
    expect(buildContextWindowFallback(defaultSessionConfigOptions, undefined, "composer-2.5")).toBeUndefined();
  });

  test("never fabricates a fill or a total", () => {
    // Even handed the real one-shot stream-json usage numbers, the fallback is
    // window-only: Cursor's ACP cannot attach those to a session, so claiming
    // them as a running total would be invented.
    const usage = buildContextWindowFallback(opus5ConfigOptions, undefined, "claude-opus-5");
    expect(usage).not.toHaveProperty("total");
    expect(usage).not.toHaveProperty("contextUsed");
    expect(usage).not.toHaveProperty("input");
    expect(usage).not.toHaveProperty("output");
  });
});

// Cursor persists a context-usage record per session at
// `~/.cursor/acp-sessions/<sessionId>/store.db`, in the latest root blob's
// trailing protobuf (field 5 = { used, window, per-section breakdown }). The
// fixtures below are the verbatim root-blob bytes from live 2026.07.23 sessions,
// hex-encoded; `used` is the session's running context fill, `window` the model
// budget. The 727-byte fixture is a one-turn composer-2.5 chat (12,500 / 200,000);
// the 1265-byte fixture is the same kind of chat after a second, heavier turn
// (51,731 / 200,000) — a running total, not a per-turn delta.
describe("Cursor stored context record", () => {
  const hex = (s: string) => Buffer.from(s, "hex");

  const singleTurnBlob =
    "0a20908e12717bb34652265bb9544e15e236e08013fbe4731a8115e2fdcc0e569300" +
    "0a20c81e9d9440fbf1b9925ae17a2d608f958e1c422c731a65e1472a20d3f0856639" +
    "0a20900159fc844fcb1f29a70c61f2e8502d61870db9977d872d972894f76bed1a2a" +
    "0a20b79ead463dd35e57372f56a65dd650d422eec62c4ac4a0ceca7975e25c05b7d7" +
    "0a20974d0ec1b6d11af4012bddaeb5e0c04876fa46cc06863e88852318fe191aeece" +
    "0a2026b33977bbc687089b90f09de869c027bf502e21e5560f7cb0a1f914f23748f1" +
    "0a20cdb25e34503d644f112fb7b3f2f693b5e470eddb923613d0fb589ee8e6fa9fd1" +
    "2aa80208d46110c09a0c1a9e0208d46110c09a0c1a240a0d73797374656d5f70726f6d7074120d53797374656d2070726f6d707418f80320bf101a200a05746f6f6c731210546f6f6c20646566696e6974696f6e731899322098d2011a140a0572756c6573120552756c657318871720c6601a160a06736b696c6c731206536b696c6c73188f0a20ae2a1a1c0a036d637012134d435020262064796e616d696320746f6f6c7320001a270a097375626167656e747312145375626167656e7420646566696e6974696f6e7318ab0120ca051a340a1773756d6d6172697a65645f636f6e766572736174696f6e121753756d6d6172697a656420636f6e766572736174696f6e20001a220a0c636f6e766572736174696f6e120c436f6e766572736174696f6e18820920f91f422054c388c7cc93c201baaad16b319d1b8e742d51a9416f9201716811706bf9a3094a1766696c653a2f2f2f746d702f637572736f7270726f626550019201162f746d702f637572736f7270726f62652f612e74787492012b2f55736572732f676964656f6e736172666f2f446576656c6f7065722f6b6f6e652f4147454e54532e6d64aa011a0a182f707269766174652f746d702f637572736f7270726f6265b20103636c69d001fab7a9a4fc33da010c4166726963612f4163637261";

  const twoTurnBlob =
    "0a20908e12717bb34652265bb9544e15e236e08013fbe4731a8115e2fdcc0e569300" +
    "0a205cae100644e410d7b5ea77053835e0fd20c3c97ff8b6bcfef855eecd1ac7b6d1" +
    "0a205371c680379664a87fb1f690135e8466c366857367e87570de1486da174282d6" +
    "0a20214cbe1ce8f63a58f19875352b33bf4831ac71059cb24386382408ff7a46868d" +
    "0a20f0a88d41361294e4fb15f3795f4c2c578a098b844da39d6bc681c5966bb56260" +
    "0a2096035390f90d0d4003f0cd56570d9b3ae45d773ac8327a07538cefef330e73e5" +
    "0a2090f36f465560df884269e423757f87560c5cc4c3793f2015b813ae0acd070bc9" +
    "0a20a1a1f34f8bec226508624f1b752db19125d9ea9b0ca1a7e92d49322b639ca93f" +
    "0a20ed936e4b85a8bfd250d076491cf783904aebe6185a51246f0f9feaa567dc481f" +
    "0a207a08d45d47854181f73fa65a6bf68193457729f002b8bc9bd333f8b63499b961" +
    "0a203aedc2638d171c7684e6151d21cf7cd9aa75f2c1af2e584a2c1d55408ef096da" +
    "0a204862b4719c10f8471a7c916150bbd8f4cdb8303c6c9057fcb0a7617990174c66" +
    "0a205728aaeb2b578cab5f89ae692980e94c75b666668ef1bc60573b6ba0a6e76e25" +
    "0a204b07506f50b70c966d6eaad8f7d228911fbdb09bfb198bdf2d24b20506354f85" +
    "0a2073c02247db1144b0ce3c1af5c0e54de15c0b0dc44c4a34d91c13f4d14256b69e" +
    "0a20a3d140196415fa3445f8eb63b1a10cdb99e44c4990c97ddfdedb06a22dc42c8d" +
    "0a201731679876c358d6cccf8d9d2d491b3539d6444a2bdd348e70e31295506e9ae2" +
    "0a2032b079e626f048e7a227eb142602fc310594375ffb2b611dda01d7ae6e34fe9e" +
    "0a203df669077cb6e6066c1d19d8953cd39471de58d2b2166d6b156b5e4759b553e4" +
    "0a20d4e40c62618cea0b517776b1792fc8d5689837777438ade538ac197848d759c1" +
    "0a201521f4b971b884d85def83ea63f4ae653abca59c7f521890945351dd3ce3f1e9" +
    "0a2079512ff4ef121a5d89ac6c4646e4fc1e448f799e93a4dd3c34c238624b62006b" +
    "0a202e9610ec89ea3eff5c051fe51486dd44da1830e9c17d99bbd35ab57a2ce844d4" +
    "2aac020893940310c09a0c1aa1020893940310c09a0c1a240a0d73797374656d5f70726f6d7074120d53797374656d2070726f6d707418fa0320bf101a200a05746f6f6c731210546f6f6c20646566696e6974696f6e7318b4322098d2011a140a0572756c6573120552756c657318931720c6601a160a06736b696c6c731206536b696c6c7318940a20ae2a1a1c0a036d637012134d435020262064796e616d696320746f6f6c7320001a270a097375626167656e747312145375626167656e7420646566696e6974696f6e7318ac0120ca051a340a1773756d6d6172697a65645f636f6e766572736174696f6e121753756d6d6172697a656420636f6e766572736174696f6e20001a240a0c636f6e766572736174696f6e120c436f6e766572736174696f6e1892bb0220c4970a42205965b94d0845bc75c0ab5da1550f58969284fcf916d2bc387adaf1f32707c144422064b1e20da9d8062c760333275edfa869a88ba154c59386887a693a80709a63b04a1766696c653a2f2f2f746d702f637572736f7270726f626550019201182f746d702f637572736f7270726f62652f6269672e747874aa011a0a182f707269766174652f746d702f637572736f7270726f6265b20103636c69d001b6beaca4fc33da010c4166726963612f4163637261";

  test("decodes the running context fill and window from a real root blob", () => {
    expect(parseStoredCursorContext(hex(singleTurnBlob))).toEqual({ used: 12_500, window: 200_000 });
    expect(parseStoredCursorContext(hex(twoTurnBlob))).toEqual({ used: 51_731, window: 200_000 });
  });

  test("the numbers grow across turns — a running total, not a per-turn delta", () => {
    // The same kind of conversation after a second, heavier turn reports a
    // larger fill; kone's store handles Cursor as running totals (keeps max).
    const first = parseStoredCursorContext(hex(singleTurnBlob))!;
    const second = parseStoredCursorContext(hex(twoTurnBlob))!;
    expect(second.used).toBeGreaterThan(first.used);
    expect(second.window).toBe(first.window);
  });

  test("tolerates a shifted or unreadable blob without guessing", () => {
    expect(parseStoredCursorContext(new Uint8Array(0))).toBeUndefined();
    expect(parseStoredCursorContext(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeUndefined();
    // A blob whose context window doesn't look like a token budget is rejected.
    expect(parseStoredCursorContext(Buffer.from("0a200a1a2a3a4a5a6a7a8a9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c2a02080410ca01080c10ff7f", "hex"))).toBeUndefined();
  });
});

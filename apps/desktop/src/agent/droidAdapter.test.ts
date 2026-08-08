import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import path from "node:path";

import {
  parseDroidConfigOptions,
  resolveDroidAuthMethodId,
  resolveDroidModeId,
  toDroidModelDescriptor,
  toolCallDetail,
  toolCallStatus,
  toolCallTarget,
  parseDroidPlan,
} from "./adapters/DroidAdapter.js";
import { detectDroidAuth, droidHomeDir, parseDroidVersion, resolveDroidBinary } from "./droidHome.js";

// Every fixture below is a verbatim shape captured from a live `droid exec
// --output-format acp` session (droid 0.186.0, 2026-08-03; captures in
// docs/archive/droid/raw/), not one invented from the ACP spec — the fields droid
// actually sends (modelId, file_path, reasoning_effort, autonomy_level, …)
// are its own spellings, and they disagree with a spec-derived guess in
// exactly the places a fixture would quietly break.

describe("Droid install detection", () => {
  test("maps the ambiguous brand names onto the real executable, keeps a real path", () => {
    // `factory` is Factory's brand, not its binary — it's what users reach
    // for when asked to point kone at an install, and neither it nor a blank
    // override is a valid spawn target.
    expect(resolveDroidBinary(undefined)).toBe("droid");
    expect(resolveDroidBinary("  ")).toBe("droid");
    expect(resolveDroidBinary("factory")).toBe("droid");
    expect(resolveDroidBinary("factory-cli")).toBe("droid");
    expect(resolveDroidBinary("/opt/homebrew/bin/droid")).toBe("/opt/homebrew/bin/droid");
  });

  test("reads the bare semver and falls back to the first line", () => {
    // 0.186.0 is the agent version droid reported in every initialize result
    // (probe-permission.stdout); `--version` prints that bare semver.
    expect(parseDroidVersion("0.186.0\n")).toBe("0.186.0");
    // A non-semver first line (the real --help banner) survives as-is so the
    // telemetry string never turns into undefined.
    expect(parseDroidVersion("  -v, --version                       output the version number\n")).toBe(
      "-v, --version                       output the version number",
    );
  });

  test("Factory state lives under ~/.factory", () => {
    // droid keeps settings, sessions and auth files under ~/.factory — a
    // different directory would silently point kone at nothing.
    expect(path.isAbsolute(droidHomeDir())).toBe(true);
    expect(path.basename(droidHomeDir())).toBe(".factory");
  });

  test("detects auth from an explicit FACTORY_API_KEY, never the real ~/.factory", async () => {
    // The key name is verbatim from the initialize authMethods description
    // ("set in the FACTORY_API_KEY environment variable"). Called with an
    // explicit env so the test never depends on this machine's ~/.factory.
    expect(await detectDroidAuth({ FACTORY_API_KEY: "x" })).toEqual({
      authenticated: true,
      label: "Factory API Key",
    });
    // A blank key is no key: it must fall through to the credential-file
    // check (which may or may not find a device-pairing login) and never
    // claim the API-key label.
    const fallthrough = await detectDroidAuth({ FACTORY_API_KEY: "   " });
    expect(typeof fallthrough.authenticated).toBe("boolean");
    expect(fallthrough.label).not.toBe("Factory API Key");
  });
});

describe("Droid auth method", () => {
  // The two auth methods are verbatim from the initialize result
  // (probe-permission.stdout): device pairing for a human login, and an
  // exported API key. resolveDroidAuthMethodId reads process.env directly, so
  // every test here starts from a clean slate and restores it afterwards.
  const initialize = {
    protocolVersion: 1,
    authMethods: [
      { id: "device-pairing", name: "Login", description: "Authenticate with Factory using a device pairing code in your browser." },
      { id: "factory-api-key", name: "Factory API Key", description: "Authenticate using a Factory API key set in the FACTORY_API_KEY environment variable." },
    ],
  };

  let previousKey: string | undefined;
  beforeEach(() => {
    previousKey = process.env.FACTORY_API_KEY;
    delete process.env.FACTORY_API_KEY;
  });
  afterEach(() => {
    if (previousKey === undefined) delete process.env.FACTORY_API_KEY;
    else process.env.FACTORY_API_KEY = previousKey;
  });

  test("prefers the API key when FACTORY_API_KEY is set", () => {
    process.env.FACTORY_API_KEY = "kone-test";
    expect(resolveDroidAuthMethodId(initialize)).toBe("factory-api-key");
  });

  test("falls back to device pairing when no key is set", () => {
    expect(resolveDroidAuthMethodId(initialize)).toBe("device-pairing");
  });

  test("a blank key is treated as unset", () => {
    process.env.FACTORY_API_KEY = "   ";
    expect(resolveDroidAuthMethodId(initialize)).toBe("device-pairing");
  });

  test("returns undefined when the CLI advertises no auth method", () => {
    expect(resolveDroidAuthMethodId({})).toBeUndefined();
    expect(resolveDroidAuthMethodId({ authMethods: [{ id: "device-pairing" }] })).toBe("device-pairing");
  });
});

describe("Droid config options", () => {
  // The verbatim `session/new` configOptions matrix (full-session-model.stdout):
  // droid spells kone's axes `autonomy_level` (mode ladder, category "mode"),
  // `model`, and `reasoning_effort`. The `type`/`description` fields droid adds
  // are not part of kone's model and must not leak.
  const sessionNewConfigOptions = [
    {
      id: "autonomy_level", name: "Autonomy Level",
      description: "Which tool actions the agent may run without confirmation.",
      category: "mode", type: "select", currentValue: "auto-medium",
      options: [
        { value: "normal", name: "Auto (Off)" },
        { value: "spec", name: "Spec" },
        { value: "auto-low", name: "Auto (Low)" },
        { value: "auto-medium", name: "Auto (Medium)" },
        { value: "auto-high", name: "Auto (High)" },
      ],
    },
    {
      id: "model", name: "Model",
      description: "The model used for this session. Changing this may also change the available Reasoning Effort options.",
      category: "model", type: "select", currentValue: "kimi-k2.6",
      options: [
        { value: "kimi-k2.6", name: "Kimi K2.6 (Droid Core)", description: "0.4x Factory token rate" },
        { value: "custom:deepseek-v4-flash", name: "DeepSeek V4 Flash [OpenCode]" },
      ],
    },
    {
      id: "reasoning_effort", name: "Reasoning Effort",
      description: "Controls how much thinking the model performs before responding. The available options depend on the selected model.",
      category: "thought_level", type: "select", currentValue: "none",
      options: [
        { value: "off", name: "Off" },
        { value: "high", name: "High" },
        { value: "none", name: "None" },
      ],
    },
  ];

  test("projects the session/new matrix onto droid's axes", () => {
    const parsed = parseDroidConfigOptions(sessionNewConfigOptions);
    expect(parsed.map((option) => option.id)).toEqual(["autonomy_level", "model", "reasoning_effort"]);
    // The autonomy select carries the mode ladder droid applies mode changes
    // through (fallback path for older builds without session/set_mode).
    expect(parsed[0]).toEqual({
      id: "autonomy_level", name: "Autonomy Level", category: "mode",
      currentValue: "auto-medium",
      options: [
        { value: "normal", name: "Auto (Off)" },
        { value: "spec", name: "Spec" },
        { value: "auto-low", name: "Auto (Low)" },
        { value: "auto-medium", name: "Auto (Medium)" },
        { value: "auto-high", name: "Auto (High)" },
      ],
    });
    expect(parsed[2]).toMatchObject({
      currentValue: "none",
      options: [
        { value: "off", name: "Off" },
        { value: "high", name: "High" },
        { value: "none", name: "None" },
      ],
    });
  });

  test("tolerates a malformed config-option payload", () => {
    // A row with no id and an option with no value would otherwise poison the
    // matrix the adapter resolves models and modes from.
    expect(
      parseDroidConfigOptions([
        { name: "no id" },
        { id: "model", options: [{ name: "no value" }, { value: "kimi-k2.6" }] },
      ]),
    ).toEqual([
      { id: "model", name: undefined, category: undefined, currentValue: undefined, options: [{ value: "kimi-k2.6", name: undefined }] },
    ]);
    expect(parseDroidConfigOptions(undefined)).toEqual([]);
  });
});

describe("Droid model catalog", () => {
  test("reads droid's real field names and attaches the reasoning-effort list", () => {
    // The entry is verbatim from session/new `models.availableModels[0]`; the
    // efforts are the `reasoning_effort` options droid reported for that model
    // after switching to it (config_option_update, full-session-model.stdout).
    const descriptor = toDroidModelDescriptor(
      { modelId: "kimi-k2.6", name: "Kimi K2.6 (Droid Core)", description: "0.4x Factory token rate" },
      { values: ["off", "low", "medium", "high"], current: "low" },
    );
    expect(descriptor).toEqual({
      id: "kimi-k2.6",
      label: "Kimi K2.6 (Droid Core)",
      reasoningEfforts: ["off", "low", "medium", "high"],
      defaultReasoningEffort: "low",
    });
  });

  test("a row with no modelId is not a model", () => {
    expect(toDroidModelDescriptor({ name: "No id" })).toBeUndefined();
  });

  test("a model with no reasoning axis carries no effort keys", () => {
    expect(
      toDroidModelDescriptor({ modelId: "custom:deepseek-v4-flash", name: "DeepSeek V4 Flash [OpenCode]", description: null }),
    ).toEqual({ id: "custom:deepseek-v4-flash", label: "DeepSeek V4 Flash [OpenCode]" });
    // The id is the fallback label when droid's name is blank — the catalog
    // must never surface an undefined label.
    expect(toDroidModelDescriptor({ modelId: "custom:z-ai/glm-5.2" })).toEqual({
      id: "custom:z-ai/glm-5.2",
      label: "custom:z-ai/glm-5.2",
    });
  });
});

describe("Droid session modes", () => {
  // The five mode ids droid advertised in session/new `modes.availableModes`
  // (full-session-model.stdout). kone's three rungs resolve onto this ladder
  // by what each mode auto-approves: normal=read-only (ask),
  // auto-low=edits+low-risk (accept-edits), auto-high=everything (full-access).
  const advertisedModes = ["normal", "spec", "auto-low", "auto-medium", "auto-high"];

  test("maps kone's ladder onto the modes the session advertises", () => {
    expect(resolveDroidModeId("ask", advertisedModes)).toBe("normal");
    expect(resolveDroidModeId("accept-edits", advertisedModes)).toBe("auto-low");
    expect(resolveDroidModeId("full-access", advertisedModes)).toBe("auto-high");
  });

  test("degrades down the ladder, never up, and never invents an id", () => {
    // The org's list can omit a rung; a set_mode must never send a mode id
    // droid doesn't advertise, or the whole call is rejected. When the exact
    // rung is missing the fallback has to be *narrower* — the agent asking too
    // often is a nuisance, the agent auto-approving too much is a breach.
    expect(resolveDroidModeId("accept-edits", ["normal", "auto-medium", "auto-high"])).toBe("normal");
    expect(resolveDroidModeId("full-access", ["normal", "auto-low"])).toBe("auto-low");
    // No advertised mode is narrow enough for the read-only rung: send nothing
    // and stay on droid's default rather than falling into `auto-high`.
    expect(resolveDroidModeId("ask", ["auto-low", "auto-high"])).toBeUndefined();
    expect(resolveDroidModeId("ask", [])).toBeUndefined();
  });
});

describe("Droid tool-call translation", () => {
  test("prefers the command, then droid's file_path, then the title as the inline target", () => {
    // execute tool_call (probe-tool-exec): the command is the row's inline text.
    expect(
      toolCallTarget({
        sessionUpdate: "tool_call",
        toolCallId: "call_00_ET_aJsMzt23x8jAcmr8DX7n1842",
        title: "`echo HELLO_DROID` (low)",
        kind: "execute", status: "pending",
        rawInput: { command: "echo HELLO_DROID", summary: "Print test string", riskLevel: "low", riskLevelReason: "Read-only echo command printing a string to stdout." },
      }),
    ).toBe("echo HELLO_DROID");
    // Write tool_call (probe-permission): droid puts the path in rawInput.file_path,
    // and that beats the `locations` array — a spec-derived `path` read would
    // miss it and fall through to the title.
    expect(
      toolCallTarget({
        sessionUpdate: "tool_call",
        toolCallId: "call_00_zUHvVe9cM1FkDYSq1Hs53194",
        title: "Create /tmp/droid-probe/PROBE.txt",
        kind: "edit", status: "pending",
        rawInput: { file_path: "/tmp/droid-probe/PROBE.txt", content: "pwned\n" },
        content: [{ type: "diff", path: "/tmp/droid-probe/PROBE.txt", oldText: null, newText: "pwned\n" }],
        locations: [{ path: "/tmp/droid-probe/PROBE.txt" }],
      }),
    ).toBe("/tmp/droid-probe/PROBE.txt");
    expect(toolCallTarget({ title: "Create /tmp/droid-probe/PROBE.txt" })).toBe("Create /tmp/droid-probe/PROBE.txt");
    expect(toolCallTarget({})).toBe("");
  });

  test("collects the result body from rawOutput; unknown shapes are stringified, never dropped", () => {
    // tool_call_update completed (probe-resume): rawOutput.text is not one of
    // the known body keys, so the whole object is pretty-printed rather than
    // discarded — losing a terminal transcript would be worse than a JSON dump.
    expect(
      toolCallDetail({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_00_ET_aJsMzt23x8jAcmr8DX7n1842",
        status: "completed",
        rawOutput: { text: "HELLO_DROID\n\n\n[Process exited with code 0]" },
      }),
    ).toBe(`{\n  "text": "HELLO_DROID\\n\\n\\n[Process exited with code 0]"\n}`);
    // A diff block carries no renderable text — the edit body stays empty.
    expect(
      toolCallDetail({
        kind: "edit",
        rawInput: { file_path: "/tmp/droid-probe/PROBE.txt" },
        content: [{ type: "diff", path: "/tmp/droid-probe/PROBE.txt", oldText: null, newText: "pwned\n" }],
      }),
    ).toBe("");
    expect(toolCallDetail({})).toBe("");
  });

  test("anything that is not a terminal status is still running", () => {
    // pending/in_progress/undefined all mean the row is mid-flight; only
    // completed and failed close it out.
    expect(["pending", "in_progress", "completed", "failed", undefined].map(toolCallStatus)).toEqual([
      "in-progress",
      "in-progress",
      "completed",
      "failed",
      "in-progress",
    ]);
  });
});

describe("Droid plan translation", () => {
  test("re-spells ACP's `in_progress` and drops empty entries", () => {
    // droid 0.186.0 never emitted a `plan` update across 364 live captures, so
    // there is no verbatim droid plan to paste — this is the ACP-standard
    // shape, identical to the one Cursor's live captures proved.
    expect(
      parseDroidPlan({
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
    expect(parseDroidPlan({ entries: [] })).toBeUndefined();
    expect(parseDroidPlan({})).toBeUndefined();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { createHandoff } from "./useThreadHandoff";
import type { CreateHandoffInput, CreateHandoffResult } from "~/types/desktop";

/** The slice of the desktop bridge the composable actually reaches for. */
type BridgeHost = {
  koneDesktop: { agent: { createHandoff: (input: CreateHandoffInput) => Promise<CreateHandoffResult> } };
};

function installBridge(
  impl?: (input: CreateHandoffInput) => Promise<CreateHandoffResult>,
) {
  const inputs: CreateHandoffInput[] = [];
  const host: BridgeHost = {
    koneDesktop: {
      agent: {
        createHandoff: (input) => {
          inputs.push(input);
          if (impl) return impl(input);
          return Promise.resolve({
            requestId: input.requestId,
            threadId: input.threadId,
            sourceThreadId: input.sourceThreadId,
            provider: input.target.provider,
            status: "created",
          });
        },
      },
    },
  };
  // SAFETY: the composable reads only window.koneDesktop.agent.createHandoff,
  // which BridgeHost provides; nothing else in this file touches window.
  (globalThis as { window?: BridgeHost }).window = host;
  return { inputs };
}

afterEach(() => {
  // SAFETY: restores the no-bridge (browser-dev) shape between tests — a
  // defined window with no koneDesktop, exactly what the composable guards.
  (globalThis as { window?: object }).window = {};
});

describe("createHandoff", () => {
  test("dispatches minted ids plus the chosen target", async () => {
    const { inputs } = installBridge();
    const result = await createHandoff({
      sourceThreadId: "t-src",
      kind: "handoff",
      target: { provider: "claudeAgent", model: "claude-sonnet-5" },
    });
    expect(result).toMatchObject({ status: "created", joined: false });
    expect(inputs).toHaveLength(1);
    const sent = inputs[0]!;
    expect(sent.sourceThreadId).toBe("t-src");
    expect(sent.target).toEqual({ provider: "claudeAgent", model: "claude-sonnet-5" });
    expect(sent.threadId).toBe(result.threadId);
    expect(sent.requestId).toBeTruthy();
  });

  test("rapid repeats for the same source + target join one flight", async () => {
    const { inputs } = installBridge();
    const [a, b] = await Promise.all([
      createHandoff({ sourceThreadId: "t-src", kind: "handoff", target: { provider: "claudeAgent" } }),
      createHandoff({ sourceThreadId: "t-src", kind: "handoff", target: { provider: "claudeAgent" } }),
    ]);
    expect(inputs).toHaveLength(1);
    expect(a.threadId).toBe(b.threadId);
    expect(b.joined).toBe(true);
  });

  test("hands off to the source's own provider and model without resuming it", async () => {
    const { inputs } = installBridge();
    const result = await createHandoff({
      sourceThreadId: "t-src",
      kind: "handoff",
      // The source runs this exact provider/model/effort.
      target: { provider: "codex", model: "gpt-x", effort: "high" },
    });
    expect(result).toMatchObject({ status: "created", joined: false });
    expect(inputs).toHaveLength(1);
    const sent = inputs[0]!;
    // A fresh renderer-minted thread id — the source thread is never returned
    // or resumed by a same-provider/model handoff.
    expect(sent.threadId).toBe(result.threadId);
    expect(sent.threadId).not.toBe("t-src");
    expect(sent.target).toEqual({ provider: "codex", model: "gpt-x", effort: "high" });
  });

  test("rapid identical same-provider/model clicks join one flight", async () => {
    const { inputs } = installBridge();
    const options = {
      sourceThreadId: "t-src",
      kind: "handoff" as const,
      target: { provider: "codex" as const, model: "gpt-x" },
    };
    const [a, b] = await Promise.all([createHandoff(options), createHandoff(options)]);
    expect(inputs).toHaveLength(1);
    expect(a.threadId).toBe(b.threadId);
    expect(b.joined).toBe(true);
  });

  test("without a bridge it still resolves so the join semantics hold", async () => {
    const result = await createHandoff({
      sourceThreadId: "t-src",
      kind: "handoff",
      target: { provider: "codex" },
    });
    expect(result.status).toBe("created");
    expect(result.threadId).toBeTruthy();
  });
});

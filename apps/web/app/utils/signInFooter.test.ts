import { describe, expect, test } from "bun:test";
import type { ProviderStatus } from "~/types/desktop";
import type { SignInState } from "~/composables/useSignInRun";
import { signInFooter, type SignInFooterInput } from "./signInFooter";

// Variant A's footer is data: copy and buttons for each phase, asserted here
// rather than by mounting the card.

function statusWith(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    provider: "cursor",
    label: "Cursor",
    available: true,
    authStatus: "authenticated",
    readiness: "ready",
    ...overrides,
  };
}

const BASE: Omit<SignInFooterInput, "state"> = {
  finish: "browser",
  live: true,
  copied: false,
};

function footer(state: SignInState, overrides: Partial<SignInFooterInput> = {}) {
  return signInFooter({ ...BASE, state, ...overrides });
}

describe("signInFooter", () => {
  test("idle: Ready, one Run login", () => {
    const { status, secondary, primary } = footer({ phase: "idle" });

    expect(status).toEqual({ text: "Ready", tone: "idle" });
    expect(secondary).toEqual([]);
    expect(primary).toMatchObject({ id: "run", label: "Run login", variant: "primary" });
    expect(primary.disabled).toBeFalsy();
  });

  test("starting: Starting…, Stop and Check both disabled", () => {
    const { status, secondary, primary } = footer({ phase: "starting" });

    expect(status).toEqual({ text: "Starting…", tone: "busy" });
    expect(secondary).toEqual([{ id: "stop", label: "Stop", variant: "quiet", disabled: true }]);
    expect(primary).toEqual({
      id: "check",
      label: "Check authentication",
      variant: "primary",
      disabled: true,
    });
  });

  test("running: Running, Stop and Check live", () => {
    const { status, secondary, primary } = footer({ phase: "running" });

    expect(status).toEqual({ text: "Running", tone: "busy" });
    expect(secondary).toMatchObject([{ id: "stop", label: "Stop" }]);
    expect(primary).toMatchObject({ id: "check", label: "Check authentication" });
    expect(primary.disabled).toBeFalsy();
  });

  test("waiting on a browser URL uses the amber waiting tone", () => {
    const { status, secondary, primary } = footer({ phase: "waiting" });

    expect(status).toEqual({ text: "Waiting for browser", tone: "waiting" });
    expect(secondary).toMatchObject([{ id: "stop", label: "Stop" }]);
    expect(primary).toMatchObject({ id: "check", label: "Check authentication" });
  });

  test("waiting on a terminal menu says Answer in terminal", () => {
    const { status } = footer({ phase: "waiting" }, { finish: "terminal" });

    expect(status).toEqual({ text: "Answer in terminal", tone: "waiting" });
  });

  test("checking: Checking… disabled, Stop only while a PTY lives", () => {
    const live = footer({ phase: "checking" });
    expect(live.status).toEqual({ text: "Checking…", tone: "busy" });
    expect(live.secondary).toMatchObject([{ id: "stop", label: "Stop" }]);
    expect(live.primary).toEqual({
      id: "check",
      label: "Checking…",
      variant: "primary",
      disabled: true,
    });

    const dead = footer({ phase: "checking" }, { live: false });
    expect(dead.secondary).toEqual([]);
    expect(dead.primary.disabled).toBe(true);
  });

  test("verified names the plan when the provider knows one", () => {
    const withPlan = footer({ phase: "verified", status: statusWith({ authLabel: "Cursor Pro" }) });
    expect(withPlan.status).toEqual({ text: "Signed in · Cursor Pro", tone: "ok" });
    expect(withPlan.secondary).toEqual([]);
    expect(withPlan.primary).toMatchObject({ id: "close", label: "Done", variant: "outline" });

    const withoutPlan = footer({ phase: "verified", status: statusWith() });
    expect(withoutPlan.status).toEqual({ text: "Signed in", tone: "ok" });
  });

  test("an exit failure names the code and offers Copy command + Run again", () => {
    const { status, secondary, primary } = footer({
      phase: "failed",
      failure: { kind: "exit", reason: "cursor-agent exited with code 1", code: 1 },
    });

    expect(status).toEqual({ text: "Exited with code 1", tone: "danger" });
    expect(secondary).toMatchObject([{ id: "copy", label: "Copy command" }]);
    expect(primary).toMatchObject({ id: "run", label: "Run again" });
  });

  test("the copy button reports its copied beat", () => {
    const state: SignInState = {
      phase: "failed",
      failure: { kind: "exit", reason: "cursor-agent exited with code 1", code: 1 },
    };

    expect(footer(state, { copied: true }).secondary[0]?.label).toBe("Copied");
    expect(footer({ phase: "cancelled", reason: "user" }, { copied: true }).secondary[0]?.label).toBe(
      "Copied",
    );
  });

  test("an exit without a code still says so", () => {
    const { status } = footer({
      phase: "failed",
      failure: { kind: "exit", reason: "cursor-agent exited with code ?", code: null },
    });

    expect(status.text).toBe("Exited with code ?");
  });

  test("a refused start keeps the CLI's sentence", () => {
    const { status, secondary, primary } = footer({
      phase: "failed",
      failure: { kind: "start", reason: "cursor-agent isn't on your PATH." },
    });

    expect(status).toEqual({
      text: "cursor-agent isn't on your PATH.",
      tone: "danger",
    });
    expect(secondary).toMatchObject([{ id: "copy" }]);
    expect(primary).toMatchObject({ id: "run", label: "Run again" });
  });

  test("a failed check while the CLI lives keeps Stop and Check", () => {
    const state: SignInState = {
      phase: "failed",
      failure: { kind: "check", reason: "Cursor still reports no sign-in." },
    };

    const live = footer(state);
    expect(live.status).toEqual({ text: "Cursor still reports no sign-in.", tone: "danger" });
    expect(live.secondary).toMatchObject([{ id: "stop", label: "Stop" }]);
    expect(live.primary).toMatchObject({ id: "check", label: "Check authentication" });
    expect(live.primary.disabled).toBeFalsy();

    const dead = footer(state, { live: false });
    expect(dead.secondary).toMatchObject([{ id: "run", label: "Run again" }]);
    expect(dead.primary).toMatchObject({ id: "check", label: "Check authentication" });
  });

  test("cancelled is the muted stop copy, and the ten-minute cap says why", () => {
    const user = footer({ phase: "cancelled", reason: "user" });
    expect(user.status).toEqual({ text: "Sign-in stopped", tone: "muted" });
    expect(user.secondary).toMatchObject([{ id: "copy", label: "Copy command" }]);
    expect(user.primary).toMatchObject({ id: "run", label: "Run again" });

    expect(footer({ phase: "cancelled", reason: "timeout" }).status).toEqual({
      text: "Sign-in stopped after 10 minutes",
      tone: "muted",
    });
  });
});

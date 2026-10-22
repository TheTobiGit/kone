import { beforeEach, describe, expect, test } from "bun:test";
import type {
  KoneProviderSignInApi,
  KoneTerminalApi,
  ProviderSignInCommand,
  ProviderStatus,
  TerminalCloseInput,
  TerminalEvent,
  TerminalSessionSnapshot,
} from "~/types/desktop";
import { createDevBridge } from "~/lib/devBridge";
import { installDevBridge } from "~/utils/desktopBridge";
import { isRunActive, isSettled, useSignInRun } from "./useSignInRun";

// The sign-in state machine, driven through a stand-in bridge: `start` mints a
// PTY, the test plays the events a real TerminalManager would send, and the
// state is asserted as the card would read it. No DOM, no xterm, no timers.

const COMMAND: ProviderSignInCommand = {
  provider: "cursor",
  display: "cursor-agent login",
  cwd: "~",
  finish: "browser",
};

function snapshot(
  terminalId: string,
  overrides: Partial<TerminalSessionSnapshot> = {},
): TerminalSessionSnapshot {
  return {
    terminalId,
    pid: 1,
    cols: 80,
    rows: 24,
    cwd: "~",
    status: "ready",
    history: "",
    sequence: 0,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: false,
    childCommandLabel: null,
    ...overrides,
  };
}

function statusWith(overrides: Partial<ProviderStatus>): ProviderStatus {
  return {
    provider: "cursor",
    label: "Cursor",
    available: true,
    authStatus: "authenticated",
    readiness: "ready",
    ...overrides,
  };
}

/** A latch a test can release to hold `close` open — the window a real
 *  tree-kill takes to settle. */
function latch() {
  let release = (): void => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

type HarnessOptions = {
  /** What `check` answers. */
  status?: ProviderStatus;
  /** When set, `start` refuses with this message. */
  startMessage?: string;
  finish?: ProviderSignInCommand["finish"];
  /** When set, every `close` waits for this latch. */
  closeGate?: () => Promise<void>;
  /** When set, `start` holds its answer until this latch resolves — the window
   *  where a live PTY can exit before `start()` has settled. */
  startGate?: () => Promise<void>;
  /** When set, `check` holds its answer until this latch resolves. */
  checkGate?: () => Promise<void>;
  /** Output already folded into the snapshot `start` returns (it was printed
   *  before the main process captured the snapshot). Emitted as an `output`
   *  event whose sequence is at or below the snapshot's. */
  preloaded?: string;
  /** Output emitted in the gap the review found: as a microtask queued after
   *  the opener's continuation has drained its buffer, but before `spawn`
   *  resumes and adopts the id. The emit is scheduled off the start answer, so
   *  it lands in that gap with or without `startGate`. */
  gapOutput?: string;
  /** Install the terminal registry's live listener, as a renderer would (Bun
   *  has no `import.meta.client`). */
  client?: boolean;
};

function harness(options: HarnessOptions = {}) {
  const listeners = new Set<(event: TerminalEvent) => void>();
  const log: string[] = [];
  const closes: TerminalCloseInput[] = [];
  const command: ProviderSignInCommand = { ...COMMAND, finish: options.finish ?? "browser" };
  let sequence = 0;
  let currentId: string | null = null;
  let checks = 0;
  let nextSignInId = 0;

  const emit = (event: TerminalEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const terminal: KoneTerminalApi = {
    open: (input) => Promise.resolve(snapshot(input.terminalId)),
    write: () => Promise.resolve(),
    resize: () => Promise.resolve(),
    close: async (input) => {
      closes.push(input);
      log.push(`close:${input.terminalId}`);
      await options.closeGate?.();
    },
    restart: (input) => Promise.resolve(snapshot(input.terminalId)),
    ack: () => Promise.resolve(),
    onEvent: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };

  const providerSignIn: KoneProviderSignInApi = {
    command: () => Promise.resolve(command),
    start: () => {
      // The real main process mints the id; the fake does too so the test
      // exercises adoption rather than trusting the provisional id.
      const terminalId = `signin-test-${++nextSignInId}`;
      log.push(`start:${terminalId}`);
      if (options.startMessage) {
        return Promise.resolve({ ok: false, command, message: options.startMessage });
      }
      currentId = terminalId;
      // Output printed before the snapshot was captured is in its history and
      // carries a sequence at or below the snapshot's.
      if (options.preloaded !== undefined) {
        emit({
          terminalId,
          type: "output",
          sequence: ++sequence,
          data: options.preloaded,
        });
      }
      const result = {
        ok: true as const,
        terminalId,
        command,
        snapshot: snapshot(terminalId, {
          history: options.preloaded ?? "",
          sequence,
        }),
      };
      const answer = options.startGate ? options.startGate().then(() => result) : Promise.resolve(result);
      const gap = options.gapOutput;
      if (!gap) return answer;
      // The window between the opener returning and `spawn` adopting: the first
      // microtask lands behind the opener's await continuation (it has already
      // drained), the second ahead of `spawn`'s continuation (it has not
      // adopted yet). Nothing owns the id there unless handoff is atomic.
      return answer.then((settled) => {
        void Promise.resolve().then(() =>
          Promise.resolve().then(() => {
            emit({ terminalId, type: "output", sequence: ++sequence, data: gap });
          }),
        );
        return settled;
      });
    },
    check: () => {
      checks += 1;
      const status = options.status ?? statusWith({});
      return options.checkGate ? options.checkGate().then(() => status) : Promise.resolve(status);
    },
  };

  installDevBridge({ ...createDevBridge(), terminal, providerSignIn });

  const signIn = useSignInRun({ provider: "cursor", label: "Cursor", client: options.client });

  return {
    signIn,
    log,
    closes,
    starts: (): number => log.filter((entry) => entry.startsWith("start:")).length,
    checkCount: (): number => checks,
    output: (data: string): void => {
      if (!currentId) throw new Error("no PTY");
      emit({ terminalId: currentId, type: "output", sequence: ++sequence, data });
    },
    exit: (exitCode: number | null, signal?: number): void => {
      if (!currentId) throw new Error("no PTY");
      emit({ terminalId: currentId, type: "exited", sequence: ++sequence, exitCode, signal });
    },
    closed: (): void => {
      if (!currentId) throw new Error("no PTY");
      emit({ terminalId: currentId, type: "closed", sequence: ++sequence });
    },
  };
}

/** Let the microtask queue drain: `check()` is fired without an await from the
 *  exit path, so its result lands a turn later. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Attach a fake xterm sink to the run's session and return a reader for what
 *  the attached transcript would hold: the replayed buffer plus live writes. */
function transcript(h: ReturnType<typeof harness>): () => string {
  const session = h.signIn.session.value;
  if (!session) throw new Error("no session attached");
  let text = "";
  session.attach({
    write: (data) => {
      text += data;
    },
    reset: () => {
      text = "";
    },
  });
  return () => text;
}

/** How many times `needle` occurs in `text`, without overlapping matches. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

// Every test installs its own stand-in, so none sees another's listeners.
beforeEach(() => installDevBridge(null));

describe("useSignInRun", () => {
  test("idle → run → waiting on a URL", async () => {
    const h = harness();
    expect(h.signIn.state.value).toEqual({ phase: "idle" });

    await h.signIn.run();
    expect(h.signIn.phase.value).toBe("running");
    expect(h.signIn.process.value.state).toBe("live");
    // The session adopted the id the "main process" returned, not the
    // provisional one the registry minted.
    expect(h.signIn.session.value?.terminalId).toMatch(/^signin-test-/);

    h.output("Open this URL in your browser to sign in:\r\n  \x1b[4;36mhttps://cursor.com/login?x=1\x1b[0m\r\n");
    expect(h.signIn.state.value).toEqual({ phase: "waiting" });
  });

  test("output that lands before start() resolves reaches the transcript", async () => {
    const gate = latch();
    const h = harness({ startGate: () => gate.wait });

    const starting = h.signIn.run();
    await settle();
    expect(h.signIn.phase.value).toBe("starting");

    // The login URL prints after main captured the snapshot but before the
    // start IPC resolves: the card already sees it (below), and the attached
    // transcript must not lose it.
    h.output("Open https://example.com/login\r\n");
    gate.release();
    await starting;

    expect(h.signIn.phase.value).toBe("waiting");
    const shown = transcript(h)();
    expect(shown).toContain("Open https://example.com/login");
    expect(occurrences(shown, "Open https://example.com/login")).toBe(1);
  });

  test("output already in the snapshot history is not shown twice", async () => {
    const gate = latch();
    const h = harness({
      startGate: () => gate.wait,
      preloaded: "Open https://example.com/login\r\n",
    });

    const starting = h.signIn.run();
    await settle();
    gate.release();
    await starting;

    expect(h.signIn.phase.value).toBe("waiting");
    const shown = transcript(h)();
    // It arrived in snapshot.history; its event (sequence <= snapshot.sequence)
    // must not be replayed into the transcript on top of it.
    expect(occurrences(shown, "Open https://example.com/login")).toBe(1);
  });

  test("output between the opener returning and id adoption reaches the transcript", async () => {
    const h = harness({
      client: true,
      preloaded: "BANNER\r\n",
      gapOutput: "Open https://example.com/login\r\n",
    });

    await h.signIn.run();

    // The card saw the URL — it is in the early buffer the opener drains...
    expect(h.signIn.phase.value).toBe("waiting");
    const shown = transcript(h)();
    // ...but the registry must not lose it: adoption and the drain have to be
    // one step, or this event is owned by nobody.
    expect(occurrences(shown, "Open https://example.com/login")).toBe(1);
    // The snapshot seeded the buffer; the replay must not add it again.
    expect(occurrences(shown, "BANNER")).toBe(1);
  });

  test("output after adoption is routed live, exactly once", async () => {
    const h = harness({ client: true, preloaded: "BANNER\r\n" });
    await h.signIn.run();

    const shown = transcript(h);
    h.output("Open https://example.com/live\r\n");

    expect(h.signIn.phase.value).toBe("waiting");
    expect(occurrences(shown(), "Open https://example.com/live")).toBe(1);
    expect(occurrences(shown(), "BANNER")).toBe(1);
  });

  test("a run disposed while start resolves adopts nothing", async () => {
    const gate = latch();
    const h = harness({
      client: true,
      startGate: () => gate.wait,
      gapOutput: "Open https://example.com/login\r\n",
    });

    const starting = h.signIn.run();
    await settle();
    await h.signIn.dispose();
    gate.release();
    await starting;

    // The card is gone: the late id is closed rather than adopted, and its
    // output must not move a state machine nobody is watching.
    expect(h.signIn.phase.value).toBe("starting");
    expect(h.signIn.session.value).toBeNull();
    expect(h.closes.map((close) => close.terminalId)).toEqual(["signin-test-1"]);
  });

  test("exit 0 runs a check and verifies", async () => {
    const h = harness({ status: statusWith({ authLabel: "Cursor Pro" }) });
    await h.signIn.run();

    h.exit(0);
    await settle();

    expect(h.signIn.state.value).toEqual({
      phase: "verified",
      status: statusWith({ authLabel: "Cursor Pro" }),
    });
    expect(h.signIn.status.value?.authLabel).toBe("Cursor Pro");
    expect(h.signIn.failure.value).toBeNull();
    expect(h.signIn.process.value.state).toBe("exited");
  });

  test("a needs-login check ignores the CLI's login advice", async () => {
    const h = harness({
      status: statusWith({
        readiness: "needs-login",
        authStatus: "unauthenticated",
        message: "Run `cursor-agent login` to sign in.",
      }),
    });
    await h.signIn.run();

    await h.signIn.check();

    expect(h.signIn.phase.value).toBe("failed");
    expect(h.signIn.failure.value?.kind).toBe("check");
    // The message tells the user to run the very command this card just ran.
    expect(h.signIn.failure.value?.reason).toBe("Cursor still reports no sign-in.");
    // The CLI is still alive: a failed check never touches the PTY.
    expect(h.signIn.process.value.state).toBe("live");
  });

  test("a check with no message falls back to the provider's own wording", async () => {
    const h = harness({
      status: statusWith({ readiness: "needs-login", authStatus: "unauthenticated" }),
    });
    await h.signIn.run();

    await h.signIn.check();

    expect(h.signIn.failure.value?.reason).toBe("Cursor still reports no sign-in.");
  });

  test("a long check message collapses to one line and is cut", async () => {
    const h = harness({
      status: statusWith({
        readiness: "error",
        authStatus: "unknown",
        message: `a\nb ${"x".repeat(160)}`,
      }),
    });
    await h.signIn.run();

    await h.signIn.check();

    expect(h.signIn.failure.value?.reason).toBe(`a b ${"x".repeat(136)}…`);
  });

  test("a check message loses its backticks", async () => {
    const h = harness({
      status: statusWith({
        readiness: "error",
        authStatus: "unknown",
        message: "Run `cursor-agent doctor` first.",
      }),
    });
    await h.signIn.run();

    await h.signIn.check();

    expect(h.signIn.failure.value?.reason).toBe("Run cursor-agent doctor first.");
  });

  test("a check with no message on a non-login failure says it isn't available", async () => {
    const h = harness({
      status: statusWith({ readiness: "error", authStatus: "unknown", message: undefined }),
    });
    await h.signIn.run();

    await h.signIn.check();

    expect(h.signIn.failure.value?.reason).toBe("Cursor isn't available right now.");
  });

  test("a non-zero exit fails (exit), not (check)", async () => {
    const h = harness();
    await h.signIn.run();

    h.exit(1);

    expect(h.signIn.phase.value).toBe("failed");
    expect(h.signIn.failure.value?.kind).toBe("exit");
    expect(h.signIn.failure.value?.code).toBe(1);
    expect(h.signIn.failure.value?.reason).toBe("cursor-agent exited with code 1");
  });

  test("a signal exit cancels", async () => {
    const h = harness();
    await h.signIn.run();

    h.exit(null, 2);

    expect(h.signIn.state.value).toEqual({ phase: "cancelled", reason: "user" });
  });

  test("exit 130 cancels", async () => {
    const h = harness();
    await h.signIn.run();

    h.exit(130);

    expect(h.signIn.state.value).toEqual({ phase: "cancelled", reason: "user" });
  });

  test("a closed PTY the user did not close is the ten-minute stop", async () => {
    const h = harness();
    await h.signIn.run();
    h.output("Open this URL:\r\nhttps://cursor.com/login\r\n");

    // The main process caps a sign-in PTY at ten minutes and emits `closed`
    // rather than an exit; the card must not sit on "Waiting for the browser".
    h.closed();

    expect(h.signIn.state.value).toEqual({ phase: "cancelled", reason: "timeout" });
    expect(h.signIn.process.value.state).toBe("none");
  });

  test("exit 0 before start() resolves still runs the check and never says running", async () => {
    const gate = latch();
    const h = harness({
      startGate: () => gate.wait,
      status: statusWith({ authLabel: "Cursor Pro" }),
    });

    const starting = h.signIn.run();
    await settle();
    expect(h.signIn.phase.value).toBe("starting");

    // The CLI exits while the start IPC is still resolving: `canCheck()` would
    // refuse a check now, so the exit has to be remembered.
    h.exit(0);
    expect(h.checkCount()).toBe(0);
    expect(h.signIn.phase.value).toBe("starting");

    gate.release();
    await starting;
    await settle();

    expect(h.signIn.phase.value).toBe("verified");
    expect(h.signIn.process.value.state).toBe("exited");
    expect(h.checkCount()).toBe(1);
  });

  test("a check that resolves after the timeout cannot overwrite it", async () => {
    const gate = latch();
    const h = harness({
      checkGate: () => gate.wait,
      status: statusWith({ authLabel: "Cursor Pro" }),
    });
    await h.signIn.run();

    const checking = h.signIn.check();
    expect(h.signIn.phase.value).toBe("checking");

    // The main process's ten-minute cap lands while the probe is in flight.
    h.closed();
    expect(h.signIn.state.value).toEqual({ phase: "cancelled", reason: "timeout" });

    // The probe then resolves ready; it must not replace the timeout reason.
    gate.release();
    await checking;
    await settle();
    expect(h.signIn.state.value).toEqual({ phase: "cancelled", reason: "timeout" });
  });

  test("our own Stop stays the plain stop copy", async () => {
    const h = harness();
    await h.signIn.run();

    await h.signIn.stop();

    expect(h.signIn.state.value).toEqual({ phase: "cancelled", reason: "user" });
  });

  test("stop closes the PTY and cancels", async () => {
    const h = harness();
    await h.signIn.run();
    const terminalId = h.signIn.session.value!.terminalId;

    await h.signIn.stop();

    expect(h.signIn.phase.value).toBe("cancelled");
    expect(h.signIn.process.value.state).toBe("none");
    expect(h.signIn.session.value).toBeNull();
    expect(h.closes).toEqual([{ terminalId, deleteHistory: true }]);
  });

  test("dispose drops the PTY and its history", async () => {
    const h = harness();
    await h.signIn.run();
    const terminalId = h.signIn.session.value!.terminalId;

    await h.signIn.dispose();
    await h.signIn.dispose(); // idempotent

    expect(h.signIn.session.value).toBeNull();
    expect(h.closes).toEqual([{ terminalId, deleteHistory: true }]);
  });

  test("run again closes the old PTY before starting a new one", async () => {
    const h = harness();
    await h.signIn.run();
    const first = h.signIn.session.value?.terminalId;
    h.exit(1);
    expect(h.signIn.phase.value).toBe("failed");

    await h.signIn.run();
    const second = h.signIn.session.value?.terminalId;

    expect(second).not.toBe(first);
    expect(h.log).toEqual([`start:${first}`, `close:${first}`, `start:${second}`]);
    expect(h.signIn.phase.value).toBe("running");
  });

  test("close during the old PTY's close window spawns nothing", async () => {
    const gate = latch();
    const h = harness({ closeGate: () => gate.wait });
    await h.signIn.run();
    h.exit(1);

    // Run again claims the card, then waits on the tree-kill. Escape lands in
    // that window: the card is disposed before the new start is reached.
    const again = h.signIn.run();
    await h.signIn.dispose();
    gate.release();
    await again;

    expect(h.starts()).toBe(1);
    expect(h.signIn.session.value).toBeNull();
  });

  test("a double press on Run again starts one login", async () => {
    const gate = latch();
    const h = harness({ closeGate: () => gate.wait });
    await h.signIn.run();
    h.exit(1);

    const first = h.signIn.run();
    const second = h.signIn.run();
    gate.release();
    await Promise.all([first, second]);

    expect(h.starts()).toBe(2);
    expect(h.signIn.phase.value).toBe("running");
  });

  test("a terminal-finish provider waits on its first output", async () => {
    const h = harness({ finish: "terminal" });
    await h.signIn.run();

    h.output("Select a provider");

    expect(h.signIn.phase.value).toBe("waiting");
  });

  test("without a bridge, Run login fails (start) needing the desktop app", async () => {
    installDevBridge(null);
    const signIn = useSignInRun({ provider: "cursor", label: "Cursor" });

    await signIn.run();

    expect(signIn.phase.value).toBe("failed");
    expect(signIn.failure.value?.kind).toBe("start");
    expect(signIn.failure.value?.reason).toBe("Signing in needs the desktop app.");
  });

  test("a refused start reports the main process's sentence", async () => {
    const h = harness({ startMessage: "cursor-agent isn't on your PATH." });

    await h.signIn.run();

    expect(h.signIn.phase.value).toBe("failed");
    expect(h.signIn.failure.value?.kind).toBe("start");
    expect(h.signIn.failure.value?.reason).toBe("cursor-agent isn't on your PATH.");
    expect(h.signIn.session.value).toBeNull();
  });

  test("the predicates name the phases the card acts on", () => {
    expect(isRunActive({ phase: "starting" })).toBe(true);
    expect(isRunActive({ phase: "running" })).toBe(true);
    expect(isRunActive({ phase: "waiting" })).toBe(true);
    expect(isRunActive({ phase: "checking" })).toBe(true);
    expect(isRunActive({ phase: "idle" })).toBe(false);
    expect(isRunActive({ phase: "verified", status: statusWith({}) })).toBe(false);

    expect(isSettled({ phase: "verified", status: statusWith({}) })).toBe(true);
    expect(
      isSettled({ phase: "failed", failure: { kind: "check", reason: "Not yet." } }),
    ).toBe(true);
    expect(isSettled({ phase: "cancelled", reason: "timeout" })).toBe(true);
    expect(isSettled({ phase: "running" })).toBe(false);
  });
});

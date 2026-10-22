import { computed, ref } from "vue";
import type {
  KoneProviderSignInApi,
  ProviderKind,
  ProviderSignInCommand,
  ProviderStatus,
  TerminalEvent,
} from "~/types/desktop";
import { useTerminal, type TerminalSession } from "./useTerminal";
import { desktopBridge, needsDesktop } from "~/utils/desktopBridge";
import { peelIpcError } from "~/utils/ipcError";
import { PROVIDER_LOGIN } from "~/utils/providerLogin";

// The sign-in modal's state machine, kept apart from its markup so every
// transition can be tested without a DOM or a terminal.
//
// `state` is one discriminated union — what the card says, and everything that
// goes with saying it. `process` is tracked separately on purpose: a check that
// fails while the CLI is still waiting for the browser must keep offering Stop,
// so the phase alone can't answer "is it running?".
//
// The login itself is an ordinary kone PTY: `start` spawns it, output arrives
// on the normal terminal event stream, and closing it tree-kills the CLI. kone
// never sees the credential — it only re-reads provider health afterwards.

export type SignInPhase =
  | "idle"
  | "starting"
  | "running"
  | "waiting"
  | "checking"
  | "verified"
  | "failed"
  | "cancelled";

export type SignInFailureKind = "check" | "exit" | "start";

export type SignInFailure = {
  kind: SignInFailureKind;
  /** One plain sentence, already shaped for the status line. */
  reason: string;
  /** The CLI's exit code, for the `{bin} exited with code {n}` copy. */
  code?: number | null;
};

/** Why a cancelled run stopped. `user` is Stop or Ctrl+C; `timeout` is the main
 *  process's ten-minute cap, which reaches the renderer as a `closed` event. */
export type SignInCancelReason = "user" | "timeout";

export type SignInState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "running" }
  | { phase: "waiting" }
  | { phase: "checking" }
  | { phase: "verified"; status: ProviderStatus }
  | { phase: "failed"; failure: SignInFailure }
  | { phase: "cancelled"; reason: SignInCancelReason };

/** Phases where a login is under way or in flight: another Run press has to
 *  wait, and Stop/Cancel has something to kill. */
export function isRunActive(state: SignInState): boolean {
  switch (state.phase) {
    case "starting":
    case "running":
    case "waiting":
    case "checking":
      return true;
    default:
      return false;
  }
}

/** The phases that have an outcome to show and an action that starts over. */
export function isSettled(state: SignInState): boolean {
  switch (state.phase) {
    case "verified":
    case "failed":
    case "cancelled":
      return true;
    default:
      return false;
  }
}

export type SignInProcess =
  | { state: "none" }
  | { state: "live" }
  | { state: "exited"; code: number | null; signal: number | null };

export type UseSignInRunOptions = {
  provider: ProviderKind;
  /** The provider's display name, for the check-failure fallbacks. */
  label: string;
  /** Test seam, handed to the terminal registry: whether `import.meta.client`
   *  would be true there. Bun is neither server nor renderer, so a test that
   *  needs the registry's live event listener has to say so. */
  client?: boolean;
};

/** Longest check message the status line will carry before it is cut. */
const REASON_MAX = 140;

/** The status copy for a cancelled run, by why it stopped. The timeout wording
 *  is the only difference: Stop and Ctrl+C are something the user did, the cap
 *  is something that happened to them.
 *
 *  cancelled (user)    → "Sign-in stopped"
 *  cancelled (timeout) → "Sign-in stopped after 10 minutes"
 */

/** Sequences, but with the escapes removed — URL detection reads visible text,
 *  not the styling around it. */
function stripAnsi(text: string): string {
  // One pass for both families the CLIs emit: OSC (title/hyperlink) and CSI
  // (colour, underline).
  // oxlint-disable-next-line no-control-regex -- ANSI escapes are control characters by definition
  const escapes = /(?:\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~])/g;
  return text.replace(escapes, "");
}

export function useSignInRun(options: UseSignInRunOptions) {
  const provider = options.provider;
  const label = options.label;

  const state = ref<SignInState>({ phase: "idle" });
  const process = ref<SignInProcess>({ state: "none" });
  const command = ref<ProviderSignInCommand | null>(null);
  const copied = ref(false);

  // Read-only views of the union, for the card and for tests that only care
  // about the phase or about the failure it carries.
  const phase = computed(() => state.value.phase);
  const failure = computed<SignInFailure | null>(() =>
    state.value.phase === "failed" ? state.value.failure : null,
  );
  const status = computed<ProviderStatus | null>(() =>
    state.value.phase === "verified" ? state.value.status : null,
  );
  const active = computed(() => isRunActive(state.value));
  const settled = computed(() => isSettled(state.value));

  const display = computed(
    () => command.value?.display ?? PROVIDER_LOGIN[provider]?.display ?? "",
  );
  const bin = computed(() => display.value.split(/\s+/)[0] ?? display.value);
  /** How the CLI finishes, which decides both the lede and the waiting copy.
   *  The table already knows, so the first frame doesn't have to say "browser"
   *  for opencode's terminal menu. */
  const finish = computed(
    () => command.value?.finish ?? PROVIDER_LOGIN[provider]?.finish ?? "browser",
  );
  const live = computed(() => process.value.state === "live");

  // One registry for this modal's lifetime; the PTY is started through
  // `providerSignIn.start` below, but still gets useTerminal's buffer, attach
  // and close plumbing.
  const {
    sessions,
    spawn,
    write,
    resize,
    close,
  } = useTerminal({ cwd: () => command.value?.cwd ?? "~", client: options.client });

  const sessionKey = ref<string | null>(null);
  const session = computed<TerminalSession | null>(
    () => sessions.value.find((s) => s.key === sessionKey.value) ?? null,
  );

  const signInApi = (): KoneProviderSignInApi | undefined => desktopBridge()?.providerSignIn;

  // ── run bookkeeping ───────────────────────────────────────────────────────
  // A token per run and per check: a late event or a slow check from a run the
  // user already ended must not move the card. `detach` holds the PTY event
  // subscription for the current run.
  let runToken = 0;
  let checkToken = 0;
  let detach: (() => void) | null = null;
  /** The main-generated PTY id for the run, known only after `start` resolves.
   *  Events that arrive before then are buffered, then drained in the same
   *  synchronous step the registry adopts the id, so none falls between. */
  let ptyId: string | null = null;
  /** Events received while the start IPC was resolving. Small + short-lived:
   *  only the id is missing; the buffer is dropped as soon as it is known. */
  let earlyEvents: TerminalEvent[] = [];
  let earlyOutputBytes = 0;
  /** Visible output of this run, ANSI-stripped and capped, for URL detection. */
  let seen = "";
  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /** Exit 0 landed while the start IPC was still resolving. Its check was
   *  refused ("starting"), so the settled start runs it instead of walking the
   *  card back to "running" over a dead PTY. */
  let exitAwaitsStart = false;

  function handleEvent(event: TerminalEvent): void {
    if (event.type === "output") {
      observe(event.data);
    } else if (event.type === "exited") {
      onExit(event.exitCode ?? null, event.signal ?? null);
    } else if (event.type === "closed") {
      onClosed();
    }
  }

  /** Hold events until `start` tells us the main-generated id. Only the id is
   *  missing, so the window is short; output is capped and control events are
   *  always kept, because an early `exited` is exactly what the state machine
   *  must not miss. */
  function bufferEarly(event: TerminalEvent): void {
    earlyEvents.push(event);
    if (event.type === "output") earlyOutputBytes += event.data.length;
    while (earlyOutputBytes > 64 * 1024) {
      const index = earlyEvents.findIndex((candidate) => candidate.type === "output");
      if (index < 0) break;
      const [dropped] = earlyEvents.splice(index, 1);
      if (dropped?.type === "output") earlyOutputBytes -= dropped.data.length;
    }
  }

  /** Drain the events held while the main-generated id was unknown. */
  function takeEarly(): TerminalEvent[] {
    const events = earlyEvents;
    earlyEvents = [];
    earlyOutputBytes = 0;
    return events;
  }

  /** Feed held events for `id` to the state machine, once each. The opener's
   *  drain is the only caller, and it empties the buffer as it runs. */
  function observeEarly(id: string, events: TerminalEvent[]): void {
    for (const event of events) {
      if (event.terminalId === id) handleEvent(event);
    }
  }

  function attachPty(token: number): void {
    const api = desktopBridge()?.terminal;
    if (!api) return;
    earlyEvents = [];
    earlyOutputBytes = 0;
    detach = api.onEvent((event) => {
      if (token !== runToken) return;
      if (ptyId === null) {
        bufferEarly(event);
        return;
      }
      if (event.terminalId !== ptyId) return;
      handleEvent(event);
    });
  }

  function observe(data: string): void {
    const at = state.value.phase;
    if (at !== "starting" && at !== "running") return;
    // Terminal-finish providers (opencode's provider menu) never print a URL;
    // their first output is already the prompt waiting for an answer.
    if (finish.value === "terminal") {
      state.value = { phase: "waiting" };
      return;
    }
    seen = (seen + stripAnsi(data)).slice(-4096);
    if (/https?:\/\/\S+/.test(seen)) state.value = { phase: "waiting" };
  }

  function onExit(code: number | null, signal: number | null): void {
    process.value = { state: "exited", code, signal };
    detach?.();
    detach = null;
    // A check owns the card while it runs; an exit that lands under it must not
    // overwrite the check's outcome.
    if (!isRunActive(state.value) || state.value.phase === "checking") return;
    // Ctrl+C arrives as 130 on some CLIs and as a signal on others; both mean
    // the user stopped it, not that sign-in broke.
    if (signal != null || code === 130) {
      state.value = { phase: "cancelled", reason: "user" };
      return;
    }
    if (code === 0) {
      // `canCheck()` refuses a check while the start is still pending. Record
      // it and let `run()` fire the check once the PTY id is in hand; otherwise
      // the settled start would leave a dead process sitting on "running".
      if (state.value.phase === "starting") {
        exitAwaitsStart = true;
        return;
      }
      void check();
      return;
    }
    state.value = {
      phase: "failed",
      failure: {
        kind: "exit",
        reason: `${bin.value} exited with code ${code ?? "?"}`,
        code,
      },
    };
  }

  /** The main process closes a sign-in PTY it stopped itself — after ten
   *  minutes of running, or because its window went away. We detach before
   *  closing on purpose (`closePty`), so a `closed` reaching this listener is
   *  never the user's own Stop. */
  function onClosed(): void {
    if (process.value.state !== "live") return;
    process.value = { state: "none" };
    detach?.();
    detach = null;
    if (!isRunActive(state.value)) return;
    // An auth check may be in flight; its late result must not replace the
    // reason the run ended (the ten-minute message) with failed/verified.
    checkToken++;
    state.value = { phase: "cancelled", reason: "timeout" };
  }

  /** Collapse a provider's message to the one line the footer has room for. */
  function reasonFor(next: ProviderStatus): string {
    const name = next.label || label;
    // A needs-login status carries the CLI's own "run `… login`" advice, and
    // that is exactly what this card just did — repeating it under "Not signed
    // in yet" would read as if the login above never ran.
    if (next.readiness === "needs-login") return `${name} still reports no sign-in.`;
    const message = (next.message ?? "").replace(/\s+/g, " ").trim();
    if (message) {
      return message.length > REASON_MAX ? `${message.slice(0, REASON_MAX)}…` : message;
    }
    return `${name} isn't available right now.`;
  }

  function failCheck(reason: string): void {
    // Provider messages come from CLIs that mark commands with backticks; the
    // status line is plain prose, so the marks go — whichever path the reason
    // took to get here.
    state.value = {
      phase: "failed",
      failure: { kind: "check", reason: reason.replace(/`/g, "") },
    };
  }

  async function loadCommand(): Promise<void> {
    const api = signInApi();
    if (!api) return;
    try {
      command.value = await api.command(provider);
    } catch {
      // The command is copy, not a prerequisite: `run` asks for it again and
      // reports its own failure. A miss here only leaves the fallback label.
    }
  }

  /** Close the run's PTY (tree-kill, history dropped). Safe when there is none. */
  async function closePty(): Promise<void> {
    detach?.();
    detach = null;
    ptyId = null;
    earlyEvents = [];
    earlyOutputBytes = 0;
    seen = "";
    process.value = { state: "none" };
    const key = sessionKey.value;
    sessionKey.value = null;
    if (key) await close(key);
  }

  /** A check may start from any phase except these two: one is already in
   *  flight, and the other has no PTY id yet to keep. */
  function canCheck(): boolean {
    return state.value.phase !== "starting" && state.value.phase !== "checking";
  }

  /** Start (or restart) the login. Any earlier PTY is closed first, so a Run
   *  again never leaves the previous CLI alive behind the new one. */
  async function run(): Promise<void> {
    if (disposed || isRunActive(state.value)) return;

    // Claim the card before the first await. Closing the previous PTY can take
    // a second, and a second press in that window — or a Cancel — must not be
    // able to slip a fresh login in behind the old one.
    const token = ++runToken;
    checkToken++;
    state.value = { phase: "starting" };
    seen = "";
    exitAwaitsStart = false;
    await closePty();
    // Cancel/Escape during the close: the card is gone, so nothing may spawn.
    if (disposed || token !== runToken) return;

    process.value = { state: "live" };

    const api = signInApi();
    if (!api) {
      process.value = { state: "none" };
      state.value = {
        phase: "failed",
        failure: { kind: "start", reason: needsDesktop("Signing in") },
      };
      return;
    }

    const started = await spawn(async (provisionalId) => {
      // Subscribe before `start` so the first output chunk after the id is
      // known is seen. The id itself is minted in main and returned below; the
      // provisional one is sent only so the browser dev stand-in (which has no
      // main process) still has something to name its fake PTY.
      attachPty(token);
      const result = await api.start({ provider, terminalId: provisionalId });
      if (!result.ok) throw new Error(result.message);
      const terminalId = result.terminalId ?? provisionalId;
      command.value = result.command;
      // Nothing is drained here: an event landing after this returns would still
      // find `ptyId` unset and the registry without ownership, and would be lost
      // to the transcript. `spawn` calls `replay` in the same synchronous step
      // that adopts the id, so the handoff is atomic: this listener starts
      // handling the id directly, the registry owns every later event, and the
      // held ones go to the card here and back to the registry for the
      // transcript. A run the user already ended observes nothing.
      return {
        terminalId,
        snapshot: result.snapshot,
        replay: () => {
          if (disposed || token !== runToken) return [];
          ptyId = terminalId;
          const early = takeEarly();
          observeEarly(terminalId, early);
          return early;
        },
      };
    });
    if (disposed || token !== runToken) {
      // A newer run (or a close) took over while this one was spawning.
      await close(started.key);
      return;
    }
    sessionKey.value = started.key;

    if (started.error) {
      // A refused or rejecting start still leaves the shell's reason worth
      // showing verbatim; only a blank one falls back to the desktop note.
      const reason = peelIpcError(started.error, needsDesktop("Signing in"));
      await closePty();
      state.value = { phase: "failed", failure: { kind: "start", reason } };
      return;
    }

    // The opener's drain already adopted the id and handed the card everything
    // it had buffered, in the same step the registry took ownership. This only
    // covers a start that never reached that step; the error path returned
    // above and a superseded run returned before it.
    ptyId = started.terminalId;

    // The PTY may already have printed its URL while `start` was resolving;
    // never walk that back to "running".
    if (state.value.phase !== "starting") return;
    // An exit-0 that arrived before `start` resolved: the process is already
    // gone, so run the check it could not run then instead of showing Stop for
    // a dead CLI.
    if (exitAwaitsStart) {
      exitAwaitsStart = false;
      // Step out of "starting" first: `check()` refuses that phase, and the
      // check itself moves straight on to "checking".
      state.value = { phase: "running" };
      void check();
      return;
    }
    state.value = { phase: "running" };
  }

  /** Stop the login: close the PTY (tree-kill), then cancelled. */
  async function stop(): Promise<void> {
    if (!live.value) return;
    runToken++;
    // A check that was in flight must not land on top of the cancelled card.
    checkToken++;
    await closePty();
    state.value = { phase: "cancelled", reason: "user" };
  }

  /** Re-read this provider's auth state. Never touches the PTY, so it works
   *  while the CLI is still waiting for the browser. */
  async function check(): Promise<void> {
    if (disposed || !canCheck()) return;

    const token = ++checkToken;
    state.value = { phase: "checking" };
    const api = signInApi();
    if (!api) {
      failCheck(needsDesktop("Checking sign-in"));
      return;
    }

    try {
      const next = await api.check(provider);
      if (token !== checkToken || disposed) return;
      if (next.readiness === "ready") {
        state.value = { phase: "verified", status: next };
      } else {
        failCheck(reasonFor(next));
      }
    } catch (error) {
      if (token !== checkToken || disposed) return;
      failCheck(peelIpcError(error, `${label} isn't available right now.`));
    }
  }

  /** Put the login command on the clipboard — the fallback for a user who would
   *  rather run it themselves. */
  async function copy(): Promise<boolean> {
    if (typeof navigator === "undefined" || !navigator.clipboard) return false;
    try {
      await navigator.clipboard.writeText(display.value);
    } catch {
      return false;
    }
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied.value = false;
      copyTimer = null;
    }, 1_600);
    return true;
  }

  /** Drop everything on close or unmount: the CLI is tree-killed and its
   *  transcript goes with it. Idempotent. */
  async function dispose(): Promise<void> {
    disposed = true;
    runToken++;
    checkToken++;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = null;
    await closePty();
  }

  return {
    provider,
    label,
    state,
    phase,
    failure,
    process,
    command,
    status,
    copied,
    display,
    bin,
    finish,
    live,
    active,
    settled,
    session,
    loadCommand,
    run,
    stop,
    check,
    copy,
    dispose,
    // The PTY writer/resizer, for the terminal view bound in the modal.
    write,
    resize,
  };
}

export type SignInRun = ReturnType<typeof useSignInRun>;

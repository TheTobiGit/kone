// The dev-only stand-in for the in-app sign-in surface: a fake terminal
// registry and a scripted provider login, so `nuxt dev` in a browser can show
// the modal's whole state machine — the waiting beat, a failing check, an exit
// error, a missing CLI — without an Electron shell to spawn anything in.
//
// `localStorage["kone:signin-fixture"]` picks the outcome (spec §7):
// "verified" (the default) · "failed" · "exit-error" · "start-error". When the
// key is set, the demo providers report Cursor as needing sign-in until a
// check verifies it, which is what makes the entry points and the tray look
// right while shooting a screenshot. Nothing here is reachable from a
// production build: lib/devBridge is loaded behind `import.meta.dev`.

import type {
  KoneProviderSignInApi,
  KoneTerminalApi,
  ProviderKind,
  ProviderSignInCommand,
  ProviderSignInStart,
  ProviderStatus,
  TerminalEvent,
  TerminalSessionSnapshot,
  TerminalStatus,
} from "~/types/desktop";
import { PROVIDER_LOGIN } from "~/utils/providerLogin";
import { PROVIDER_LABEL } from "~/utils/usageProviders";
import { MOCK_STATUSES } from "./devProviders";

export type SignInFixture = "verified" | "failed" | "exit-error" | "start-error";

const FIXTURE_KEY = "kone:signin-fixture";

/** One place that accepts a stored value as a fixture, so the reads below can
 *  narrow instead of asserting. */
function isFixture(value: string | null): value is SignInFixture {
  return (
    value === "verified" ||
    value === "failed" ||
    value === "exit-error" ||
    value === "start-error"
  );
}

/** The scripted outcome. Absent or unrecognised reads as "verified" — the
 *  happy path is the one worth landing on by default. */
export function signInFixture(): SignInFixture {
  if (!import.meta.client) return "verified";
  try {
    const raw = localStorage.getItem(FIXTURE_KEY);
    return isFixture(raw) ? raw : "verified";
  } catch {
    return "verified";
  }
}

/** Whether a fixture was actually chosen, which is what makes the demo provider
 *  surface pretend Cursor needs a login. Without the key the ordinary demo
 *  world stays ready, so the modal is an opt-in review surface. */
function fixtureSet(): boolean {
  if (!import.meta.client) return false;
  try {
    return isFixture(localStorage.getItem(FIXTURE_KEY));
  } catch {
    return false;
  }
}

// ── a tiny in-memory PTY registry ───────────────────────────────────────────
// One map serves both the project strip's echo shells and the modal's sign-in
// login, exactly as TerminalManager serves every terminal in the shell. Events
// fan out to whichever composable subscribed, so useTerminal and the sign-in
// run see the same stream the main process would send.

type DevSignInPty = {
  provider: ProviderKind;
  live: boolean;
  timers: ReturnType<typeof setTimeout>[];
};

type DevShell = {
  sequence: number;
  cwd: string;
  cols: number;
  rows: number;
  status: TerminalStatus;
  exitCode: number | null;
  exitSignal: number | null;
  history: string;
  signIn: DevSignInPty | null;
};

const terminals = new Map<string, DevShell>();
const listeners = new Set<(event: TerminalEvent) => void>();

/** Set once a check verifies the scripted login, so the demo provider surface
 *  keeps reporting the provider as ready after the modal closes. */
let signedIn = false;

function emit(event: TerminalEvent): void {
  // A listener may unsubscribe itself while handling the event; deleting during
  // a Set walk is safe in JS.
  for (const listener of listeners) listener(event);
}

function snapshotOf(terminalId: string): TerminalSessionSnapshot {
  const shell = terminals.get(terminalId);
  return {
    terminalId,
    pid: 4242,
    cols: shell?.cols ?? 80,
    rows: shell?.rows ?? 24,
    cwd: shell?.cwd ?? "~",
    status: shell?.status ?? "ready",
    history: shell?.history ?? "",
    sequence: shell?.sequence ?? 0,
    exitCode: shell?.exitCode ?? null,
    exitSignal: shell?.exitSignal ?? null,
    hasRunningSubprocess: false,
    childCommandLabel: null,
  };
}

/** Append one chunk the way the manager does: history for a cold re-attach,
 *  plus a live `output` event. */
function output(terminalId: string, data: string): void {
  const shell = terminals.get(terminalId);
  if (!shell) return;
  shell.history += data;
  emit({ terminalId, type: "output", sequence: ++shell.sequence, data });
}

function clearTimers(pty: DevSignInPty): void {
  for (const timer of pty.timers) clearTimeout(timer);
  pty.timers.length = 0;
}

function finish(
  terminalId: string,
  shell: DevShell,
  exitCode: number | null,
  signal?: number,
): void {
  if (shell.signIn) {
    clearTimers(shell.signIn);
    shell.signIn.live = false;
  }
  shell.status = "exited";
  shell.exitCode = exitCode;
  shell.exitSignal = signal ?? null;
  emit({ terminalId, type: "exited", sequence: ++shell.sequence, exitCode, signal });
}

// ── the terminal API ────────────────────────────────────────────────────────

export function createDevTerminal(): KoneTerminalApi {
  return {
    open: (input) => {
      terminals.set(input.terminalId, {
        sequence: 0,
        cwd: input.cwd,
        cols: input.cols ?? 80,
        rows: input.rows ?? 24,
        status: "ready",
        exitCode: null,
        exitSignal: null,
        history: "kone terminal (dev mock)\r\n$ ",
        signIn: null,
      });
      return Promise.resolve(snapshotOf(input.terminalId));
    },
    write: ({ terminalId, data }) => {
      const shell = terminals.get(terminalId);
      if (!shell) return Promise.resolve();
      if (shell.signIn) {
        // Ctrl+C is the CLI's own cancel: echo it and exit by signal, which is
        // what makes the modal land on "cancelled".
        if (data.includes("\x03") && shell.signIn.live) {
          output(terminalId, "^C\r\n");
          finish(terminalId, shell, null, 2);
        }
        return Promise.resolve();
      }
      output(terminalId, data === "\r" ? "\r\n$ " : data);
      return Promise.resolve();
    },
    resize: ({ terminalId, cols, rows }) => {
      const shell = terminals.get(terminalId);
      if (shell) {
        shell.cols = cols;
        shell.rows = rows;
      }
      return Promise.resolve();
    },
    close: ({ terminalId }) => {
      const shell = terminals.get(terminalId);
      if (!shell) return Promise.resolve();
      if (shell.signIn) clearTimers(shell.signIn);
      shell.status = "closed";
      emit({ terminalId, type: "closed", sequence: ++shell.sequence });
      terminals.delete(terminalId);
      return Promise.resolve();
    },
    restart: ({ terminalId }) => {
      const shell = terminals.get(terminalId);
      if (shell) {
        shell.history = "kone terminal (dev mock)\r\n$ ";
        shell.status = "ready";
        shell.exitCode = null;
        shell.exitSignal = null;
        emit({ terminalId, type: "restarted", sequence: ++shell.sequence, snapshot: snapshotOf(terminalId) });
      }
      return Promise.resolve(snapshotOf(terminalId));
    },
    ack: () => Promise.resolve(),
    onEvent: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

// ── the scripted provider login ─────────────────────────────────────────────

const LOGIN_URL =
  "https://cursor.com/loginDeepControl?challenge=Q2xh…&mode=login";

/** The command the real bridge would resolve for this provider, from the one
 *  renderer login table. Null for a CLI with no login subcommand (Droid). */
function commandFor(provider: ProviderKind): ProviderSignInCommand | null {
  const login = PROVIDER_LOGIN[provider];
  if (!login) return null;
  return {
    provider,
    display: login.display,
    cwd: "~",
    finish: login.finish,
  };
}

function readyStatus(provider: ProviderKind): ProviderStatus {
  const base = MOCK_STATUSES.find((s) => s.provider === provider);
  return {
    ...(base ?? { provider, label: PROVIDER_LABEL[provider], available: true }),
    readiness: "ready",
    authStatus: "authenticated",
    available: true,
  };
}

function needsLoginStatus(provider: ProviderKind): ProviderStatus {
  const login = PROVIDER_LOGIN[provider];
  return {
    provider,
    label: PROVIDER_LABEL[provider],
    available: true,
    authStatus: "unauthenticated",
    readiness: "needs-login",
    // Cursor's own words (adapters/CursorAdapter.ts), so the demo's needs-login
    // row reads exactly like the real one.
    message: login
      ? `Run \`${login.display}\` to sign in.`
      : `${PROVIDER_LABEL[provider]} signs in on its first run.`,
  };
}

/** The demo provider surface. With a fixture chosen it reports Cursor as
 *  needing sign-in until a check verifies it; otherwise it is the ordinary
 *  ready demo world. */
export function devProviderStatuses(): ProviderStatus[] {
  if (!fixtureSet() || signedIn) return MOCK_STATUSES;
  return MOCK_STATUSES.map((status) =>
    status.provider === "cursor" ? needsLoginStatus("cursor") : status,
  );
}

export function createDevProviderSignIn(
  onProviderChanged: () => void = () => {},
): KoneProviderSignInApi {
  return {
    command: (provider) => Promise.resolve(commandFor(provider)),
    start: (input): Promise<ProviderSignInStart> => {
      const command = commandFor(input.provider);
      // Mirrors the real launch: a CLI with no login subcommand is a returned
      // sentence with no command, never a throw.
      if (!command) {
        return Promise.resolve({
          ok: false,
          command: null,
          message: `${PROVIDER_LABEL[input.provider]} signs in on its first run — it has no login command.`,
        });
      }
      const fixture = signInFixture();
      if (fixture === "start-error") {
        return Promise.resolve({
          ok: false,
          command,
          message: `${command.display.split(/\s+/)[0]} isn't on your PATH.`,
        });
      }

      const pty: DevSignInPty = { provider: input.provider, live: true, timers: [] };
      terminals.set(input.terminalId, {
        sequence: 0,
        cwd: command.cwd,
        cols: input.cols ?? 80,
        rows: input.rows ?? 24,
        status: "ready",
        exitCode: null,
        exitSignal: null,
        history: "",
        signIn: pty,
      });

      // Delays, not instants: the modal's starting → running → waiting beats
      // are what the screenshots are for, and each one needs a frame on screen.
      // The first line lands late enough that "running" is still on screen when
      // the preview has already gone.
      const at = (ms: number, line: string): void => {
        pty.timers.push(setTimeout(() => output(input.terminalId, line), ms));
      };
      at(400, `\x1b[2m${command.cwd}\x1b[0m\r\n\x1b[32m❯\x1b[0m ${command.display}\r\n\r\n`);
      at(1_200, "Starting login process...\r\n\r\n");
      at(2_400, `Open this URL in your browser to sign in:\r\n  \x1b[4;36m${LOGIN_URL}\x1b[0m\r\n\r\n`);
      at(
        3_000,
        "Waiting for browser authentication \x1b[2m(press Ctrl+C to cancel)\x1b[0m…\r\n",
      );
      if (fixture === "exit-error") {
        pty.timers.push(
          setTimeout(() => {
            output(input.terminalId, "\r\nerror: login request expired\r\n");
            const shell = terminals.get(input.terminalId);
            if (shell) finish(input.terminalId, shell, 1);
          }, 4_200),
        );
      }

      return Promise.resolve({ ok: true, command, snapshot: snapshotOf(input.terminalId) });
    },
    check: async (provider) => {
      // A real check shells out to the CLI and waits for its answer; the beat
      // is the whole point of the "Checking with Cursor…" copy.
      await new Promise((resolve) => setTimeout(resolve, 900));
      if (signInFixture() !== "verified") {
        // A failed/exit-error/start-error fixture has nothing to verify: the
        // check keeps telling the truth, so the modal lands on failed(check).
        return Promise.resolve(needsLoginStatus(provider));
      }
      signedIn = true;
      // While the login is still live, the CLI's own confirmation appears in
      // the transcript the moment kone re-reads its health — the beat the
      // verified screenshots are taken on.
      for (const [terminalId, shell] of terminals) {
        if (shell.signIn?.provider !== provider || !shell.signIn.live) continue;
        output(
          terminalId,
          "\r\n\x1b[32m✓\x1b[0m Logged in as \x1b[1ma.sarfo@…\x1b[0m (Cursor Pro)\r\n",
        );
      }
      onProviderChanged();
      return Promise.resolve(readyStatus(provider));
    },
  };
}

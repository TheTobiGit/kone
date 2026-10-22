import { randomUUID } from "node:crypto";

import type { AgentService } from "@kone/agent-core/AgentService.js";
import {
  ProviderSignInStartInputSchema,
  resolveProviderSignInCommand,
  resolveProviderSignInLaunch,
  type ProviderSignInCommand,
  type ProviderSignInStartInput,
} from "@kone/agent-core/providerSignIn.js";
import { buildAgentEnv } from "@kone/agent-core/processEnv.js";
import type { ProviderKind } from "@kone/agent-core/types.js";
import type { TerminalManager } from "../modules/terminal/TerminalManager.js";
import type { TerminalSessionSnapshot } from "../modules/terminal/index.js";
import {
  claimTerminal,
  onTerminalReleased,
  releaseTerminal,
} from "../modules/terminal/ownership.js";

// ── In-app provider sign-in: main-process controller ────────────────────────
// The renderer asks for a provider, never a command: the login subcommand comes
// from agent-core/providerSignIn.ts and the executable from the user's
// ProviderConfig.binaryPath. The login runs in an ordinary kone PTY, so
// output/write/resize/close all flow through the normal terminal:* channels. No
// credential crosses this boundary in either direction — the CLI writes its own
// login and `check` only re-probes health.
//
// A login is a modal with a lifetime, so each request owns its PTY id, its
// sender watchers, its timeout and its claim in the terminal ownership registry
// (ownership.ts). Every way it can end — timeout, navigation, window destroyed,
// the CLI exiting, a refused spawn — goes through the same `release`, which
// detaches exactly what the request installed.
//
// This module deliberately imports no Electron: ipc.ts-facing registration and
// the WebContents type live in providerSignInIpc.ts, so the whole lifecycle is
// testable with fake senders under `bun test`.

/** The outcome of provider-signin:start. A failure is data, not a rejection:
 *  the missing binary is the expected case. Mirrors the renderer contract in
 *  apps/web/app/types/desktop.d.ts. */
export type ProviderSignInStart =
  | {
      ok: true;
      /** Main-generated PTY id. The renderer attaches to this; it is never
       *  taken from renderer input. */
      terminalId: string;
      command: ProviderSignInCommand;
      snapshot: TerminalSessionSnapshot;
    }
  | {
      ok: false;
      /** Null when this provider has no login subcommand at all (Droid). */
      command: ProviderSignInCommand | null;
      message: string;
    };

/** ms — a sign-in PTY is a modal, not a workspace. Ten minutes is generous for
 *  a browser round-trip; after that the session is closed so a forgotten login
 *  can't hold a PTY forever. */
const PROVIDER_SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/** The sentence a request that lost its window gets. The renderer is usually
 *  gone by the time this resolves; it exists for the queued/aborted case the
 *  test harness and a same-window retry can still see. */
const WENT_AWAY = "The window that asked to sign in went away.";

/** The main-frame navigation details Electron hands the first listener arg.
 *  Only the two flags matter here. */
export type SignInNavigationDetails = {
  isMainFrame: boolean;
  isSameDocument: boolean;
};

/** The slice of a renderer's WebContents a login needs: its identity and the
 *  two lifecycle events that end a run. Structural, so tests pass a fake. */
export type SignInSender = {
  isDestroyed(): boolean;
  on(
    event: "did-start-navigation",
    listener: (details: SignInNavigationDetails) => void,
  ): void;
  off(
    event: "did-start-navigation",
    listener: (details: SignInNavigationDetails) => void,
  ): void;
  once(event: "destroyed", listener: () => void): void;
  off(event: "destroyed", listener: () => void): void;
};

/** The terminal-manager surface a login uses. */
export type SignInTerminalManager = Pick<
  TerminalManager,
  "openCommand" | "close" | "onSessionEnded"
>;

export type ProviderSignInControllerOptions = {
  manager: SignInTerminalManager;
  svc: Pick<AgentService, "getProviderSettings" | "checkProvider">;
  /** Test seam: the base env the login resolves against. */
  buildEnv?: () => Promise<NodeJS.ProcessEnv>;
  /** Test seam: the main-generated terminal id. Defaults to `signin-<uuid>`. */
  terminalIdFactory?: () => string;
};

/** One accepted login request. It owns the PTY id, the sender watchers, the
 *  timeout and the terminal-ownership claim from the moment the IPC request is
 *  accepted — before it waits in the per-provider queue. */
class SignInRun {
  readonly provider: ProviderKind;
  readonly terminalId: string;
  readonly sender: SignInSender;
  /** This run's ownership token; release is a no-op unless it still matches. */
  readonly token: string;
  private readonly manager: SignInTerminalManager;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly detachers: Array<() => void> = [];
  private released = false;
  /** The sender navigated to a new document (reload) or was destroyed. */
  private gone = false;
  /** Set once the PTY exists: a later reload must tree-kill it immediately
   *  rather than leaving an unread login running to its timeout. */
  private spawned = false;
  private abort: (() => void) | null = null;

  constructor(input: {
    provider: ProviderKind;
    terminalId: string;
    token: string;
    sender: SignInSender;
    manager: SignInTerminalManager;
  }) {
    this.provider = input.provider;
    this.terminalId = input.terminalId;
    this.token = input.token;
    this.sender = input.sender;
    this.manager = input.manager;
    // The claim is already reserved by `start`, before this run existed; the
    // constructor only owns the sender watchers.

    if (this.sender.isDestroyed()) {
      this.gone = true;
      return;
    }
    // A renderer reload does not destroy its webContents, so "destroyed" alone
    // never fires for one: the PTY (and the browser tab it opened) would
    // survive until the ten-minute timeout, with nobody left to read it. Any
    // main-frame navigation that starts a new document is that reload — a
    // same-document one (hash change, history) is not.
    const onNavigation = (details: SignInNavigationDetails): void => {
      if (!details.isMainFrame || details.isSameDocument) return;
      this.markGone();
    };
    const onDestroyed = (): void => {
      this.markGone();
    };
    this.sender.on("did-start-navigation", onNavigation);
    this.sender.once("destroyed", onDestroyed);
    this.detachers.push(() => this.sender.off("did-start-navigation", onNavigation));
    // `off` works for a `once` listener too, and is harmless if `destroyed`
    // already fired — this is what stops ten sign-ins leaving ten listeners.
    this.detachers.push(() => this.sender.off("destroyed", onDestroyed));
  }

  /** The document went away. If the PTY already exists, end it now; the
   *  controller owns that decision (and the runs map) through `abort`. */
  private markGone(): void {
    if (this.gone) return;
    this.gone = true;
    if (this.spawned) this.abort?.();
  }

  /** Let the controller end this run (kill the PTY) the moment its document
   *  goes away after the spawn. */
  watchAbort(handler: () => void): void {
    this.abort = handler;
  }

  /** Called once the PTY was created successfully. A reload that landed during
   *  the spawn is honoured here, before the run is tracked as live. */
  markSpawned(): void {
    this.spawned = true;
    if (this.gone) this.abort?.();
  }

  /** True once the requesting document is gone; checked before every spawn. */
  get cancelled(): boolean {
    return this.gone || this.sender.isDestroyed();
  }

  /** Arm the run's ten-minute cap. One timer per run, cleared by `release`. */
  armTimeout(onTimeout: () => void): void {
    this.timer = setTimeout(onTimeout, PROVIDER_SIGN_IN_TIMEOUT_MS);
  }

  /** End the run once. `kill` closes the PTY (timeout, navigation, destroyed,
   *  replacement); `kill: false` is for a session that already ended on its own
   *  or never spawned, where the work left is detaching the watchers.
   *
   *  `keepClaim` leaves the terminal-ownership claim in place after a session
   *  that DID spawn ends naturally: the exited terminal (and its in-memory
   *  transcript) still belongs to its window until that window closes it. A
   *  refused or never-spawned request has nothing to protect and drops it. */
  release({ kill, keepClaim = false }: { kill: boolean; keepClaim?: boolean }): void {
    if (this.released) return;
    this.released = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const detach of this.detachers.splice(0)) detach();
    if (!kill) {
      if (!keepClaim) {
        releaseTerminal(this.terminalId, this.token);
        return;
      }
      // The session is gone but its transcript stays private to this window.
      // One self-removing watcher releases the claim when that window dies; a
      // normal close releases it through the terminal IPC path instead. The
      // claim owns the watcher's detach, so whichever path releases first
      // leaves no `destroyed` listener (and this run) behind on the sender.
      if (this.sender.isDestroyed()) {
        releaseTerminal(this.terminalId, this.token);
        return;
      }
      const onDestroyed = (): void => releaseTerminal(this.terminalId, this.token);
      const watchesClaim = onTerminalReleased(this.terminalId, this.token, () =>
        this.sender.off("destroyed", onDestroyed),
      );
      // The claim was released while this run waited in the queue, so there is
      // nothing left for the watcher to guard.
      if (!watchesClaim) return;
      this.sender.once("destroyed", onDestroyed);
      return;
    }
    void this.manager
      .close({ terminalId: this.terminalId, deleteHistory: true })
      .catch(() => {
        // The session may already have exited; closing is idempotent.
      })
      .finally(() => {
        // Keep the claim until the close (and its `closed` event) has settled,
        // so the transcript's last event still goes only to its window.
        releaseTerminal(this.terminalId, this.token);
      });
  }
}

/** The controller surface the IPC adapter registers. */
export type ProviderSignInController = {
  start: (raw: ProviderSignInStartInput, sender: SignInSender) => Promise<ProviderSignInStart>;
};

/** Build the provider-signin controller. `start` is the IPC boundary's one
 *  entry point; command/check are plain service reads the adapter wires. */
export function createProviderSignInController(
  options: ProviderSignInControllerOptions,
): ProviderSignInController {
  const { manager, svc } = options;
  const buildEnv = options.buildEnv ?? (() => buildAgentEnv());
  /** The main process owns sign-in ids. Renderer input cannot name one. */
  const newTerminalId = options.terminalIdFactory ?? (() => `signin-${randomUUID()}`);

  /** The one live run per provider — a second "Sign in" replaces the first. */
  const runs = new Map<ProviderKind, SignInRun>();
  /** Start calls per provider, chained. A start awaits the agent env and the
   *  spawn, so without this two starts could both get past "release the old
   *  run" before either one tracked itself, and the first would kill the
   *  second's PTY. */
  const starts = new Map<ProviderKind, Promise<void>>();

  /** End `run` and forget it if it is still the provider's current run. */
  const releaseRun = (
    run: SignInRun,
    { kill, keepClaim = false }: { kill: boolean; keepClaim?: boolean },
  ): void => {
    if (runs.get(run.provider) === run) runs.delete(run.provider);
    run.release({ kill, keepClaim });
  };

  /** Release the tracked run only if it is still the one for `terminalId`.
   *  That id check is what keeps a stale timeout or a navigation from a
   *  previous login from closing the newer login's PTY. */
  const releaseTracked = (provider: ProviderKind, terminalId: string): void => {
    const run = runs.get(provider);
    if (run?.terminalId !== terminalId) return;
    releaseRun(run, { kill: true });
  };

  // A login that ends on its own (the CLI exits) must drop its timer and
  // watchers, so a later sign-in doesn't inherit either. The session is already
  // gone, so this releases without killing — but keeps the ownership claim
  // until the window closes the terminal, so its transcript stays private even
  // after the process exits.
  manager.onSessionEnded((terminalId) => {
    for (const run of runs.values()) {
      if (run.terminalId !== terminalId) continue;
      releaseRun(run, { kill: false, keepClaim: true });
    }
  });

  const commandFor = (provider: ProviderKind): ProviderSignInCommand | null =>
    resolveProviderSignInCommand(provider, svc.getProviderSettings());

  /** The accepted request's run, or the reason it cannot launch. */
  const launchRun = async (
    run: SignInRun,
    input: ProviderSignInStartInput,
  ): Promise<ProviderSignInStart> => {
    const fail = (command: ProviderSignInCommand | null, message: string): ProviderSignInStart => {
      run.release({ kill: false });
      return { ok: false, command, message };
    };

    // Queued behind another start and cancelled (reload/destroy) while it
    // waited: never spawn, and never disturb the run that is currently live.
    if (run.cancelled) return fail(commandFor(run.provider), WENT_AWAY);

    // One live login per provider: a second "Sign in" replaces the first
    // instead of leaving an orphaned PTY behind the modal. This happens only
    // once this request is known to still want a login.
    const previousRun = runs.get(run.provider);
    if (previousRun) releaseRun(previousRun, { kill: true });

    const env = await buildEnv();
    if (run.cancelled) return fail(commandFor(run.provider), WENT_AWAY);
    const launch = resolveProviderSignInLaunch({
      provider: run.provider,
      settings: svc.getProviderSettings(),
      env,
    });
    if (!launch.ok) return fail(launch.command, launch.message);

    // Last check immediately before the spawn: the document may have gone
    // away during the env read above.
    if (run.cancelled) return fail(launch.command, WENT_AWAY);

    try {
      const snapshot = await manager.openCommand(
        {
          terminalId: run.terminalId,
          cwd: launch.cwd,
          cols: input.cols,
          rows: input.rows,
          env: launch.env,
        },
        {
          command: { file: launch.file, args: launch.args },
          banner: launch.banner,
          // `launch.env` is already the complete, sanitized login env. Let it
          // replace the inherited base instead of merging back what sign-in
          // deliberately removed (BROWSER/NO_BROWSER, runtime blocklist).
          completeEnv: true,
        },
      );
      if (run.cancelled) {
        run.release({ kill: true });
        return { ok: false, command: launch.command, message: WENT_AWAY };
      }
      run.markSpawned();
      run.armTimeout(() => releaseTracked(run.provider, run.terminalId));
      // Release again after the awaits: the early release above can be stale by
      // the time the spawn resolves, and tracking over a live run would strand
      // its PTY and its timer.
      const tracked = runs.get(run.provider);
      if (tracked) releaseRun(tracked, { kill: true });
      runs.set(run.provider, run);
      return {
        ok: true,
        terminalId: run.terminalId,
        command: launch.command,
        snapshot,
      };
    } catch (error) {
      // Nothing was spawned (a refused id, a spawn failure), so this only
      // detaches the watchers and the claim.
      run.release({ kill: false });
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        command: launch.command,
        message: `Couldn't start ${launch.command.display}: ${message}`,
      };
    }
  };

  const start = (raw: ProviderSignInStartInput, sender: SignInSender): Promise<ProviderSignInStart> => {
    const input = ProviderSignInStartInputSchema.parse(raw);

    // A destroyed sender can never receive the result; reject before claiming
    // an id or installing listeners.
    if (sender.isDestroyed()) {
      return Promise.resolve({
        ok: false,
        command: commandFor(input.provider),
        message: WENT_AWAY,
      });
    }

    // Accept the request now: reserve a main-generated id under this run's own
    // token, then install navigation/destroy watchers BEFORE it waits in the
    // per-provider queue, so a reload during that wait cancels it instead of
    // launching an unattended login later.
    //
    // A conflicting reservation is refused here, before any run, watcher,
    // spawn or kill exists. The existing claim is left exactly as it was.
    const terminalId = newTerminalId();
    const token = randomUUID();
    if (!claimTerminal(terminalId, sender, token)) {
      return Promise.resolve({
        ok: false,
        command: commandFor(input.provider),
        message: "That sign-in terminal is already in use.",
      });
    }
    const run = new SignInRun({
      provider: input.provider,
      terminalId,
      token,
      sender,
      manager,
    });
    // A reload after the spawn kills that PTY now, not at the ten-minute cap.
    run.watchAbort(() => releaseRun(run, { kill: true }));
    const previous = starts.get(input.provider) ?? Promise.resolve();
    const next = previous.then(
      () => launchRun(run, input),
      () => launchRun(run, input),
    );
    starts.set(
      input.provider,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  };

  return { start };
}

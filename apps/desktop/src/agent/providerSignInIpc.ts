import { ipcMain, type WebContents } from "electron";

import type { AgentService } from "@kone/agent-core/AgentService.js";
import {
  ProviderSignInStartInputSchema,
  resolveProviderSignInCommand,
  resolveProviderSignInLaunch,
  type ProviderSignInCommand,
  type ProviderSignInStartInput,
} from "@kone/agent-core/providerSignIn.js";
import { ProviderKindSchema } from "@kone/agent-core/types.js";
import type { ProviderKind, ProviderStatus } from "@kone/agent-core/types.js";
import { buildAgentEnv } from "@kone/agent-core/processEnv.js";
import { getTerminalManager } from "../modules/terminal/index.js";
import type { TerminalSessionSnapshot } from "../modules/terminal/index.js";

// ── In-app provider sign-in IPC ──────────────────────────────────────────────
// The renderer asks for a provider, never a command: the login subcommand comes
// from agent-core/providerSignIn.ts and the executable from the user's
// ProviderConfig.binaryPath. The login runs in an ordinary kone PTY, so
// output/write/resize/close all flow through the normal terminal:* channels. No
// credential crosses this boundary in either direction — the CLI writes its own
// login and `check` only re-probes health.
//
// A login is a modal with a lifetime, so each run is an object that owns its
// PTY id, its timeout and its renderer watchers. Every way a run can end —
// timeout, navigation, window destroyed, the CLI exiting — goes through the
// same `release`, which detaches exactly what the run installed.

/** ms — a sign-in PTY is a modal, not a workspace. Ten minutes is generous for
 *  a browser round-trip; after that the session is closed so a forgotten login
 *  can't hold a PTY forever. */
const PROVIDER_SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/** The outcome of provider-signin:start. A failure is data, not a rejection:
 *  the missing binary is the expected case. Mirrors the renderer contract in
 *  apps/web/app/types/desktop.d.ts. */
export type ProviderSignInStart =
  | { ok: true; command: ProviderSignInCommand; snapshot: TerminalSessionSnapshot }
  | {
      ok: false;
      /** Null when this provider has no login subcommand at all (Droid). */
      command: ProviderSignInCommand | null;
      message: string;
    };

/** The preload bridge for in-app provider sign-in. */
export type KoneProviderSignInApi = {
  command: (provider: ProviderKind) => Promise<ProviderSignInCommand | null>;
  start: (input: ProviderSignInStartInput) => Promise<ProviderSignInStart>;
  check: (provider: ProviderKind) => Promise<ProviderStatus>;
};

/** One live login. It owns the id of the PTY it spawned, its timeout and the
 *  sender watchers that end it, so releasing is a single idempotent step no
 *  matter which exit path got there first. */
class SignInRun {
  readonly provider: ProviderKind;
  readonly terminalId: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly detachers: Array<() => void> = [];
  private released = false;

  constructor(provider: ProviderKind, terminalId: string) {
    this.provider = provider;
    this.terminalId = terminalId;
  }

  /** Have `release` detach a sender listener installed for this run. */
  trackDetacher(detach: () => void): void {
    this.detachers.push(detach);
  }

  /** Arm the run's ten-minute cap. One timer per run, cleared by `release`. */
  armTimeout(onTimeout: () => void): void {
    this.timer = setTimeout(onTimeout, PROVIDER_SIGN_IN_TIMEOUT_MS);
  }

  /** End the run once. `kill` closes the PTY (timeout, navigation, destroyed);
   *  `kill: false` is for a session that already ended on its own, where the
   *  only work left is detaching the watchers. */
  release({ kill }: { kill: boolean }): void {
    if (this.released) return;
    this.released = true;
    if (this.timer !== null) clearTimeout(this.timer);
    for (const detach of this.detachers.splice(0)) detach();
    if (!kill) return;
    void getTerminalManager()
      .close({ terminalId: this.terminalId, deleteHistory: true })
      .catch(() => {
        // The session may already have exited; closing is idempotent.
      });
  }
}

/** Register the provider-signin:* IPC handlers. Call once, with the live
 *  AgentService, from registerAgentIpc. */
export function registerProviderSignInIpc(svc: AgentService): void {
  /** The one live run per provider — a second "Sign in" replaces the first. */
  const runs = new Map<ProviderKind, SignInRun>();
  /** Start calls per provider, chained. A start awaits the agent env and the
   *  spawn, so without this two starts could both get past "release the old
   *  run" before either one tracked itself, and the first would kill the
   *  second's PTY. */
  const starts = new Map<ProviderKind, Promise<void>>();

  /** End `run` and forget it if it is still the provider's current run. */
  const releaseRun = (run: SignInRun, { kill }: { kill: boolean }): void => {
    if (runs.get(run.provider) === run) runs.delete(run.provider);
    run.release({ kill });
  };

  /** Release the tracked run only if it is still the one for `terminalId`.
   *  That id check is what keeps a stale timeout or a navigation from a
   *  previous login from closing the newer login's PTY. */
  const releaseTracked = (provider: ProviderKind, terminalId: string): void => {
    const run = runs.get(provider);
    if (run?.terminalId !== terminalId) return;
    releaseRun(run, { kill: true });
  };

  // A login that ends on its own (the CLI exits) must drop its timer and its
  // watchers, so a later sign-in doesn't inherit either. The session is already
  // gone, so this releases without killing.
  getTerminalManager().onSessionEnded((terminalId) => {
    for (const run of runs.values()) {
      if (run.terminalId !== terminalId) continue;
      releaseRun(run, { kill: false });
    }
  });

  const launchRun = async (
    provider: ProviderKind,
    input: ProviderSignInStartInput,
    sender: WebContents,
  ): Promise<ProviderSignInStart> => {
    // One live login per provider: a second "Sign in" replaces the first
    // instead of leaving an orphaned PTY behind the modal.
    const previousRun = runs.get(provider);
    if (previousRun) releaseRun(previousRun, { kill: true });

    // Watchers go on BEFORE the first await (the agent env read, then the
    // spawn). A renderer that reloads or is destroyed while the PTY is still
    // being created must not leave a login behind for the full timeout with
    // nobody to read it. If it already went away by the time the spawn
    // resolves, `gone` ends the run immediately.
    const run = new SignInRun(provider, input.terminalId);
    let spawned = false;
    let gone = false;
    const onGone = (): void => {
      gone = true;
      if (spawned) releaseRun(run, { kill: true });
    };
    // A renderer reload does not destroy its webContents, so "destroyed" below
    // never fires for one: the PTY (and the browser tab it opened) would
    // survive until the ten-minute timeout, with nobody left to read it. Any
    // main-frame navigation that starts a new document is that reload — a
    // same-document one (hash change, history) is not.
    const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
      if (!details.isMainFrame || details.isSameDocument) return;
      onGone();
    };
    sender.on("did-start-navigation", onNavigation);
    sender.once("destroyed", onGone);
    run.trackDetacher(() => sender.off("did-start-navigation", onNavigation));
    // `off` works for a `once` listener too, and is harmless if `destroyed`
    // already fired — this is what stops ten sign-ins leaving ten listeners.
    run.trackDetacher(() => sender.off("destroyed", onGone));

    const env = await buildAgentEnv();
    const launch = resolveProviderSignInLaunch({
      provider,
      settings: svc.getProviderSettings(),
      env,
    });
    if (!launch.ok) {
      releaseRun(run, { kill: false });
      return { ok: false, command: launch.command, message: launch.message };
    }

    try {
      const snapshot = await getTerminalManager().openCommand(
        {
          terminalId: input.terminalId,
          cwd: launch.cwd,
          cols: input.cols,
          rows: input.rows,
          env: launch.env,
        },
        { command: { file: launch.file, args: launch.args }, banner: launch.banner },
      );
      spawned = true;
      if (gone) {
        releaseRun(run, { kill: true });
        return {
          ok: false,
          command: launch.command,
          message: "The window that asked to sign in went away.",
        };
      }
      run.armTimeout(() => releaseTracked(provider, input.terminalId));
      // Release again after the awaits: the early release above can be stale by
      // the time the spawn resolves, and tracking over a live run would strand
      // its PTY and its timer.
      const tracked = runs.get(provider);
      if (tracked) releaseRun(tracked, { kill: true });
      runs.set(provider, run);
      return { ok: true, command: launch.command, snapshot };
    } catch (error) {
      // Nothing was spawned (a refused id, a spawn failure), so this only
      // detaches the watchers installed above.
      releaseRun(run, { kill: false });
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        command: launch.command,
        message: `Couldn't start ${launch.command.display}: ${message}`,
      };
    }
  };

  ipcMain.handle("provider-signin:command", (_event, provider: ProviderKind) => {
    const parsed = ProviderKindSchema.parse(provider);
    return resolveProviderSignInCommand(parsed, svc.getProviderSettings());
  });

  ipcMain.handle("provider-signin:start", (event, raw: ProviderSignInStartInput) => {
    const input = ProviderSignInStartInputSchema.parse(raw);
    const { provider } = input;
    // Serialize starts per provider: the next one waits for the previous env
    // read and spawn to settle before it releases that run, so it can never
    // spawn into an id the previous run is about to kill.
    const previous = starts.get(provider) ?? Promise.resolve();
    const next = previous.then(
      () => launchRun(provider, input, event.sender),
      () => launchRun(provider, input, event.sender),
    );
    starts.set(
      provider,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  });

  ipcMain.handle("provider-signin:check", (_event, provider: ProviderKind) => {
    const parsed = ProviderKindSchema.parse(provider);
    return svc.checkProvider(parsed);
  });
}

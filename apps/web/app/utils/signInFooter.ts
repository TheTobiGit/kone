import type { SignInState } from "~/composables/useSignInRun";

// Variant A's footer, as data: one short status and the two button sets, both
// read off the run's single state union. Kept out of the modal so every line of
// copy and every button can be asserted without a DOM or a PTY — the card only
// turns an action id into a handler.
//
// The terminal is the transcript; the footer never explains. "Waiting for
// browser" and "Answer in terminal" are the two waiting flavours the existing
// state machine already distinguishes (`finish`), and nothing here invents a
// detection the run doesn't have: no device-code phase, no parsed exit reason.

export type SignInTone = "idle" | "waiting" | "busy" | "ok" | "danger" | "muted";

export type SignInStatusLine = {
  /** One to three words wherever the run knows that little. */
  text: string;
  /** Picks the dot or icon in the card; the copy stays plain. */
  tone: SignInTone;
};

export type SignInActionId = "run" | "stop" | "check" | "copy" | "close";

export type SignInAction = {
  id: SignInActionId;
  label: string;
  variant: "primary" | "outline" | "quiet";
  disabled?: boolean;
};

export type SignInFooter = {
  status: SignInStatusLine;
  secondary: SignInAction[];
  primary: SignInAction;
};

export type SignInFooterInput = {
  state: SignInState;
  /** How this provider's CLI finishes: a browser flow or a terminal menu. */
  finish: "browser" | "terminal";
  /** The login PTY is still alive. A failed check keeps offering Stop. */
  live: boolean;
  /** The copy command button's transient "Copied". */
  copied: boolean;
};

const copyAction = (copied: boolean): SignInAction => ({
  id: "copy",
  label: copied ? "Copied" : "Copy command",
  variant: "quiet",
});

const stopAction = (disabled = false): SignInAction => ({
  id: "stop",
  label: "Stop",
  variant: "quiet",
  disabled,
});

const runAgain: SignInAction = { id: "run", label: "Run again", variant: "primary" };

/** Status copy for the run, phase by phase. */
export function signInStatus(
  state: SignInState,
  finish: SignInFooterInput["finish"],
): SignInStatusLine {
  switch (state.phase) {
    case "idle":
      return { text: "Ready", tone: "idle" };
    case "starting":
      return { text: "Starting…", tone: "busy" };
    case "running":
      return { text: "Running", tone: "busy" };
    case "waiting":
      // opencode's provider menu never prints a URL; the CLI is waiting for
      // keys, not for a browser.
      return finish === "terminal"
        ? { text: "Answer in terminal", tone: "waiting" }
        : { text: "Waiting for browser", tone: "waiting" };
    case "checking":
      return { text: "Checking…", tone: "busy" };
    case "verified":
      return {
        text: state.status.authLabel ? `Signed in · ${state.status.authLabel}` : "Signed in",
        tone: "ok",
      };
    case "failed":
      // A failed check or a refused start has one sentence worth keeping; an
      // exit names the code instead.
      return state.failure.kind === "exit"
        ? { text: `Exited with code ${state.failure.code ?? "?"}`, tone: "danger" }
        : { text: state.failure.reason, tone: "danger" };
    case "cancelled":
      return {
        text: state.reason === "timeout" ? "Sign-in stopped after 10 minutes" : "Sign-in stopped",
        tone: "muted",
      };
  }
}

/** The buttons for the run, phase by phase. `primary` is always present; a
 *  phase with nothing to do gives it a disabled label rather than an empty
 *  footer. */
export function signInActions(
  state: SignInState,
  options: Pick<SignInFooterInput, "live" | "copied">,
): Pick<SignInFooter, "secondary" | "primary"> {
  switch (state.phase) {
    case "idle":
      return { secondary: [], primary: { id: "run", label: "Run login", variant: "primary" } };
    case "starting":
      return {
        secondary: [stopAction(true)],
        primary: {
          id: "check",
          label: "Check authentication",
          variant: "primary",
          disabled: true,
        },
      };
    case "running":
    case "waiting":
      return {
        secondary: [stopAction()],
        primary: { id: "check", label: "Check authentication", variant: "primary" },
      };
    case "checking":
      return {
        // A check started from idle has no PTY to stop.
        secondary: options.live ? [stopAction()] : [],
        primary: { id: "check", label: "Checking…", variant: "primary", disabled: true },
      };
    case "verified":
      return { secondary: [], primary: { id: "close", label: "Done", variant: "outline" } };
    case "failed":
      if (state.failure.kind === "check") {
        // A failing check never killed the CLI: while it lives, Stop stays and
        // Check can be pressed again.
        return {
          secondary: [options.live ? stopAction() : runAgain],
          primary: { id: "check", label: "Check authentication", variant: "primary" },
        };
      }
      return { secondary: [copyAction(options.copied)], primary: runAgain };
    case "cancelled":
      return { secondary: [copyAction(options.copied)], primary: runAgain };
  }
}

/** Both halves of variant A's footer for one state. */
export function signInFooter(input: SignInFooterInput): SignInFooter {
  return {
    status: signInStatus(input.state, input.finish),
    ...signInActions(input.state, input),
  };
}

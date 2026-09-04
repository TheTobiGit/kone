// Shared provider-health plumbing: how a failed probe becomes a status row, and
// how a fresh round of rows folds over the previous one.
//
// Both halves exist because a probe has more than two outcomes. An adapter that
// can only see "output or nothing" has to guess, and the guess it used to make
// was "not installed" — so a CLI that was merely slow told the user to install
// something they already had, and that wrong row was then written to the disk
// snapshot and hydrated on the next cold launch. Naming the outcome
// (`ProbeResult.outcome`) fixes the message; folding over the previous round
// fixes the persistence.

import type { ProbeResult } from "./spawn.js";
import type { ProviderKind, ProviderReadiness, ProviderStatus } from "./types.js";

/** The most useful line the CLI itself gave us about why a probe went wrong.
 *  stderr first — that's where CLIs put their diagnostics — then stdout, then
 *  the exit code as a last resort. */
export function probeDetail(result: ProbeResult): string | undefined {
  const stderr = result.stderr.trim();
  if (stderr) return stderr;
  const stdout = result.stdout.trim();
  if (stdout) return stdout;
  if (result.outcome === "timeout") return "Timed out while running the command.";
  if (result.error) return result.error.message;
  if (result.code !== null && result.code !== 0) return `Command exited with code ${result.code}.`;
  return undefined;
}

/** The status fields a provider row takes on when its `--version` probe did not
 *  come back clean. Spread over the row's identity fields by the adapter. */
export type VersionProbeFailure = {
  available: boolean;
  authStatus: "unknown";
  readiness: ProviderReadiness;
  message: string;
  /** Only ever set for a timeout — see `stabilizeProviderStatuses`. */
  transient?: true;
};

/** Classify a failed `--version` probe into a row the user can act on.
 *
 *  `installHint` is the sentence for a genuinely absent binary — the only case
 *  where telling someone to install something is correct. Everything else means
 *  the CLI *is* there and misbehaved, so the row stays `available` and carries
 *  the CLI's own words rather than an install instruction. */
export function versionProbeFailure(input: {
  label: string;
  installHint: string;
  result: ProbeResult;
}): VersionProbeFailure {
  const { label, result } = input;
  const detail = probeDetail(result);
  const withDetail = (sentence: string) => (detail ? `${sentence} ${detail}` : sentence);

  switch (result.outcome) {
    case "missing":
      return {
        available: false,
        authStatus: "unknown",
        readiness: "not-installed",
        message: input.installHint,
      };
    case "timeout":
      return {
        available: true,
        authStatus: "unknown",
        readiness: "error",
        message: `${label} did not respond in time. It may still be starting up — try again in a moment.`,
        transient: true,
      };
    case "failure":
      return {
        available: true,
        authStatus: "unknown",
        readiness: "error",
        message: withDetail(`${label} is installed but could not be run.`),
      };
    default:
      return {
        available: true,
        authStatus: "unknown",
        readiness: "error",
        message: withDetail(`${label} is installed but failed to run.`),
      };
  }
}

/** True when a `--version` probe that did not exit clean should still count as
 *  a working install. Some CLIs print their version and then exit non-zero
 *  (a stale-update notice, a config warning on the way out); the version we
 *  parsed is proof the binary runs, so the round continues on to auth rather
 *  than reporting "installed but failed to run". Only a run that actually
 *  completed qualifies — a missing binary, a timeout, or a spawn failure has no
 *  version to believe. */
export function versionProbeUsable(
  result: ProbeResult,
  version: string | null | undefined,
): boolean {
  if (result.outcome === "ok") return true;
  return result.outcome === "nonzero" && version !== null && version !== undefined;
}

/** The definite enabled flag for a status row. Rows decoded from the disk cache
 *  predate the toggle and carry no `enabled` field — absent reads as enabled,
 *  the same opt-out default the settings decode applies. This is the only
 *  place that interprets the optional wire field; everything else reads the
 *  boolean this returns. */
export function statusEnabled(status: Pick<ProviderStatus, "enabled">): boolean {
  return status.enabled !== false;
}

/** The status row for a provider switched off in app settings. The single
 *  factory behind cachedSurface and discover, so a disabled provider looks
 *  identical whether the row came off disk or from a skipped probe: not
 *  available, `disabled` readiness, and the settings message that
 *  `providerUnavailableReason` would otherwise derive. */
export function disabledProviderStatus(provider: ProviderKind, label: string): ProviderStatus {
  return {
    provider,
    label,
    available: false,
    authStatus: "unknown",
    readiness: "disabled",
    enabled: false,
    message: "Provider is disabled in app settings",
  };
}

/** True when a row is one we'd let the user send a turn on. */
function wasUsable(status: ProviderStatus): boolean {
  return status.available && status.readiness === "ready";
}

// The fields a change is judged on, keyed by themselves so the set is exactly
// ProviderStatus minus the internal marker — add a field to the row and this
// stops compiling rather than letting a real change compare equal and never
// reach the UI.
const COMPARED = {
  provider: "provider",
  label: "label",
  available: "available",
  authStatus: "authStatus",
  readiness: "readiness",
  enabled: "enabled",
  version: "version",
  authLabel: "authLabel",
  message: "message",
} as const satisfies Record<keyof Omit<ProviderStatus, "transient">, keyof ProviderStatus>;

/** Whether two discovery rounds say the same thing. Matched by provider, not by
 *  position, so a reordered adapter map doesn't republish an unchanged surface —
 *  the same identity the fold uses. */
export function providerStatusesEqual(
  a: readonly ProviderStatus[],
  b: readonly ProviderStatus[],
): boolean {
  if (a.length !== b.length) return false;
  const byProvider = new Map(b.map((row) => [row.provider, row]));
  return a.every((row) => {
    const other = byProvider.get(row.provider);
    return other !== undefined && Object.values(COMPARED).every((key) => row[key] === other[key]);
  });
}

/** Fold a fresh round of probe results over the previous round.
 *
 *  A row marked `transient` never reached a verdict — the CLI was still
 *  starting, or the machine was busy. Demoting a provider the user was happily
 *  using ten seconds ago on that evidence is worse than being slightly stale, so
 *  the previous row is kept instead.
 *
 *  With no usable previous row there is nothing to fall back to, so the timeout
 *  row stands on its own — an honest "didn't respond" rather than a fabricated
 *  verdict. Either way `transient` is stripped here: it is a signal from the
 *  probe to this fold, and nothing downstream should have to know about it. */
export function stabilizeProviderStatuses(
  previous: readonly ProviderStatus[],
  next: readonly ProviderStatus[],
): ProviderStatus[] {
  const previousByProvider = new Map(previous.map((status) => [status.provider, status]));

  return next.map(({ transient, ...status }) => {
    if (!transient) return status;
    const before = previousByProvider.get(status.provider);
    if (!before || !wasUsable(before)) return status;
    const { transient: _stale, ...carried } = before;
    return carried;
  });
}

/** Whether a turn can be sent on this provider right now, and if not, why.
 *
 *  One rule, so the composer, the banner and anything else that gates a send
 *  agree. Two properties it deliberately has:
 *
 *  - Only a KNOWN bad row refuses. A provider kone has never probed is unknown,
 *    not broken, and blocking on absent knowledge would make a cold launch
 *    unsendable — the same permissive floor the spawn guard takes.
 *  - It is stricter than the spawn guard about what counts as bad: that guard
 *    refuses only an unavailable provider, because no human is watching a
 *    spawned child. A person about to send should also be stopped by a CLI that
 *    is merely signed out, since being told now beats an opaque failure from the
 *    CLI a second later.
 */
export type ProviderSendAvailability = {
  provider: ProviderKind;
  status: ProviderStatus | null;
  usable: boolean;
  /** Empty when usable — a reason to show only ever accompanies a refusal. */
  reason: string;
};

export function resolveProviderSendAvailability(input: {
  provider: ProviderKind;
  statuses: readonly ProviderStatus[];
}): ProviderSendAvailability {
  const status = input.statuses.find((row) => row.provider === input.provider) ?? null;
  if (!status || wasUsable(status)) {
    return { provider: input.provider, status, usable: true, reason: "" };
  }
  return {
    provider: input.provider,
    status,
    usable: false,
    reason: providerUnavailableReason(status),
  };
}

/** The sentence shown for a provider that can't take a turn. The probe's own
 *  message wins wherever it exists — it is the one line written against what
 *  actually happened, and a generic restatement here would bury it. */
export function providerUnavailableReason(status: ProviderStatus): string {
  if (status.message) return status.message;
  switch (status.readiness) {
    case "not-installed":
      return `${status.label} is not installed on this machine.`;
    case "needs-login":
      return `${status.label} is installed but not signed in.`;
    case "error":
      return `${status.label} is not usable right now.`;
    case "disabled":
      return `${status.label} is disabled in app settings.`;
    case "ready":
      // `available: false` on an otherwise ready row — no probe writes this, but
      // the union permits it and a silent empty reason would be worse.
      return `${status.label} is not available right now.`;
  }
}

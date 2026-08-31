// Whether a turn can go to a provider right now, and if not, why.
//
// Mirrors the rule in packages/agent-core/src/providerHealth.ts, the same way
// types/desktop.d.ts mirrors agent-core's types: the renderer can't import the
// main-process package, and two surfaces disagreeing about whether a send is
// allowed is worse than one duplicated function. Keep the two in step.

import type { ProviderKind, ProviderStatus } from "~/types/desktop";

export type ProviderSendAvailability = {
  provider: ProviderKind;
  status: ProviderStatus | null;
  usable: boolean;
  /** Empty when usable — a reason to show only ever accompanies a refusal. */
  reason: string;
};

/** Only a KNOWN bad row refuses. A provider kone has not probed yet is unknown,
 *  not broken: blocking on absent knowledge would leave the composer dead for
 *  the first moments of a cold launch, when the snapshot has not landed and the
 *  user has done nothing wrong.
 *
 *  The signature is kept identical to the agent-core copy on purpose: the two
 *  are meant to be diffable line for line, and signatures drifting apart is how
 *  a silent composer/banner split would begin. */
export function resolveProviderSendAvailability(input: {
  provider: ProviderKind;
  statuses: readonly ProviderStatus[];
}): ProviderSendAvailability {
  const status = input.statuses.find((row) => row.provider === input.provider) ?? null;
  if (!status || (status.available && status.readiness === "ready")) {
    return { provider: input.provider, status, usable: true, reason: "" };
  }
  return {
    provider: input.provider,
    status,
    usable: false,
    reason: providerUnavailableReason(status),
  };
}

/** The probe's own message wins wherever it exists — it is the one line written
 *  against what actually happened, and a generic restatement would bury it. */
export function providerUnavailableReason(status: ProviderStatus): string {
  if (status.message) return status.message;
  switch (status.readiness) {
    case "not-installed":
      return `${status.label} is not installed on this machine.`;
    case "needs-login":
      return `${status.label} is installed but not signed in.`;
    case "error":
      return `${status.label} is not usable right now.`;
    case "ready":
      return `${status.label} is not available right now.`;
  }
}

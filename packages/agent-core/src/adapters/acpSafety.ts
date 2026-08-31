import { checkCommandSafety, describeScreenedCall } from "../commandSafety.js";

/** The ACP `session/request_permission` reply shape both ACP adapters return. */
type AcpPermissionOutcome = { outcome: { outcome: string; optionId?: string } };

/**
 * A cancelled outcome for a command that is irreversible past the working tree,
 * or undefined to let the caller's own decision stand.
 *
 * Both ACP adapters auto-approve every gate under full-access, which is the
 * point of the mode: a child running unattended must never deadlock waiting for
 * someone to click. That leaves this the last place a `mkfs` or an `rm -rf ~`
 * can be stopped on either of them, so `critical` rules — and only those — turn the
 * auto-approval into a cancellation. Anything merely destructive is the user's
 * call to have already made by choosing the mode.
 *
 * The claim is per-adapter, not app-wide. Claude screens at its PreToolUse hook,
 * OpenCode at its permission reply, and Antigravity inside the capture hook's
 * own process — each at whatever gate that provider still routes through kone.
 * Codex has none: `approvalPolicy: "never"` means its CLI decides locally and
 * never asks, so a command there runs without kone seeing it. Nothing here
 * covers that, and this file should not be read as if it did.
 */
export function refuseCriticalCommand(
  command: string | undefined,
  threadId: string,
): AcpPermissionOutcome | undefined {
  const trimmed = command?.trim();
  if (!trimmed) return undefined;
  const result = checkCommandSafety(trimmed);
  if (!result.matchedRule) return undefined;
  const detail = describeScreenedCall({ rule: result.matchedRule, command: trimmed });
  if (result.matchedRule.severity !== "critical") {
    console.warn(`[kone] full-access ${threadId}: destructive — ${detail}`);
    return undefined;
  }
  console.error(`[kone] full-access ${threadId}: REFUSED — ${detail}`);
  return { outcome: { outcome: "cancelled" } };
}

// ── Terminal ownership ──────────────────────────────────────────────────────
// Ordinary terminals are shared: the event stream is fanned out to every
// subscribed renderer, and any window may attach to a shell it can name. A
// sign-in PTY is different — its transcript is an authentication surface, so
// the main process records which WebContents started it and refuses every other
// window: no output, no history/snapshot reattach, no write, close or restart.
//
// This registry lives in the main process on purpose. The renderer's own
// `owned` bookkeeping is a convenience, not a boundary: a compromised renderer
// can name any terminal id it likes.

/** The slice of Electron's WebContents the registry needs. Structural so the
 *  IPC handlers and their tests share one contract without importing Electron
 *  (which is unavailable under `bun test`). */
export type TerminalOwner = {
  isDestroyed(): boolean;
};

const owners = new Map<string, TerminalOwner>();

/** Bind `terminalId` to the renderer that started it. Claim before spawning so
 *  another window cannot attach during the spawn window. */
export function claimTerminal(terminalId: string, owner: TerminalOwner): void {
  owners.set(terminalId, owner);
}

/** Drop the claim, but only if `owner` still holds it — a newer run may have
 *  reused the id, and releasing it would unprotect that run. Omitting `owner`
 *  clears whatever holds the id (session close, app shutdown). */
export function releaseTerminal(terminalId: string, owner?: TerminalOwner): void {
  if (owner !== undefined && owners.get(terminalId) !== owner) return;
  owners.delete(terminalId);
}

/** The window a terminal belongs to, or null for a shared/ordinary terminal.
 *  A destroyed owner is pruned (and reads as unowned): nobody can act as it. */
export function terminalOwner(terminalId: string): TerminalOwner | null {
  const owner = owners.get(terminalId) ?? null;
  if (owner !== null && owner.isDestroyed()) {
    owners.delete(terminalId);
    return null;
  }
  return owner;
}

/** True when `sender` may act on `terminalId`: unowned terminals are open to
 *  any renderer, owned ones only to their window. */
export function canUseTerminal(terminalId: string, sender: TerminalOwner): boolean {
  const owner = terminalOwner(terminalId);
  return owner === null || owner === sender;
}

// ── Terminal ownership ──────────────────────────────────────────────────────
// Ordinary terminals are shared: the event stream is fanned out to every
// subscribed renderer, and any window may attach to a shell it can name. A
// sign-in PTY is different — its transcript is an authentication surface, so
// the main process records which WebContents started it and refuses every other
// window: no output, no history/snapshot reattach, no write, close or restart.
//
// A claim carries the run's own random token. Cleanup must present that token,
// so a failed or stale request can never release a newer run's protection (and
// a conflicting claim is refused before anything is mutated). The terminal IPC
// close handler, which has already authorized the sender as the owner, has one
// separate close path. This registry lives in the main process: the renderer's
// own bookkeeping is a convenience, not a boundary.

/** The slice of Electron's WebContents the registry needs. Structural so the
 *  IPC handlers and their tests share one contract without importing Electron
 *  (which is unavailable under `bun test`). */
export type TerminalOwner = {
  isDestroyed(): boolean;
};

type TerminalClaim = {
  owner: TerminalOwner;
  /** Unique per accepted sign-in request (main-generated). */
  token: string;
};

const claims = new Map<string, TerminalClaim>();

/** Reserve `terminalId` for `owner` under `token`. Returns false whenever the
 *  id is already claimed, leaving that claim untouched. A destroyed owner's
 *  claim is still held until its run's cleanup releases it, so a replacement
 *  can never race the dying PTY's close and reattach to its transcript. */
export function claimTerminal(
  terminalId: string,
  owner: TerminalOwner,
  token: string,
): boolean {
  if (claims.has(terminalId)) return false;
  claims.set(terminalId, { owner, token });
  return true;
}

/** Drop the claim only if THIS run still holds it. A refused or stale request
 *  passing a different token is a no-op. */
export function releaseTerminal(terminalId: string, token: string): void {
  if (claims.get(terminalId)?.token !== token) return;
  claims.delete(terminalId);
}

/** The one non-token release path: an explicit close of a terminal the IPC
 *  handler has already authorized `owner` to act on. */
export function releaseClosedTerminal(terminalId: string, owner: TerminalOwner): void {
  if (claims.get(terminalId)?.owner !== owner) return;
  claims.delete(terminalId);
}

/** The window a terminal belongs to, or null for a shared/ordinary terminal.
 *  A destroyed owner keeps its claim until the run releases it; until then the
 *  terminal is locked to everyone (nobody can act as, or around, a dead window). */
export function terminalOwner(terminalId: string): TerminalOwner | null {
  return claims.get(terminalId)?.owner ?? null;
}

/** True when `sender` may act on `terminalId`: unowned terminals are open to
 *  any renderer, owned ones only to their window. */
export function canUseTerminal(terminalId: string, sender: TerminalOwner): boolean {
  const owner = terminalOwner(terminalId);
  return owner === null || owner === sender;
}

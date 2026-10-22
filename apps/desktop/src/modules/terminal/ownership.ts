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
  /** Cleanup the claiming run installs for the claim's lifetime — detaching the
   *  watcher it keeps while it holds the terminal, say. Runs exactly once,
   *  whichever path drops the claim. */
  onRelease?: () => void;
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
 *  passing a different token is a no-op (and never touches a newer claim). */
export function releaseTerminal(terminalId: string, token: string): void {
  const claim = claims.get(terminalId);
  if (claim?.token !== token) return;
  dropClaim(terminalId, claim);
}

/** The one non-token release path: an explicit close of a terminal the IPC
 *  handler has already authorized `owner` to act on. */
export function releaseClosedTerminal(terminalId: string, owner: TerminalOwner): void {
  const claim = claims.get(terminalId);
  if (claim?.owner !== owner) return;
  dropClaim(terminalId, claim);
}

/** Attach a release hook to the claim held under `token`. Returns false when
 *  that claim is already gone, so a stale run installs nothing for it. The hook
 *  runs exactly once, when either release path drops the claim: a run can undo
 *  what it installed for the claim without predicting which path wins. */
export function onTerminalReleased(
  terminalId: string,
  token: string,
  onRelease: () => void,
): boolean {
  const claim = claims.get(terminalId);
  if (claim?.token !== token) return false;
  claim.onRelease = onRelease;
  return true;
}

/** Delete a claim, then run its hook. The delete comes first so a hook that
 *  releases again (or throws) can't see, or resurrect, its own claim. */
function dropClaim(terminalId: string, claim: TerminalClaim): void {
  claims.delete(terminalId);
  claim.onRelease?.();
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

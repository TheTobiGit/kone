import type { SurfaceId } from "./surfaceTop";

// Whether a surface owns the key that just arrived.
//
// Every surface that binds a window-level shortcut has to answer the same
// question — "am I the thing in front?" — and answering it locally is how the
// same binding ends up with a different test in every file. Four surfaces claim
// ⌘N; before this they claimed it three different ways, and the loosest of them
// answered from behind whatever was actually on screen.
//
// Two parts, both of which have been the bug at some point:
//
// `defaultPrevented` is the first test because anything nested inside a surface
// gets the event first and marks it handled. A listener that skips this answers
// keys a composer or a dialog has already consumed.
//
// Ownership is a `surfaceTop` comparison and never a visibility flag. A portal
// that was never summoned is hidden rather than covered, so "not covered" is
// true for a surface the user cannot see, and a surface gating on cover alone
// claims keys from every other surface in the app. "Active" is no better: a
// modal standing over a portal leaves the portal active underneath, and the key
// belongs to the modal.
//
// `owners` is a list because a surface can legitimately answer for more than
// one place — the studio also answers on the bare stage, where a project page
// is the plane with one row pulled to the front.
//
// The event is typed by the one field this reads rather than as a KeyboardEvent,
// so the rule is about ownership and nothing else, and a test can state a
// handled event without standing up a DOM to build one.
export function ownsKey(
  top: SurfaceId,
  owners: SurfaceId | readonly SurfaceId[],
  event: Pick<KeyboardEvent, "defaultPrevented">,
): boolean {
  if (event.defaultPrevented) return false;
  if (Array.isArray(owners)) return owners.includes(top);
  return owners === top;
}

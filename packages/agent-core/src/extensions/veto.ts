/**
 * Base class for errors that veto the operation an event was dispatched about,
 * rather than merely reporting a handler failure.
 *
 * `dispatch()` deliberately swallows handler errors so that one broken extension
 * cannot abort the others. A veto is the opt-in exception: handlers that need to
 * *prevent* the pending operation throw an error extending this class, and the
 * dispatcher surfaces it separately in `DispatchResult.vetoes` so the caller can
 * abort. Ordinary handler errors stay non-fatal.
 */
export class ExtensionVetoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionVetoError";
  }
}

// Warm the agent provider surface the moment the app opens. Two steps, in this
// order on purpose:
//
//   1. hydrate() — read the main process's disk snapshot of the last known
//      providers + model catalogs. No CLI is spawned, so this lands in roughly
//      one IPC round-trip and the picker is genuinely usable immediately rather
//      than populated-but-not-really-available.
//   2. refresh() — ask the main process to re-probe for real, correcting the
//      snapshot in place (and writing it back to disk for the next launch).
//
// Fire-and-forget: a slow or failing probe never blocks the UI, and every
// surface shares the module-scope result, so ProjectView's own prepare() call
// becomes a near-instant no-op.
export default defineNuxtPlugin(() => {
  const providers = useAgentProviders();
  void providers
    .hydrate()
    .then(() => providers.refresh())
    .catch(() => {});
});

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

  // Prime the global usage report in the background so the Agents / Usage
  // settings pane opens instantly instead of paying a cold transcript scan +
  // Cursor read on first sight. This fills both cache layers — the main
  // process's report memo and useAgentSpace's cross-instance cache — so the pane
  // paints its last-good numbers with no skeleton at all. Switching the scope is
  // what kicks the fetch (the pane opens on the global view); reads Cursor's
  // local session store only, so it can never surface a keychain prompt. Fire-
  // and-forget, and a no-op with no desktop bridge (nuxt dev).
  const space = useAgentSpace(() => null);
  space.setUsageScope("global");
});

// Warm the agent provider surface the moment the app opens — probe which CLIs
// are installed + logged in, and prefetch each one's model list — so the picker
// and the first project you enter read a ready cache instead of shelling out to
// `agy` on demand. Discovery/models are cached at module scope, so ProjectView's
// own `discover()`/`models()` calls become instant no-ops. Fire-and-forget: a
// slow or failing probe never blocks the UI (the composable holds the error).
export default defineNuxtPlugin(() => {
  const providers = useAgentProviders();
  void providers.prepare();
});

// The agent sounds — a reply landing, an agent waiting on the user — watch the
// app-wide registries for the life of the window. A plugin rather than a page:
// no surface, route, or layout can unmount them, so no turn finishes unheard
// because whichever component held the watcher happened to go away.
export default defineNuxtPlugin(() => {
  useAgentCues();
});

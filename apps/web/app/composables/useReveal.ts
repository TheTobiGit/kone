// Reveal path in Finder/Explorer: Electron bridge, then /api/reveal in `nuxt dev`.
export function useReveal() {
  async function reveal(path: string): Promise<void> {
    if (!path) return;

    const bridge = import.meta.client ? window.koneDesktop : undefined;
    if (bridge?.system?.reveal) {
      try {
        await bridge.system.reveal(path);
        return;
      } catch {
        // fall through to the server route
      }
    }

    try {
      await $fetch("/api/reveal", { method: "POST", body: { path } });
    } catch {
    }
  }

  return { reveal };
}

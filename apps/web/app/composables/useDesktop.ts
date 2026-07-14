import type { Project } from "./useProject";

// Thin wrapper over the Electron preload bridge, with a browser fallback so
// the flow is still exercisable in `nuxt dev` (localhost:3001).
export function useDesktop() {
  const bridge = import.meta.client ? window.koneDesktop : undefined;

  return {
    isDesktop: Boolean(bridge?.isDesktop),

    async openFolder(): Promise<Project | null> {
      // Desktop shell: real native directory dialog.
      if (bridge?.openFolder) {
        return bridge.openFolder();
      }

      // Browser dev fallback: File System Access API. For security the browser
      // only exposes the folder's name, not its absolute path — that's enough
      // to preview the opened-project screen.
      if (import.meta.client && "showDirectoryPicker" in window) {
        try {
          const handle = await (
            window as unknown as {
              showDirectoryPicker: () => Promise<{ name: string }>;
            }
          ).showDirectoryPicker();
          return { path: handle.name, name: handle.name };
        } catch {
          return null; // dismissed
        }
      }

      return null;
    },
  };
}

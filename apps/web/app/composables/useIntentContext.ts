// The intent menu's cross-component bridge: where the open project is (the
// working tree vs. the repository) and what is live in it (the git snapshot).
// ProjectView publishes both as its own surface and git model move; the menu
// host in index.vue reads them to rank its rows. Both keys live here so no
// component repeats the string literals or their defaults.
//
// Go-to requests run through a registered callback, not an event: ProjectView
// registers its surface switcher on mount and releases it on unmount, and the
// menu host calls it directly. With no listener there is no wire format to
// parse and no stale handler after the page goes away. Unmount also clears the
// snapshot, so leaving a project never leaves its git state behind.

import { ref } from "vue";
import type { IntentGitNow } from "./useIntentMenu";

export type IntentSurface = "overview" | "git";

// Holds ProjectView's surface switcher while it is mounted. Module scope so
// the menu host (two layers up, with no component ref to the page) can reach
// it; only ever set on the client, inside mount/unmount hooks.
const goSurfaceHandler = ref<((target: IntentSurface) => void) | null>(null);

export function useIntentContext() {
  const surface = useState<IntentSurface>("kone:intent-surface", () => "overview");
  const git = useState<IntentGitNow | null>("kone:intent-git", () => null);

  function setSurface(next: IntentSurface): void {
    surface.value = next;
  }

  function setGit(next: IntentGitNow | null): void {
    git.value = next;
  }

  // Back to the launcher view: the working tree, with no git snapshot.
  function clear(): void {
    surface.value = "overview";
    git.value = null;
  }

  function registerGoSurface(fn: (target: IntentSurface) => void): void {
    goSurfaceHandler.value = fn;
  }

  function unregisterGoSurface(): void {
    goSurfaceHandler.value = null;
  }

  // A menu go-to. A no-op when no project page is mounted (the launcher), the
  // same as a dispatch with no listener used to be.
  function goSurface(target: IntentSurface): void {
    goSurfaceHandler.value?.(target);
  }

  return {
    surface,
    git,
    setSurface,
    setGit,
    clear,
    registerGoSurface,
    unregisterGoSurface,
    goSurface,
  };
}

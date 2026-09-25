import type {
  KoneAgentApi,
  KoneAgentHistoryApi,
  KoneFsApi,
  KoneGitApi,
} from "~/types/desktop";
import type { createMockTurnRunner } from "~/composables/agentMock";

// The one place the renderer asks "is there a desktop behind me?".
//
// The Electron preload installs `window.koneDesktop`. `nuxt dev` in a browser has
// none, so the dev-only devBridge plugin installs a stand-in for the slice of it
// the demo world can answer — the filesystem, git, the provider surface and the
// thread list. Composables read through `desktopBridge()` and see one of two
// things: a bridge, or no bridge. They never branch on dev themselves; which
// bridge answered is this file's business, and a production build never has a
// stand-in to hand out because the plugin that installs one isn't in it.

/** The provider and thread-list calls the stand-in answers. The real agent API
 *  is a superset, so either one satisfies it. */
export type DesktopAgentReach = Pick<
  KoneAgentApi,
  "surface" | "warm" | "discover" | "onProvidersChanged" | "models" | "maintenance" | "updateProvider"
> & {
  history: Pick<
    KoneAgentHistoryApi,
    "list" | "archive" | "remove" | "setPinned" | "setDone" | "setVisited"
  >;
};

/** The bridge as the stand-in-aware composables see it. */
export type DesktopReach = {
  fs: KoneFsApi;
  git: KoneGitApi;
  agent: DesktopAgentReach;
};

/** What the dev plugin installs: the reachable slice, plus the scripted turn
 *  runner the play-demo shortcut drives (in a browser or in the shell). */
export type DevBridge = DesktopReach & { turnRunner: typeof createMockTurnRunner };

let standIn: DevBridge | null = null;

/** Called once by the devBridge plugin (and by tests that want the demo world). */
export function installDevBridge(bridge: DevBridge | null): void {
  standIn = bridge;
}

/** The desktop bridge, or the dev stand-in, or nothing. */
export function desktopBridge(): DesktopReach | undefined {
  if (!import.meta.client) return undefined;
  return window.koneDesktop ?? standIn ?? undefined;
}

/** The scripted turn runner, when the dev plugin has installed one. Offered
 *  alongside a real bridge too: the demo is a review tool for the thread UI. */
export function devTurnRunner(): DevBridge["turnRunner"] | undefined {
  return standIn?.turnRunner;
}

/** The sentence a surface shows when the thing it was asked to do can only
 *  happen inside the shell. */
export function needsDesktop(what: string): string {
  return `${what} needs the desktop app.`;
}

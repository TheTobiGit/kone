import { ref, type ComputedRef } from "vue";
import { useEventListener } from "@vueuse/core";
import { useShortcuts } from "~/composables/useShortcuts";
import type { Project } from "~/composables/useProject";
import type { RecentProject } from "~/composables/useRecentProjects";

export type CycleEntry = { path: string; name: string; isSelf: boolean };

export function useProjectCycle(deps: {
  project: Project;
  cycleProjects: ComputedRef<RecentProject[]>;
  switchTo: (p: RecentProject) => void;
}) {
  const { project, cycleProjects, switchTo } = deps;

  const cycling = ref(false);
  const cycleIndex = ref(0);
  const cycleEntries = ref<CycleEntry[]>([]);

  function stepCycle(forward: boolean) {
    const n = cycleEntries.value.length;
    if (!n) return;
    cycleIndex.value = ((cycleIndex.value + (forward ? 1 : -1)) % n + n) % n;
  }

  function startCycle(forward: boolean) {
    const entries: CycleEntry[] = [
      { path: project.path, name: project.name, isSelf: true },
      ...cycleProjects.value.map((p) => ({ path: p.path, name: p.name, isSelf: false })),
    ];
    if (entries.length < 2) return; // nothing else to switch to — don't open the HUD for a no-op
    cycleEntries.value = entries;
    cycleIndex.value = 0;
    cycling.value = true;
    stepCycle(forward);
  }

  function commitCycle() {
    const chosen = cycleEntries.value[cycleIndex.value];
    cycling.value = false;
    cycleEntries.value = [];
    if (!chosen || chosen.isSelf) return;
    const p = cycleProjects.value.find((o) => o.path === chosen.path);
    if (p) switchTo(p);
  }

  function cancelCycle() {
    cycling.value = false;
    cycleEntries.value = [];
  }

  const {
    matchesShortcut: matchesCycle,
    bindingModsFor,
    isMacPlatform,
  } = useShortcuts();

  function cycleBindingMods() {
    return bindingModsFor("cycle-projects");
  }

  useEventListener(window, "keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape" && cycling.value) {
      e.preventDefault();
      cancelCycle();
      return;
    }
    if (!matchesCycle("cycle-projects", e)) return;
    e.preventDefault();
    if (!cycling.value) startCycle(!e.shiftKey);
    else stepCycle(!e.shiftKey);
  });

  // Ctrl release commits — mirrors a held app-switcher, not a click-to-toggle menu.
  useEventListener(window, "keyup", (e: KeyboardEvent) => {
    if (!cycling.value) return;
    // Commit when the modifier that opens the cycle is released. For a "mod"
    // binding that's Meta on macOS / Control elsewhere; for an explicit "ctrl"
    // binding it's Control. Releasing Shift alone (a cycle direction change, not
    // the commit modifier) must not commit.
    const bindingMods = cycleBindingMods();
    const releaseKey =
      bindingMods.includes("mod")
        ? isMacPlatform() ? "Meta" : "Control"
        : bindingMods.includes("ctrl")
          ? "Control"
          : null;
    if (releaseKey && e.key === releaseKey) commitCycle();
  });

  // If the window loses focus mid-hold (e.g. an OS-level app switch), abandon the
  // cycle instead of leaving it stuck open with no keyup to close it.
  useEventListener(window, "blur", () => {
    if (cycling.value) cancelCycle();
  });

  return {
    cycling,
    cycleIndex,
    cycleEntries,
    startCycle,
    stepCycle,
    commitCycle,
    cancelCycle,
  };
}

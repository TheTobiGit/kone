// The thread dock's sections and the shell that holds them talk through this.
//
// Each section (Changes, Tasks, Subagents) owns its own fold — it knows when a
// live turn should open it and when a settled one should ease it shut — so the
// shell never decides for them. What the shell does need is the sum of them:
// whether every section is open (for its Expand all / Collapse all), a way to
// set them all at once, and whether any section has asked for the wide stance
// (the Changes section, while it reads one file's diff in place). A shell can
// also be told which section to open on arrival — the rail's tiles open the
// shell at the section they stand for.
//
// A section rendered outside a shell gets no group and simply runs alone.

import { computed, inject, onBeforeUnmount, provide, shallowReactive, watch, type InjectionKey, type Ref } from "vue";

/** The sections a dock can hold — what a rail tile or a focus names. */
export type DockSectionId = "changes" | "tasks" | "subagents";

interface DockSectionGroup {
  folds: Set<Ref<boolean>>;
  byId: Map<DockSectionId, Ref<boolean>>;
  wide: Set<symbol>;
}

const GROUP: InjectionKey<DockSectionGroup> = Symbol("dock-sections");

/** The shell's side: provide the group, read its sum, drive every fold at once,
 *  and open the `focus` section whenever it names one. */
export function provideDockSections(focus: () => DockSectionId | null = () => null) {
  // Shallow: the sets hold refs, and a deep reactive set would wrap each one in
  // a proxy of its own instead of handing back the section's ref.
  const group: DockSectionGroup = {
    folds: shallowReactive(new Set<Ref<boolean>>()),
    byId: shallowReactive(new Map<DockSectionId, Ref<boolean>>()),
    wide: shallowReactive(new Set<symbol>()),
  };
  provide(GROUP, group);

  const count = computed(() => group.folds.size);
  const allOpen = computed(() => {
    if (!group.folds.size) return false;
    for (const fold of group.folds) if (!fold.value) return false;
    return true;
  });
  const wide = computed(() => group.wide.size > 0);

  function setAll(open: boolean): void {
    for (const fold of group.folds) fold.value = open;
  }

  // Keyed on the section's fold as well as the name: the sections register
  // after the shell sets up, so the focused one may not exist yet at first.
  watch(
    () => {
      const id = focus();
      return id ? group.byId.get(id) : undefined;
    },
    (fold) => {
      if (fold) fold.value = true;
    },
    { immediate: true },
  );

  return { count, allOpen, wide, setAll };
}

/** A section's side: join the shell's group with its fold, and ask for width. */
export function useDockSection(section: DockSectionId, expanded: Ref<boolean>) {
  const group = inject(GROUP, null);
  const id = Symbol(section);
  group?.folds.add(expanded);
  group?.byId.set(section, expanded);
  onBeforeUnmount(() => {
    group?.folds.delete(expanded);
    if (group?.byId.get(section) === expanded) group.byId.delete(section);
    group?.wide.delete(id);
  });

  function setWide(on: boolean): void {
    if (!group) return;
    if (on) group.wide.add(id);
    else group.wide.delete(id);
  }

  return { setWide };
}

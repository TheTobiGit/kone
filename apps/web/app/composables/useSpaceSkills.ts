import { computed, ref } from "vue";
import type { SkillEntry } from "~/types/desktop";
import { useAgentSettings } from "~/composables/useAgentSettings";
import { useSkills } from "~/composables/useSkills";
import { useSpaceRefresh } from "~/composables/useSpaceRefresh";
import { groupSkills } from "~/utils/spaceSkills";

// The skills behind the project Space: everything an agent on this machine can
// reach from one project, grouped by the provider that reads it. The scan looks
// in each provider's own root and in the project's, and the per-skill reads say
// which of them are actually switched on. The board makes one and hands it to
// the card. It is read-only: switching a skill on or off, and looking inside one,
// belong to the Skills page in Settings.

export function useSpaceSkills(projectPath: () => string, visible: () => boolean) {
  const space = useAgentSettings(projectPath);
  const skills = useSkills(projectPath);

  /** What the last scan found for this project. Kept here, not read off the
   *  inventory, so a project change can clear it without reaching into it. */
  const found = ref<SkillEntry[]>([]);

  // The scan, then the switches: `settled` means both have landed, so a skill
  // is never drawn as on while its state is still being read.
  const { settled } = useSpaceRefresh(
    projectPath,
    visible,
    async (current) => {
      await space.refreshInventory();
      if (!current()) return;
      found.value = space.inventory.value?.skills ?? [];
      await skills.loadStates(found.value);
    },
    { reset: () => (found.value = []) },
  );

  const off = computed(
    () => new Set(found.value.filter((s) => !skills.isEffectiveEnabled(s)).map((s) => s.path)),
  );
  const groups = computed(() => groupSkills(found.value, off.value));
  const count = computed(() => groups.value.reduce((total, g) => total + g.rows.length, 0));

  return { groups, count, settled };
}

export type SpaceSkills = ReturnType<typeof useSpaceSkills>;

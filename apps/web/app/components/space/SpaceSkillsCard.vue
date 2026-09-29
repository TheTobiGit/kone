<script setup lang="ts">
import SkillOriginIcon from "~/components/skill/SkillOriginIcon.vue";
import type { SkillGroup } from "~/utils/spaceSkills";

// The skills an agent can reach from this project, one card per provider that
// reads them. The project's own skills lead each card, tagged; a skill that is
// switched off, or hidden by another copy in the same provider, stays listed but
// dimmed, so the card says what is there and what is in play. Read-only: the
// switches live on the Skills page in Settings.

defineProps<{
  groups: readonly SkillGroup[];
  /** The scan and the switches have landed, so no groups means none were found
   *  and no longer means they haven't arrived. */
  settled: boolean;
}>();
</script>

<template>
  <template v-if="groups.length">
    <SpaceCard v-for="g in groups" :key="g.origin" :title="g.label" :label="`${g.label} skills`" :count="g.rows.length">
      <template #icon>
        <SkillOriginIcon :origin="g.origin" :size="14" />
      </template>

      <ul class="skills__list">
        <li v-for="r in g.rows" :key="r.key" class="skills__row" :class="{ 'is-dim': r.off || r.shadowed }">
          <span class="skills__name-line">
            <span class="skills__name" :title="r.name">{{ r.name }}</span>
            <span v-if="r.project" class="skills__tag skills__tag--project">Project</span>
            <span v-if="r.off" class="skills__tag">Off</span>
            <span v-else-if="r.shadowed" class="skills__tag" title="Another copy in this provider's folders takes precedence">
              Shadowed
            </span>
          </span>
          <span v-if="r.description" class="skills__desc" :title="r.description">{{ r.description }}</span>
        </li>
      </ul>
    </SpaceCard>
  </template>

  <div v-else-if="!settled" class="skills__skel" aria-hidden="true">
    <span v-for="n in 3" :key="n" class="skills__skel-row">
      <span class="skills__skel-bar skills__skel-bar--name" />
      <span class="skills__skel-bar" />
    </span>
  </div>

  <p v-else class="skills__empty">No skills found for this project.</p>
</template>

<style scoped>
.skills__list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.skills__row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  transition: opacity 0.18s ease;
}
.skills__row.is-dim {
  opacity: 0.5;
}
.skills__name-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.skills__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ink);
}
.skills__tag {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 9.5px;
  font-weight: 500;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--muted);
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
}
.skills__tag--project {
  color: var(--ink);
  background-color: color-mix(in srgb, var(--accent) 16%, transparent);
}
/* What a skill is for runs to a couple of lines; the whole of it is the tooltip. */
.skills__desc {
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--muted);
}

.skills__empty {
  margin: 0;
  padding: 0 4px;
  font-size: 12px;
  color: var(--muted);
}

/* Stands in for the first card while the scan runs. */
.skills__skel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  border-radius: 16px;
  background-color: color-mix(in srgb, var(--ink) 3.5%, transparent);
}
.skills__skel-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.skills__skel-bar {
  display: block;
  height: 10px;
  border-radius: 6px;
  background-color: color-mix(in srgb, var(--ink) 7%, transparent);
  animation: skills-pulse 1.4s ease-in-out infinite;
}
.skills__skel-bar--name {
  width: 38%;
  height: 12px;
}
@keyframes skills-pulse {
  50% {
    opacity: 0.5;
  }
}
@media (prefers-reduced-motion: reduce) {
  .skills__skel-bar {
    animation: none;
  }
  .skills__row {
    transition: none;
  }
}
</style>

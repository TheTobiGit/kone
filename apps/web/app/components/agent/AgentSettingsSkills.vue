<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Folder01Icon, Globe02Icon } from "@hugeicons/core-free-icons";
import type { SkillEntry } from "~/types/desktop";
import type { useAgentSettings } from "~/composables/useAgentSettings";
import type { useSkills } from "~/composables/useSkills";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import type { BrandKey } from "~/utils/modelCatalog";
import { useRecentProjects } from "~/composables/useRecentProjects";

// Cards like the Discover reference — flat top, no gradient, no byline.
// Logos are the providers the skill is reachable from. `agents` = shared
// (shows all providers except claude), others = single provider.

const props = defineProps<{
  space: ReturnType<typeof useAgentSettings>;
  skills: ReturnType<typeof useSkills>;
}>();

const ORIGIN_TO_BRAND: Record<string, BrandKey> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  factory: "droid",
};

const AGENTS_BRANDS: BrandKey[] = ["codex", "cursor", "opencode", "droid", "antigravity"];

function brandsFor(skill: SkillEntry): BrandKey[] {
  if (skill.origin === "agents") return AGENTS_BRANDS;
  const b = ORIGIN_TO_BRAND[skill.origin];
  return b ? [b] : ["generic"];
}

const { recents } = useRecentProjects();

function projectsFor(skill: SkillEntry): string[] {
  if (skill.scope !== "project") return [];
  const paths = [skill.path, ...skill.shadowedBy.map((c) => c.path)];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    // longest matching recent project that contains this SKILL.md path
    let best: { path: string; name: string } | null = null;
    for (const r of recents.value) {
      if (p.startsWith(r.path + "/") && (!best || r.path.length > best.path.length)) {
        best = { path: r.path, name: (r as unknown as { name?: string }).name ?? r.path.split("/").pop() ?? r.path };
      }
    }
    const label = best ? best.name : p.split("/").slice(-3, -2)[0] ?? "project";
    if (!seen.has(label)) {
      seen.add(label);
      names.push(label);
    }
  }
  return names;
}

const all = computed(() => props.space.inventory.value?.skills ?? []);

function label(skill: SkillEntry): string {
  return skill.displayName ?? skill.name;
}

function describe(skill: SkillEntry): string | null {
  return skill.description ?? skill.shortDescription ?? null;
}

const loading = computed(
  () => props.space.inventoryLoading.value && !props.space.inventoryLoaded.value,
);
const empty = computed(() => props.space.inventoryLoaded.value && !loading.value && all.value.length === 0);

const errors = computed(
  () => props.space.inventory.value?.errors.filter((e) => /skill/i.test(e.source)) ?? [],
);
</script>

<template>
  <section class="sk" aria-label="Skills">
    <div v-if="loading" class="sk__loading">
      <span v-for="n in 6" :key="n" class="placeholder" :style="{ animationDelay: `${n * 90}ms` }" />
    </div>

    <p v-else-if="empty" class="sk__empty">No skills found on this machine.</p>

    <ul v-else class="grid">
      <li v-for="s in all" :key="s.path" class="card">
        <div class="card__top">
          <div class="icons">
            <span v-for="b in brandsFor(s)" :key="b" class="icon">
              <ProviderLogo :brand="b" :size="18" />
            </span>
          </div>
          <div class="scopeRow">
            <HugeiconsIcon
              :icon="s.scope === 'user' ? Globe02Icon : Folder01Icon"
              :size="11"
              :stroke-width="1.8"
              class="scopeIcon"
              :aria-label="s.scope === 'user' ? 'Global' : 'Project'"
            />
            <template v-if="s.scope === 'project'">
              <span v-for="proj in projectsFor(s)" :key="proj" class="proj">{{ proj }}</span>
            </template>
          </div>
        </div>
        <div class="card__body">
          <span class="card__name">{{ label(s) }}</span>
          <span v-if="describe(s)" class="card__desc">{{ describe(s) }}</span>
        </div>
      </li>
    </ul>

    <ul v-if="errors.length" class="sk__errors">
      <li v-for="e in errors" :key="e.source" class="sk__error">
        couldn't read {{ e.source }}: {{ e.message }}
      </li>
    </ul>
  </section>
</template>

<style scoped>
.sk {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding-bottom: 2rem;
}

.sk__empty {
  font-size: 14px;
  color: var(--muted);
  padding: 1.25rem 0;
}

/* grid like the Discover reference: 2-col on desktop, 1 on narrow */
.grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}

/* double outline like the wire: outer card + inset top — tight top/left/right */
.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 2px 2px 6px;
  overflow: hidden;
  border: 1px solid var(--line-soft);
  border-radius: 16px;
  background: var(--panel);
  transition: border-color 160ms ease;
}

.card:hover {
  border-color: color-mix(in srgb, var(--ink) 12%, transparent);
}

/* inset top — own border + radius, flat band, no gradient, no icon boxes */
.card__top {
  height: 88px;
  position: relative;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--panel) 96%, var(--band) 4%);
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  flex-shrink: 0;
  overflow: hidden;
}

.icons {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: center;
  padding-bottom: 10px;
  color: color-mix(in srgb, var(--ink) 78%, transparent);
}

.scopeRow {
  position: absolute;
  left: 9px;
  bottom: 7px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  max-width: calc(100% - 18px);
}

.scopeRow .scopeIcon {
  color: var(--faint);
  flex-shrink: 0;
}

.proj {
  font-size: 10px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 999px;
  border: 1px solid var(--line-soft);
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  color: var(--muted);
  white-space: nowrap;
}

/* no box — just the mark, sized for the band */
.icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  /* subtle lift so the mark doesn't feel pasted on the flat band */
  filter: drop-shadow(0 1px 1px rgb(0 0 0 / 0.04));
}

@media (prefers-color-scheme: dark) {
  .card__top {
    background: color-mix(in srgb, var(--panel) 88%, black 12%);
  }
  .icons {
    color: color-mix(in srgb, var(--ink) 88%, transparent);
  }
}

.card__body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 10px 10px;
  min-width: 0;
}

.card__name {
  font-size: 14.5px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__desc {
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: calc(12.5px * 1.45 * 2);
}

.sk__errors {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sk__error {
  font-size: 11.5px;
  color: var(--muted);
}

.sk__loading {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
  padding: 8px 0;
}

.sk__loading .placeholder {
  display: block;
  height: 182px;
  border-radius: 18px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  animation: sk-breathe 1700ms ease-in-out infinite;
}

@keyframes sk-breathe {
  0%,
  100% {
    opacity: 0.5;
  }
  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .placeholder {
    animation: none;
    opacity: 0.75;
  }
}
</style>

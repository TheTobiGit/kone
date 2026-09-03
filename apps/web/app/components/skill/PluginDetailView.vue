<script setup lang="ts">
import type { PluginEntry, SkillEntry } from "~/types/desktop";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import type { BrandKey } from "~/utils/modelCatalog";

const props = defineProps<{
  plugin: PluginEntry;
  onOpenSkill: (s: SkillEntry) => void;
}>();

const emit = defineEmits<{ back: [] }>();

const ORIGIN_TO_BRAND: Record<string, BrandKey> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  factory: "droid",
};
const AGENTS_BRANDS: BrandKey[] = ["codex", "cursor", "opencode", "droid", "antigravity"];
function brandsFor(s: SkillEntry): BrandKey[] {
  if (s.origin === "agents") return AGENTS_BRANDS;
  const b = ORIGIN_TO_BRAND[s.origin];
  return b ? [b] : ["generic"];
}
</script>

<template>
  <div class="pd">
    <header class="head">
      <div>
        <h2 class="name">{{ plugin.name }}</h2>
        <p v-if="plugin.description" class="desc">{{ plugin.description }}</p>
        <p v-else class="desc muted">Plugin — {{ plugin.skills.length }} skill{{ plugin.skills.length === 1 ? "" : "s" }} · {{ plugin.origin }}</p>
        <p class="meta">{{ plugin.path.replace(/^\/(?:Users|home)\/[^/]+/, "~") }}</p>
      </div>
    </header>

    <section class="block">
      <h3 class="eyebrow">Skills in this plugin · {{ plugin.skills.length }}</h3>
      <ul class="grid">
        <li v-for="s in plugin.skills" :key="s.path" class="card" @click="onOpenSkill(s)">
          <div class="card__top">
            <div class="icons">
              <span v-for="b in brandsFor(s)" :key="b" class="icon">
                <ProviderLogo :brand="b" :size="16" />
              </span>
            </div>
          </div>
          <div class="card__body">
            <span class="card__name">{{ s.displayName ?? s.name }}</span>
            <span v-if="s.description" class="card__desc">{{ s.description }}</span>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.pd { display: flex; flex-direction: column; gap: 18px; padding-bottom: 32px; }
.back { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); cursor: pointer; }
.back:hover { color: var(--ink); }
.head { display: flex; gap: 14px; align-items: flex-start; }
.head__icon { width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--line-soft); border-radius: 10px; background: var(--panel); color: var(--muted); flex-shrink: 0; }
.name { margin: 0; font-size: 18px; font-weight: 600; color: var(--ink); }
.desc { margin: 6px 0 0; font-size: 13px; color: var(--muted); max-width: 62ch; }
.desc.muted { color: var(--faint); }
.meta { margin: 4px 0 0; font-family: var(--font-mono); font-size: 11px; color: var(--faint); overflow-wrap: anywhere; }
.eyebrow { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
.grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
.card { display: flex; flex-direction: column; gap: 6px; padding: 2px 2px 6px; border: 1px solid var(--line-soft); border-radius: 14px; background: var(--panel); cursor: pointer; }
.card:hover { border-color: color-mix(in srgb, var(--ink) 12%, transparent); }
.card__top { height: 72px; display: grid; place-items: center; background: color-mix(in srgb, var(--panel) 96%, var(--band) 4%); border: 1px solid var(--line-soft); border-radius: 10px; }
.icons { display: flex; gap: 8px; color: color-mix(in srgb, var(--ink) 78%, transparent); }
.icon { display: grid; place-items: center; }
.card__body { padding: 4px 10px 8px; display: flex; flex-direction: column; gap: 4px; }
.card__name { font-size: 13.5px; font-weight: 600; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card__desc { font-size: 12px; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
</style>

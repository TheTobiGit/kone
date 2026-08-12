<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import ProviderLogo from "~/components/ProviderLogo.vue";
import { useAgentProviders } from "~/composables/useAgentProviders";
import { useProviderSettings } from "~/composables/useProviderSettings";
import {
  buildModelCatalog,
  describeModelId,
  EFFORT_META,
  sessionBrand,
  type BrandKey,
  type EffortTier,
  type ModelOption,
} from "~/utils/modelCatalog";
import { SESSION_BRAND } from "~/types/session";
import type { InteractionMode, ProviderKind } from "~/types/desktop";
import type { Project } from "~/composables/useProject";

// What can the agents here run, and what is this project defaulting to. Purely
// read-only — mirrors exactly what ProjectView.vue reads/writes on mount/turn
// (kone:provider, kone:model, kone:reasoning, kone:mode:<path>), but never
// touches any of it. A later pass turns this into an editable surface.

const props = defineProps<{ project: Project }>();

const providers = useAgentProviders();
const providerSettings = useProviderSettings();

const PROVIDER_KEY = "kone:provider";
const MODEL_KEY = "kone:model";
const REASONING_KEY = "kone:reasoning";
const MODE_KEY = `kone:mode:${props.project.path}`;
const MODE_LABEL: Record<InteractionMode, string> = {
  ask: "Ask before every change",
  "accept-edits": "Accept edits",
  "full-access": "Full access",
};

const PROVIDER_LABEL: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  opencode: "OpenCode",
  cursor: "Cursor",
  droid: "Factory Droid",
  antigravity: "Antigravity",
};
const providerBrand = (p: ProviderKind): BrandKey => SESSION_BRAND[p] ?? "generic";

// ── preferences (read-only) ──────────────────────────────────────────────────
const prefsLoaded = ref(false);
const rawProvider = ref<string | null>(null);
const rawModel = ref<string | null>(null);
const rawReasoning = ref<string | null>(null);
const rawMode = ref<string | null>(null);

function loadPreferences(): void {
  if (!import.meta.client) return;
  try {
    rawProvider.value = localStorage.getItem(PROVIDER_KEY);
    rawModel.value = localStorage.getItem(MODEL_KEY);
    rawReasoning.value = localStorage.getItem(REASONING_KEY);
    rawMode.value = localStorage.getItem(MODE_KEY);
  } catch {
    // A blocked/full localStorage just leaves every row at "—".
  } finally {
    prefsLoaded.value = true;
  }
}

const catalogFor = (provider: ProviderKind | null): ModelOption[] =>
  provider ? catalogs.value[provider] ?? [] : [];

/** Which provider owns a model id, per the catalogs already in hand. Used only
 *  to fill in a provider the user never explicitly pinned: if their remembered
 *  model appears in exactly one provider's catalog, that provider *is* the
 *  default — inferring it is reading the fact, not inventing one. Ambiguous or
 *  unknown ids stay blank. */
function ownerOfModel(modelId: string): ProviderKind | null {
  const owners = (Object.keys(catalogs.value) as ProviderKind[]).filter((p) =>
    (catalogs.value[p] ?? []).some((fam) => fam.efforts.some((e) => e.modelId === modelId)),
  );
  return owners.length === 1 ? owners[0]! : null;
}

const preferenceRows = computed(() => {
  const pinned = rawProvider.value as ProviderKind | null;
  const provider = pinned ?? (rawModel.value ? ownerOfModel(rawModel.value) : null);
  const modelDesc = rawModel.value ? describeModelId(rawModel.value, catalogFor(provider)) : null;
  const reasoningMeta =
    rawReasoning.value && rawReasoning.value in EFFORT_META
      ? EFFORT_META[rawReasoning.value as EffortTier]
      : null;
  return [
    {
      key: "provider",
      label: "Default provider",
      value: provider ? PROVIDER_LABEL[provider] ?? provider : null,
      brand: provider ? providerBrand(provider) : undefined,
    },
    {
      key: "model",
      label: "Default model",
      value: modelDesc?.name ?? null,
      brand: modelDesc?.brand,
    },
    {
      key: "reasoning",
      label: "Default reasoning effort",
      value: reasoningMeta?.label ?? null,
      brand: undefined,
    },
    {
      key: "mode",
      label: "Permission mode",
      value: rawMode.value && rawMode.value in MODE_LABEL ? MODE_LABEL[rawMode.value as InteractionMode] : null,
      brand: undefined,
    },
  ];
});

// ── catalogs (read-only) ─────────────────────────────────────────────────────
const catalogs = ref<Partial<Record<ProviderKind, ModelOption[]>>>({});
const catalogsLoading = ref(true);

const readyProviders = computed(() =>
  providers.ready.value.filter((s) => providerSettings.isEnabled(s.provider)),
);

const providerBlocks = computed(() => {
  const visible = providerSettings.modelVisiblePredicate.value;
  return readyProviders.value.map((s) => ({
    provider: s.provider,
    label: s.label || PROVIDER_LABEL[s.provider] || s.provider,
    families: (catalogs.value[s.provider] ?? []).filter((m) => visible(s.provider, m.key)),
  }));
});

const noProvidersReady = computed(
  () => !catalogsLoading.value && readyProviders.value.length === 0,
);

function isCurrentModel(modelOption: ModelOption): boolean {
  const current = rawModel.value;
  return Boolean(current) && modelOption.efforts.some((e) => e.modelId === current);
}

async function loadCatalogs(): Promise<void> {
  catalogsLoading.value = true;
  try {
    await providers.prepare();
    await providerSettings.load();
    const list = readyProviders.value;
    await Promise.all(
      list.map(async (s) => {
        try {
          const raw = await providers.models(s.provider);
          catalogs.value = { ...catalogs.value, [s.provider]: buildModelCatalog(raw) };
        } catch {
          // A single provider's probe failing must never blank the rest.
        }
      }),
    );
  } catch {
    // No bridge (nuxt dev) or a probe failure — the empty state below covers it.
  } finally {
    catalogsLoading.value = false;
  }
}

onMounted(() => {
  loadPreferences();
  void loadCatalogs();
});
</script>

<template>
  <section class="models" aria-label="Models">
    <!-- ── preferences ──────────────────────────────────────────────────────── -->
    <section class="block" aria-label="Preferences">
      <p class="eyebrow">Preferences</p>
      <dl class="prefs">
        <div v-for="row in preferenceRows" :key="row.key" class="pref">
          <dt class="pref__label">{{ row.label }}</dt>
          <dd class="pref__value">
            <template v-if="row.value">
              <ProviderLogo v-if="row.brand" :brand="row.brand" :size="15" class="pref__logo" />
              <span :class="{ 'pref__value--mono': row.key === 'model' }">{{ row.value }}</span>
            </template>
            <span v-else class="pref__empty">—</span>
          </dd>
        </div>
      </dl>
    </section>

    <!-- ── catalogs ─────────────────────────────────────────────────────────── -->
    <template v-if="catalogsLoading">
      <section class="block" aria-label="Loading models">
        <p class="eyebrow">Models</p>
        <ul class="placeholders" aria-hidden="true">
          <li v-for="n in 3" :key="n" class="placeholder" :style="{ animationDelay: `${n * 180}ms` }" />
        </ul>
      </section>
    </template>
    <template v-else-if="noProvidersReady">
      <p class="models__empty">No agent CLIs detected on this machine.</p>
    </template>
    <template v-else>
      <section v-for="block in providerBlocks" :key="block.provider" class="block" :aria-label="block.label">
        <p class="eyebrow">{{ block.label }}</p>
        <ul v-if="block.families.length" class="families">
          <li
            v-for="fam in block.families"
            :key="fam.key"
            class="family"
            :class="{ 'family--current': isCurrentModel(fam) }"
          >
            <div class="family__id">
              <ProviderLogo
                :brand="sessionBrand(block.provider, providerBrand(block.provider), fam.efforts[0]?.modelId)"
                :size="15"
                class="family__logo"
              />
              <div class="family__names">
                <p class="family__name">{{ fam.label }}</p>
                <p class="family__raw">{{ fam.key }}</p>
              </div>
            </div>
            <div class="family__chips">
              <span
                v-for="(effort, i) in fam.efforts"
                :key="effort.id"
                class="chip"
                :class="{ 'chip--on': i === fam.defaultEffortIndex }"
                >{{ EFFORT_META[effort.tier]?.label ?? effort.label }}</span
              >
              <span
                v-for="win in fam.contextWindows ?? []"
                :key="win.id"
                class="chip"
                :class="{ 'chip--on': win.isDefault }"
                >{{ win.label }}</span
              >
            </div>
          </li>
        </ul>
        <p v-else class="models__empty models__empty--tight">No models reported.</p>
      </section>
    </template>
  </section>
</template>

<style scoped>
.models {
  display: flex;
  flex-direction: column;
  gap: 2.25rem;
  padding-bottom: 2rem;
}

.eyebrow {
  margin: 0 0 14px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}

.models__empty {
  font-size: 15px;
  color: var(--muted);
  padding: 1.5rem 0;
}
.models__empty--tight {
  font-size: 13px;
  padding: 0.25rem 0 0;
}

/* ── preferences ─────────────────────────────────────────────────────────── */
.prefs {
  margin: 0;
  display: flex;
  flex-direction: column;
}
.pref {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 0;
  border-top: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
}
.pref:first-child {
  border-top: none;
}
.pref__label {
  font-size: 13px;
  color: var(--muted);
}
.pref__value {
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  font-size: 14px;
  color: var(--ink);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.pref__value--mono {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 13px;
}
.pref__logo {
  flex-shrink: 0;
}
.pref__empty {
  color: var(--muted);
}

/* ── model families ───────────────────────────────────────────────────────── */
.families {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.family {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-top: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
  transition: background-color 140ms ease;
}
.family:first-child {
  border-top: none;
}
.family--current {
  /* Just enough to say "this is the one you're on" — any louder and the row
     starts reading as a warning rather than a marker. */
  background-color: color-mix(in srgb, var(--accent) 4%, transparent);
  border-radius: 10px;
  padding: 12px 10px;
  margin-inline: -10px;
}
.family--current + .family {
  border-top: none;
}

.family__id {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1 1 auto;
}
.family__logo {
  flex-shrink: 0;
}
.family__names {
  min-width: 0;
}
.family__name {
  margin: 0;
  font-size: 14px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.family__raw {
  margin: 2px 0 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.family__chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
  flex-shrink: 0;
  max-width: 55%;
}

/* ── chips ─────────────────────────────────────────────────────────────────── */
.chip {
  padding: 2px 7px;
  border-radius: 6px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  white-space: nowrap;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.chip--on {
  background-color: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--ink);
}

/* ── loading placeholders ─────────────────────────────────────────────────── */
.placeholders {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.placeholder {
  height: 40px;
  border-radius: 10px;
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
  animation: breathe 1700ms ease-in-out infinite;
}

@keyframes breathe {
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
  .chip,
  .family {
    transition: none;
  }
}
</style>

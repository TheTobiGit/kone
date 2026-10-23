<script setup lang="ts">
// Direction B — one scroll, sticky index. The open provider is a single page read
// top to bottom in task order (is it working → what can it do → what's left →
// how kone runs it), with a sticky index on the left and a compact provider bar
// that takes over once the deck scrolls away. Nothing is behind tabs.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onClickOutside, useEventListener } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AlertCircleIcon,
  ArrowDown02Icon,
  ArrowUp02Icon,
  CheckmarkCircle02Icon,
  ComputerTerminal01Icon,
  Copy01Icon,
  Delete02Icon,
  DragDropVerticalIcon,
  Folder01Icon,
  GitForkIcon,
  Layers01Icon,
  LinkSquare02Icon,
  LockIcon,
  Package01Icon,
  PlusSignIcon,
  RefreshIcon,
  Search01Icon,
  SquareUnlock01Icon,
} from "@hugeicons/core-free-icons";
import MockDeck from "~/mockups/providers-pane/MockDeck.vue";
import MockLimits from "~/mockups/providers-pane/MockLimits.vue";
import MockModels from "~/mockups/providers-pane/MockModels.vue";
import MockPaneFrame from "~/mockups/providers-pane/MockPaneFrame.vue";
import MockSwitch from "~/mockups/providers-pane/MockSwitch.vue";
import {
  hasUpdate,
  INSTALL_SOURCE_LABEL,
  useMockProvidersPane,
} from "~/mockups/providers-pane/useMockProvidersPane";
import {
  MOCK_ACCOUNTS,
  MOCK_CUSTOM_MODELS,
  MOCK_ENV,
  MOCK_HEALTH,
  MOCK_HOME,
  MOCK_ORDER,
  MOCK_PATH_CHECK,
  MOCK_REGISTRY,
} from "~/mockups/providers-pane/sample";
import { canSignIn } from "~/utils/providerLogin";
import type { ProviderKind } from "~/types/desktop";

const route = useRoute();
// The URL is the mockup's only input, so it is parsed here and nowhere else:
// anything the deck doesn't know falls back to the pane's default provider.
const initial: ProviderKind = MOCK_ORDER.find((p) => p === route.query.p) ?? "codex";
const pane = useMockProvidersPane(initial);

const row = computed(() => pane.current.value);
const heroAction = computed(() => pane.heroActionFor(row.value));
const statusLine = computed(() => pane.heroStatusFor(row.value));
const accounts = computed(() => MOCK_ACCOUNTS[row.value.provider] ?? []);
const health = computed(() => MOCK_HEALTH[row.value.provider]);
const pathCheck = computed(() => MOCK_PATH_CHECK[row.value.provider] ?? null);
const home = computed(() => MOCK_HOME[row.value.provider] ?? "");
const signInLabel = computed(() => (row.value.status?.readiness === "ready" ? "Sign in again" : "Sign in"));
const readyCount = computed(() => pane.rows.value.filter((r) => r.status?.readiness === "ready").length);

// ── clipboard ───────────────────────────────────────────────────────────────
const copied = ref<string | null>(null);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

async function copy(text: string | null | undefined) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return;
  }
  copied.value = text;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copied.value = null;
  }, 1200);
}

// ── account tiles ───────────────────────────────────────────────────────────
const activeAccount = ref<string | null>(null);
const accountOn = (id: string) =>
  (activeAccount.value ?? accounts.value.find((a) => a.active)?.id) === id;

// ── runtime ─────────────────────────────────────────────────────────────────
const pathDraft = ref("");

// ── environment ─────────────────────────────────────────────────────────────
const env = ref<{ name: string; value: string; secret: boolean }[]>(
  (MOCK_ENV[initial] ?? []).map((v) => ({ ...v })),
);
function addEnv() {
  env.value.push({ name: "", value: "", secret: false });
}
function removeEnv(index: number) {
  env.value.splice(index, 1);
}

watch(
  () => row.value.provider,
  (provider) => {
    activeAccount.value = null;
    pathDraft.value = "";
    env.value = (MOCK_ENV[provider] ?? []).map((v) => ({ ...v }));
  },
);

// ── the one scroller ────────────────────────────────────────────────────────
const SECTIONS = [
  { id: "account", label: "Account" },
  { id: "models", label: "Models" },
  { id: "limits", label: "Limits" },
  { id: "runtime", label: "Runtime" },
  { id: "environment", label: "Environment" },
  { id: "provider", label: "Provider" },
] as const;
type SectionID = (typeof SECTIONS)[number]["id"];

const scroller = ref<HTMLElement>();
const deckWrap = ref<HTMLElement>();
const sectionsWrap = ref<HTMLElement>();
const active = ref<SectionID>("account");
const barIn = ref(false);

function sectionTop(node: HTMLElement): number {
  const el = scroller.value;
  if (!el) return 0;
  return node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
}

function sectionNode(id: SectionID): HTMLElement | null {
  return sectionsWrap.value?.querySelector<HTMLElement>(`[data-sec="${id}"]`) ?? null;
}

let syncFrame = 0;
function syncActive() {
  const el = scroller.value;
  if (!el) return;
  const line = el.scrollTop + 68;
  let next: SectionID = "account";
  for (const s of SECTIONS) {
    const node = sectionNode(s.id);
    if (node && sectionTop(node) <= line) next = s.id;
  }
  active.value = next;
}

function onScroll() {
  if (syncFrame) return;
  syncFrame = requestAnimationFrame(() => {
    syncFrame = 0;
    syncActive();
  });
}

function go(id: SectionID, behavior: ScrollBehavior = "smooth") {
  const el = scroller.value;
  const node = sectionNode(id);
  if (!el || !node) return;
  el.scrollTo({ top: Math.max(0, sectionTop(node) - 56), behavior });
  active.value = id;
}

let deckObserver: IntersectionObserver | undefined;

onMounted(async () => {
  await nextTick();
  const el = scroller.value;
  if (el && deckWrap.value) {
    deckObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) barIn.value = !entry.isIntersecting;
      },
      { root: el, threshold: 0 },
    );
    deckObserver.observe(deckWrap.value);
  }
  syncActive();
  // The URL is the only input beyond the provider, and it is parsed right here.
  const at = SECTIONS.find((s) => s.id === route.query.at)?.id;
  if (at) {
    requestAnimationFrame(() => go(at, "auto"));
  }
});

onBeforeUnmount(() => {
  deckObserver?.disconnect();
  if (syncFrame) cancelAnimationFrame(syncFrame);
  clearTimeout(copyTimer);
});

// ── custom models ───────────────────────────────────────────────────────────
const customModels = ref<Record<string, string[]>>(
  Object.fromEntries(
    Object.entries(MOCK_CUSTOM_MODELS).map(([key, list]) => [key, [...(list ?? [])]]),
  ),
);
const customRows = computed(() => customModels.value[row.value.provider] ?? []);
function removeCustomModel(id: string) {
  customModels.value[row.value.provider] = customRows.value.filter((m) => m !== id);
}

// ── add agent ───────────────────────────────────────────────────────────────
const addWrap = ref<HTMLElement>();
const searchEl = ref<HTMLInputElement>();
const addOpen = ref(route.query.add === "1");
const registryQuery = ref("");
const added = ref(new Set<string>());
const registryRows = computed(() => {
  const q = registryQuery.value.trim().toLowerCase();
  return q ? MOCK_REGISTRY.filter((a) => a.label.toLowerCase().includes(q)) : MOCK_REGISTRY;
});
const registryIsAdded = (agentId: string, installed: boolean) =>
  installed || added.value.has(agentId);

function addAgent(agentId: string) {
  const next = new Set(added.value);
  next.add(agentId);
  added.value = next;
}

onClickOutside(addWrap, () => {
  addOpen.value = false;
});
useEventListener(window, "keydown", (event: KeyboardEvent) => {
  if (event.key === "Escape" && addOpen.value) addOpen.value = false;
});
watch(addOpen, async (open) => {
  if (!open) return;
  await nextTick();
  searchEl.value?.focus();
});
</script>

<template>
  <MockPaneFrame>
    <template #actions>
      <div class="pp__checkrow pb__check">
        <span class="pp__checklabel">Check on open</span>
        <MockSwitch
          :on="pane.updateChecks.value"
          label="Check on open"
          @toggle="pane.updateChecks.value = !pane.updateChecks.value"
        />
      </div>
      <button type="button" class="pp__btn">
        <HugeiconsIcon :icon="RefreshIcon" :size="13" :stroke-width="1.9" aria-hidden="true" />
        Check again
      </button>

      <div ref="addWrap" class="pb__addwrap">
        <button
          type="button"
          class="pp__btn pp__btn--outline pb__addbtn"
          :aria-expanded="addOpen"
          aria-haspopup="dialog"
          @click="addOpen = !addOpen"
        >
          <HugeiconsIcon :icon="PlusSignIcon" :size="13" :stroke-width="2" aria-hidden="true" />
          Add agent
        </button>

        <Transition name="pb-sheet">
          <div v-if="addOpen" class="pb__sheet" role="dialog" aria-label="Add agent">
            <div class="pb__search">
              <HugeiconsIcon
                :icon="Search01Icon"
                :size="13"
                :stroke-width="1.8"
                class="pb__searchicon"
                aria-hidden="true"
              />
              <input
                ref="searchEl"
                v-model="registryQuery"
                type="search"
                spellcheck="false"
                autocomplete="off"
                class="pp__input pb__searchinput"
                aria-label="Search agents"
              />
            </div>

            <ul class="pb__registry">
              <li v-for="agent in registryRows" :key="agent.id" class="pb__reg">
                <ProviderLogo :brand="agent.brand" :size="18" class="pb__regmark" />
                <span class="pb__regname">{{ agent.label }}</span>
                <span v-if="registryIsAdded(agent.id, agent.installed)" class="pb__regadded">Added</span>
                <button
                  v-else
                  type="button"
                  class="pp__btn pp__btn--outline pb__regadd"
                  @click="addAgent(agent.id)"
                >
                  Add
                </button>
              </li>
            </ul>
          </div>
        </Transition>
      </div>
    </template>

    <div ref="scroller" class="pb__scroll" @scroll.passive="onScroll">
      <div ref="deckWrap" class="pb__deckwrap">
        <MockDeck :pane="pane" />
      </div>

      <div class="pb__bar" :class="{ 'pb__bar--in': barIn }">
        <div class="pb__barid">
          <ProviderLogo :brand="row.meta.brand" tone="mono" :size="16" class="pb__barmark" />
          <span class="pb__barname">{{ row.meta.label }}</span>
          <span class="pb__barstatus">{{ statusLine }}</span>
        </div>
        <div class="pb__barright">
          <div class="pb__barchips" role="group" aria-label="Providers">
            <button
              v-for="r in pane.rows.value"
              :key="r.provider"
              type="button"
              class="pb__chip"
              :class="{ 'pb__chip--on': pane.selected.value === r.provider }"
              :style="{ background: r.meta.grad }"
              :aria-label="pane.cardLabel(r)"
              :aria-pressed="pane.selected.value === r.provider"
              @click="pane.select(r.provider)"
            >
              <ProviderLogo :brand="r.meta.brand" tone="mono" :size="12" />
            </button>
          </div>
          <button type="button" class="pp__btn pp__btn--outline pb__baraa">{{ heroAction.label }}</button>
        </div>
      </div>

      <div class="pb__flow">
        <div class="pb__grid">
          <nav class="pb__index" aria-label="Sections">
            <button
              v-for="section in SECTIONS"
              :key="section.id"
              type="button"
              class="pb__indexlink"
              :class="{ 'pb__indexlink--on': active === section.id }"
              :aria-current="active === section.id ? 'true' : undefined"
              @click="go(section.id)"
            >
              {{ section.label }}
            </button>
          </nav>

          <div ref="sectionsWrap" class="pb__sections">
            <!-- ── account ───────────────────────────────────────────────── -->
            <section class="pb__section" data-sec="account">
              <p class="pp__blocklabel">Account</p>

              <div class="pb__accounts">
                <button
                  v-for="account in accounts"
                  :key="account.id"
                  type="button"
                  class="pb__account"
                  :class="{ 'pb__account--on': accountOn(account.id) }"
                  :aria-pressed="accountOn(account.id)"
                  @click="activeAccount = account.id"
                >
                  <span class="pb__accountlabel">
                    <HugeiconsIcon
                      v-if="accountOn(account.id)"
                      :icon="CheckmarkCircle02Icon"
                      :size="12"
                      :stroke-width="2"
                      aria-hidden="true"
                    />
                    {{ account.label }}
                  </span>
                  <span class="pb__accountdetail">{{ account.detail }}</span>
                </button>

                <button type="button" class="pb__account pb__account--add">
                  <HugeiconsIcon :icon="PlusSignIcon" :size="12" :stroke-width="2" aria-hidden="true" />
                  Add account
                </button>
              </div>

              <dl v-if="accounts.length && pane.loginDisplay.value" class="pp__facts">
                <div class="pp__factsrow">
                  <dt>
                    <HugeiconsIcon
                      :icon="ComputerTerminal01Icon"
                      :size="14"
                      :stroke-width="1.7"
                      aria-hidden="true"
                    />
                    Login
                  </dt>
                  <dd class="pp__factsval--cmd pb__cmd">
                    <code>{{ pane.loginDisplay.value }}</code>
                    <button
                      type="button"
                      class="pp__copy"
                      aria-label="Copy the sign-in command"
                      @click="copy(pane.loginDisplay.value)"
                    >
                      <HugeiconsIcon :icon="Copy01Icon" :size="12" :stroke-width="1.9" aria-hidden="true" />
                      {{ copied === pane.loginDisplay.value ? "Copied" : "Copy" }}
                    </button>
                  </dd>
                </div>
              </dl>

              <button
                v-if="canSignIn(row.provider) && row.status?.readiness !== 'not-installed'"
                type="button"
                class="pp__btn pp__btn--outline"
              >
                {{ signInLabel }}
              </button>
            </section>

            <!-- ── models ────────────────────────────────────────────────── -->
            <section class="pb__section" data-sec="models">
              <div class="pb__wide">
                <MockModels :pane="pane">
                  <template #actions>
                    <button type="button" class="pp__btn pb__iconbtn" aria-label="Refresh models">
                      <HugeiconsIcon :icon="RefreshIcon" :size="13" :stroke-width="1.9" aria-hidden="true" />
                    </button>
                    <button type="button" class="pp__btn">Add model</button>
                  </template>
                  <template #after>
                    <li v-for="model in customRows" :key="model" class="pb__custom">
                      <ProviderLogo :brand="row.meta.brand" :size="16" class="pb__custommark" />
                      <span class="pb__customname">{{ model }}</span>
                      <button
                        type="button"
                        class="pb__iconbtn"
                        :aria-label="`Remove ${model}`"
                        @click="removeCustomModel(model)"
                      >
                        <HugeiconsIcon :icon="Delete02Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
                      </button>
                    </li>
                  </template>
                </MockModels>
              </div>
            </section>

            <!-- ── limits ────────────────────────────────────────────────── -->
            <section class="pb__section" data-sec="limits">
              <p class="pp__blocklabel">Limits</p>
              <div class="pb__limits">
                <MockLimits :pane="pane" :label="false" />
              </div>
            </section>

            <!-- ── runtime ───────────────────────────────────────────────── -->
            <section class="pb__section" data-sec="runtime">
              <p class="pp__blocklabel">Runtime</p>

              <div v-if="row.meta.binary" class="pb__field">
                <span class="pb__fieldlabel">Executable path</span>
                <div class="pb__pathwrap">
                  <input
                    v-model="pathDraft"
                    type="text"
                    spellcheck="false"
                    autocapitalize="off"
                    autocorrect="off"
                    class="pp__input pb__pathinput"
                    :placeholder="row.meta.binary"
                    :aria-label="`${row.meta.label} executable path`"
                  />
                  <span
                    v-if="pathCheck"
                    class="pb__pathcheck"
                    :class="{ 'pb__pathcheck--bad': pathCheck.state === 'missing' }"
                  >
                    <HugeiconsIcon
                      :icon="pathCheck.state === 'ok' ? CheckmarkCircle02Icon : AlertCircleIcon"
                      :size="13"
                      :stroke-width="2"
                      aria-hidden="true"
                    />
                    <span v-if="pathCheck.state === 'missing'">Not found</span>
                    <span v-else-if="pathCheck.version">{{ pathCheck.version }}</span>
                  </span>
                </div>
              </div>

              <dl class="pp__facts">
                <div v-if="row.upkeep?.resolvedPath" class="pp__factsrow">
                  <dt>
                    <HugeiconsIcon :icon="Folder01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
                    Resolved
                  </dt>
                  <dd>{{ row.upkeep.resolvedPath }}</dd>
                </div>

                <div v-if="row.upkeep?.realPath" class="pp__factsrow">
                  <dt>
                    <HugeiconsIcon :icon="LinkSquare02Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
                    Points at
                  </dt>
                  <dd>{{ row.upkeep.realPath }}</dd>
                </div>

                <div class="pp__factsrow">
                  <dt>
                    <HugeiconsIcon :icon="Layers01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
                    Current
                  </dt>
                  <dd>{{ row.upkeep?.currentVersion ?? row.status?.version ?? "—" }}</dd>
                </div>

                <div v-if="row.upkeep?.latestKnowable" class="pp__factsrow">
                  <dt>
                    <HugeiconsIcon :icon="ArrowUp02Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
                    Latest
                  </dt>
                  <dd>
                    {{ row.upkeep.latestVersion ?? "—" }}
                    <span v-if="hasUpdate(row.status, row.upkeep)" class="pp__new">New</span>
                  </dd>
                </div>

                <div class="pp__factsrow">
                  <dt>
                    <HugeiconsIcon :icon="GitForkIcon" :size="14" :stroke-width="1.7" aria-hidden="true" />
                    Channel
                  </dt>
                  <dd class="pp__factsval--plain">
                    {{ INSTALL_SOURCE_LABEL[row.upkeep?.installSource ?? "unknown"] }}
                  </dd>
                </div>

                <div v-if="row.upkeep?.packageName" class="pp__factsrow">
                  <dt>
                    <HugeiconsIcon :icon="Package01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
                    Package
                  </dt>
                  <dd>{{ row.upkeep.packageName }}</dd>
                </div>

                <div
                  v-if="row.upkeep?.canUpdate && row.status?.available && row.upkeep.updateCommand"
                  class="pp__factsrow"
                >
                  <dt>
                    <HugeiconsIcon
                      :icon="ComputerTerminal01Icon"
                      :size="14"
                      :stroke-width="1.7"
                      aria-hidden="true"
                    />
                    Update
                  </dt>
                  <dd class="pp__factsval--cmd pb__cmd">
                    <code>{{ row.upkeep.updateCommand }}</code>
                    <button
                      type="button"
                      class="pp__copy"
                      aria-label="Copy the update command"
                      @click="copy(row.upkeep?.updateCommand)"
                    >
                      <HugeiconsIcon :icon="Copy01Icon" :size="12" :stroke-width="1.9" aria-hidden="true" />
                      {{ copied === row.upkeep?.updateCommand ? "Copied" : "Copy" }}
                    </button>
                  </dd>
                </div>

                <div class="pp__factsrow">
                  <dt>Health</dt>
                  <dd class="pb__healthval">
                    <span class="pb__dot" :class="`pb__dot--${health.state}`" aria-hidden="true" />
                    <span class="pb__healthword">{{ health.label }}</span>
                    <span class="pb__healthtime">{{ health.checked }}</span>
                    <button type="button" class="pp__btn pb__recheck">Re-check</button>
                  </dd>
                </div>
              </dl>
            </section>

            <!-- ── environment ───────────────────────────────────────────── -->
            <section class="pb__section" data-sec="environment">
              <p class="pp__blocklabel">Environment</p>

              <div class="pb__home">
                <HugeiconsIcon :icon="Folder01Icon" :size="14" :stroke-width="1.7" class="pb__homeicon" aria-hidden="true" />
                <span class="pb__homepath">{{ home }}</span>
                <button type="button" class="pp__btn">Open</button>
                <button type="button" class="pp__btn">Change</button>
              </div>

              <div v-if="env.length" class="pb__env">
                <div v-for="(variable, index) in env" :key="index" class="pb__envrow">
                  <input
                    v-model="variable.name"
                    type="text"
                    spellcheck="false"
                    autocapitalize="off"
                    autocorrect="off"
                    class="pp__input"
                    placeholder="NAME"
                    aria-label="Variable name"
                  />
                  <input
                    v-model="variable.value"
                    :type="variable.secret ? 'password' : 'text'"
                    spellcheck="false"
                    autocapitalize="off"
                    autocorrect="off"
                    class="pp__input"
                    placeholder="VALUE"
                    aria-label="Variable value"
                  />
                  <button
                    type="button"
                    class="pb__iconbtn"
                    :aria-pressed="variable.secret"
                    :aria-label="variable.secret ? 'Unlock value' : 'Lock value'"
                    @click="variable.secret = !variable.secret"
                  >
                    <HugeiconsIcon
                      :icon="variable.secret ? LockIcon : SquareUnlock01Icon"
                      :size="13"
                      :stroke-width="1.8"
                      aria-hidden="true"
                    />
                  </button>
                  <button
                    type="button"
                    class="pb__iconbtn"
                    :aria-label="`Remove ${variable.name || 'variable'}`"
                    @click="removeEnv(index)"
                  >
                    <HugeiconsIcon :icon="Delete02Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
                  </button>
                </div>
              </div>

              <button type="button" class="pp__btn pp__btn--outline" @click="addEnv">Add variable</button>
            </section>

            <!-- ── provider ──────────────────────────────────────────────── -->
            <section class="pb__section" data-sec="provider">
              <p class="pp__blocklabel">Provider</p>

              <div class="pb__toggles">
                <div class="pp__checkrow pb__toggle">
                  <span class="pp__checklabel">Enabled</span>
                  <MockSwitch
                    :on="row.enabled"
                    label="Enabled"
                    @toggle="pane.toggleEnabled(row.provider)"
                  />
                </div>
                <div class="pp__checkrow pb__toggle">
                  <span class="pp__checklabel">Show in picker</span>
                  <MockSwitch
                    :on="!row.hidden"
                    label="Show in picker"
                    @toggle="pane.toggleHidden(row.provider)"
                  />
                </div>
              </div>

              <span class="pb__fieldlabel">Order</span>
              <ul class="pb__order">
                <li
                  v-for="(item, index) in pane.rows.value"
                  :key="item.provider"
                  class="pb__orderrow"
                  :class="{ 'pb__orderrow--on': item.provider === row.provider }"
                >
                  <ProviderLogo :brand="item.meta.brand" :size="16" class="pb__ordermark" />
                  <span class="pb__ordername">{{ item.meta.label }}</span>
                  <button
                    type="button"
                    class="pb__iconbtn"
                    aria-label="Move up"
                    :disabled="index === 0"
                    @click="pane.move(item.provider, -1)"
                  >
                    <HugeiconsIcon :icon="ArrowUp02Icon" :size="13" :stroke-width="1.9" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    class="pb__iconbtn"
                    aria-label="Move down"
                    :disabled="index === pane.rows.value.length - 1"
                    @click="pane.move(item.provider, 1)"
                  >
                    <HugeiconsIcon :icon="ArrowDown02Icon" :size="13" :stroke-width="1.9" aria-hidden="true" />
                  </button>
                  <span class="pb__handle" aria-hidden="true">
                    <HugeiconsIcon :icon="DragDropVerticalIcon" :size="14" :stroke-width="1.8" />
                  </span>
                </li>
              </ul>
            </section>
          </div>
        </div>
      </div>
    </div>

    <template #foot>
      <p class="pb__foot">{{ readyCount }} of {{ pane.rows.value.length }} ready</p>
    </template>
  </MockPaneFrame>
</template>

<style scoped>
/* ── the one scroller ─────────────────────────────────────────────────────── */
.pb__scroll {
  flex: 1;
  min-height: 0;
  padding-inline: 1rem;
  overflow-y: auto;
  scrollbar-width: none;
}
.pb__scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.pb__deckwrap {
  animation: pp-in var(--pp-t-enter) var(--pp-ease) 40ms backwards;
}

/* ── the compact provider bar ─────────────────────────────────────────────── */
/* Always in the flow, only visible once the deck is gone: sticky at the top of
   the scroller, pulled up out of view until it's needed, and taking no layout
   height when it is (the sections start where they would without it). */
.pb__bar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 44px;
  margin-inline: -1rem;
  margin-bottom: -44px;
  padding-inline: 1rem;
  border-bottom: 1px solid var(--line-soft);
  background-color: var(--sunken);
  opacity: 0;
  transform: translateY(-100%);
  pointer-events: none;
  transition:
    opacity var(--pp-t-small) var(--pp-ease),
    transform var(--pp-t-small) var(--pp-ease);
}
.pb__bar--in {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
.pb__barid {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.pb__barmark {
  flex-shrink: 0;
  align-self: center;
}
.pb__barname {
  flex-shrink: 0;
  font-size: 13px;
  letter-spacing: -0.1px;
  line-height: 1.2;
  color: var(--ink);
}
.pb__barstatus {
  font-size: 11.5px;
  line-height: 1.2;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pb__barright {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
.pb__barchips {
  display: flex;
  align-items: center;
  gap: 7px;
}
.pb__chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  color: #fff;
  cursor: pointer;
  transition:
    transform var(--pp-t-micro) var(--pp-ease-move),
    outline-color var(--pp-t-micro) ease;
  outline: 2px solid transparent;
  outline-offset: 2px;
}
.pb__chip:hover {
  transform: translateY(-1px);
}
.pb__chip:focus-visible {
  outline-color: color-mix(in srgb, var(--ink) 45%, transparent);
}
.pb__chip--on {
  outline-color: var(--ink);
}
.pb__baraa {
  height: 24px;
  padding: 3px 10px;
  font-size: 11.5px;
}

/* ── index + sections ─────────────────────────────────────────────────────── */
.pb__flow {
  container-type: inline-size;
}
.pb__grid {
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr);
  column-gap: 40px;
  align-items: start;
  margin-top: 28px;
  padding-bottom: 48px;
}

.pb__index {
  position: sticky;
  top: 60px;
  align-self: start;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 1px;
}
.pb__indexlink {
  position: relative;
  padding: 6px 0 6px 14px;
  font-size: 12.5px;
  line-height: 1.3;
  text-align: left;
  color: var(--muted);
  cursor: pointer;
  border-radius: 6px;
  transition: color var(--pp-t-micro) ease;
}
.pb__indexlink:hover {
  color: var(--ink-soft);
}
.pb__indexlink:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.pb__indexlink--on {
  color: var(--ink);
}
.pb__indexlink--on::before {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  width: 2px;
  height: 14px;
  border-radius: 1px;
  background-color: var(--ink);
  transform: translateY(-50%);
}

.pb__sections {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
  max-width: 760px;
}
/* A section that reads as a list takes the whole measure (the models roster's
   switches line up on one right edge). */
.pb__wide {
  width: 100%;
  min-width: 0;
}
/* The Limits block is a readout, not a form: kept at the width its rows were
   drawn for instead of spreading its two switches across the full page. */
.pb__limits {
  width: 100%;
  max-width: 480px;
  min-width: 0;
}
.pb__section {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
  padding-top: 24px;
  border-top: 1px solid var(--line-soft);
}
.pb__section:first-child {
  padding-top: 0;
  border-top: none;
  animation: pp-in var(--pp-t-enter) var(--pp-ease) 90ms backwards;
}

/* ── account ──────────────────────────────────────────────────────────────── */
.pb__accounts {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 8px;
}
.pb__account {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  cursor: pointer;
  transition:
    border-color var(--pp-t-micro) ease,
    background-color var(--pp-t-micro) ease;
}
.pb__account:hover {
  background-color: var(--hover);
}
.pb__account:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.pb__account--on {
  border-color: color-mix(in srgb, var(--ink) 24%, transparent);
}
.pb__accountlabel {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  line-height: 1.25;
  color: var(--ink);
}
.pb__accountdetail {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.3;
  color: var(--muted);
}
.pb__account--add {
  flex-direction: row;
  align-items: center;
  gap: 7px;
  border-style: dashed;
  font-size: 12.5px;
  line-height: 1.25;
  color: var(--muted);
}

/* ── models: custom rows ──────────────────────────────────────────────────── */
/* Same row grammar as MockModels' own list, but this is a new kind of row, so it
   carries its own recipe (the kit's scoped styles don't reach slot content). */
.pb__custom {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
  padding: 9px 4px;
  border-top: 1px solid var(--line-soft);
}
.pb__custommark {
  flex-shrink: 0;
  opacity: 0.7;
}
.pb__customname {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── shared small controls ────────────────────────────────────────────────── */
.pb__iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border-radius: 6px;
  color: var(--muted);
  cursor: pointer;
  transition:
    color var(--pp-t-micro) ease,
    background-color var(--pp-t-micro) ease;
}
.pb__iconbtn:hover:not(:disabled) {
  color: var(--ink);
  background-color: var(--hover);
}
.pb__iconbtn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.pb__iconbtn:disabled {
  opacity: 0.3;
  cursor: default;
}
/* Icon-only pp__btn (Models' Refresh): square so it sits level with the label. */
.pp__btn.pb__iconbtn {
  width: 27px;
  height: 27px;
  padding-inline: 0;
}

.pb__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  min-width: 0;
}
.pb__fieldlabel {
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--muted);
}

/* ── runtime ──────────────────────────────────────────────────────────────── */
/* The path input carries its own verdict on its trailing edge: one field, one
   answer, no sentence underneath. */
.pb__pathwrap {
  position: relative;
  width: 100%;
  min-width: 0;
}
.pb__pathinput {
  padding-right: 96px;
}
.pb__pathcheck {
  position: absolute;
  right: 10px;
  top: 50%;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transform: translateY(-50%);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  pointer-events: none;
}
.pb__pathcheck--bad {
  font-family: var(--font-sans);
  font-size: 11.5px;
  color: var(--danger);
}

.pb__healthval {
  align-items: center;
  gap: 7px;
  font-family: var(--font-sans);
}

/* This page stands on --sunken, not the raised sheet the kit's command rows were
   drawn for: the Copy chip's fade has to match the ground it sits on. */
dd.pb__cmd button.pp__copy {
  background: linear-gradient(to right, transparent, var(--sunken) 18px);
}
dd.pb__cmd button.pp__copy:hover {
  background: linear-gradient(
    to right,
    transparent,
    color-mix(in srgb, var(--ink) 8%, var(--sunken)) 18px
  );
}
.pb__dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.pb__dot--ok {
  background-color: var(--ok);
}
.pb__dot--warn {
  background-color: var(--warn);
}
.pb__dot--fail {
  background-color: var(--danger);
}
.pb__healthword {
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--ink-soft);
}
.pb__healthtime {
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.pb__recheck {
  margin-inline-start: 2px;
}

/* ── environment ──────────────────────────────────────────────────────────── */
.pb__home {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
}
.pb__homeicon {
  flex-shrink: 0;
  color: var(--muted);
}
.pb__homepath {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pb__env {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.pb__envrow {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr) 22px 22px;
  align-items: center;
  gap: 8px;
}

/* ── provider ─────────────────────────────────────────────────────────────── */
.pb__toggles {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 24px;
  margin-inline-start: -12px;
}
.pb__toggle {
  gap: 14px;
  padding-block: 4px;
}
.pb__order {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  max-width: 420px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.pb__orderrow {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 4px 6px 4px 8px;
  border-radius: 9px;
  transition: background-color var(--pp-t-micro) ease;
}
.pb__orderrow:hover {
  background-color: var(--hover);
}
.pb__orderrow--on {
  background-color: var(--hover);
}
.pb__ordermark {
  flex-shrink: 0;
}
.pb__ordername {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.3;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pb__orderrow--on .pb__ordername {
  color: var(--ink);
}
.pb__handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 22px;
  flex-shrink: 0;
  color: var(--muted);
  opacity: 0.7;
  cursor: grab;
}

/* ── masthead: add agent ──────────────────────────────────────────────────── */
.pb__addwrap {
  position: relative;
  display: inline-flex;
}
.pb__addbtn {
  gap: 5px;
}
.pb__sheet {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 340px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background-color: var(--panel);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.14);
}
.pb-sheet-enter-active,
.pb-sheet-leave-active {
  transition:
    opacity var(--pp-t-small) var(--pp-ease),
    transform var(--pp-t-small) var(--pp-ease);
}
.pb-sheet-enter-from,
.pb-sheet-leave-to {
  opacity: 0;
  transform: translateY(-5px);
}
.pb__search {
  position: relative;
  display: flex;
  align-items: center;
}
.pb__searchicon {
  position: absolute;
  left: 9px;
  color: var(--muted);
  pointer-events: none;
}
.pb__searchinput {
  padding-left: 29px;
  font-family: var(--font-sans);
  font-size: 12px;
  appearance: none;
}
.pb__searchinput::-webkit-search-cancel-button {
  display: none;
}
.pb__registry {
  display: flex;
  flex-direction: column;
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 288px;
  overflow-y: auto;
  scrollbar-width: none;
}
.pb__registry::-webkit-scrollbar {
  width: 0;
}
.pb__reg {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 5px 6px;
  border-radius: 9px;
}
.pb__reg:hover {
  background-color: var(--hover);
}
.pb__regmark {
  flex-shrink: 0;
}
.pb__regname {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.3;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pb__regadded {
  flex-shrink: 0;
  padding-right: 6px;
  font-size: 11.5px;
  line-height: 1;
  color: var(--muted);
}
.pb__regadd {
  flex-shrink: 0;
  padding: 3px 11px;
  font-size: 11.5px;
}

/* ── foot ─────────────────────────────────────────────────────────────────── */
.pb__foot {
  font-size: 11.5px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

/* ── narrow: the index becomes a row above the page ───────────────────────── */
@container (max-width: 900px) {
  .pb__grid {
    display: block;
    margin-top: 22px;
  }
  /* In one column the index stops being a grid item (its own grid area would be
     no taller than itself, which leaves sticky nowhere to travel), so the grid
     becomes block flow and the row sticks against the page below the bar. */
  .pb__index {
    top: 44px;
    z-index: 1;
    flex-direction: row;
    align-items: center;
    gap: 20px;
    margin-inline: -1rem;
    padding: 9px 1rem;
    background-color: var(--sunken);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .pb__index::-webkit-scrollbar {
    display: none;
  }
  .pb__indexlink {
    flex-shrink: 0;
    padding: 0;
    border-radius: 0;
  }
  .pb__indexlink--on::before {
    display: none;
  }
  .pb__indexlink--on {
    box-shadow: inset 0 -2px 0 var(--ink);
  }
  .pb__sections {
    max-width: none;
    margin-top: 8px;
  }
  .pb__barstatus {
    display: none;
  }
}
</style>

<script setup lang="ts">
// Rethought Runtime & Environment column:
// - No giant padded <input> boxes by default: detected Binary and Home paths
//   sit as clean read-only mono rows and only open an inline editor on Override / Change.
// - Inline binary verification badge (✓ version or ! Not found) right beside the path.
// - Version + install channel condensed to one scannable line instead of 5 redundant rows.
// - Environment variables as compact `KEY = value` rows with inline lock & delete.
import { computed, nextTick, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  ComputerTerminal01Icon,
  Delete02Icon,
  Folder01Icon,
  Layers01Icon,
  LockIcon,
  PlusSignIcon,
  RefreshIcon,
  SquareUnlock01Icon,
} from "@hugeicons/core-free-icons";
import {
  MOCK_ENV,
  MOCK_HEALTH,
  MOCK_HOME,
  MOCK_PATH_CHECK,
  type MockEnvVar,
} from "~/mockups/providers-pane/sample";
import {
  INSTALL_SOURCE_LABEL,
  hasUpdate,
  type MockRow,
} from "~/mockups/providers-pane/useMockProvidersPane";

const props = defineProps<{
  row: MockRow;
  initialEditBinary?: boolean;
  initialCustomBinary?: string;
}>();

const editingBinary = ref(props.initialEditBinary ?? false);
const binaryOverride = ref(props.initialCustomBinary ?? "");
const binaryDraft = ref(props.initialCustomBinary ?? "");

const editingHome = ref(false);
const homeOverride = ref("");
const homeDraft = ref("");

const vars = ref<MockEnvVar[]>([]);
const addingVar = ref(false);
const newKey = ref("");
const newVal = ref("");
const newSecret = ref(false);
const rechecking = ref(false);

watch(
  () => props.row.provider,
  (p) => {
    editingBinary.value = props.initialEditBinary ?? false;
    binaryOverride.value = props.initialCustomBinary ?? "";
    binaryDraft.value = binaryOverride.value || (props.row.upkeep?.resolvedPath ?? props.row.meta.binary ?? "");
    editingHome.value = false;
    homeOverride.value = "";
    homeDraft.value = MOCK_HOME[p] ?? "";
    vars.value = (MOCK_ENV[p] ?? []).map((v) => ({ ...v }));
    addingVar.value = false;
  },
  { immediate: true },
);

const resolvedBinary = computed(
  () => binaryOverride.value || props.row.upkeep?.resolvedPath || props.row.meta.binary || "—",
);

const pathCheck = computed(() => {
  if (binaryOverride.value) {
    if (binaryOverride.value.includes("missing") || binaryOverride.value.includes("bad")) {
      return { state: "missing" as const, version: null };
    }
    return {
      state: "ok" as const,
      version: props.row.upkeep?.currentVersion ?? props.row.status?.version ?? "0.48.0",
    };
  }
  return MOCK_PATH_CHECK[props.row.provider] ?? null;
});

const health = computed(() => MOCK_HEALTH[props.row.provider]);
const behind = computed(() => hasUpdate(props.row.status, props.row.upkeep));
const channelLabel = computed(
  () => INSTALL_SOURCE_LABEL[props.row.upkeep?.installSource ?? "unknown"],
);
const currentVer = computed(
  () => props.row.upkeep?.currentVersion ?? props.row.status?.version ?? "—",
);
const resolvedHome = computed(() => homeOverride.value || MOCK_HOME[props.row.provider] || "—");

function startBinaryEdit() {
  binaryDraft.value = binaryOverride.value || (props.row.upkeep?.resolvedPath ?? props.row.meta.binary ?? "");
  editingBinary.value = true;
}

function saveBinary() {
  binaryOverride.value = binaryDraft.value.trim();
  editingBinary.value = false;
}

function resetBinary() {
  binaryOverride.value = "";
  editingBinary.value = false;
}

function startHomeEdit() {
  homeDraft.value = resolvedHome.value;
  editingHome.value = true;
}

function saveHome() {
  homeOverride.value = homeDraft.value.trim();
  editingHome.value = false;
}

function recheck() {
  if (rechecking.value) return;
  rechecking.value = true;
  setTimeout(() => {
    rechecking.value = false;
  }, 800);
}

async function openAddVar() {
  addingVar.value = true;
  newKey.value = "";
  newVal.value = "";
  newSecret.value = false;
  await nextTick();
}

function commitVar() {
  const k = newKey.value.trim();
  if (k) {
    vars.value.push({ name: k, value: newVal.value, secret: newSecret.value });
  }
  addingVar.value = false;
}

function removeVar(i: number) {
  vars.value.splice(i, 1);
}
</script>

<template>
  <div class="pf__leftcol">
    <!-- RUNTIME -->
    <section class="pp__block pf__section" aria-label="Runtime">
      <div class="pf__secthead">
        <p class="pp__blocklabel">Runtime</p>

        <div class="pf__healthpill">
          <span class="pf__hdot" :class="`pf__hdot--${health.state}`" aria-hidden="true" />
          <span class="pf__hlabel" :class="`pf__hlabel--${health.state}`">{{ health.label }}</span>
          <span class="pf__htime">{{ health.checked }}</span>
          <button
            type="button"
            class="pp__btn pf__iconbtn"
            aria-label="Re-check health"
            @click="recheck"
          >
            <HugeiconsIcon
              :icon="RefreshIcon"
              :size="12"
              :stroke-width="1.9"
              :class="{ 'pp__spin': rechecking }"
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      <dl class="pp__facts pf__facts">
        <!-- Binary row (omitted for bundled providers with no external binary) -->
        <div v-if="row.meta.binary" class="pp__factsrow pf__row">
          <dt>
            <HugeiconsIcon :icon="ComputerTerminal01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
            Binary
          </dt>
          <dd class="pf__dd">
            <template v-if="!editingBinary">
              <code class="pf__path">{{ resolvedBinary }}</code>
              <span v-if="binaryOverride" class="pf__tag">Custom</span>
              <span
                v-if="pathCheck"
                class="pf__check"
                :class="{ 'pf__check--bad': pathCheck.state === 'missing' }"
              >
                <HugeiconsIcon
                  :icon="pathCheck.state === 'ok' ? CheckmarkCircle02Icon : AlertCircleIcon"
                  :size="12"
                  :stroke-width="2"
                  aria-hidden="true"
                />
                <span>{{ pathCheck.state === "ok" ? (pathCheck.version ?? "OK") : "Not found" }}</span>
              </span>
              <span class="pf__rowacts">
                <button
                  v-if="binaryOverride"
                  type="button"
                  class="pp__btn pf__tinybtn"
                  @click="resetBinary"
                >
                  Reset
                </button>
                <button type="button" class="pp__btn pf__tinybtn" @click="startBinaryEdit">
                  Override
                </button>
              </span>
            </template>

            <div v-else class="pf__inlineedit">
              <input
                v-model="binaryDraft"
                type="text"
                class="pp__input pf__compactinput"
                spellcheck="false"
                autocapitalize="off"
                autocorrect="off"
                :placeholder="row.meta.binary"
                :aria-label="`${row.meta.label} binary path`"
                @keydown.enter.prevent="saveBinary"
                @keydown.esc.prevent="editingBinary = false"
              />
              <button type="button" class="pp__btn pp__btn--outline pf__tinybtn" @click="saveBinary">
                Check &amp; save
              </button>
              <button type="button" class="pp__btn pf__tinybtn" @click="editingBinary = false">
                Cancel
              </button>
            </div>
          </dd>
        </div>

        <!-- Home / config directory row -->
        <div class="pp__factsrow pf__row">
          <dt>
            <HugeiconsIcon :icon="Folder01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
            Home
          </dt>
          <dd class="pf__dd">
            <template v-if="!editingHome">
              <code class="pf__path">{{ resolvedHome }}</code>
              <span v-if="homeOverride" class="pf__tag">Custom</span>
              <span class="pf__rowacts">
                <button type="button" class="pp__btn pf__tinybtn">Open</button>
                <button type="button" class="pp__btn pf__tinybtn" @click="startHomeEdit">
                  Change
                </button>
              </span>
            </template>

            <div v-else class="pf__inlineedit">
              <input
                v-model="homeDraft"
                type="text"
                class="pp__input pf__compactinput"
                spellcheck="false"
                autocapitalize="off"
                autocorrect="off"
                aria-label="Home directory"
                @keydown.enter.prevent="saveHome"
                @keydown.esc.prevent="editingHome = false"
              />
              <button type="button" class="pp__btn pp__btn--outline pf__tinybtn" @click="saveHome">
                Save
              </button>
              <button type="button" class="pp__btn pf__tinybtn" @click="editingHome = false">
                Cancel
              </button>
            </div>
          </dd>
        </div>

        <!-- Condensed Version + Channel row -->
        <div class="pp__factsrow pf__row">
          <dt>
            <HugeiconsIcon :icon="Layers01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
            Version
          </dt>
          <dd class="pf__dd">
            <span class="pf__ver">{{ currentVer }}</span>
            <span class="pf__sep">·</span>
            <span class="pf__chan">{{ channelLabel }}</span>
            <span v-if="behind && row.upkeep?.latestVersion" class="pf__updatebadge">
              {{ row.upkeep.latestVersion }} available
            </span>
          </dd>
        </div>
      </dl>
    </section>

    <!-- ENVIRONMENT -->
    <section class="pp__block pf__section" aria-label="Environment">
      <div class="pf__secthead">
        <p class="pp__blocklabel">Environment</p>
        <button type="button" class="pp__btn pf__tinybtn" @click="openAddVar">
          <HugeiconsIcon :icon="PlusSignIcon" :size="11" :stroke-width="2" aria-hidden="true" />
          Add variable
        </button>
      </div>

      <ul v-if="vars.length || addingVar" class="pf__envlist">
        <li v-for="(v, i) in vars" :key="i" class="pf__envrow">
          <code class="pf__envkey">{{ v.name }}</code>
          <span class="pf__enveq" aria-hidden="true">=</span>
          <code class="pf__envval" :class="{ 'pf__envval--secret': v.secret }">
            {{ v.secret ? "••••••••••••" : v.value }}
          </code>
          <div class="pf__envacts">
            <button
              type="button"
              class="pf__iconbtn"
              :class="{ 'pf__iconbtn--on': v.secret }"
              :aria-pressed="v.secret"
              :aria-label="v.secret ? `Show ${v.name}` : `Mask ${v.name}`"
              @click="v.secret = !v.secret"
            >
              <HugeiconsIcon
                :icon="v.secret ? LockIcon : SquareUnlock01Icon"
                :size="13"
                :stroke-width="1.8"
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              class="pf__iconbtn pf__iconbtn--del"
              :aria-label="`Remove ${v.name}`"
              @click="removeVar(i)"
            >
              <HugeiconsIcon :icon="Delete02Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
            </button>
          </div>
        </li>

        <li v-if="addingVar" class="pf__envrow pf__envrow--edit">
          <input
            v-model="newKey"
            type="text"
            class="pp__input pf__compactinput pf__keyinput"
            placeholder="KEY"
            spellcheck="false"
            aria-label="Variable name"
            @keydown.enter.prevent="commitVar"
          />
          <span class="pf__enveq" aria-hidden="true">=</span>
          <input
            v-model="newVal"
            :type="newSecret ? 'password' : 'text'"
            class="pp__input pf__compactinput pf__valinput"
            placeholder="value"
            spellcheck="false"
            aria-label="Variable value"
            @keydown.enter.prevent="commitVar"
          />
          <button
            type="button"
            class="pf__iconbtn"
            :class="{ 'pf__iconbtn--on': newSecret }"
            :aria-pressed="newSecret"
            aria-label="Secret"
            @click="newSecret = !newSecret"
          >
            <HugeiconsIcon
              :icon="newSecret ? LockIcon : SquareUnlock01Icon"
              :size="13"
              :stroke-width="1.8"
              aria-hidden="true"
            />
          </button>
          <button type="button" class="pp__btn pp__btn--outline pf__tinybtn" @click="commitVar">
            Add
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.pf__leftcol {
  display: flex;
  flex-direction: column;
  gap: 28px;
  min-width: 0;
}
.pf__section {
  width: 100%;
  align-items: stretch;
}
.pf__secthead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}

/* Health pill in the Runtime header */
.pf__healthpill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--ink-soft);
}
.pf__hdot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--ok, #3fb950);
}
.pf__hdot--warn {
  background-color: var(--warn);
}
.pf__hdot--fail {
  background-color: var(--danger);
}
.pf__hlabel--warn {
  color: var(--warn);
}
.pf__hlabel--fail {
  color: var(--danger);
}
.pf__htime {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
}

.pf__facts {
  margin-top: 2px;
}
.pf__row {
  grid-template-columns: 88px minmax(0, 1fr);
  align-items: center;
  padding: 7px 0;
}
.pf__dd {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 8px;
  min-width: 0;
  width: 100%;
}
.pf__path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink);
}
.pf__tag {
  flex-shrink: 0;
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-family: var(--font-sans);
  font-size: 10px;
  color: var(--ink-soft);
}
.pf__check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ok, #3fb950);
}
.pf__check--bad {
  font-family: var(--font-sans);
  color: var(--danger);
}
.pf__rowacts {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  flex-shrink: 0;
}
.pf__tinybtn {
  height: 23px;
  padding-inline: 8px;
  font-size: 11px;
}
.pf__inlineedit {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
}
.pf__compactinput {
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 8px;
  font-size: 11.5px;
}
.pf__ver {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink);
}
.pf__sep {
  color: var(--muted);
}
.pf__chan {
  font-family: var(--font-sans);
  font-size: 12px;
  color: var(--muted);
}
.pf__updatebadge {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ink) 9%, transparent);
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--ink);
}

/* Compact KEY = value environment list */
.pf__envlist {
  display: flex;
  flex-direction: column;
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}
.pf__envrow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 7px 0;
  border-top: 1px solid var(--line-soft);
}
.pf__envrow:first-child {
  border-top: none;
  padding-top: 2px;
}
.pf__envkey {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink);
}
.pf__enveq {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}
.pf__envval {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink-soft);
}
.pf__envval--secret {
  letter-spacing: 0.08em;
  color: var(--muted);
}
.pf__envacts {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.pf__iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: 6px;
  color: var(--muted);
  cursor: pointer;
  transition:
    color var(--pp-t-micro) ease,
    background-color var(--pp-t-micro) ease;
}
.pf__iconbtn:hover {
  color: var(--ink);
  background-color: var(--hover);
}
.pf__iconbtn--on {
  color: var(--ink-soft);
}
.pf__iconbtn--del:hover {
  color: var(--danger);
}
.pf__keyinput {
  max-width: 165px;
}
</style>

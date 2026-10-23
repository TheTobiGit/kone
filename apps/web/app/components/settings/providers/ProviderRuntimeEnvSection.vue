<script setup lang="ts">
// Left column of the fused Providers pane board:
// - Runtime: inline health status + Re-check, read-only Binary path chip with
//   inline verification badge (✓ version or ! Not found) and Override/Reset,
//   read-only Home path chip with Change/Reset, and single-line Version + channel.
// - Environment: compact `KEY = value` rows with secret lock toggle and delete.
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
import type { ProviderBinaryCheckResult, ProviderEnvVar, ProviderKind } from "~/types/desktop";
import { INSTALL_SOURCE_LABEL, hasUpdate, type ProviderPaneRow } from "./types";

const props = defineProps<{
  row: ProviderPaneRow;
  open: boolean;
  checkedLabel: string | null;
  binaryOverride: string;
  homeOverride: string;
  envVars: ProviderEnvVar[];
  runLine: { text: string; bad: boolean; output: string | null } | null;
}>();

const emit = defineEmits<{
  recheckHealth: [provider: ProviderKind];
  saveBinary: [provider: ProviderKind, path: string];
  saveHome: [provider: ProviderKind, path: string];
  saveEnv: [provider: ProviderKind, vars: ProviderEnvVar[]];
  dismissRun: [provider: ProviderKind];
}>();

const providerSettings = useProviderSettings();

const editingBinary = ref(false);
const binaryDraft = ref("");
const binaryCheck = ref<ProviderBinaryCheckResult | null>(null);
const checkingBinary = ref(false);

const editingHome = ref(false);
const homeDraft = ref("");

const addingVar = ref(false);
const newKey = ref("");
const newVal = ref("");
const newSecret = ref(false);
const rechecking = ref(false);

watch(
  () => props.row.provider,
  () => {
    editingBinary.value = false;
    checkingBinary.value = false;
    binaryDraft.value = props.binaryOverride;
    binaryCheck.value = null;
    editingHome.value = false;
    homeDraft.value = props.homeOverride;
    addingVar.value = false;
  },
  { immediate: true },
);

const resolvedBinary = computed(
  () =>
    props.binaryOverride ||
    props.row.upkeep?.resolvedPath ||
    props.row.meta.binary ||
    "—",
);

const resolvedHome = computed(
  () => props.homeOverride || props.row.meta.defaultHome,
);

const currentVer = computed(
  () => props.row.upkeep?.currentVersion ?? props.row.status?.version ?? "—",
);

const channelLabel = computed(
  () => INSTALL_SOURCE_LABEL[props.row.upkeep?.installSource ?? "unknown"],
);

const behind = computed(() => hasUpdate(props.row.status, props.row.upkeep));

const healthState = computed(() => {
  const s = props.row.status;
  if (!s) return { tone: "warn", label: "Checking…" };
  if (s.readiness === "ready") return { tone: "ok", label: "Healthy" };
  if (s.readiness === "needs-login") return { tone: "warn", label: "Not signed in" };
  if (s.readiness === "disabled") return { tone: "warn", label: "Disabled" };
  if (s.readiness === "not-installed") return { tone: "fail", label: "Not found" };
  return { tone: "fail", label: "Unavailable" };
});

const pathBadge = computed(() => {
  if (binaryCheck.value) {
    return {
      ok: binaryCheck.value.ok,
      label: binaryCheck.value.ok
        ? (binaryCheck.value.version ?? "OK")
        : (binaryCheck.value.error ?? "Not found"),
    };
  }
  if (props.row.status?.readiness === "not-installed") {
    return { ok: false, label: "Not found" };
  }
  const v = props.row.upkeep?.currentVersion ?? props.row.status?.version;
  if (v) return { ok: true, label: v };
  if (props.row.upkeep?.resolvedPath) return { ok: true, label: "OK" };
  return null;
});

function startBinaryEdit() {
  binaryDraft.value =
    props.binaryOverride ||
    props.row.upkeep?.resolvedPath ||
    props.row.meta.binary ||
    "";
  editingBinary.value = true;
}

async function commitBinaryEdit() {
  const provider = props.row.provider;
  const next = binaryDraft.value.trim();
  checkingBinary.value = true;
  try {
    const res = await providerSettings.checkBinary(provider, next);
    if (props.row.provider === provider && res) binaryCheck.value = res;
    emit("saveBinary", provider, next);
  } finally {
    if (props.row.provider === provider) {
      checkingBinary.value = false;
      editingBinary.value = false;
    }
  }
}

function resetBinary() {
  const provider = props.row.provider;
  binaryCheck.value = null;
  emit("saveBinary", provider, "");
  editingBinary.value = false;
}

function startHomeEdit() {
  homeDraft.value = props.homeOverride || props.row.meta.defaultHome;
  editingHome.value = true;
}

function commitHomeEdit() {
  const provider = props.row.provider;
  const next = homeDraft.value.trim();
  const isDefault = next === props.row.meta.defaultHome;
  emit("saveHome", provider, isDefault ? "" : next);
  editingHome.value = false;
}

function resetHome() {
  const provider = props.row.provider;
  emit("saveHome", provider, "");
  editingHome.value = false;
}

function recheck() {
  if (rechecking.value) return;
  rechecking.value = true;
  emit("recheckHealth", props.row.provider);
  setTimeout(() => {
    rechecking.value = false;
  }, 700);
}

async function openAddVar() {
  addingVar.value = true;
  newKey.value = "";
  newVal.value = "";
  newSecret.value = false;
  await nextTick();
}

function commitNewVar() {
  const provider = props.row.provider;
  const k = newKey.value.trim();
  if (k) {
    const entry: ProviderEnvVar = { name: k, value: newVal.value };
    if (newSecret.value) entry.secret = true;
    const next = [...props.envVars.filter((v) => v.name !== k), entry];
    emit("saveEnv", provider, next);
  }
  addingVar.value = false;
}

function toggleSecret(index: number) {
  const provider = props.row.provider;
  const next = props.envVars.map((v, i) =>
    i === index ? { ...v, secret: !v.secret } : { ...v },
  );
  emit("saveEnv", provider, next);
}

function removeVar(index: number) {
  const provider = props.row.provider;
  const next = props.envVars.filter((_, i) => i !== index);
  emit("saveEnv", provider, next);
}
</script>

<template>
  <div class="pf__leftcol">
    <!-- RUNTIME -->
    <section class="pp__block pf__section" aria-label="Runtime">
      <div class="pf__secthead">
        <p class="pp__blocklabel">Runtime</p>

        <div class="pf__healthpill">
          <span class="pf__hdot" :class="`pf__hdot--${healthState.tone}`" aria-hidden="true" />
          <span class="pf__hlabel" :class="`pf__hlabel--${healthState.tone}`">
            {{ healthState.label }}
          </span>
          <span v-if="checkedLabel" class="pf__htime">{{ checkedLabel }}</span>
          <button
            type="button"
            class="pp__btn pf__iconbtn"
            aria-label="Re-check health"
            :tabindex="open ? 0 : -1"
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
        <!-- Binary row (omitted for bundled providers) -->
        <div v-if="row.meta.binary" class="pp__factsrow pf__row">
          <dt>
            <HugeiconsIcon
              :icon="ComputerTerminal01Icon"
              :size="14"
              :stroke-width="1.7"
              aria-hidden="true"
            />
            Binary
          </dt>
          <dd class="pf__dd">
            <template v-if="!editingBinary">
              <code class="pf__path">{{ resolvedBinary }}</code>
              <span v-if="binaryOverride" class="pf__tag">Custom</span>
              <span
                v-if="pathBadge"
                class="pf__check"
                :class="{ 'pf__check--bad': !pathBadge.ok }"
              >
                <HugeiconsIcon
                  :icon="pathBadge.ok ? CheckmarkCircle02Icon : AlertCircleIcon"
                  :size="12"
                  :stroke-width="2"
                  aria-hidden="true"
                />
                <span>{{ pathBadge.label }}</span>
              </span>
              <span class="pf__rowacts">
                <button
                  v-if="binaryOverride"
                  type="button"
                  class="pp__btn pf__tinybtn"
                  :tabindex="open ? 0 : -1"
                  @click="resetBinary"
                >
                  Reset
                </button>
                <button
                  type="button"
                  class="pp__btn pf__tinybtn"
                  :tabindex="open ? 0 : -1"
                  @click="startBinaryEdit"
                >
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
                :aria-label="`${row.meta.label} CLI path`"
                @keydown.enter.prevent="commitBinaryEdit"
                @keydown.esc.prevent="editingBinary = false"
              />
              <button
                type="button"
                class="pp__btn pp__btn--outline pf__tinybtn"
                :disabled="checkingBinary"
                @click="commitBinaryEdit"
              >
                {{ checkingBinary ? "Checking…" : "Save" }}
              </button>
              <button
                type="button"
                class="pp__btn pf__tinybtn"
                @click="editingBinary = false"
              >
                Cancel
              </button>
            </div>
          </dd>
        </div>

        <!-- Home / config directory row -->
        <div class="pp__factsrow pf__row">
          <dt>
            <HugeiconsIcon
              :icon="Folder01Icon"
              :size="14"
              :stroke-width="1.7"
              aria-hidden="true"
            />
            Home
          </dt>
          <dd class="pf__dd">
            <template v-if="!editingHome">
              <code class="pf__path">{{ resolvedHome }}</code>
              <span v-if="homeOverride" class="pf__tag">Custom</span>
              <span class="pf__rowacts">
                <button
                  v-if="homeOverride"
                  type="button"
                  class="pp__btn pf__tinybtn"
                  :tabindex="open ? 0 : -1"
                  @click="resetHome"
                >
                  Reset
                </button>
                <button
                  type="button"
                  class="pp__btn pf__tinybtn"
                  :tabindex="open ? 0 : -1"
                  @click="startHomeEdit"
                >
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
                :placeholder="row.meta.defaultHome"
                :aria-label="`${row.meta.label} home directory`"
                @keydown.enter.prevent="commitHomeEdit"
                @keydown.esc.prevent="editingHome = false"
              />
              <button
                type="button"
                class="pp__btn pp__btn--outline pf__tinybtn"
                @click="commitHomeEdit"
              >
                Save
              </button>
              <button
                type="button"
                class="pp__btn pf__tinybtn"
                @click="editingHome = false"
              >
                Cancel
              </button>
            </div>
          </dd>
        </div>

        <!-- Single-line Version + channel -->
        <div class="pp__factsrow pf__row">
          <dt>
            <HugeiconsIcon
              :icon="Layers01Icon"
              :size="14"
              :stroke-width="1.7"
              aria-hidden="true"
            />
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

      <div v-if="runLine" class="pp__result">
        <p class="pp__resulttext" :class="{ 'pp__resulttext--bad': runLine.bad }">
          {{ runLine.text }}
          <button
            type="button"
            class="pp__dismiss"
            :tabindex="open ? 0 : -1"
            @click="emit('dismissRun', row.provider)"
          >
            Dismiss
          </button>
        </p>
        <pre v-if="runLine.output" class="pp__output">{{ runLine.output }}</pre>
      </div>
    </section>

    <!-- ENVIRONMENT -->
    <section class="pp__block pf__section" aria-label="Environment">
      <div class="pf__secthead">
        <p class="pp__blocklabel">Environment</p>
        <button
          type="button"
          class="pp__btn pf__tinybtn"
          :tabindex="open ? 0 : -1"
          @click="openAddVar"
        >
          <HugeiconsIcon :icon="PlusSignIcon" :size="11" :stroke-width="2" aria-hidden="true" />
          Add variable
        </button>
      </div>

      <ul v-if="envVars.length || addingVar" class="pf__envlist">
        <li v-for="(v, i) in envVars" :key="v.name" class="pf__envrow">
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
              :aria-pressed="Boolean(v.secret)"
              :aria-label="v.secret ? `Show ${v.name}` : `Mask ${v.name}`"
              :tabindex="open ? 0 : -1"
              @click="toggleSecret(i)"
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
              :tabindex="open ? 0 : -1"
              @click="removeVar(i)"
            >
              <HugeiconsIcon
                :icon="Delete02Icon"
                :size="13"
                :stroke-width="1.8"
                aria-hidden="true"
              />
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
            @keydown.enter.prevent="commitNewVar"
            @keydown.esc.prevent="addingVar = false"
          />
          <span class="pf__enveq" aria-hidden="true">=</span>
          <input
            v-model="newVal"
            :type="newSecret ? 'password' : 'text'"
            class="pp__input pf__compactinput pf__valinput"
            placeholder="value"
            spellcheck="false"
            aria-label="Variable value"
            @keydown.enter.prevent="commitNewVar"
            @keydown.esc.prevent="addingVar = false"
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
          <button type="button" class="pp__btn pp__btn--outline pf__tinybtn" @click="commitNewVar">
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

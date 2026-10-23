<script setup lang="ts">
// Direction A — Account: the provider's accounts as a strip (the active one
// marked), then sign-in status, login command, and sign-in / sign-out actions.
import { computed, onBeforeUnmount, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  CheckmarkCircle02Icon,
  ComputerTerminal01Icon,
  Copy01Icon,
  PlusSignIcon,
  UserCheck01Icon,
} from "@hugeicons/core-free-icons";
import { MOCK_ACCOUNTS } from "~/mockups/providers-pane/sample";
import type { MockProvidersPane } from "~/mockups/providers-pane/useMockProvidersPane";

const props = defineProps<{ pane: MockProvidersPane }>();

const row = computed(() => props.pane.current.value);
const ready = computed(() => row.value.status?.readiness === "ready");
const accounts = computed(() => MOCK_ACCOUNTS[row.value.provider] ?? []);
const chosen = ref<string | null>(null);
const activeId = computed(() => chosen.value ?? accounts.value.find((a) => a.active)?.id ?? null);
const activeAccount = computed(() => accounts.value.find((a) => a.id === activeId.value) ?? null);
const statusLabel = computed(() => {
  if (!ready.value) return "Not signed in";
  if (activeAccount.value) return `${activeAccount.value.label} · ${activeAccount.value.detail}`;
  return row.value.status?.authLabel ?? "Signed in";
});
const login = computed(() => props.pane.loginDisplay.value);
const signInLabel = computed(() => (ready.value ? "Sign in again" : "Sign in"));

const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copy() {
  try {
    await navigator.clipboard.writeText(login.value);
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied.value = false), 1_600);
  } catch {
    // A denied clipboard is not worth an error state — the command is on screen.
  }
}

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer);
});
</script>

<template>
  <div class="pa__account">
    <div class="pa__strip" role="group" aria-label="Accounts">
      <button
        v-for="account in accounts"
        :key="account.id"
        type="button"
        class="pa__acct"
        :class="{ 'pa__acct--on': account.id === activeId }"
        :aria-pressed="account.id === activeId"
        @click="chosen = account.id"
      >
        <span class="pa__accthead">
          <span class="pa__acctlabel">{{ account.label }}</span>
          <HugeiconsIcon
            v-if="account.id === activeId"
            :icon="CheckmarkCircle02Icon"
            :size="13"
            :stroke-width="1.9"
            aria-hidden="true"
          />
        </span>
        <span class="pa__acctdetail">{{ account.detail }}</span>
      </button>

      <button type="button" class="pa__acct pa__acct--add">
        <HugeiconsIcon :icon="PlusSignIcon" :size="13" :stroke-width="2" aria-hidden="true" />
        Add account
      </button>
    </div>

    <div class="pa__signin">
      <dl class="pp__facts">
        <div class="pp__factsrow">
          <dt>
            <HugeiconsIcon :icon="UserCheck01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
            Status
          </dt>
          <dd class="pp__factsval--plain" :class="{ 'pp__factsval--warn': !ready }">
            {{ statusLabel }}
          </dd>
        </div>

        <div v-if="login" class="pp__factsrow">
          <dt>
            <HugeiconsIcon
              :icon="ComputerTerminal01Icon"
              :size="14"
              :stroke-width="1.7"
              aria-hidden="true"
            />
            Login
          </dt>
          <dd class="pp__factsval--cmd">
            <code>{{ login }}</code>
            <button
              type="button"
              class="pp__copy"
              aria-label="Copy the sign-in command"
              @click="copy"
            >
              <HugeiconsIcon :icon="Copy01Icon" :size="12" :stroke-width="1.9" aria-hidden="true" />
              {{ copied ? "Copied" : "Copy" }}
            </button>
          </dd>
        </div>
      </dl>

      <div class="pa__authacts">
        <button type="button" class="pp__btn pp__btn--outline">{{ signInLabel }}</button>
        <button v-if="ready" type="button" class="pp__btn">Sign out</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── the accounts strip ───────────────────────────────────────────────────── */
.pa__strip {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.pa__acct {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  min-width: 200px;
  padding: 12px 14px;
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--pp-t-micro) ease,
    background-color var(--pp-t-micro) ease;
}
.pa__acct:hover {
  background-color: var(--hover);
}
.pa__acct:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
/* The account kone would use is the one tile that earns a full hairline. */
.pa__acct--on {
  border-color: var(--line);
}
.pa__accthead {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
}
.pa__acctlabel {
  min-width: 0;
  overflow: hidden;
  font-size: 12.5px;
  line-height: 1.3;
  letter-spacing: -0.1px;
  color: var(--ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa__accthead svg {
  flex-shrink: 0;
  color: var(--ink);
}
.pa__acctdetail {
  max-width: 100%;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.3;
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa__acct--add {
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border-style: dashed;
  border-color: var(--line);
  font-size: 12.5px;
  letter-spacing: -0.1px;
  color: var(--muted);
}
.pa__acct--add svg {
  color: var(--muted);
}

/* ── sign-in ──────────────────────────────────────────────────────────────── */
.pa__signin {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 14px;
  max-width: 520px;
  margin-top: 22px;
}
.pa__authacts {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>

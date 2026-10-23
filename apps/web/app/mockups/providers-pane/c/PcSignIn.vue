<script setup lang="ts">
// The open agent's sign-in facts, laid flat: who the credential belongs to and
// the CLI's own login command, with the one action that opens its terminal.
import { HugeiconsIcon } from "@hugeicons/vue";
import { ComputerTerminal01Icon, Copy01Icon, UserCheck01Icon } from "@hugeicons/core-free-icons";
import type { MockRow } from "~/mockups/providers-pane/useMockProvidersPane";
import { usePcCopy } from "./usePcCopy";

defineProps<{ row: MockRow; login: string }>();

const { copied, copy } = usePcCopy();
</script>

<template>
  <section class="pp__block" aria-label="Sign-in">
    <p class="pp__blocklabel">Sign-in</p>

    <dl class="pp__facts">
      <div class="pp__factsrow">
        <dt>
          <HugeiconsIcon :icon="UserCheck01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
          Account
        </dt>
        <dd
          class="pp__factsval--plain"
          :class="{ 'pp__factsval--warn': row.status?.readiness !== 'ready' }"
        >
          {{
            row.status?.readiness === "ready"
              ? (row.status.authLabel ?? "Signed in")
              : "Not signed in"
          }}
        </dd>
      </div>

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
        <dd class="pp__factsval--cmd">
          <code>{{ login }}</code>
          <button
            type="button"
            class="pp__copy"
            aria-label="Copy the sign-in command"
            @click="copy(login)"
          >
            <HugeiconsIcon :icon="Copy01Icon" :size="12" :stroke-width="1.9" aria-hidden="true" />
            {{ copied === login ? "Copied" : "Copy" }}
          </button>
        </dd>
      </div>
    </dl>

    <button type="button" class="pp__btn pp__btn--outline">
      {{ row.status?.readiness === "ready" ? "Sign in again" : "Sign in" }}
    </button>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { ArrowRight01Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import SettingsPageShell from "~/components/SettingsPageShell.vue";
import SettingsAgentDetail from "~/components/SettingsAgentDetail.vue";
import { useAgentRoster } from "~/composables/useAgentRoster";

const props = defineProps<{ open: boolean }>();
defineEmits<{ back: [] }>();

// The roster, read out — one line per agent you work with. A row now acts: it
// opens that agent's detail (SettingsAgentDetail), a nested leaf under this pane
// rather than a separate settings page. `openId` is which agent that is, or null
// for the list itself.
const { roster } = useAgentRoster();
const openId = ref<string | null>(null);

// Closing the drawer returns you to the list, so reopening it doesn't drop you
// back inside whichever agent you last looked at.
watch(
  () => props.open,
  (open) => {
    if (!open) openId.value = null;
  },
);
</script>

<template>
  <SettingsAgentDetail
    v-if="openId"
    :open="open"
    :agent-id="openId"
    @back="openId = null"
  />

  <SettingsPageShell
    v-else
    :open="open"
    breadcrumb="Ecosystem / Agents"
    :breadcrumb-icon="UserGroupIcon"
    label="Agents"
    @back="$emit('back')"
  >
    <section class="ag" aria-label="Agents">
      <ul class="ag__list">
        <li v-for="c in roster" :key="c.id" class="ag__row">
          <button
            type="button"
            class="ag__open"
            :tabindex="open ? 0 : -1"
            :aria-label="`Open ${c.name}`"
            @click="openId = c.id"
          >
            <span class="ag__face" v-html="c.svg" />
            <span class="ag__stack">
              <span class="ag__name">{{ c.name }}</span>
              <span class="ag__role">{{ c.role }}</span>
            </span>
            <HugeiconsIcon
              class="ag__go"
              :icon="ArrowRight01Icon"
              :size="15"
              :stroke-width="1.8"
              aria-hidden="true"
            />
          </button>
        </li>
      </ul>
    </section>

    <template #foot>
      An agent is whoever does the work, kept apart from the threads they do it in, so the same name
      and face follow them across every conversation. Pick one in the composer to hand it the next
      turn; leave it on Guest and the thread gets a name and a face of its own, good for that
      conversation and nothing beyond it. A named agent is told its name and, when it has them, its
      personality — who it is — and its instructions for how to work; it answers to the name, carries
      the personality, and follows the instructions. The role and face stay here in the drawer;
      nothing else about it reaches the model.
    </template>
  </SettingsPageShell>
</template>

<style scoped>
.ag {
  display: flex;
  flex-direction: column;
}

.ag__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
/* Rows on the pane surface, not cards: the spacing does the separating, so a
   team of eight reads as a list of people rather than a grid of containers. The
   list item is just the slot; the button inside it is what the pointer meets. */
.ag__row {
  display: block;
}
/* The whole row is the target that opens an agent — face, name, role and a
   trailing mark, on one borderless button. A soft wash on hover is the only
   container it ever grows, and only while the pointer is on it. */
.ag__open {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 6px 8px;
  margin-inline: -8px;
  border-radius: 10px;
  text-align: start;
  cursor: pointer;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.ag__open:hover {
  background-color: var(--hover);
}
.ag__open:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

.ag__face {
  display: block;
  flex: none;
  width: 34px;
  height: 34px;
}
.ag__face :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

.ag__stack {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1 1 auto;
  min-width: 0;
}

.ag__name {
  font-size: 15px;
  line-height: 1.2;
  color: var(--ink);
}

.ag__role {
  font-size: 12px;
  line-height: 1.2;
  color: var(--muted);
}

/* The disclosure mark: quiet until the row is under the pointer, then it settles
   into ink and steps toward the edge it opens. */
.ag__go {
  flex: none;
  color: var(--muted);
  opacity: 0;
  transform: translateX(-3px);
  transition:
    opacity 140ms ease,
    transform 140ms ease,
    color 140ms ease;
}
.ag__open:hover .ag__go,
.ag__open:focus-visible .ag__go {
  color: var(--ink);
  opacity: 1;
  transform: none;
}
@media (prefers-reduced-motion: reduce) {
  .ag__go {
    transform: none;
  }
}
</style>

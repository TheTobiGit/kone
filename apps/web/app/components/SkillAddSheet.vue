<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { SkillMutateResult, SkillRootTarget } from "~/types/desktop";
import type { useSkills } from "~/composables/useSkills";
import SkillMark from "~/components/SkillMark.vue";

// The other half of the surface: not what is installed, but how something new
// gets here. Two ways in, and the same question under both — which CLI is this
// for — because a skill folder belongs to whichever agent reads that folder,
// and picking the folder is picking the agent.

const props = defineProps<{ skills: ReturnType<typeof useSkills> }>();
const emit = defineEmits<{ done: [] }>();

const ORIGIN_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  factory: "Factory",
  agents: "Agents",
  kone: "kone",
};

const mode = ref<"write" | "fetch">("write");
const root = ref<string | null>(null);
const name = ref("");
const description = ref("");
const url = ref("");
const working = ref(false);
const result = ref<SkillMutateResult | null>(null);

onMounted(() => {
  void props.skills.loadRoots();
});

const roots = computed(() => props.skills.roots.value);

/** Land on a folder that already exists, since that is the CLI this machine is
 *  actually set up for; with none, the first is as good an answer as any. */
watch(
  roots,
  (list: SkillRootTarget[]) => {
    if (root.value || list.length === 0) return;
    root.value = (list.find((r) => r.exists) ?? list[0])?.dir ?? null;
  },
  { immediate: true },
);

function tilde(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

const chosen = computed(() => roots.value.find((r) => r.dir === root.value) ?? null);

/** A folder name is what the agent matches on, so the field is held to what a
 *  folder name can be rather than corrected after the fact. */
const slug = computed(() =>
  name.value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, ""),
);

const ready = computed(() => {
  if (!root.value || working.value) return false;
  return mode.value === "write"
    ? slug.value.length > 0 && description.value.trim().length > 0
    : /^(https?:\/\/|git@)/.test(url.value.trim());
});

async function commit() {
  if (!ready.value || !root.value) return;
  working.value = true;
  result.value =
    mode.value === "write"
      ? await props.skills.scaffold(root.value, slug.value, description.value.trim())
      : await props.skills.installFromGit(url.value.trim(), root.value);
  working.value = false;
  if (result.value.ok) {
    name.value = "";
    description.value = "";
    url.value = "";
    emit("done");
  }
}
</script>

<template>
  <section class="add" aria-label="Add a skill">
    <header class="add__head">
      <h2 class="add__title">Add a skill</h2>
      <p class="add__lede">
        Write one here, or bring one in from a repository. Either way it lands in a folder one of
        your agents already reads, and shows up in the list on the next scan.
      </p>
    </header>

    <div class="add__modes" role="group" aria-label="How to add">
      <button
        type="button"
        class="mode"
        :class="{ 'is-on': mode === 'write' }"
        @click="mode = 'write'"
      >
        Write a new one
      </button>
      <button
        type="button"
        class="mode"
        :class="{ 'is-on': mode === 'fetch' }"
        @click="mode = 'fetch'"
      >
        Bring one in
      </button>
    </div>

    <section class="field">
      <h3 class="field__label">Which agent</h3>
      <div class="roots">
        <button
          v-for="r in roots"
          :key="r.dir"
          type="button"
          class="root"
          :class="{ 'is-on': root === r.dir }"
          @click="root = r.dir"
        >
          <span class="root__name">{{ ORIGIN_LABEL[r.origin] ?? r.origin }}</span>
          <span v-if="r.scope === 'project'" class="root__scope">this project</span>
        </button>
      </div>
      <p v-if="chosen" class="field__note">
        <code>{{ tilde(chosen.dir) }}</code>
        <span v-if="!chosen.exists"> — doesn't exist yet, and will be created.</span>
      </p>
    </section>

    <template v-if="mode === 'write'">
      <section class="field">
        <h3 class="field__label">Name</h3>
        <div class="named">
          <input
            v-model="name"
            type="text"
            class="input input--mono"
            placeholder="commit-hygiene"
            aria-label="Skill name"
            @keydown.enter="commit"
          />
          <SkillMark
            class="named__mark"
            cover
            :name="slug"
            :origin="chosen?.origin ?? 'kone'"
            :muted="!slug"
          />
        </div>
        <p v-if="slug && slug !== name" class="field__note">
          Saved as <code>{{ slug }}</code
          >, since the folder name is what the agent matches on.
        </p>
      </section>

      <section class="field">
        <h3 class="field__label">Description</h3>
        <textarea
          v-model="description"
          class="input input--area"
          rows="3"
          placeholder="Write commit messages and split changes the way this repo's history does."
          aria-label="Skill description"
        />
        <p class="field__note">
          The one line every agent carries on every turn. Say when to reach for it, not what it is.
        </p>
      </section>
    </template>

    <template v-else>
      <section class="field">
        <h3 class="field__label">Repository</h3>
        <input
          v-model="url"
          type="text"
          class="input input--mono"
          placeholder="https://github.com/someone/a-skill.git"
          aria-label="Repository URL"
          @keydown.enter="commit"
        />
        <p class="field__note">
          Cloned as it is. Nothing is trusted on arrival — read what came in before you leave it on,
          the same as any other code you pull down.
        </p>
      </section>
    </template>

    <div class="add__foot">
      <button type="button" class="commit" :disabled="!ready" @click="commit">
        {{ working ? "Working…" : mode === "write" ? "Create it" : "Fetch it" }}
      </button>
      <p v-if="result" class="add__result" :class="{ 'is-bad': !result.ok }">{{ result.detail }}</p>
    </div>
  </section>
</template>

<style scoped>
.add {
  max-width: 620px;
  padding-top: 4px;
}

.add__title {
  margin: 0;
  font-size: 19px;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.add__lede {
  margin: 8px 0 0;
  max-width: 52ch;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-soft);
}

.add__modes {
  display: inline-flex;
  gap: 2px;
  margin-top: 26px;
  padding: 2px;
  border-radius: 999px;
  background-color: var(--sunken);
}
.mode {
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 12.5px;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color 160ms ease,
    color 160ms ease;
}
.mode:hover {
  color: var(--ink-soft);
}
.mode.is-on {
  background-color: var(--raised-high);
  color: var(--ink);
}
.mode:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 30%, transparent);
}

.field {
  margin-top: 26px;
}
.field__label {
  margin: 0 0 10px;
  font-size: 10px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--muted);
}
.field__note {
  margin: 8px 0 0;
  max-width: 52ch;
  font-size: 12px;
  line-height: 1.6;
  color: var(--muted);
}
.field__note code {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11.5px;
}

.roots {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.root {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 5px 11px;
  border-radius: 999px;
  font-size: 12.5px;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color 160ms ease,
    color 160ms ease;
}
.root:hover {
  background-color: var(--hover);
  color: var(--ink-soft);
}
/* The chosen folder is the one fact this screen turns on, so it is the one
   place worth spending full contrast. */
.root.is-on {
  background-color: var(--ink);
  color: var(--ground);
}
.root.is-on:hover {
  color: var(--ground);
}
.root__scope {
  font-size: 10.5px;
  opacity: 0.7;
}
.root:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 30%, transparent);
}

/* The name is the whole seed for a skill's mark, so the mark is drawn while it
   is being typed rather than discovered after the fact — the folder being named
   and the thing that will stand for it in the list are the same decision. It
   sits grey until there is a name to derive it from. */
.named {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}
.named .input {
  flex: 1;
  min-width: 0;
}
.named__mark {
  flex: 0 0 116px;
}

.input {
  width: 100%;
  padding: 9px 12px;
  border: none;
  border-radius: 10px;
  background-color: var(--field);
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink);
  transition: box-shadow 160ms ease;
}
.input::placeholder {
  color: var(--placeholder);
}
/* The field already reads as a place to type by sitting off the ground, so focus
   only has to say which one is live — a ring rather than a second surface. */
.input:focus {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 22%, transparent);
}
.input--mono {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12.5px;
}
.input--area {
  resize: vertical;
  min-height: 66px;
}

.add__foot {
  margin-top: 30px;
}
.commit {
  padding: 8px 18px;
  border-radius: 999px;
  background-color: var(--ink);
  font-size: 12.5px;
  color: var(--ground);
  cursor: pointer;
  transition:
    opacity 160ms ease,
    background-color 160ms ease;
}
.commit:disabled {
  background-color: var(--sunken);
  color: var(--muted);
  cursor: default;
}
.commit:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 30%, transparent);
}

.add__result {
  margin: 12px 0 0;
  max-width: 52ch;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-soft);
}
.add__result.is-bad {
  color: var(--danger);
}
</style>

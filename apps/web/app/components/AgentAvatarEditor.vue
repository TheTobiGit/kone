<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from "vue";
import { ImageAdd01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import { useSound } from "~/composables/useSound";
import { generateAvatar, uploadAvatar } from "~/utils/agentAvatar";
import type { AgentAvatar, AgentAvatarSource } from "~/utils/agents";
import type { DicebearStyle } from "~/utils/agentDicebear";

// A picture of the agent — what it is shown as wherever it answers. Its own
// editor and its own row, away from the bot: this one is about who is speaking.
//
// Three ways to get one, offered as three tabs rather than three stacked blocks,
// because a maker wants one picture and picking a source is the first decision,
// not a fourth thing to read past. All three land on the same stored shape — a
// downscaled picture carried by value on the agent's row — so nothing downstream
// knows or cares which was used. `source` is kept only so reopening this lands
// the maker back where they were.
//
// The drawn portraits are loaded on demand: each style carries its own library
// of parts, and none of it should sit in the app's first paint for the sake of a
// picker most launches never open.

const props = defineProps<{ avatar: AgentAvatar | null }>();
const emit = defineEmits<{ "update:avatar": [AgentAvatar | null] }>();

const { cue } = useSound();

type Source = Extract<AgentAvatarSource, "generated" | "upload" | "dicebear">;
const SOURCES: { id: Source; label: string }[] = [
  { id: "generated", label: "Generated" },
  { id: "upload", label: "Your own" },
  { id: "dicebear", label: "Drawn" },
];

/** A shipped picture has no tab of its own — it is the build's choice, not one of
 *  these — so an agent wearing one opens on the first way to replace it. */
function initialSource(): Source {
  const from = props.avatar?.source;
  return from === "upload" || from === "dicebear" ? from : "generated";
}
const source = ref<Source>(initialSource());

const busy = ref(false);
const failed = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

function pickSource(next: Source) {
  if (source.value === next) return;
  source.value = next;
  failed.value = null;
  cue("select");
  if (next === "dicebear") void loadStyles();
}

function keep(picture: AgentAvatar | null, whenEmpty: string) {
  if (!picture) {
    failed.value = whenEmpty;
    cue("error");
    return;
  }
  failed.value = null;
  cue("success");
  emit("update:avatar", picture);
}

/** The generated face is fetched, downscaled and stored by value, which takes a
 *  beat and can come back with nothing. Both facts are visible rather than
 *  swallowed: a maker who pressed the button is owed an answer either way. */
async function takeGenerated() {
  if (busy.value) return;
  busy.value = true;
  failed.value = null;
  try {
    keep(await generateAvatar(), "No face came back. Try again in a moment.");
  } finally {
    busy.value = false;
  }
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // Cleared so choosing the same file twice still counts as a change.
  input.value = "";
  if (!file || busy.value) return;
  busy.value = true;
  failed.value = null;
  try {
    keep(await uploadAvatar(file), "That file couldn't be read as a picture.");
  } finally {
    busy.value = false;
  }
}

// ── drawn portraits ─────────────────────────────────────────────────────────
const styles = shallowRef<readonly DicebearStyle[]>([]);
const seed = ref("");
const loadingStyles = ref(false);
// Held on the module once loaded, so switching tabs doesn't re-import it and
// every preview below is drawn by the same copy.
let drawing: typeof import("~/utils/agentDicebear") | null = null;

async function loadStyles() {
  if (styles.value.length || loadingStyles.value) return;
  loadingStyles.value = true;
  try {
    drawing = await import("~/utils/agentDicebear");
    seed.value = drawing.newSeed();
    styles.value = drawing.DICEBEAR_STYLES;
  } catch {
    failed.value = "The portraits couldn't be loaded.";
  } finally {
    loadingStyles.value = false;
  }
}

/** Each style shown as the portrait it would actually give, for the seed in
 *  hand — a row of style names would make the maker press six of them to see
 *  what they are. Redrawn on a shuffle, which is what makes the shuffle legible
 *  before anything is picked. */
const previews = computed(() => {
  if (!drawing || !seed.value) return [];
  const draw = drawing;
  const at = seed.value;
  return styles.value.map((style) => ({ style, src: draw.drawPortrait(style, at).src }));
});

function shuffle() {
  if (!drawing) return;
  seed.value = drawing.newSeed();
  cue("toggle");
}

function takePortrait(style: DicebearStyle) {
  if (!drawing || !seed.value) return;
  keep(drawing.drawPortrait(style, seed.value), "That portrait couldn't be drawn.");
}

function clear() {
  cue("toggle");
  failed.value = null;
  emit("update:avatar", null);
}

// An agent already wearing a portrait opens on that tab, so the styles have to
// be there without the maker picking the tab they are already on.
onMounted(() => {
  if (source.value === "dicebear") void loadStyles();
});

const generatedLabel = computed(() => {
  if (busy.value) return "Finding a face…";
  return props.avatar?.source === "generated" ? "Another" : "Give it a face";
});
</script>

<template>
  <div class="av">
    <div class="av__row">
      <span class="av__mug" :class="{ 'av__mug--empty': !avatar }" aria-hidden="true">
        <img v-if="avatar" class="av__mugimg" :src="avatar.src" alt="" draggable="false" />
        <HugeiconsIcon v-else :icon="ImageAdd01Icon" :size="18" :stroke-width="1.6" />
      </span>

      <div class="av__tabs" role="tablist" aria-label="Where the picture comes from">
        <button
          v-for="s in SOURCES"
          :key="s.id"
          type="button"
          role="tab"
          class="av__tab"
          :class="{ 'is-on': source === s.id }"
          :aria-selected="source === s.id"
          @click="pickSource(s.id)"
        >
          {{ s.label }}
        </button>
      </div>

      <button v-if="avatar" type="button" class="av__btn av__btn--quiet" @click="clear">
        Remove
      </button>
    </div>

    <!-- Generated: a face with nobody behind it. -->
    <div v-if="source === 'generated'" class="av__pane">
      <button type="button" class="av__btn" :disabled="busy" @click="takeGenerated">
        <HugeiconsIcon
          v-if="avatar?.source === 'generated'"
          :icon="RefreshIcon"
          :size="13"
          :stroke-width="1.8"
        />
        <span>{{ generatedLabel }}</span>
      </button>
    </div>

    <!-- Your own: a file off the maker's disk, put through the same downscale. -->
    <div v-else-if="source === 'upload'" class="av__pane">
      <button type="button" class="av__btn" :disabled="busy" @click="fileInput?.click()">
        {{ busy ? "Reading…" : "Choose a picture" }}
      </button>
      <span class="av__aside">Cropped square and stored at 256px.</span>
      <input
        ref="fileInput"
        class="av__file"
        type="file"
        accept="image/*"
        aria-label="Choose a picture"
        @change="onFile"
      />
    </div>

    <!-- Drawn: one portrait per style, all on the same seed, so the row is a
         choice between styles rather than between six unrelated faces. -->
    <div v-else class="av__pane av__pane--stack">
      <p v-if="loadingStyles" class="av__aside">Loading the portraits…</p>
      <template v-else-if="previews.length">
        <div class="av__portraits">
          <button
            v-for="p in previews"
            :key="p.style.id"
            type="button"
            class="av__portrait"
            :class="{ 'is-on': avatar?.src === p.src }"
            :aria-pressed="avatar?.src === p.src"
            :aria-label="p.style.label"
            :title="p.style.label"
            @click="takePortrait(p.style)"
          >
            <img :src="p.src" alt="" draggable="false" />
          </button>
        </div>
        <button type="button" class="av__btn av__btn--quiet" @click="shuffle">
          <HugeiconsIcon :icon="RefreshIcon" :size="13" :stroke-width="1.8" />
          <span>Different faces</span>
        </button>
      </template>
    </div>

    <p v-if="failed" class="av__note">{{ failed }}</p>
  </div>
</template>

<style scoped>
.av {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.av__note {
  margin: 0;
  font-size: 11.5px;
  color: var(--danger, #c0483f);
}
.av__aside {
  font-size: 11.5px;
  color: var(--muted);
}
.av__row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 2px;
}
/* The preview is round because every other mark an agent wears is, and it holds
   its size whether or not there is anything in it — so picking a picture fills a
   hole rather than pushing the row about. */
.av__mug {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  overflow: hidden;
  color: var(--muted);
}
.av__mug--empty {
  background: color-mix(in srgb, var(--ink) 5%, transparent);
}
.av__mugimg {
  width: 100%;
  height: 100%;
  object-fit: cover;
  user-select: none;
}
/* Three ways to get a picture, as a strip of words on one shared ground — the
   choice is which source, so the sources sit together rather than each carrying
   a button of its own. */
.av__tabs {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
}
.av__tab {
  padding: 5px 11px;
  border: 0;
  border-radius: 999px;
  font-size: 12px;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    color 0.16s ease;
}
.av__tab:hover {
  color: var(--ink);
}
.av__tab.is-on {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 9%, transparent);
}
.av__pane {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 32px;
}
.av__pane--stack {
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.av__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  border: 0;
  border-radius: 999px;
  font-size: 12.5px;
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    color 0.16s ease,
    opacity 0.16s ease;
}
.av__btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ink) 11%, transparent);
}
.av__btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.av__btn--quiet {
  color: var(--muted);
  background: transparent;
}
.av__btn--quiet:hover {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}
/* The native control is never shown — its own button says what it does, in the
   same voice as the other two sources. */
.av__file {
  display: none;
}
.av__portraits {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.av__portrait {
  width: 52px;
  height: 52px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  overflow: hidden;
  background: transparent;
  cursor: pointer;
  transition:
    transform 0.16s ease,
    box-shadow 0.16s ease;
}
.av__portrait img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  user-select: none;
}
.av__portrait:hover {
  transform: translateY(-1px);
}
/* The picked one is ringed rather than tinted: the portrait fills its whole
   tile, so there is no ground left to mark. */
.av__portrait.is-on {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 34%, transparent);
}
</style>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { SkillEntry, WritableSkillState } from "~/types/desktop";
import type { useSkills } from "~/composables/useSkills";
import { writableStates } from "~/composables/useSkills";
import SkillMark from "~/components/SkillMark.vue";
import SkillReach from "~/components/SkillReach.vue";
import HoldToConfirm from "~/components/HoldToConfirm.vue";
import ProviderLogo from "~/components/ProviderLogo.vue";
import type { BrandKey } from "~/utils/modelCatalog";

// One skill's own page. Everything on it is read from the file or from the
// settings file that governs it — kone states what it found and names where it
// found it, and where it found nothing it says that instead of leaving a gap
// the reader will fill in with an assumption.

const props = defineProps<{
  skill: SkillEntry;
  skills: ReturnType<typeof useSkills>;
  /** Shown under the identity block; the pane owns the project the page is for. */
  projectPath: string | null;
}>();

const emit = defineEmits<{ removed: [] }>();

const ORIGIN_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  factory: "Factory",
  agents: "Agents",
  kone: "kone",
};

const SCOPE_LABEL: Record<string, string> = {
  user: "This machine",
  project: "This project",
  plugin: "From a plugin",
  system: "Built in",
};

const detail = computed(() => props.skills.detail.value);
const signals = computed(() => props.skills.signals.value);
const findings = computed(() => props.skills.findings.value);
const stateResult = computed(() => props.skills.stateOf(props.skill));
const state = computed(() => stateResult.value?.state);

const rungs = computed(() => writableStates(props.skill.origin));
/** A ladder is only drawn when there is a file to write it to. `unsupported` is
 *  the backend's own answer and outranks the origin map — a plugin's Claude
 *  skill is owned by the plugin, whatever Claude's settings can normally hold. */
const canSwitch = computed(
  () => state.value !== undefined && state.value !== "unsupported" && rungs.value.length > 0,
);

/** The one word the title wears when this skill is not plainly on. */
const badge = computed(() => {
  switch (state.value) {
    case "disabled":
      return "Off";
    case "name-only":
      return "Name only";
    case "user-invocable-only":
      return "When asked";
    default:
      return null;
  }
});

const busy = ref(false);
const writeNote = ref<string | null>(null);

async function pick(next: WritableSkillState) {
  busy.value = true;
  writeNote.value = null;
  const result = await props.skills.setState(props.skill, next);
  busy.value = false;
  // The write's own sentence is the one shown: it names the file it touched, or
  // says why it touched nothing, and kone has no better wording to offer.
  writeNote.value = result.reason || null;
}

/** The CLI's own logomark, where one exists. Agents and kone have no mark of
 *  their own here, and get the letter tile instead of a borrowed one. */
const BRAND: Record<string, BrandKey | undefined> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  cursor: "cursor",
  factory: "droid",
};

/** Every agent that holds a copy of this name, the winner first — the same tiles
 *  the card carried, and the shortest statement of the shadowing this page
 *  spells out further down. */
const coverOrigins = computed(() =>
  [...new Set([props.skill.origin, ...props.skill.shadowedBy.map((c) => c.origin)])].slice(0, 3),
);

const removing = ref(false);
const removeNote = ref<string | null>(null);

/** The hold is the confirmation, so there is nothing further to ask. The page
 *  stays put afterwards and says what happened: leaving it while the list is
 *  still a scan behind would show the skill again and read as a failed remove. */
async function drop() {
  if (removing.value) return;
  removing.value = true;
  removeNote.value = null;
  const result = await props.skills.remove(props.skill.directory);
  removing.value = false;
  removeNote.value = result.detail;
  if (result.ok) emit("removed");
}

/** `~/…` for anything under the user's home. The renderer is never told where
 *  home is, so it is recognised by shape — the one path form every root here
 *  takes — and a path that doesn't match is printed exactly as it came. */
function tilde(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
}

function when(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** The spec sheet. Rows with nothing to say are dropped rather than printed
 *  empty — a table half full of dashes reads as a broken read. */
const rows = computed(() => {
  const d = detail.value;
  const out: { label: string; value: string; mono?: boolean }[] = [
    { label: "Origin", value: ORIGIN_LABEL[props.skill.origin] ?? props.skill.origin },
    { label: "Scope", value: SCOPE_LABEL[props.skill.scope] ?? props.skill.scope },
    { label: "Location", value: tilde(props.skill.directory), mono: true },
  ];
  if (props.skill.author) out.push({ label: "Author", value: props.skill.author });
  if (d) {
    out.push({ label: "Size", value: bytes(d.bytes) });
    out.push({ label: "Modified", value: when(d.modifiedAt) });
  }
  return out;
});

const resources = computed(() => detail.value?.resources ?? []);

/** The listing every agent reads at rest, in characters — the honest unit here,
 *  since what a skill costs before it is ever used is its name and description
 *  sitting in the prompt. */
const cost = computed(() => signals.value?.cost ?? null);
</script>

<template>
  <div class="sd">
    <!-- ── identity ─────────────────────────────────────────────────────── -->
    <header class="sd__head">
      <!-- The same generated mark the listing shows, at the size a page can
           afford — so arriving here reads as opening the card that was clicked
           rather than landing somewhere new. -->
      <SkillMark
        class="sd__cover"
        cover
        :name="skill.name"
        :origin="skill.origin"
        :muted="state === 'disabled'"
      >
        <span class="tiles">
          <span v-for="o in coverOrigins" :key="o" class="tile">
            <ProviderLogo v-if="BRAND[o]" :brand="BRAND[o]!" :size="19" />
            <span v-else class="tile__letter">{{ (ORIGIN_LABEL[o] ?? o).slice(0, 1) }}</span>
          </span>
        </span>
      </SkillMark>

      <div class="sd__id">
        <div class="sd__line">
          <h2 class="sd__name">{{ skill.displayName ?? skill.name }}</h2>
          <!-- Only the exception is worth a badge. A skill that is simply on
               says so by having nothing to say. -->
          <span v-if="badge" class="badge" :class="{ 'badge--off': state === 'disabled' }">
            {{ badge }}
          </span>
        </div>
        <p v-if="skill.description" class="sd__desc">{{ skill.description }}</p>
      </div>
    </header>

    <!-- ── reach ────────────────────────────────────────────────────────── -->
    <section class="block" aria-label="Reach">
      <p class="eyebrow">Reach</p>
      <SkillReach
        v-if="canSwitch && state"
        :state="state"
        :writable="rungs"
        :busy="busy"
        @pick="pick"
      />
      <p v-else-if="state === 'unsupported'" class="sd__note">
        {{ stateResult?.reason ?? "This CLI offers no way to turn a single skill off." }}
      </p>
      <p v-else class="sd__note">Reading this skill's setting…</p>

      <!-- Where the answer came from, and what the last write did. Both name a
           real file, so the user can go look. -->
      <p v-if="stateResult?.source" class="sd__src">{{ tilde(stateResult.source) }}</p>
      <p v-if="writeNote" class="sd__note sd__note--write">{{ writeNote }}</p>
    </section>

    <!-- ── shadowing ────────────────────────────────────────────────────── -->
    <section v-if="skill.shadowedBy.length" class="block" aria-label="Other copies">
      <p class="eyebrow">Other copies</p>
      <p class="sd__note">
        {{ skill.shadowedBy.length }}
        {{ skill.shadowedBy.length === 1 ? "other copy of this name was found" : "other copies of this name were found" }}
        and lost to the one above. The agent loads only the winner.
      </p>
      <ul class="stack">
        <li v-for="c in skill.shadowedBy" :key="c.path" class="stack__row">
          <span class="stack__origin">{{ ORIGIN_LABEL[c.origin] ?? c.origin }}</span>
          <span class="stack__path">{{ tilde(c.path) }}</span>
        </li>
      </ul>
    </section>

    <!-- ── details ──────────────────────────────────────────────────────── -->
    <section class="block" aria-label="Details">
      <p class="eyebrow">Details</p>
      <dl class="spec">
        <div v-for="r in rows" :key="r.label" class="spec__row">
          <dt class="spec__k">{{ r.label }}</dt>
          <dd class="spec__v" :class="{ 'spec__v--mono': r.mono }">{{ r.value }}</dd>
        </div>
      </dl>
    </section>

    <!-- ── what it carries ──────────────────────────────────────────────── -->
    <section v-if="resources.length" class="block" aria-label="Bundled files">
      <p class="eyebrow">Bundled files</p>
      <ul class="files">
        <li v-for="r in resources" :key="r.name" class="files__item" :class="{ 'is-dir': r.kind === 'directory' }">
          {{ r.name }}{{ r.kind === "directory" ? "/" : "" }}
        </li>
      </ul>
    </section>

    <!-- ── cost ─────────────────────────────────────────────────────────── -->
    <section v-if="cost" class="block" aria-label="Context cost">
      <p class="eyebrow">Context cost</p>
      <p class="sd__note">
        Every agent that can see this skill carries its listing —
        <span class="num">{{ cost.listingChars.toLocaleString() }}</span> characters — before the
        skill is ever used.
      </p>
      <p v-if="cost.overListingCap || cost.overSpecCap" class="sd__warn">
        That is over what a listing is meant to spend. Shortening the description gives the budget
        back to every turn.
      </p>
    </section>

    <!-- ── signals ──────────────────────────────────────────────────────── -->
    <section v-if="signals?.security.length" class="block" aria-label="What this skill does">
      <p class="eyebrow">What this skill does</p>
      <ul class="sigs">
        <li v-for="s in signals.security" :key="s.id" class="sigs__row">
          <span class="sigs__label">{{ s.label }}</span>
          <span v-if="s.detail" class="sigs__detail">{{ s.detail }}</span>
          <code v-if="s.preview" class="sigs__preview">{{ s.preview }}</code>
        </li>
      </ul>
      <p class="sd__limit">{{ signals.limitation }}</p>
    </section>

    <!-- ── authoring findings ───────────────────────────────────────────── -->
    <section v-if="findings.length" class="block" aria-label="Findings">
      <p class="eyebrow">Findings</p>
      <ul class="finds">
        <li v-for="f in findings" :key="f.id" class="finds__row" :class="`is-${f.severity}`">
          <span class="finds__dot" aria-hidden="true" />
          <span>{{ f.message }}</span>
        </li>
      </ul>
    </section>

    <!-- ── the file itself ──────────────────────────────────────────────── -->
    <section v-if="detail?.body" class="block" aria-label="SKILL.md">
      <p class="eyebrow">SKILL.md</p>
      <pre class="body">{{ detail.body }}</pre>
      <p v-if="detail.bodyTruncated" class="sd__limit">
        Shown to a limit — the file continues past this point.
      </p>
    </section>

    <!-- ── removal ──────────────────────────────────────────────────────── -->
    <section class="block" aria-label="Remove">
      <p class="eyebrow">Remove</p>
      <p class="sd__note">
        Moves the whole folder to the Trash, where it can be put back. Nothing is unlinked, and no
        settings file is touched — a skill removed this way simply stops being found.
      </p>
      <HoldToConfirm
        class="sd__remove"
        :duration="1100"
        :aria-label="`Hold to move ${skill.name} to the Trash`"
        @confirm="drop"
      >
        {{ removing ? "Moving…" : "Hold to move to Trash" }}
      </HoldToConfirm>
      <p v-if="removeNote" class="sd__note sd__note--said">{{ removeNote }}</p>
    </section>
  </div>
</template>

<style scoped>
.sd {
  display: flex;
  flex-direction: column;
  gap: 2rem;
  padding-bottom: 3rem;
}

/* ── identity ─────────────────────────────────────────────────────────────── */
.sd__head {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
/* Wider than the card's band and shallower: on a page the mark is a header, and
   a card-shaped block this size would be the whole first screen. */
.sd__cover {
  max-width: 560px;
  aspect-ratio: 32 / 9;
}
.tiles {
  display: flex;
  align-items: center;
  gap: 9px;
}
.tile {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background-color: #ffffff;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.1);
}
.tile__letter {
  font-family: var(--font-mono);
  font-size: 13px;
  color: #4a4a4a;
}
.sd__id {
  min-width: 0;
}
.sd__line {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.badge {
  padding: 2px 9px;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--muted);
  white-space: nowrap;
}
/* Off is the one state worth a colour: it is the difference between a skill the
   agent has and one it does not. */
.badge--off {
  background-color: color-mix(in oklab, var(--danger) 10%, transparent);
  color: var(--danger);
}

.sd__name {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 17px;
  line-height: 1.25;
  color: var(--ink);
}
.sd__desc {
  margin: 7px 0 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--ink-soft);
  text-wrap: pretty;
  max-width: 62ch;
}

/* ── blocks ───────────────────────────────────────────────────────────────── */
.block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.eyebrow {
  margin: 0;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}

.sd__note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--muted);
  text-wrap: pretty;
  max-width: 62ch;
}
.sd__note--write {
  color: var(--ink-soft);
}
.sd__note--said {
  color: var(--ink-soft);
}
/* Everything else on this page is text, so a destructive gesture set as text
   would be indistinguishable from the sentence above it. It rests in a faint
   field of its own hue instead — enough of a shape to be pressable, and a track
   for the hold to sweep across. */
.sd__remove {
  --hold-danger: var(--danger);
  align-self: flex-start;
  margin-top: 2px;
  padding: 7px 13px;
  border-radius: 9px;
  font-size: 12.5px;
  background-color: color-mix(in srgb, var(--danger) 8%, transparent);
}
/* Doubled to sit above the variant's own muted label — the field is already the
   action's colour, and a grey word on it reads as two objects rather than one. */
.sd__remove.sd__remove {
  color: color-mix(in srgb, var(--danger) 62%, var(--ink));
}
.sd__remove:hover,
.sd__remove.is-holding {
  background-color: color-mix(in srgb, var(--danger) 12%, transparent);
}
.sd__src {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--faint);
  overflow-wrap: anywhere;
}
.sd__warn {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--warn);
  max-width: 62ch;
}
.sd__limit {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--faint);
  max-width: 62ch;
}
.num {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--ink-soft);
}

/* ── spec sheet ───────────────────────────────────────────────────────────── */
/* Hairlines between rows and nothing around them: a table needs the reading
   rhythm, not a box. */
.spec {
  margin: 0;
  display: flex;
  flex-direction: column;
}
.spec__row {
  display: grid;
  grid-template-columns: 128px minmax(0, 1fr);
  gap: 16px;
  padding: 9px 0;
  border-top: 1px solid var(--line-soft);
}
.spec__row:first-child {
  border-top: none;
}
.spec__k {
  font-size: 12.5px;
  color: var(--muted);
}
.spec__v {
  margin: 0;
  font-size: 12.5px;
  color: var(--ink);
  overflow-wrap: anywhere;
}
.spec__v--mono {
  font-family: var(--font-mono);
  font-size: 11.5px;
}

/* ── shadowed copies ──────────────────────────────────────────────────────── */
.stack {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.stack__row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.stack__origin {
  flex-shrink: 0;
  font-size: 11.5px;
  color: var(--ink-soft);
}
.stack__path {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--faint);
  overflow-wrap: anywhere;
}

/* ── bundled files ────────────────────────────────────────────────────────── */
.files {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.files__item {
  padding: 3px 9px;
  border-radius: 7px;
  background-color: color-mix(in srgb, var(--ink) 4%, transparent);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}
.files__item.is-dir {
  color: var(--ink-soft);
}

/* ── signals ──────────────────────────────────────────────────────────────── */
.sigs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sigs__row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.sigs__label {
  font-size: 12.5px;
  color: var(--ink);
}
.sigs__detail {
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
  max-width: 62ch;
}
.sigs__preview {
  margin-top: 2px;
  padding: 6px 9px;
  border-radius: 8px;
  background-color: var(--code-bg);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-soft);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

/* ── findings ─────────────────────────────────────────────────────────────── */
.finds {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.finds__row {
  display: flex;
  align-items: baseline;
  gap: 9px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-soft);
  max-width: 62ch;
}
.finds__dot {
  flex-shrink: 0;
  width: 5px;
  height: 5px;
  margin-top: 1px;
  border-radius: 50%;
  background-color: var(--muted);
}
.finds__row.is-error .finds__dot {
  background-color: var(--danger);
}
.finds__row.is-warning .finds__dot {
  background-color: var(--warn);
}

/* ── the file ─────────────────────────────────────────────────────────────── */
.body {
  margin: 0;
  padding: 14px 16px;
  border-radius: 12px;
  background-color: var(--code-bg);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--ink-soft);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 460px;
  overflow-y: auto;
  scrollbar-width: none;
}
.body::-webkit-scrollbar {
  width: 0;
}
</style>

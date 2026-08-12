<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AiChipIcon,
  CommandIcon,
  Copy01Icon,
  File01Icon,
  Folder01Icon,
  FolderOpenIcon,
  Layers01Icon,
  RefreshIcon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/SettingsPageShell.vue";
import ProviderLogo from "~/components/ProviderLogo.vue";
import { useEdgeFade } from "~/composables/useEdgeFade";
import type { BrandKey } from "~/utils/modelCatalog";
import type { SkillDetail, SkillEntry } from "~/types/desktop";

// Skills in settings — the whole set of skills the agent CLIs on this machine can
// reach for, and one skill's full story. Read-only by nature: kone scans disk and
// reports; nothing here writes to a SKILL.md or turns one off (the CLIs own that,
// and lying about ownership would be worse than a missing switch).
//
// Two views in one pane, because they are one subject at two depths:
//   • the index — every skill as a row, filterable by the CLI that offers it
//   • the detail — one skill: what the agent reads, where it lives, what it ships
// The shell's back glyph steps *out* of the detail first and only then leaves the
// pane, so the trail in the breadcrumb is the trail the button walks.

defineProps<{ open: boolean }>();
defineEmits<{ back: [] }>();

const { cue } = useSound();
// The pane is global — a skill belongs to the machine, not to a project — but if a
// project is open, its own `.claude/skills` (and the rest of its ancestor chain)
// are part of what the agents there can reach, so they belong in the list too,
// marked as project-scoped rather than quietly folded in with the user's own.
const project = useProject();
const space = useAgentSpace(() => project.value?.path ?? null);

/** The CLI a skill was found under, as a person would name it, plus the logomark
 *  that names it faster than the word does. `agents` is the cross-CLI `.agents`
 *  convention rather than a product, so it gets the neutral dot. */
const ORIGIN: Record<string, { label: string; brand: BrandKey }> = {
  claude: { label: "Claude", brand: "claude" },
  codex: { label: "Codex", brand: "gpt" },
  opencode: { label: "OpenCode", brand: "opencode" },
  cursor: { label: "Cursor", brand: "cursor" },
  agents: { label: "Agents", brand: "generic" },
  kone: { label: "kone", brand: "generic" },
};
const originLabel = (origin: string): string => ORIGIN[origin]?.label ?? origin;
const originBrand = (origin: string): BrandKey => ORIGIN[origin]?.brand ?? "generic";

/** Scope as an answer to "where does this apply", not as a database value — the
 *  four raw scopes turned into words a person reads once. */
const SCOPE_LABEL: Record<SkillEntry["scope"], string> = {
  user: "Yours",
  project: "This project",
  plugin: "From a plugin",
  system: "System",
};

// ── the list ─────────────────────────────────────────────────────────────────
const query = ref("");
/** null = every origin. A chip filter rather than the old origin grouping: with
 *  the mark on every row saying where a skill came from, sections were repeating
 *  what the rows already said, and a flat alphabetical list is the one that
 *  answers "do I have X" at a glance. */
const originFilter = ref<string | null>(null);

const skills = computed<SkillEntry[]>(() => space.inventory.value?.skills ?? []);
const total = computed(() => skills.value.length);

/** One chip per origin actually present, busiest first — the list never offers a
 *  filter that would empty it. */
const originChips = computed(() => {
  const counts = new Map<string, number>();
  for (const s of skills.value) counts.set(s.origin, (counts.get(s.origin) ?? 0) + 1);
  return [...counts.entries()]
    .map(([origin, count]) => ({ origin, count, label: originLabel(origin) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
});

const nameOf = (s: SkillEntry): string => s.displayName ?? s.name;
const blurbOf = (s: SkillEntry): string => s.shortDescription ?? s.description ?? "";

/** The chip's slice, before the query narrows it — what the search box is
 *  actually searching, and so the number its placeholder has to name. */
const inScope = computed<SkillEntry[]>(() =>
  originFilter.value ? skills.value.filter((s) => s.origin === originFilter.value) : skills.value,
);

const filtered = computed<SkillEntry[]>(() => {
  const q = query.value.trim().toLowerCase();
  return inScope.value
    .filter((s) =>
      q
        ? nameOf(s).toLowerCase().includes(q) ||
          s.name.toLowerCase().includes(q) ||
          blurbOf(s).toLowerCase().includes(q)
        : true,
    )
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
});

/** The placeholder counts the chip's slice, not the machine's total — offering to
 *  "search 12 skills" while five are showing promises a reach the box doesn't
 *  have. With a chip on, it names the CLI too, so the narrowing is legible from
 *  inside the field you're about to type in. */
const searchLabel = computed(() => {
  const n = inScope.value.length;
  if (!n) return "Search skills";
  const origin = originFilter.value;
  return origin ? `Search ${n} ${originLabel(origin)} skills` : `Search ${n} skills`;
});

const loading = computed(() => space.inventoryLoading.value && !space.inventoryLoaded.value);
/** "Nothing on this machine" and "your search matched nothing" are different
 *  sentences; saying the first when the second is true would be a lie. */
const empty = computed(() => space.inventoryLoaded.value && !loading.value && total.value === 0);
const noMatch = computed(() => !loading.value && total.value > 0 && filtered.value.length === 0);
/** Only the failures this pane is answerable for — an unreadable MCP config has
 *  no business surfacing under Skills, but a skills root kone couldn't read does:
 *  a short list for an unreadable reason is a lie. */
const errors = computed(
  () => space.inventory.value?.errors.filter((e) => /skill/i.test(e.source)) ?? [],
);

function setOrigin(origin: string | null): void {
  if (origin === originFilter.value) return;
  cue("press");
  originFilter.value = origin;
}

const refreshing = ref(false);
async function onRefresh(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  cue("press");
  try {
    await space.refreshInventory();
  } finally {
    refreshing.value = false;
  }
}

// ── one skill ────────────────────────────────────────────────────────────────
const selected = ref<SkillEntry | null>(null);
const detail = ref<SkillDetail | null>(null);
const detailLoading = ref(false);
/** Read once per SKILL.md and kept for the life of the pane: stepping back into a
 *  skill you just looked at should be instant, and the file can't change under a
 *  scan the user hasn't asked for. */
const detailCache = new Map<string, SkillDetail | null>();

async function openSkill(skill: SkillEntry): Promise<void> {
  cue("press");
  selected.value = skill;
  bandOpen.value = false;
  const cached = detailCache.get(skill.path);
  if (cached !== undefined) {
    detail.value = cached;
    return;
  }
  detail.value = null;
  detailLoading.value = true;
  try {
    const read = (await window.koneDesktop?.agent?.inventory?.readSkill?.(skill.path)) ?? null;
    detailCache.set(skill.path, read);
    // The user may have stepped back out while the file was being read.
    if (selected.value?.path === skill.path) detail.value = read;
  } catch (err) {
    console.error("[SettingsAgentSkillsPane] skill read failed:", err);
  } finally {
    detailLoading.value = false;
  }
}

function onBack(): void {
  if (!selected.value) return; // the shell's own emit takes it back to root
  cue("toggle");
  selected.value = null;
  detail.value = null;
}

const breadcrumb = computed(() =>
  selected.value ? `Agents / Skills / ${nameOf(selected.value)}` : "Agents / Skills",
);

/** The head chip. A skill that opts out of automatic invocation is still there —
 *  the model just won't reach for it unasked — and that is the one piece of a
 *  skill's state worth stating up front. */
const invocation = computed(() =>
  selected.value?.manualOnly
    ? { label: "Asked for by name", auto: false }
    : { label: "Invoked automatically", auto: true },
);

/** What the agent actually reads when it decides whether to use this skill: the
 *  full `description` frontmatter, verbatim. The band exists because that string
 *  is the skill's real interface and every other surface truncates it. */
const trigger = computed(() => selected.value?.description ?? selected.value?.shortDescription ?? "");

/** The band is the page's one warm object; it earns that by being an invocation
 *  you can read at a glance, not a wall. Long trigger strings (skills routinely
 *  write a paragraph of "use this when…") clamp to four lines and open on ask. */
const bandOpen = ref(false);
const triggerIsLong = computed(() => trigger.value.length > 240);

/** The line under the title — dropped when the band below is about to say the
 *  same sentence. Most SKILL.md files carry one description and nothing else, so
 *  showing it twice sixty pixels apart is the common case, not the rare one; when
 *  a skill does write a separate short-description, both lines earn their place. */
const lede = computed(() => {
  const s = selected.value;
  if (!s) return "";
  const blurb = blurbOf(s);
  return blurb && blurb !== trigger.value ? blurb : "";
});

const bundled = computed(() => detail.value?.resources ?? []);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

const modified = computed(() => {
  const at = detail.value?.modifiedAt;
  if (!at) return null;
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
});

/** The one line the "SKILL.md" row carries: how big the file is and when it last
 *  changed, which are two halves of the same fact and read worse apart. */
const fileMeta = computed(() => {
  if (!detail.value) return null;
  const size = formatBytes(detail.value.bytes);
  return modified.value ? `${size} · edited ${modified.value}` : size;
});

const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copyPath(): Promise<void> {
  const path = selected.value?.path;
  if (!path) return;
  try {
    await navigator.clipboard.writeText(path);
    cue("success");
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 1600);
  } catch {
    cue("error");
  }
}

function revealFolder(): void {
  const dir = selected.value?.directory;
  if (!dir) return;
  cue("press");
  void window.koneDesktop?.system?.reveal(dir);
}

// The pane's own scroller (the shell's is off) so the search field and the origin
// chips stay put while a long list runs under them.
const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);

onMounted(() => {
  // Inventory only — `space.load()` would also fan out to the usage scan and a
  // round of quota reads this pane shows nothing of.
  void space.refreshInventory();
});
</script>

<template>
  <SettingsPageShell
    :open="open"
    :breadcrumb="breadcrumb"
    label="Agent skills settings"
    :scroll="false"
    @back="selected ? onBack() : $emit('back')"
  >
    <template #actions>
      <button type="button" class="sk__btn" :disabled="refreshing" @click="onRefresh">
        <HugeiconsIcon
          class="sk__btnglyph"
          :class="{ 'sk__btnglyph--spin': refreshing }"
          :icon="RefreshIcon"
          :size="13"
          :stroke-width="2"
          aria-hidden="true"
        />
        <span>Rescan</span>
      </button>
    </template>

    <!-- ── the index ──────────────────────────────────────────────────────── -->
    <template v-if="!selected">
      <div class="sk__filters">
        <input
          v-model="query"
          type="search"
          class="sk__search"
          :placeholder="searchLabel"
          :tabindex="open ? 0 : -1"
          aria-label="Search skills"
        />
        <div v-if="originChips.length > 1" class="sk__chips" role="group" aria-label="Filter by CLI">
          <button
            type="button"
            class="sk__chip"
            :class="{ 'sk__chip--on': originFilter === null }"
            :tabindex="open ? 0 : -1"
            :aria-pressed="originFilter === null"
            @click="setOrigin(null)"
          >
            All
          </button>
          <button
            v-for="c in originChips"
            :key="c.origin"
            type="button"
            class="sk__chip"
            :class="{ 'sk__chip--on': originFilter === c.origin }"
            :tabindex="open ? 0 : -1"
            :aria-pressed="originFilter === c.origin"
            @click="setOrigin(c.origin)"
          >
            <ProviderLogo :brand="originBrand(c.origin)" :size="12" class="sk__chipmark" />
            {{ c.label }}
            <span class="sk__chipcount">{{ c.count }}</span>
          </button>
        </div>
      </div>

      <div ref="scroller" class="sk__scroll" :style="maskStyle" @scroll.passive="measure">
        <ul v-if="loading" class="sk__ghosts" aria-hidden="true">
          <li v-for="n in 8" :key="n" class="sk__ghost" :style="{ animationDelay: `${n * 90}ms` }" />
        </ul>

        <p v-else-if="empty" class="sk__note">
          No skills on this machine yet. Drop a folder with a
          <span class="sk__mono">SKILL.md</span> into
          <span class="sk__mono">~/.claude/skills</span> — or any CLI's equivalent — and rescan.
        </p>

        <p v-else-if="noMatch" class="sk__note">Nothing matches “{{ query }}”.</p>

        <ul v-else class="sk__rows">
          <li v-for="s in filtered" :key="s.path">
            <button type="button" class="sk__row" :tabindex="open ? 0 : -1" @click="openSkill(s)">
              <span class="sk__mark">
                <ProviderLogo :brand="originBrand(s.origin)" :size="17" />
              </span>
              <span class="sk__rowtext">
                <span class="sk__rowname">{{ nameOf(s) }}</span>
                <span class="sk__rowblurb">{{ blurbOf(s) || "No description" }}</span>
              </span>
              <span class="sk__rowscope">{{ SCOPE_LABEL[s.scope] }}</span>
            </button>
          </li>
        </ul>

        <ul v-if="errors.length && !loading" class="sk__errors">
          <li v-for="e in errors" :key="e.source">couldn't read {{ e.source }} — {{ e.message }}</li>
        </ul>
      </div>
    </template>

    <!-- ── one skill ──────────────────────────────────────────────────────── -->
    <div v-else ref="scroller" class="sk__scroll" :style="maskStyle" @scroll.passive="measure">
      <header class="sk__head">
        <span class="sk__headmark">
          <ProviderLogo :brand="originBrand(selected.origin)" :size="22" />
        </span>
        <div class="sk__headline">
          <h2 class="sk__title">{{ nameOf(selected) }}</h2>
          <span class="sk__state" :class="{ 'sk__state--auto': invocation.auto }">
            {{ invocation.label }}
          </span>
        </div>
        <p v-if="lede" class="sk__lede">{{ lede }}</p>
      </header>

      <!-- The band: the description string the model itself reads, set as the
           agent sees it — a named pill, then the trigger prose. -->
      <section v-if="trigger" class="sk__band" aria-label="What the agent reads">
        <p class="sk__bandcap">What the agent reads</p>
        <p class="sk__bandline">
          <span class="sk__pill">
            <ProviderLogo :brand="originBrand(selected.origin)" :size="12" />
            {{ invocation.auto ? selected.name : `/${selected.name}` }}
          </span>
          <span class="sk__bandtext" :class="{ 'sk__bandtext--clamp': !bandOpen }">{{ trigger }}</span>
        </p>
        <button
          v-if="triggerIsLong"
          type="button"
          class="sk__bandmore"
          :tabindex="open ? 0 : -1"
          @click="bandOpen = !bandOpen"
        >
          {{ bandOpen ? "Show less" : "Show all" }}
        </button>
      </section>

      <!-- Details: an icon-labelled left column, one hairline per fact, no box
           around any of it. -->
      <section class="sk__section" aria-label="Details">
        <h3 class="sk__h">Details</h3>
        <dl class="sk__table">
          <!-- Only when the two differ. A skill whose display name IS its
               frontmatter name would have this row repeat the title and the
               band's pill, and a table's first fact shouldn't be one you've
               already read twice. -->
          <div v-if="selected.name !== nameOf(selected)" class="sk__tr">
            <dt><HugeiconsIcon :icon="CommandIcon" :size="14" :stroke-width="1.7" aria-hidden="true" />Invoked as</dt>
            <dd class="sk__mono">{{ selected.name }}</dd>
          </div>
          <div class="sk__tr">
            <dt><HugeiconsIcon :icon="AiChipIcon" :size="14" :stroke-width="1.7" aria-hidden="true" />Offered by</dt>
            <dd class="sk__ddmark">
              <ProviderLogo :brand="originBrand(selected.origin)" :size="15" />
              {{ originLabel(selected.origin) }}
            </dd>
          </div>
          <div class="sk__tr">
            <dt><HugeiconsIcon :icon="UserIcon" :size="14" :stroke-width="1.7" aria-hidden="true" />Reaches</dt>
            <dd>{{ SCOPE_LABEL[selected.scope] }}</dd>
          </div>
          <div class="sk__tr">
            <dt><HugeiconsIcon :icon="Folder01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />Folder</dt>
            <dd class="sk__ddpath">
              <span class="sk__mono sk__path" :title="selected.directory">{{ selected.directory }}</span>
              <span class="sk__pathacts">
                <button type="button" class="sk__ghostbtn" :tabindex="open ? 0 : -1" @click="copyPath">
                  <HugeiconsIcon :icon="Copy01Icon" :size="12" :stroke-width="1.8" aria-hidden="true" />
                  {{ copied ? "Copied" : "Copy" }}
                </button>
                <button type="button" class="sk__ghostbtn" :tabindex="open ? 0 : -1" @click="revealFolder">
                  <HugeiconsIcon :icon="FolderOpenIcon" :size="12" :stroke-width="1.8" aria-hidden="true" />
                  Reveal
                </button>
              </span>
            </dd>
          </div>
          <div class="sk__tr">
            <dt><HugeiconsIcon :icon="File01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />SKILL.md</dt>
            <dd>
              <span v-if="fileMeta">{{ fileMeta }}</span>
              <span v-else class="sk__dim">{{ detailLoading ? "reading…" : "—" }}</span>
            </dd>
          </div>
          <div v-if="bundled.length" class="sk__tr">
            <dt><HugeiconsIcon :icon="Layers01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />Ships with</dt>
            <dd class="sk__bundles">
              <span v-for="r in bundled" :key="r.name" class="sk__bundle">
                {{ r.name }}<template v-if="r.kind === 'directory'">/</template>
              </span>
            </dd>
          </div>
          <div v-if="selected.shadowedBy.length" class="sk__tr">
            <dt><HugeiconsIcon :icon="Layers01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />Shadows</dt>
            <dd class="sk__shadows">
              <p class="sk__shadowlede">
                {{ selected.shadowedBy.length }} other cop{{ selected.shadowedBy.length === 1 ? "y" : "ies" }}
                of this name {{ selected.shadowedBy.length === 1 ? "is" : "are" }} on disk and
                {{ selected.shadowedBy.length === 1 ? "isn't" : "aren't" }} used.
              </p>
              <span v-for="c in selected.shadowedBy" :key="c.path" class="sk__mono sk__shadow" :title="c.path">
                {{ originLabel(c.origin) }} · {{ c.path }}
              </span>
            </dd>
          </div>
        </dl>
      </section>

      <!-- The instructions themselves. Last, because it is the longest thing here
           and the only one you read rather than scan. -->
      <section class="sk__section" aria-label="Instructions">
        <h3 class="sk__h">Instructions</h3>
        <p v-if="detailLoading && !detail" class="sk__note sk__note--tight">Reading SKILL.md…</p>
        <p v-else-if="!detail" class="sk__note sk__note--tight">
          kone couldn't read this SKILL.md — it may have moved since the last scan.
        </p>
        <template v-else>
          <pre class="sk__body">{{ detail.body || "This SKILL.md has frontmatter but no body." }}</pre>
          <p v-if="detail.bodyTruncated" class="sk__dim sk__truncated">
            Shown up to the first 20,000 characters — open the file for the rest.
          </p>
        </template>
      </section>
    </div>

    <template #foot>
      Every skill above is read from disk exactly as it sits there — kone never edits a
      <span class="sk__mono">SKILL.md</span>, and never turns one off. Which of them an agent can
      actually reach is its own CLI's decision.
    </template>
  </SettingsPageShell>
</template>

<style scoped>
/* ── shared ───────────────────────────────────────────────────────────────── */
.sk__mono {
  font-family: var(--font-mono);
}
.sk__dim {
  color: var(--muted);
}
.sk__note {
  padding: 1.75rem 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--muted);
  max-width: 56ch;
  text-wrap: pretty;
}
.sk__note--tight {
  padding: 0.5rem 0 0;
}

.sk__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding-inline: 10px;
  border-radius: 8px;
  font-size: 11px;
  color: var(--ink-soft);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color 140ms ease,
    opacity 140ms ease;
}
.sk__btn:hover:not(:disabled) {
  background-color: var(--hover);
}
.sk__btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.sk__btnglyph--spin {
  animation: sk-spin 900ms linear infinite;
}
@keyframes sk-spin {
  to {
    transform: rotate(360deg);
  }
}

/* The pane runs its own scroller (the shell's is off) so the filter bar can stay
   put; the smoke is the shell's, from the same composable. */
.sk__scroll {
  flex: 1;
  min-height: 0;
  padding: 0 1rem 0.5rem;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
}
.sk__scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}

/* ── filter bar ───────────────────────────────────────────────────────────── */
.sk__filters {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex-shrink: 0;
  padding: 0 1rem 14px;
}
/* A field with no frame: one hairline under it, which the accent takes on focus.
   Same recipe as the agents space's search, so the two read as one control. */
.sk__search {
  width: 100%;
  background: transparent;
  border: none;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 11%, transparent);
  padding: 5px 0;
  font-size: 13px;
  color: var(--ink);
  outline: none;
  transition: border-color 160ms ease;
}
.sk__search::placeholder {
  color: var(--muted);
}
.sk__search:focus {
  border-bottom-color: color-mix(in srgb, var(--accent) 70%, transparent);
}
.sk__search::-webkit-search-decoration,
.sk__search::-webkit-search-cancel-button {
  -webkit-appearance: none;
}

.sk__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
/* Soft-filled pills: kone marks the active thing with a wash, and a hard black
   chip would be the loudest object on any settings page. */
.sk__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 25px;
  padding-inline: 9px;
  border-radius: 999px;
  font-size: 11.5px;
  letter-spacing: -0.1px;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.sk__chip:hover {
  background-color: var(--hover);
  color: var(--ink-soft);
}
/* 11.5%, not 7%: the wash has to win a glance against six neighbours — at 7% it
   read as hover, not as selected. */
.sk__chip--on {
  background-color: color-mix(in srgb, var(--ink) 11.5%, transparent);
  color: var(--ink);
}
.sk__chip--on .sk__chipcount {
  opacity: 0.75;
}
.sk__chip:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 30%, transparent);
}
.sk__chipmark {
  opacity: 0.9;
}
.sk__chipcount {
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  opacity: 0.6;
}

/* ── rows ─────────────────────────────────────────────────────────────────── */
/* Two columns where there's room: the list is long, every row is short, and one
   column strands half the page. */
/* 380px, not 320: a second column only earns its place once each half can hold
   tile + name + blurb + scope word without any of them fighting. */
.sk__rows {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  column-gap: 28px;
  row-gap: 1px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.sk__row {
  display: flex;
  align-items: center;
  gap: 13px;
  width: 100%;
  padding: 11px 11px;
  border-radius: 12px;
  text-align: left;
  cursor: pointer;
  transition: background-color 140ms ease;
}
.sk__row:hover {
  background-color: var(--hover);
}
.sk__row:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 30%, transparent);
}
/* The logomark tile — a wash rather than a filled tile, so it doesn't read as a
   card. */
.sk__mark {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background-color: color-mix(in srgb, var(--ink) 4.5%, transparent);
}
.sk__rowtext {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
}
.sk__rowname {
  font-size: 13px;
  letter-spacing: -0.1px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sk__rowblurb {
  font-size: 11.5px;
  line-height: 1.35;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sk__rowscope {
  flex-shrink: 0;
  font-size: 10.5px;
  letter-spacing: 0.01em;
  color: var(--muted);
  opacity: 0.85;
  transition:
    color 140ms ease,
    opacity 140ms ease;
}
/* The row's only hover tell besides the wash — the word firms up rather than a
   glyph flying in. */
.sk__row:hover .sk__rowscope,
.sk__row:focus-visible .sk__rowscope {
  color: var(--ink-soft);
  opacity: 1;
}
/* No trailing chevron. A row gets one right-side mark, and this one spends it on
   the scope word — an arrow appearing on hover behind it was two affordances
   arguing in one 40px column. The whole row is the button. */

.sk__errors {
  list-style: none;
  margin: 1.5rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--muted);
}

.sk__ghosts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  column-gap: 28px;
  row-gap: 1px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.sk__ghost {
  height: 60px;
  border-radius: 11px;
  background-color: color-mix(in srgb, var(--ink) 4.5%, transparent);
  animation: sk-breathe 1700ms ease-in-out infinite;
}
@keyframes sk-breathe {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}

/* ── detail head ──────────────────────────────────────────────────────────── */
.sk__head {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 22px;
}
.sk__headmark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 13px;
  background-color: color-mix(in srgb, var(--ink) 4.5%, transparent);
}
.sk__headline {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.sk__title {
  font-size: 21px;
  letter-spacing: -0.4px;
  line-height: 1.15;
  color: var(--ink);
}
/* A state badge in the one accent kone owns. Automatic invocation is the norm, so
   it carries the tint and the opt-out stays neutral — the unusual state shouldn't
   be the loud one. */
.sk__state {
  padding: 3px 8px;
  border-radius: 7px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  font-size: 10.5px;
  letter-spacing: 0.01em;
  color: var(--muted);
  white-space: nowrap;
}
.sk__state--auto {
  background-color: color-mix(in srgb, var(--accent) 13%, transparent);
  color: color-mix(in srgb, var(--accent) 82%, var(--ink));
}
.sk__lede {
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--muted);
  max-width: 64ch;
  text-wrap: pretty;
}

/* ── the band ─────────────────────────────────────────────────────────────── */
/* One soft accent wash, no texture, no shadow — carrying the only sentence the
   model itself gets to read. */
.sk__band {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border-radius: 14px;
  background:
    radial-gradient(120% 140% at 8% 0%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 62%),
    linear-gradient(100deg, color-mix(in srgb, var(--accent) 7%, transparent), transparent 78%);
}
.sk__bandcap {
  font-size: 9.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}
.sk__bandline {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--ink-soft);
  text-wrap: pretty;
}
/* The named pill — the skill saying its own name before the sentence that
   describes it. */
.sk__pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  padding: 3px 9px;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ground) 82%, white 18%);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink);
}
.sk__bandtext {
  flex: 1 1 220px;
  min-width: 0;
}
.sk__bandtext--clamp {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
}
.sk__bandmore {
  align-self: flex-start;
  font-size: 11px;
  color: color-mix(in srgb, var(--accent) 78%, var(--ink));
  cursor: pointer;
  transition: opacity 140ms ease;
}
.sk__bandmore:hover {
  opacity: 0.75;
}
.sk__bandmore:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 30%, transparent);
  border-radius: 5px;
}

/* ── sections + table ─────────────────────────────────────────────────────── */
.sk__section {
  padding-top: 26px;
}
.sk__h {
  margin-bottom: 12px;
  font-size: 13px;
  letter-spacing: -0.1px;
  color: var(--ink);
}
/* A key/value table: a fixed label column, one hairline per row, and no frame
   around the whole thing. */
.sk__table {
  display: flex;
  flex-direction: column;
}
.sk__tr {
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
  padding: 11px 2px;
  border-top: 1px solid color-mix(in srgb, var(--ink) 6.5%, transparent);
}
.sk__tr:last-child {
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 6.5%, transparent);
}
.sk__tr dt {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--muted);
}
.sk__tr dd {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink);
  min-width: 0;
}
.sk__ddmark {
  display: flex;
  align-items: center;
  gap: 7px;
}
.sk__ddpath {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
}
.sk__path {
  font-size: 11.5px;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sk__pathacts {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 140ms ease;
}
.sk__tr:hover .sk__pathacts,
.sk__pathacts:focus-within {
  opacity: 1;
}
.sk__ghostbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding-inline: 7px;
  border-radius: 6px;
  font-size: 10.5px;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.sk__ghostbtn:hover {
  background-color: var(--hover);
  color: var(--ink);
}
.sk__ghostbtn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 30%, transparent);
}

.sk__bundles {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.sk__bundle {
  padding: 2px 7px;
  border-radius: 6px;
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--ink-soft);
}

.sk__shadows {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.sk__shadowlede {
  font-size: 12.5px;
  color: var(--ink);
  text-wrap: pretty;
}
.sk__shadow {
  font-size: 10.5px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── instructions ─────────────────────────────────────────────────────────── */
/* The file as written: a soft sunken slab with its own scroll, because this is the
   one thing on the page you read top-to-bottom. */
.sk__body {
  max-height: 380px;
  padding: 14px 16px;
  border-radius: 12px;
  background-color: color-mix(in srgb, var(--ink) 3.5%, transparent);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--ink-soft);
  white-space: pre-wrap;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 16%, transparent) transparent;
}
.sk__truncated {
  margin-top: 8px;
  font-size: 11px;
}

@media (max-width: 720px) {
  .sk__tr {
    grid-template-columns: minmax(0, 1fr);
    gap: 5px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sk__ghost {
    animation: none;
    opacity: 0.7;
  }
  .sk__rowscope,
  .sk__pathacts,
  .sk__search {
    transition: none;
  }
  .sk__btnglyph--spin {
    animation: none;
  }
}
</style>

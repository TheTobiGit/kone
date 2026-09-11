<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { IdIcon, NoteIcon } from "@hugeicons/core-free-icons";
import type { SkillEntry } from "~/types/desktop";
import { isKoneEnabled as isKoneGateEnabled, writableStates, type useSkills } from "~/composables/useSkills";
import { useRecentProjects } from "~/composables/useRecentProjects";
import { useMarkdown } from "~/composables/useMarkdown";
import DetailTable from "~/components/ui/DetailTable.vue";
import DetailTabs from "~/components/ui/DetailTabs.vue";
import ToggleSwitch from "~/components/ui/ToggleSwitch.vue";
import type { DetailTab } from "~/composables/useDetailTabs";
import { brandsForOrigin, originLabel as originLabelFor, type DetailTableRow } from "~/utils/detailFormat";

const props = defineProps<{
  skill: SkillEntry;
  skills: ReturnType<typeof useSkills>;
}>();

const emit = defineEmits<{ back: [] }>();

const detail = computed(() => props.skills.detail.value);
const loading = computed(() => props.skills.detailLoading.value);

const stateResult = computed(() => props.skills.stateOf(props.skill));

const originLabel = computed(() => originLabelFor(props.skill.origin));

const isSwitchable = computed(() => {
  const s = stateResult.value?.state;
  if (s === "unsupported") return false;
  if (props.skill.scope === "plugin" || props.skill.scope === "system") return false;
  return writableStates(props.skill.origin).length > 0;
});

const cliEnabled = computed(() =>
  stateResult.value ? stateResult.value.state !== "disabled" : props.skill.enabled,
);
const cliReason = computed(() => stateResult.value?.reason ?? null);
const cliSource = computed(() => stateResult.value?.source ?? null);
const busyCli = ref(false);

const isKoneEnabled = computed(() => isKoneGateEnabled(props.skill));
const busyKone = computed(() => props.skills.isSkillBusy(props.skill));

async function toggleKoneState(enabled: boolean) {
  // Single coordinated write: CLI restore plus kone gate, ordered inside.
  await props.skills.setEffectiveEnabled(props.skill, enabled);
}

async function toggleCliState(enabled: boolean) {
  if (busyCli.value || props.skills.isSkillBusy(props.skill)) return;
  busyCli.value = true;
  try {
    await props.skills.setState(props.skill, enabled ? "enabled" : "disabled");
  } finally {
    busyCli.value = false;
  }
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
}
function tilde(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

const { recents } = useRecentProjects();
const { render: renderMd } = useMarkdown();

// The SKILL.md brief as page prose, not a code box: rendered through the same
// safe parser the file preview uses (raw HTML escaped, links externalised).
// Tri-state so the raw fallback only shows when rendering definitively declines
// (server, or a body past the render cap) — never as a flash while it resolves.
const renderedBody = ref<string | null | undefined>(undefined);
let bodyToken = 0;
watch(
  () => detail.value?.body,
  async (body) => {
    const mine = ++bodyToken;
    renderedBody.value = undefined;
    if (!body) return;
    const html = await renderMd(body);
    if (mine === bodyToken) renderedBody.value = html;
  },
  { immediate: true },
);
function projectsFor(s: SkillEntry): string[] {
  if (s.scope !== "project") return [];
  const p = s.path;
  let best: { path: string; name: string } | null = null;
  for (const r of recents.value) {
    if (p.startsWith(r.path + "/") && (!best || r.path.length > best.path.length)) {
      best = { path: r.path, name: r.name ?? r.path.split("/").pop() ?? r.path };
    }
  }
  const label = best ? best.name : p.split("/").slice(-3, -2)[0] ?? "project";
  return [label];
}

const scopeLabel = computed(() => {
  const s = props.skill;
  if (s.scope === "project") {
    const names = projectsFor(s);
    return names.length ? names.join(", ") : "Project";
  }
  // ownership: anything not project-owned is global-owned (user, system, plugin, etc.)
  return "Global";
});

const rows = computed<DetailTableRow[]>(() => {
  const d = detail.value;
  const s = props.skill;
  // One entry per truth about the skill, keyed by a stable id — never by the
  // display label, so renaming a label can't rewire the Origin logomarks.
  const table: DetailTableRow[] = [
    { id: "name", label: "Name", text: s.displayName ?? s.name },
    { id: "description", label: "Description", text: s.description ?? s.shortDescription ?? "—" },
    { id: "origin", label: "Origin", text: originLabel.value, brands: brandsForOrigin(s.origin) },
    { id: "scope", label: "Scope", text: scopeLabel.value },
    { id: "path", label: "Path", text: tilde(s.path) },
    { id: "directory", label: "Directory", text: tilde(s.directory) },
    { id: "kone-visibility", label: "Kone visibility", text: isKoneEnabled.value ? "enabled" : "disabled" },
    { id: "cli-state", label: "CLI state", text: stateResult.value?.state ?? (s.enabled ? "enabled" : "disabled") },
    { id: "manual-only", label: "Manual only", text: s.manualOnly ? "true — disable-model-invocation" : "false" },
    { id: "author", label: "Author", text: s.author ?? "—" },
    { id: "modified", label: "Modified", text: fmtDate(s.modifiedAt) },
  ];
  if (stateResult.value?.reason)
    table.push({ id: "state-reason", label: "State reason", text: stateResult.value.reason });
  if (stateResult.value?.source)
    table.push({ id: "state-config", label: "State config", text: tilde(stateResult.value.source) });
  if (d) {
    table.push({ id: "size", label: "Size", text: fmtBytes(d.bytes) });
    const keys = Object.keys(d.frontmatter);
    table.push({ id: "frontmatter-keys", label: "Frontmatter keys", text: keys.join(", ") || "—" });
    table.push({
      id: "resources",
      label: "Resources",
      text: d.resources.length
        ? d.resources.map((r) => r.name + (r.kind === "directory" ? "/" : "")).join(", ")
        : "—",
    });
    if (d.bodyTruncated) table.push({ id: "body", label: "Body", text: "truncated at 20k chars" });
    // The raw pairs render through the table's value slot below, so the row
    // stays in the card while the values keep their mono listing.
    table.push({ id: "frontmatter", label: "Frontmatter", emptyText: "—" });
  }
  if (s.shadowed) {
    const winner = s.shadowedByWinner;
    if (winner) {
      table.push({
        id: "status",
        label: "Status",
        text: `Shadowed by ${originLabelFor(winner.origin)}`,
        aside: tilde(winner.path),
        brands: brandsForOrigin(winner.origin),
      });
    } else {
      table.push({ id: "status", label: "Status", text: "Shadowed by higher-precedence copy" });
    }
  } else if (s.shadowedBy.length) {
    table.push({ id: "shadowed-copies", label: "Shadowed copies", text: String(s.shadowedBy.length) });
  }
  return table;
});

// ── Tabs ────────────────────────────────────────────────────────────────────
// Details reads the metadata table; SKILL.md reads the bundled brief, the way
// Instructions reads on the sibling detail views.
type TabKey = "details" | "content";

const TABS = [
  { key: "details", label: "Details", icon: IdIcon },
  { key: "content", label: "SKILL.md", icon: NoteIcon },
] as const satisfies readonly DetailTab<TabKey>[];
</script>

<template>
  <div class="sd">
    <header class="head">
      <h2 class="name">{{ skill.displayName ?? skill.name }}</h2>
      <p v-if="skill.description" class="desc">{{ skill.description }}</p>
    </header>

    <div v-if="loading" class="loading">
      <span v-for="n in 3" :key="n" class="ph" :style="{ animationDelay: `${n * 90}ms` }" />
    </div>

    <template v-else>
      <section class="block">
        <h3 class="eyebrow">Controls</h3>
        <div class="controls">
          <div class="control-row">
            <div class="control-info">
              <span class="control-title">Kone visibility</span>
              <span class="control-desc">
                {{ isKoneEnabled ? "Active for agent turns, composer, and roster" : "Disabled in Kone for agents, composer, and roster" }}
              </span>
            </div>
            <ToggleSwitch
              :model-value="isKoneEnabled"
              :disabled="busyKone"
              :aria-label="`Turn Kone visibility ${isKoneEnabled ? 'off' : 'on'}`"
              @update:model-value="toggleKoneState"
            />
          </div>

          <div v-if="isSwitchable" class="control-row">
            <div class="control-info">
              <span class="control-title">Enabled in {{ originLabel }} CLI</span>
              <span v-if="cliReason" class="control-desc">{{ cliReason }}</span>
              <span v-else-if="cliSource" class="control-desc">Configured in {{ tilde(cliSource) }}</span>
              <span v-else class="control-desc">{{ cliEnabled ? "Active in CLI settings" : "Disabled in CLI settings" }}</span>
            </div>
            <ToggleSwitch
              :model-value="cliEnabled"
              :disabled="busyCli"
              :aria-label="`Turn ${originLabel} CLI switch ${cliEnabled ? 'off' : 'on'}`"
              @update:model-value="toggleCliState"
            />
          </div>
        </div>
      </section>

      <DetailTabs
        :tabs="TABS"
        :reset-key="skill.path"
        ariaLabel="Skill"
        can-focus
        v-slot="{ tab }"
      >
        <template v-if="tab === 'details'">
          <DetailTable fluid :rows="rows">
            <!-- Raw pairs stay debuggable without leaving the card: one mono line per key. -->
            <template #value-frontmatter>
              <span v-if="detail && Object.keys(detail.frontmatter).length" class="fm-list">
                <code v-for="(v, k) in detail.frontmatter" :key="k" class="fm">{{ k }}: {{ v }}</code>
              </span>
              <span v-else class="muted">—</span>
            </template>
          </DetailTable>

          <section v-if="skill.shadowed && skill.shadowedByWinner" class="block block--below">
            <h3 class="eyebrow">Shadowed by</h3>
            <ul class="shadow">
              <li>{{ originLabelFor(skill.shadowedByWinner.origin) }} · {{ tilde(skill.shadowedByWinner.path) }}</li>
            </ul>
          </section>

          <section v-if="skill.shadowedBy.length" class="block block--below">
            <h3 class="eyebrow">Shadowed copies</h3>
            <ul class="shadow">
              <li v-for="c in skill.shadowedBy" :key="c.path">{{ originLabelFor(c.origin) }} · {{ tilde(c.path) }}</li>
            </ul>
          </section>
        </template>

        <template v-else>
            <section v-if="detail?.resources.length" class="block">
              <h3 class="eyebrow">Bundled files</h3>
              <ul class="files">
                <li v-for="r in detail.resources" :key="r.name" :class="{ dir: r.kind === 'directory' }">
                  {{ r.name }}{{ r.kind === "directory" ? "/" : "" }}
                </li>
              </ul>
            </section>

            <section v-if="detail?.body" class="block block--below">
              <!-- Rich brief, set as page prose like the agent instructions tab. -->
              <!-- eslint-disable-next-line vue/no-v-html -->
              <article v-if="renderedBody" class="md" v-html="renderedBody" />
              <pre v-else-if="renderedBody === null" class="body">{{ detail.body }}</pre>
            </section>

            <section v-else-if="detail && !detail.body" class="block">
              <p class="muted">No readable body in this skill file.</p>
            </section>
          </template>
      </DetailTabs>
    </template>
  </div>
</template>

<style scoped>
.sd {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding-bottom: 32px;
}
.back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--muted);
  cursor: pointer;
}
.back:hover { color: var(--ink); }
.head .name {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--ink);
}
.head .desc {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--muted);
  max-width: 62ch;
}
.eyebrow {
  margin: 0 0 8px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--faint);
}
.body {
  margin: 0;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--code-bg);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 520px;
  overflow-y: auto;
}

/* ── rendered brief ───────────────────────────────────────────────────────── */
/* v-html output isn't scoped, so the prose is styled through :deep(). Set on
   the page like the agent instructions — no box, capped measure, ink
   headings over a soft body. */
.md {
  max-width: 68ch;
  padding-block: 4px;
  font-size: 13.5px;
  line-height: 1.65;
  color: color-mix(in oklab, var(--ink) 78%, transparent);
}
.md :deep(> :first-child) { margin-top: 0; }
.md :deep(p),
.md :deep(ul),
.md :deep(ol),
.md :deep(blockquote),
.md :deep(pre),
.md :deep(table) {
  margin: 0 0 1.05em;
}
.md :deep(p) { text-wrap: pretty; }

.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4),
.md :deep(h5),
.md :deep(h6) {
  margin: 1.6em 0 0.55em;
  line-height: 1.25;
  font-weight: 600;
  color: var(--ink);
  text-wrap: balance;
}
.md :deep(h1) { font-size: 20px; letter-spacing: -0.02em; }
.md :deep(h2) { font-size: 17px; letter-spacing: -0.015em; }
.md :deep(h3) { font-size: 15px; }
.md :deep(h4) { font-size: 13.5px; }
.md :deep(h5) { font-size: 12px; }
.md :deep(h6) {
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}

.md :deep(strong) { font-weight: 600; color: var(--ink); }
.md :deep(em) { font-style: italic; }

.md :deep(a) {
  color: var(--accent, #4f46e5);
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-thickness: from-font;
  border-radius: 3px;
}
.md :deep(a):focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 34%, transparent);
}

.md :deep(ul),
.md :deep(ol) { padding-inline-start: 1.4em; }
.md :deep(li) { margin: 0.28em 0; }
.md :deep(li)::marker { color: var(--muted); }

.md :deep(blockquote) {
  padding-inline-start: 1em;
  border-inline-start: 2px solid var(--hover);
  color: var(--muted);
}

.md :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.88em;
  padding: 0.12em 0.36em;
  border-radius: 5px;
  background-color: var(--hover);
}
.md :deep(pre) {
  padding: 14px 16px;
  border-radius: 10px;
  background-color: var(--hover);
  overflow-x: auto;
  line-height: 1.6;
}
.md :deep(pre code) {
  padding: 0;
  background: none;
  font-size: 12px;
}

.md :deep(hr) {
  margin: 1.8em 0;
  border: 0;
  border-top: 1px solid var(--hover);
}

.md :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
}

.md :deep(table) {
  border-collapse: collapse;
  font-size: 12.5px;
}
.md :deep(th),
.md :deep(td) {
  padding: 7px 14px 7px 0;
  text-align: start;
  border-bottom: 1px solid var(--hover);
}
.md :deep(th) { font-weight: 600; color: var(--ink); }
.files {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.files li {
  font-family: var(--font-mono);
  font-size: 11.5px;
  padding: 4px 8px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  color: var(--muted);
}
.files li.dir { color: var(--ink-soft); }
/* Raw frontmatter inside the Details card: one mono line per pair, settled
   right with the rest of the table's values. */
.fm-list {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  min-width: 0;
}
.fm {
  display: block;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.5;
  text-align: right;
  overflow-wrap: anywhere;
}
/* Precedence losers and winners, kept as plain mono lines under the card. */
.shadow {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--muted);
}
.loading {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ph {
  height: 12px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  animation: breathe 1.6s ease-in-out infinite;
}
@keyframes breathe { 0%,100% {opacity:.5} 50%{opacity:1} }
.block { display: flex; flex-direction: column; }
.block--below { margin-top: 16px; }
.muted { font-size: 12.5px; color: var(--muted); }

.controls {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-soft);
  border-radius: 14px;
  background: var(--panel);
  padding: 8px 14px;
}
.control-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 8px 0;
}
.control-row + .control-row {
  border-top: 1px solid var(--line-soft);
}
.control-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.control-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}
.control-desc {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.4;
}
.control-source {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--faint);
  overflow-wrap: anywhere;
}
.control-pill {
  font-size: 11px;
  font-weight: 500;
  padding: 3px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  color: var(--muted);
  white-space: nowrap;
}
</style>

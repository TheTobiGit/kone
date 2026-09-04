<script setup lang="ts">
import { computed, ref } from "vue";
import type { SkillEntry } from "~/types/desktop";
import { isKoneEnabled as isKoneGateEnabled, writableStates, type useSkills } from "~/composables/useSkills";
import { useRecentProjects } from "~/composables/useRecentProjects";
import ToggleSwitch from "~/components/ui/ToggleSwitch.vue";

const props = defineProps<{
  skill: SkillEntry;
  skills: ReturnType<typeof useSkills>;
}>();

const emit = defineEmits<{ back: [] }>();

const detail = computed(() => props.skills.detail.value);
const loading = computed(() => props.skills.detailLoading.value);

const stateResult = computed(() => props.skills.stateOf(props.skill));

const ORIGIN_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  factory: "Factory",
  agents: "Shared",
};
const originLabel = computed(() => ORIGIN_LABEL[props.skill.origin] ?? props.skill.origin);

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

const rows = computed(() => {
  const d = detail.value;
  const s = props.skill;
  const out: { k: string; v: string }[] = [
    { k: "Name", v: s.displayName ?? s.name },
    { k: "Description", v: s.description ?? s.shortDescription ?? "—" },
    { k: "Origin", v: originLabel.value },
    { k: "Scope", v: scopeLabel.value },
    { k: "Path", v: tilde(s.path) },
    { k: "Directory", v: tilde(s.directory) },
    { k: "Kone visibility", v: isKoneEnabled.value ? "enabled" : "disabled" },
    { k: "CLI state", v: stateResult.value?.state ?? (props.skill.enabled ? "enabled" : "disabled") },
    { k: "Manual only", v: s.manualOnly ? "true — disable-model-invocation" : "false" },
    { k: "Author", v: s.author ?? "—" },
    { k: "Modified", v: fmtDate(s.modifiedAt) },
  ];
  if (stateResult.value?.reason) out.push({ k: "State reason", v: stateResult.value.reason });
  if (stateResult.value?.source) out.push({ k: "State config", v: tilde(stateResult.value.source) });
  if (d) {
    out.push({ k: "Size", v: fmtBytes(d.bytes) });
    out.push({ k: "Frontmatter keys", v: Object.keys(d.frontmatter).join(", ") || "—" });
    out.push({ k: "Resources", v: d.resources.length ? d.resources.map((r) => r.name + (r.kind === "directory" ? "/" : "")).join(", ") : "—" });
    if (d.bodyTruncated) out.push({ k: "Body", v: "truncated at 20k chars" });
  }
  if (s.shadowed) {
    const winnerLabel = s.shadowedByWinner
      ? `${ORIGIN_LABEL[s.shadowedByWinner.origin] ?? s.shadowedByWinner.origin} (${tilde(s.shadowedByWinner.path)})`
      : "Higher-precedence copy";
    out.push({ k: "Status", v: `Shadowed by ${winnerLabel}` });
  } else if (s.shadowedBy.length) {
    out.push({ k: "Shadowed copies", v: String(s.shadowedBy.length) });
  }
  return out;
});
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

      <section class="block">
        <h3 class="eyebrow">Details</h3>
        <table class="tbl">
          <tbody>
            <tr v-for="r in rows" :key="r.k">
              <th>{{ r.k }}</th>
              <td>{{ r.v }}</td>
            </tr>
            <tr v-if="detail">
              <th>Frontmatter</th>
              <td>
                <code v-for="(v, k) in detail.frontmatter" :key="k" class="fm">{{ k }}: {{ v }}</code>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="detail?.body" class="block">
        <h3 class="eyebrow">SKILL.md — {{ detail.bodyTruncated ? "truncated" : "full" }}</h3>
        <pre class="body">{{ detail.body }}</pre>
      </section>

      <section v-else-if="detail && !detail.body" class="block">
        <p class="muted">No body — frontmatter only.</p>
      </section>

      <section v-if="detail?.resources.length" class="block">
        <h3 class="eyebrow">Bundled files</h3>
        <ul class="files">
          <li v-for="r in detail.resources" :key="r.name" :class="{ dir: r.kind === 'directory' }">
            {{ r.name }}{{ r.kind === "directory" ? "/" : "" }}
          </li>
        </ul>
      </section>

      <section v-if="skill.shadowed && skill.shadowedByWinner" class="block">
        <h3 class="eyebrow">Shadowed by</h3>
        <ul class="shadow">
          <li>{{ ORIGIN_LABEL[skill.shadowedByWinner.origin] ?? skill.shadowedByWinner.origin }} · {{ tilde(skill.shadowedByWinner.path) }}</li>
        </ul>
      </section>

      <section v-if="skill.shadowedBy.length" class="block">
        <h3 class="eyebrow">Shadowed copies</h3>
        <ul class="shadow">
          <li v-for="c in skill.shadowedBy" :key="c.path">{{ ORIGIN_LABEL[c.origin] ?? c.origin }} · {{ tilde(c.path) }}</li>
        </ul>
      </section>
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
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.tbl th {
  text-align: left;
  padding: 6px 12px 6px 0;
  font-weight: 600;
  color: var(--muted);
  white-space: nowrap;
  vertical-align: top;
  width: 140px;
}
.tbl td {
  padding: 6px 0;
  color: var(--ink-soft);
  overflow-wrap: anywhere;
  word-break: break-word;
}
.fm {
  display: block;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
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

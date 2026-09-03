<script setup lang="ts">
import { computed } from "vue";
import type { SkillEntry } from "~/types/desktop";
import type { useSkills } from "~/composables/useSkills";
import { useRecentProjects } from "~/composables/useRecentProjects";

const props = defineProps<{
  skill: SkillEntry;
  skills: ReturnType<typeof useSkills>;
}>();

const emit = defineEmits<{ back: [] }>();

const detail = computed(() => props.skills.detail.value);
const loading = computed(() => props.skills.detailLoading.value);
const state = computed(() => props.skills.stateOf(props.skill)?.state ?? (props.skill.enabled ? "enabled" : "disabled"));

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
  const paths = [s.path, ...s.shadowedBy.map((c) => c.path)];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    let best: { path: string; name: string } | null = null;
    for (const r of recents.value) {
      if (p.startsWith(r.path + "/") && (!best || r.path.length > best.path.length)) {
        best = { path: r.path, name: (r as unknown as { name?: string }).name ?? r.path.split("/").pop() ?? r.path };
      }
    }
    const label = best ? best.name : p.split("/").slice(-3, -2)[0] ?? "project";
    if (!seen.has(label)) { seen.add(label); names.push(label); }
  }
  return names;
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
    { k: "Origin", v: s.origin },
    { k: "Scope", v: scopeLabel.value },
    { k: "Path", v: tilde(s.path) },
    { k: "Directory", v: tilde(s.directory) },
    { k: "Enabled", v: state.value },
    { k: "Manual only", v: s.manualOnly ? "true — disable-model-invocation" : "false" },
    { k: "Author", v: s.author ?? "—" },
    { k: "Modified", v: fmtDate(s.modifiedAt) },
  ];
  if (d) {
    out.push({ k: "Size", v: fmtBytes(d.bytes) });
    out.push({ k: "Frontmatter keys", v: Object.keys(d.frontmatter).join(", ") || "—" });
    out.push({ k: "Resources", v: d.resources.length ? d.resources.map((r) => r.name + (r.kind === "directory" ? "/" : "")).join(", ") : "—" });
    if (d.bodyTruncated) out.push({ k: "Body", v: "truncated at 20k chars" });
  }
  if (s.shadowedBy.length) out.push({ k: "Shadowed copies", v: String(s.shadowedBy.length) });
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

      <section v-if="skill.shadowedBy.length" class="block">
        <h3 class="eyebrow">Shadowed copies</h3>
        <ul class="shadow">
          <li v-for="c in skill.shadowedBy" :key="c.path">{{ c.origin }} · {{ tilde(c.path) }}</li>
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
</style>

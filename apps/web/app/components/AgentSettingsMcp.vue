<script setup lang="ts">
import { computed } from "vue";
import type { useAgentSettings } from "~/composables/useAgentSettings";

// Every MCP server any agent CLI on this machine would read at startup — user
// config, project config, wherever it's declared. Grouped by the file it came
// from, because that file is the thing a person would actually go edit. Purely
// a read of what's on disk: nothing here starts, stops, or reconfigures a
// server.

const props = defineProps<{ space: ReturnType<typeof useAgentSettings> }>();

// `space.inventory` comes back through Vue's `readonly()`, so every array
// nested inside it (args, envKeys, …) is a `readonly` array — not assignable
// to McpServerEntry's mutable fields. Deriving the item type from the source
// itself (rather than the ~/types/desktop shape) keeps this file honest about
// what it's actually holding, instead of fighting the wrapper with casts.
type Server = NonNullable<(typeof props)["space"]["inventory"]["value"]>["mcpServers"][number];
type McpGroup = { sourcePath: string; sourceLabel: string; servers: Server[] };

const groups = computed<McpGroup[]>(() => {
  const list = props.space.inventory.value?.mcpServers ?? [];
  const bySource = new Map<string, Server[]>();
  for (const s of list) {
    const arr = bySource.get(s.sourcePath);
    if (arr) arr.push(s);
    else bySource.set(s.sourcePath, [s]);
  }
  const out: McpGroup[] = [];
  for (const [sourcePath, servers] of bySource) {
    const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name));
    out.push({ sourcePath, sourceLabel: sorted[0]?.sourceLabel ?? sourcePath, servers: sorted });
  }
  return out;
});

/** stdio servers are a command line; everything else is a URL. A server with
 *  neither (a malformed entry) reads as an em dash rather than blank space. */
function commandLine(s: Server): string {
  if (s.transport === "stdio") {
    const parts = [s.command ?? "", ...s.args].filter(Boolean);
    return parts.join(" ") || "—";
  }
  return s.url ?? s.command ?? "—";
}

const loading = computed(() => props.space.inventoryLoading.value && !props.space.inventoryLoaded.value);
const empty = computed(() => props.space.inventoryLoaded.value && !loading.value && groups.value.length === 0);

const errors = computed(() => props.space.inventory.value?.errors.filter((e) => /mcp/i.test(e.source)) ?? []);
</script>

<template>
  <section class="mcp" aria-label="MCP">
    <template v-if="loading">
      <ul class="placeholders" aria-hidden="true">
        <li v-for="n in 3" :key="n" class="placeholder" :style="{ animationDelay: `${n * 180}ms` }" />
      </ul>
    </template>
    <template v-else-if="empty">
      <p class="mcp__empty">No MCP servers configured in any of the places the agent CLIs read.</p>
    </template>
    <template v-else>
      <section v-for="g in groups" :key="g.sourcePath" class="block" :aria-label="g.sourceLabel">
        <div class="block__head">
          <p class="eyebrow">{{ g.sourceLabel }}</p>
        </div>
        <p class="block__source" :title="g.sourcePath">{{ g.sourcePath }}</p>

        <ul class="rows">
          <li v-for="s in g.servers" :key="s.name" class="row" :class="{ 'row--off': s.enabled === false }">
            <div class="row__head">
              <span class="row__name">{{ s.name }}</span>
              <span class="chip">{{ s.transport }}</span>
              <span class="chip">{{ s.scope }}</span>
              <span v-if="s.enabled === false" class="chip chip--muted">disabled</span>
            </div>
            <p class="row__line" :title="commandLine(s)">{{ commandLine(s) }}</p>
            <p v-if="s.envKeys.length" class="row__env">
              <span class="row__env-label">env:</span>
              <span v-for="k in s.envKeys" :key="k" class="chip">{{ k }}</span>
            </p>
          </li>
        </ul>
      </section>

      <p class="mcp__note">Only variable names are shown here — never their values.</p>

      <ul v-if="errors.length" class="mcp__errors">
        <li v-for="e in errors" :key="e.source" class="mcp__error">couldn't read {{ e.source }}: {{ e.message }}</li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.mcp {
  display: flex;
  flex-direction: column;
  gap: 2rem;
  padding-bottom: 2rem;
}

.mcp__empty {
  font-size: 15px;
  color: var(--muted);
  padding: 1.5rem 0;
}
.mcp__note {
  font-size: 11.5px;
  color: var(--muted);
}

/* ── blocks ───────────────────────────────────────────────────────────────── */
.block__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin: 0 0 4px;
}
.eyebrow {
  margin: 0;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}
.block__source {
  margin: 0 0 14px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── rows ─────────────────────────────────────────────────────────────────── */
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  padding: 11px 0;
  border-top: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
  transition: opacity 140ms ease;
}
.row:first-child {
  border-top: none;
}
.row--off {
  opacity: 0.55;
}
.row__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.row__name {
  min-width: 0;
  flex-shrink: 1;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-right: auto;
}
.row__line {
  margin: 5px 0 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row__env {
  margin: 6px 0 0;
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}
.row__env-label {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
}

/* ── chips ────────────────────────────────────────────────────────────────── */
.chip {
  flex-shrink: 0;
  padding: 2px 7px;
  border-radius: 6px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
  white-space: nowrap;
}
.chip--muted {
  color: var(--muted);
  opacity: 0.85;
}

/* ── errors ───────────────────────────────────────────────────────────────── */
.mcp__errors {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mcp__error {
  font-size: 11.5px;
  color: var(--muted);
}

/* ── loading placeholders ─────────────────────────────────────────────────── */
.placeholders {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.placeholder {
  height: 44px;
  border-radius: 10px;
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
  animation: mcp-breathe 1700ms ease-in-out infinite;
}
@keyframes mcp-breathe {
  0%,
  100% {
    opacity: 0.5;
  }
  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .placeholder {
    animation: none;
    opacity: 0.75;
  }
  .row {
    transition: none;
  }
}
</style>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AiBrain01Icon,
  Copy01Icon,
  GitBranchIcon,
  LinkSquare02Icon,
  PencilEdit01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import ProviderLogo from "~/components/ProviderLogo.vue";
import { describeModelId, EFFORT_META, type BrandKey, type EffortTier } from "~/utils/modelCatalog";
import { PROVIDER_LABEL } from "~/utils/usageProviders";
import { brainStack } from "~/utils/subagentRuns";
import type { ThreadSession } from "~/composables/useAgent";
import type { GitRemote, ProviderKind } from "~/types/desktop";

// The thread-info drop-down — the natural read-out of a conversation's name.
// Clicking the column title opens this beneath it: the thread's own name leads,
// with the model, its settings and a real token breakdown below, on the ground
// surface with one hairline ring, a soft low shadow and a recessed head band
// whose bottom corners round off. It reads the live session refs, so a running
// turn keeps the state and token rows current while it's open; the one thing it
// writes is the name, which edits in place on the Name row.

const props = defineProps<{
  session: ThreadSession;
  /** Viewport rect of the title that opened the panel — the anchor. */
  anchor: DOMRect;
  /** The project's folder name — shown when the thread lives in a git repo. */
  repo?: string;
  /** The project's current git branch, if any. Its presence is what marks the
   *  thread as living in a git project — the whole Project section hangs on it. */
  branch?: string;
  /** The project's origin remote, when it has one — what turns the Repo row
   *  from a folder name into the hosted repo it tracks. */
  origin?: GitRemote | null;
}>();

const inGitProject = computed(() => Boolean(props.branch));

const emit = defineEmits<{ close: []; rename: [title: string] }>();

const { cue } = useSound();

// ── the repo it tracks ──────────────────────────────────────────────────────
// A remote is worth naming in full, because a folder called `kone` says nothing
// about whose `kone` it is. It reads as a path — host, owner, repo — with the
// scheme, the credentials, the host's TLD and the `.git` suffix all dropped:
// none of them tell you anything you didn't already know from the rest. When the
// remote resolves to something reachable over http the row opens it.
/** A dotted name — what separates a real host from `localhost`, a relative
 *  `../sibling` remote or a bare folder, none of which name anything to open. */
const HOSTISH = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/** A remote reduced to the two parts worth showing, or null when it names no
 *  host: a local clone or a `file://` remote has nothing behind it. */
function parseRemote(raw: string | undefined | null): { host: string; path: string } | null {
  const url = raw?.trim();
  if (!url) return null;
  const scheme = /^([a-z+]+):\/\//i.exec(url)?.[1]?.toLowerCase();
  if (scheme && !["http", "https", "ssh", "git"].includes(scheme)) return null;
  const bare = url
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]*@/, "") // git@host — and any credentials an https remote carries
    .replace(/:(?=\D)/, "/") // scp-style `host:owner/repo`
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const [authority = "", ...rest] = bare.split("/");
  const host = authority.split(":")[0] ?? ""; // a port names the same repo
  const path = rest.join("/");
  if (!HOSTISH.test(host) || !path) return null;
  return { host, path };
}

const remote = computed(() => parseRemote(props.origin?.fetchUrl));

const repoPath = computed(() => {
  const r = remote.value;
  if (!r) return props.repo ?? null;
  const labels = r.host.split(".");
  return `${labels.slice(0, -1).join(".")}/${r.path}`;
});

const repoUrl = computed(() => {
  const o = props.origin;
  if (o?.slug && o.host) return `https://${o.host}/${o.slug}`;
  const r = remote.value;
  return r ? `https://${r.host}/${r.path}` : null;
});

const git = useGit();
function openRepo(): void {
  const url = repoUrl.value;
  if (!url) return;
  cue("press");
  void git.github.open(url);
}

const s = props.session;

const name = computed(() => s.title.value || "New thread");

// ── rename ──────────────────────────────────────────────────────────────────
// The Name row is where a thread gets its name: its value is a field, not a
// read-out. Enter commits, Esc reverts, blur commits — the owner does the write,
// so a store refusal can still put the old name back under us.
const editing = ref(false);
const draft = ref("");
const nameInput = ref<HTMLInputElement | null>(null);

function startEdit(): void {
  if (editing.value) return;
  cue("press");
  draft.value = s.title.value;
  editing.value = true;
  void nextTick(() => {
    nameInput.value?.focus();
    nameInput.value?.select();
  });
}
function cancelEdit(): void {
  editing.value = false;
  draft.value = "";
}
function commitEdit(): void {
  if (!editing.value) return;
  const next = draft.value.trim();
  editing.value = false;
  draft.value = "";
  if (!next || next === s.title.value) return;
  emit("rename", next);
}
const PROVIDER_BRAND = {
  codex: "codex",
  claudeAgent: "claude",
  opencode: "opencode",
  cursor: "cursor",
  droid: "droid",
  antigravity: "antigravity",
} satisfies Record<ProviderKind, BrandKey>;

const providerKind = computed(() => s.provider?.value);
const providerBrand = computed<BrandKey>(() =>
  providerKind.value ? PROVIDER_BRAND[providerKind.value] : "generic",
);
const providerLabel = computed(() =>
  providerKind.value ? PROVIDER_LABEL[providerKind.value] ?? providerKind.value : "",
);

const brand = computed(() => describeModelId(s.model.value).brand);
const modelName = computed(() => describeModelId(s.model.value).name);

// Reasoning wears the same brain-stack as the model picker: a tier's brain
// count and hue read at a glance, its label spelling it out.
const effort = computed(() => {
  const tier = String(s.reasoning.value ?? "").toLowerCase() as EffortTier;
  return EFFORT_META[tier] ?? EFFORT_META.medium;
});

// Status is shown only when it carries meaning: a live turn, or an error. A
// merely-ready idle thread says nothing — the name is the story, not the state.
const working = computed(() => {
  const st = String(s.sessionState.value);
  return st === "running" || st === "starting";
});
const errored = computed(() => String(s.sessionState.value) === "error");
const showStatus = computed(() => working.value || errored.value);
const statusLabel = computed(() => (errored.value ? "Error" : "Working"));

const threadId = computed(() => s.threadId.value);
const shortId = computed(() => {
  const id = threadId.value;
  if (!id) return null;
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
});

const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;
async function copyId(): Promise<void> {
  const id = threadId.value;
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied.value = false), 1400);
  } catch {
    /* clipboard blocked — silently no-op */
  }
}

// ── token breakdown ─────────────────────────────────────────────────────────
// Every row renders only when its number is real: a fresh thread that has not
// run yet reports nothing, so the section says so rather than drawing an empty
// ring that would read as "nothing consumed".
function fmt(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "0";
  if (v < 1_000) return String(Math.round(v));
  if (v < 10_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (v < 1_000_000) return `${Math.round(v / 1_000)}k`;
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
const usage = computed(() => s.tokenUsage.value);
const ctxUsed = computed(() => {
  const u = usage.value;
  if (!u) return undefined;
  const n = u.contextUsed ?? u.total;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
});
const ctxWindow = computed(() => {
  const m = usage.value?.contextWindow;
  return typeof m === "number" && m > 0 ? m : undefined;
});
const tokenRows = computed(() => {
  const u = usage.value;
  if (!u) return [] as { label: string; value: string }[];
  const out: { label: string; value: string }[] = [];
  if (ctxUsed.value !== undefined && ctxWindow.value !== undefined) {
    const remaining = ctxWindow.value - ctxUsed.value;
    if (remaining > 0) out.push({ label: "Remaining", value: fmt(remaining) });
  }
  if (typeof u.input === "number" && Number.isFinite(u.input)) out.push({ label: "Input", value: fmt(u.input) });
  if (typeof u.output === "number" && Number.isFinite(u.output)) out.push({ label: "Output", value: fmt(u.output) });
  if (typeof u.total === "number" && Number.isFinite(u.total)) out.push({ label: "Total", value: fmt(u.total) });
  return out;
});
const hasTokens = computed(() => tokenRows.value.length > 0);

// ── positioning ─────────────────────────────────────────────────────────────
const panel = ref<HTMLElement | null>(null);
const PANEL_W = 320;
const MARGIN = 12;
const pos = computed(() => {
  const a = props.anchor;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const centre = a.left + a.width / 2;
  let left = centre - PANEL_W / 2;
  left = Math.max(MARGIN, Math.min(left, vw - PANEL_W - MARGIN));
  return { top: `${a.bottom + 8}px`, left: `${left}px` };
});

function onKey(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  // Esc backs out one step at a time: it drops a name edit first, and only
  // closes the panel once there is no edit left to abandon.
  if (editing.value) {
    cancelEdit();
    return;
  }
  emit("close");
}
// The panel is pinned to a rect captured once, so anything that moves its
// anchor closes it. A scroll *inside* the panel moves nothing — and the name
// field scrolls itself the moment a long name reaches its right edge, which
// would otherwise close the panel mid-rename.
function onScroll(e: Event): void {
  const t = e.target;
  if (t instanceof Node && panel.value?.contains(t)) return;
  emit("close");
}
function onResize(): void {
  emit("close");
}
onMounted(() => {
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize, true);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", onResize, true);
  if (copyTimer) clearTimeout(copyTimer);
});
</script>

<template>
  <Teleport to="body">
    <div class="tip">
      <button type="button" class="tip__catch" aria-label="Close thread info" @click="emit('close')" />
      <div ref="panel" class="tip__panel" role="dialog" aria-label="Thread info" :style="pos">
        <header class="tip__head">
          <span class="tip__title">Details</span>
          <span v-if="showStatus" class="tip__state" :data-tone="errored ? 'error' : 'live'">
            <span class="tip__state-dot" aria-hidden="true" />
            {{ statusLabel }}
          </span>
        </header>

        <dl class="tip__rows">
          <div class="tip__row tip__row--name" :data-editing="editing ? '' : undefined">
            <dt>Name</dt>
            <dd class="tip__name">
              <input
                v-if="editing"
                ref="nameInput"
                v-model="draft"
                class="tip__name-input"
                aria-label="Thread name"
                maxlength="120"
                @keydown.enter.prevent="commitEdit()"
                @blur="commitEdit()"
              />
              <template v-else>
                <span class="tip__name-value" :title="name">{{ name }}</span>
                <button type="button" class="tip__edit" aria-label="Rename thread" @click="startEdit()">
                  <HugeiconsIcon :icon="PencilEdit01Icon" :size="12" :stroke-width="1.9" aria-hidden="true" />
                  Edit
                </button>
              </template>
            </dd>
          </div>
          <div v-if="providerLabel" class="tip__row">
            <dt>Provider</dt>
            <dd class="tip__provider" :title="providerLabel">
              <ProviderLogo v-if="providerBrand !== 'generic'" :brand="providerBrand" :size="14" />
              <span>{{ providerLabel }}</span>
            </dd>
          </div>
          <div class="tip__row">
            <dt>Model</dt>
            <dd class="tip__model" :title="modelName">
              <ProviderLogo v-if="brand !== 'generic'" :brand="brand" :size="14" />
              <span>{{ modelName }}</span>
            </dd>
          </div>
          <div class="tip__row">
            <dt>Reasoning</dt>
            <dd class="tip__reasoning">
              <span class="tip__brains" :class="{ 'tip__brains--glow': effort.glow }" aria-hidden="true">
                <HugeiconsIcon
                  v-for="i in brainStack(effort.brains)"
                  :key="i"
                  :icon="AiBrain01Icon"
                  :size="13"
                  :stroke-width="2"
                  :style="{ color: effort.hue }"
                />
              </span>
              <span>{{ effort.label }}</span>
            </dd>
          </div>
          <div v-if="s.isSideChat.value" class="tip__row">
            <dt>Kind</dt>
            <dd>Side chat</dd>
          </div>

          <template v-if="inGitProject">
            <p class="tip__section">Project</p>
            <div v-if="repoPath" class="tip__row">
              <dt>Repo</dt>
              <dd class="tip__repo">
                <a
                  v-if="repoUrl"
                  class="tip__link"
                  :href="repoUrl"
                  :title="repoUrl"
                  @click.prevent="openRepo()"
                >
                  <span class="tip__link-text">{{ repoPath }}</span>
                  <HugeiconsIcon
                    :icon="LinkSquare02Icon"
                    :size="12"
                    :stroke-width="1.9"
                    aria-hidden="true"
                  />
                </a>
                <span v-else :title="repoPath">{{ repoPath }}</span>
              </dd>
            </div>
            <div class="tip__row">
              <dt>Branch</dt>
              <dd class="tip__branch" :title="branch">
                <HugeiconsIcon :icon="GitBranchIcon" :size="13" :stroke-width="2" aria-hidden="true" />
                <span>{{ branch }}</span>
              </dd>
            </div>
          </template>

          <p class="tip__section">Context</p>
          <template v-if="hasTokens">
            <div v-for="r in tokenRows" :key="r.label" class="tip__row">
              <dt>{{ r.label }}</dt>
              <dd>{{ r.value }}</dd>
            </div>
          </template>
          <div v-else class="tip__row">
            <dt>Tokens</dt>
            <dd class="tip__muted">Not reported yet</dd>
          </div>

          <p class="tip__section">Identity</p>
          <div class="tip__row">
            <dt>Thread ID</dt>
            <dd class="tip__id">
              <template v-if="shortId">
                <code>{{ shortId }}</code>
                <button type="button" class="tip__copy" :aria-label="copied ? 'Copied' : 'Copy thread ID'" @click="copyId">
                  <HugeiconsIcon :icon="copied ? Tick02Icon : Copy01Icon" :size="12" :stroke-width="2" />
                </button>
              </template>
              <span v-else class="tip__muted">Not started</span>
            </dd>
          </div>
        </dl>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tip {
  position: fixed;
  inset: 0;
  z-index: 60;
}
.tip__catch {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: default;
}
.tip__panel {
  position: absolute;
  width: min(320px, calc(100vw - 24px));
  background: var(--panel);
  border-radius: 18px;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent),
    0 22px 48px -20px color-mix(in srgb, #000 42%, transparent);
  overflow: hidden;
  transform-origin: top center;
  animation: tip-in 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes tip-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .tip__panel { animation: none; }
}
.tip__head {
  --band-bg: var(--band);
  --band-arc: 14px;
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 0.95rem 0.7rem;
  background-color: var(--band-bg);
}
.tip__head :deep(.plogo) {
  flex: none;
  opacity: 0.9;
}
.tip__head::before,
.tip__head::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  top: 100%;
  pointer-events: none;
}
.tip__head::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}
.tip__head::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}
.tip__title {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.3;
  color: var(--ink-soft);
}
.tip__reasoning {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tip__brains {
  display: inline-flex;
  align-items: center;
}
.tip__brains > :deep(svg) {
  margin-left: -5px;
}
.tip__brains > :deep(svg:first-child) {
  margin-left: 0;
}
.tip__brains--glow > :deep(svg) {
  filter: drop-shadow(0 0 3px currentColor);
}
/* Repo — a real link, so it wears the underline every other link in the app
   wears, with the leaves-the-app glyph trailing the path. The path truncates
   before the glyph does; the full URL is on the title. */
.tip__repo {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 0;
  overflow: visible;
}
.tip__link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--ink);
  cursor: pointer;
  text-decoration: none;
  transition: color 0.15s ease;
}
.tip__link-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-decoration: underline;
  text-underline-position: from-font;
  text-decoration-thickness: from-font;
  text-decoration-color: color-mix(in srgb, var(--ink) 25%, transparent);
  text-underline-offset: 2px;
}
.tip__link > :deep(svg) {
  flex: none;
  color: var(--muted);
  transition: color 0.15s ease;
}
.tip__link:hover .tip__link-text {
  text-decoration-color: color-mix(in srgb, var(--ink) 45%, transparent);
}
.tip__link:hover > :deep(svg) {
  color: var(--ink);
}
.tip__link:focus-visible {
  outline: none;
  border-radius: 4px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
}
.tip__branch {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.tip__branch > :deep(svg) {
  flex: none;
  color: var(--muted);
}
.tip__branch span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tip__provider,
.tip__model {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.tip__provider :deep(.plogo),
.tip__model :deep(.plogo) {
  flex: none;
  opacity: 0.9;
}
.tip__provider span,
.tip__model span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tip__state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  font-size: 11px;
  font-weight: 560;
  color: color-mix(in srgb, var(--accent) 70%, var(--ink));
}
.tip__state-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.tip__state[data-tone="error"] {
  color: var(--danger, #d9544f);
}
.tip__state[data-tone="error"] .tip__state-dot {
  background: var(--danger, #d9544f);
}
.tip__rows {
  margin: 0;
  padding: 0.5rem 0.95rem 0.85rem;
  display: flex;
  flex-direction: column;
}
.tip__section {
  margin: 0.6rem 0 0.1rem;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--muted) 80%, transparent);
}
.tip__section:first-child {
  margin-top: 0;
}
.tip__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-height: 24px;
  padding: 4px 0;
}
.tip__row dt {
  flex: none;
  font-size: 11.5px;
  color: var(--muted);
}
.tip__row dd {
  margin: 0;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ink);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Name — the row reads like every other value until it's touched. Edit rides
   the row's right edge out of flow, over a fade the long name slides under, so
   it costs no space and appearing never nudges the name one pixel. */
.tip__row--name {
  min-height: 28px;
}
.tip__name {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex: 1 1 auto;
  overflow: visible; /* the field's focus ring must not be clipped by the row */
}
.tip__name-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tip__edit {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 7px 0 18px;
  border: 0;
  border-radius: 6px;
  background: linear-gradient(to right, transparent, var(--panel) 18px);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, color 0.15s ease, background 0.15s ease;
}
.tip__row--name:hover .tip__edit,
.tip__row--name:focus-within .tip__edit,
.tip__edit:focus-visible {
  opacity: 1;
}
.tip__edit:hover,
.tip__edit:focus-visible {
  color: var(--ink);
  background: linear-gradient(
    to right,
    transparent,
    color-mix(in srgb, var(--ink) 8%, var(--panel)) 18px
  );
}
.tip__edit:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
}
.tip__name-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 2px 6px;
  border: 0;
  border-radius: 7px;
  background: var(--hover);
  font-family: var(--font-sans);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ink);
  text-align: right;
}
.tip__name-input:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
}
.tip__id {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tip__id code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink);
}
.tip__muted {
  color: var(--muted);
  font-weight: 400;
}
.tip__copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.tip__copy:hover {
  background: var(--hover);
  color: var(--ink);
}
</style>

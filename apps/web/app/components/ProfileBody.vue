<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { PencilEdit02Icon, Camera01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { CountUp } from "~/components/ui/count-up";
import ProviderLogo from "~/components/ProviderLogo.vue";
import { sessionBrand, describeModelId } from "~/utils/modelCatalog";
import type { BrandKey } from "~/utils/modelCatalog";
import { SESSION_BRAND } from "~/types/session";
import type { ProviderKind } from "~/types/desktop";

// The profile surface body — lifetime usage stats aggregated in SQL across every
// project (useProfileStats) and the editable local identity (useProfile). No cloud,
// no telemetry. Rendered inside the settings profile page; the page chrome lives in
// SettingsProfilePane.

const { name, handle, initial, color, image, nameOverride, handleOverride, setColor, setImage, colors, resolve } =
  useProfile();
const { stats, loaded, load } = useProfileStats();

onMounted(() => {
  resolve();
  void load();
});

// ── formatting ────────────────────────────────────────────────────────────
const PROVIDER_LABEL = {
  codex: "Codex",
  claudeAgent: "Claude",
  opencode: "OpenCode",
  cursor: "Cursor",
  droid: "Factory Droid",
  antigravity: "Antigravity",
} satisfies Record<ProviderKind, string>;
const providerLabel = (p: ProviderKind) => PROVIDER_LABEL[p] ?? p;

// The vendor logomark for a provider row (its own mark) and for a model row
// (its *true* vendor — an OpenCode/Cursor thread on DeepSeek shows DeepSeek —
// resolved by the same rule every other session surface shares).
const providerBrand = (p: ProviderKind) => SESSION_BRAND[p] ?? "generic";
const modelBrand = (p: ProviderKind, model: string) =>
  sessionBrand(p, providerBrand(p), model);
const modelName = (model: string) => describeModelId(model).name;

const fmtInt = (n: number) => n.toLocaleString();
function fmtCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function hourLabel(h: number): string {
  const period = h < 12 ? "AM" : "PM";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${period}`;
}

// ── headline stats ────────────────────────────────────────────────────────────
const tiles = computed(() => {
  const s = stats.value;
  return [
    {
      id: "tokens",
      label: "Lifetime tokens",
      display: s ? fmtCompact(s.totals.tokens) : "—",
      raw: s?.totals.tokens ?? null,
      hint: s ? fmtInt(s.totals.tokens) : undefined,
      lead: true,
    },
    {
      id: "prompts",
      label: "Prompts",
      display: s ? fmtInt(s.totals.prompts) : "—",
      raw: s?.totals.prompts ?? null,
    },
    {
      id: "threads",
      label: "Threads",
      display: s ? fmtInt(s.totals.threads) : "—",
      raw: s?.totals.threads ?? null,
    },
    {
      id: "streak",
      label: "Current streak",
      display: s ? `${s.streak.current}d` : "—",
      raw: s?.streak.current ?? null,
      suffix: "d",
    },
    {
      id: "longest",
      label: "Longest streak",
      display: s ? `${s.streak.longest}d` : "—",
      raw: s?.streak.longest ?? null,
      suffix: "d",
    },
  ];
});

// ── activity heatmap ──────────────────────────────────────────────────────────
// A GitHub-style grid: 53 columns of weeks (Sun→Sat rows), ending today. Levels
// are scaled against the busiest day so the colour reads relatively.
const WEEKS = 53;
const DOW = ["", "Mon", "", "Wed", "", "Fri", ""];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const activityMap = computed(() => {
  const m = new Map<string, number>();
  for (const a of stats.value?.activity ?? []) m.set(a.date, a.count);
  return m;
});
const peak = computed(() => stats.value?.streak.peakDay?.count ?? 0);

interface Cell {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}
const weeks = computed<Cell[][]>(() => {
  const max = peak.value;
  const level = (c: number): 0 | 1 | 2 | 3 | 4 => {
    if (c <= 0 || max <= 0) return 0;
    const r = c / max;
    if (r > 0.75) return 4;
    if (r > 0.5) return 3;
    if (r > 0.25) return 2;
    return 1;
  };
  // Start on the Sunday (WEEKS-1) weeks before this week's Sunday.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - start.getDay() - (WEEKS - 1) * 7);
  const cols: Cell[][] = [];
  const cursor = new Date(start);
  for (let w = 0; w < WEEKS; w++) {
    const col: Cell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = cursor.toLocaleDateString("en-CA");
      const count = cursor > today ? 0 : activityMap.value.get(date) ?? 0;
      col.push({ date, count, level: cursor > today ? 0 : level(count) });
      cursor.setDate(cursor.getDate() + 1);
    }
    cols.push(col);
  }
  return cols;
});
// Month labels above the columns where the month changes.
const monthMarks = computed(() => {
  const marks: Array<{ col: number; label: string }> = [];
  let last = -1;
  weeks.value.forEach((col, i) => {
    const m = new Date(`${col[0]!.date}T00:00:00`).getMonth();
    if (m !== last) {
      marks.push({ col: i, label: MONTHS[m]! });
      last = m;
    }
  });
  return marks;
});

// ── insights ──────────────────────────────────────────────────────────────
const topProvider = computed(() => stats.value?.providers[0] ?? null);
const topModel = computed(() => stats.value?.models[0] ?? null);
const topReasoning = computed(() => stats.value?.reasoning[0] ?? null);
const topProject = computed(() => stats.value?.projects[0] ?? null);

const insights = computed(() => {
  const s = stats.value;
  if (!s) return [];
  const rows: Array<{ label: string; value: string; sub?: string; brand?: BrandKey }> = [];
  if (topProvider.value)
    rows.push({
      label: "Most-used provider",
      value: providerLabel(topProvider.value.provider),
      sub: `${Math.round((topProvider.value.count / Math.max(1, s.totals.threads)) * 100)}%`,
      brand: providerBrand(topProvider.value.provider),
    });
  if (topModel.value)
    rows.push({
      label: "Most-used model",
      value: modelName(topModel.value.model),
      brand: modelBrand(topModel.value.provider, topModel.value.model),
    });
  if (topReasoning.value)
    rows.push({ label: "Most-used reasoning", value: cap(topReasoning.value.effort) });
  if (s.mostActiveHour !== null)
    rows.push({ label: "Most active hour", value: hourLabel(s.mostActiveHour) });
  if (topProject.value)
    rows.push({
      label: "Most-worked project",
      value: topProject.value.name,
      sub: `${fmtInt(topProject.value.prompts)} prompts`,
    });
  return rows;
});

// Model usage bars — share of threads across the top handful of models.
const modelBars = computed(() => {
  const list = stats.value?.models ?? [];
  const total = list.reduce((n, m) => n + m.count, 0) || 1;
  return list.slice(0, 6).map((m) => ({
    model: m.model,
    name: modelName(m.model),
    provider: m.provider,
    brand: modelBrand(m.provider, m.model),
    share: m.count / total,
    pct: Math.round((m.count / total) * 100),
  }));
});

const empty = computed(() => loaded.value && (!stats.value || stats.value.totals.prompts === 0));

// ── editing ───────────────────────────────────────────────────────────────
// The edit UI lifts into the same scrim + elastic card the app's other modals
// enter/exit spring so a close fades out before the node unmounts.
const editing = ref(false);
const editShown = ref(false);
const fileEl = ref<HTMLInputElement | null>(null);

const cardSpring = { type: "spring", stiffness: 300, damping: 22, mass: 0.9 } as const;

async function openEdit(): Promise<void> {
  editing.value = true;
  await nextTick();
  requestAnimationFrame(() => (editShown.value = true));
}
function closeEdit(): void {
  if (!editing.value) return;
  editShown.value = false;
  window.setTimeout(() => (editing.value = false), 240);
}
function onEditKeydown(e: KeyboardEvent): void {
  if (editing.value && e.key === "Escape") {
    e.preventDefault();
    closeEdit();
  }
}
onMounted(() => window.addEventListener("keydown", onEditKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onEditKeydown));

const avatarStyle = computed(() =>
  image.value
    ? { backgroundImage: `url(${image.value})` }
    : { backgroundColor: color.value || "var(--ink)", color: color.value ? "#fff" : "var(--ground)" },
);

function pickPhoto(): void {
  fileEl.value?.click();
}
async function onPhoto(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  // Compress on-device to a small square data URL — nothing leaves the machine.
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const S = 200;
    const canvas = document.createElement("canvas");
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
      setImage(canvas.toDataURL("image/jpeg", 0.82));
    }
  } catch {
    /* ignore a bad image */
  } finally {
    URL.revokeObjectURL(url);
    (e.target as HTMLInputElement).value = "";
  }
}
function removePhoto(): void {
  setImage("");
}
</script>

<template>
  <div class="profile-body">
    <div class="profile-inner">
        <!-- ── identity ─────────────────────────────────────────────────── -->
        <header class="ident">
          <div class="ident__avatar" :style="avatarStyle" aria-hidden="true">
            <template v-if="!image">{{ initial }}</template>
          </div>
          <div class="ident__who">
            <h1 class="ident__name">{{ name || "You" }}</h1>
            <p v-if="handle" class="ident__handle">@{{ handle }}</p>
          </div>
          <button type="button" class="ident__edit" @click="openEdit">
            <HugeiconsIcon :icon="PencilEdit02Icon" :size="15" :stroke-width="2" aria-hidden="true" />
            <span>Edit</span>
          </button>
        </header>

        <p v-if="empty" class="profile-empty">
          No sessions yet — your usage will build up here as you work.
        </p>

        <template v-else>
          <!-- ── stat band (divided, not carded) ─────────────────────────── -->
          <section class="stats" aria-label="Lifetime stats">
            <div
              v-for="t in tiles"
              :key="t.id"
              class="stat"
              :class="{ 'stat--lead': t.lead }"
            >
              <p class="stat__value" :title="t.hint">
                <template v-if="t.raw !== null && t.suffix">
                  <CountUp :to="t.raw" :duration="1.1" />{{ t.suffix }}
                </template>
                <template v-else-if="t.raw !== null && t.lead">
                  {{ t.display }}
                </template>
                <template v-else-if="t.raw !== null">
                  <CountUp :to="t.raw" :duration="1.1" />
                </template>
                <template v-else>{{ t.display }}</template>
              </p>
              <p class="stat__label">{{ t.label }}</p>
            </div>
          </section>

          <!-- ── activity heatmap ───────────────────────────────────────── -->
          <section class="block" aria-label="Activity">
            <p class="eyebrow">Activity</p>
            <div class="heat">
              <div class="heat__grid">
                <div class="heat__months">
                  <span
                    v-for="m in monthMarks"
                    :key="`${m.col}-${m.label}`"
                    class="heat__month"
                    :style="{ '--col': m.col }"
                    >{{ m.label }}</span
                  >
                </div>
                <div class="heat__body">
                  <div class="heat__dow">
                    <span v-for="(d, i) in DOW" :key="i" class="heat__dow-label">{{ d }}</span>
                  </div>
                  <div class="heat__cols">
                    <div v-for="(col, wi) in weeks" :key="wi" class="heat__col">
                      <span
                        v-for="cell in col"
                        :key="cell.date"
                        class="heat__cell"
                        :data-level="cell.level"
                        :title="`${cell.count} on ${cell.date}`"
                      />
                    </div>
                  </div>
                </div>
              </div>
              <div class="heat__legend">
                <span>Less</span>
                <span class="heat__cell" data-level="0" />
                <span class="heat__cell" data-level="1" />
                <span class="heat__cell" data-level="2" />
                <span class="heat__cell" data-level="3" />
                <span class="heat__cell" data-level="4" />
                <span>More</span>
              </div>
            </div>
          </section>

          <!-- ── insights + model usage ─────────────────────────────────── -->
          <div class="cols">
            <section class="block" aria-label="Insights">
              <p class="eyebrow">Insights</p>
              <dl class="insights">
                <div v-for="row in insights" :key="row.label" class="insight">
                  <dt class="insight__label">{{ row.label }}</dt>
                  <dd class="insight__value">
                    <ProviderLogo v-if="row.brand" :brand="row.brand" :size="15" class="insight__logo" />
                    <span class="insight__text">{{ row.value }}</span>
                    <span v-if="row.sub" class="insight__sub">{{ row.sub }}</span>
                  </dd>
                </div>
              </dl>
            </section>

            <section v-if="modelBars.length" class="block" aria-label="Model usage">
              <p class="eyebrow">Model usage</p>
              <ul class="bars">
                <li v-for="m in modelBars" :key="`${m.provider}-${m.model}`" class="bar">
                  <div class="bar__head">
                    <span class="bar__name">
                      <ProviderLogo :brand="m.brand" :size="14" class="bar__logo" />
                      {{ m.name }}
                    </span>
                    <span class="bar__pct">{{ m.pct }}%</span>
                  </div>
                  <div class="bar__track">
                    <div class="bar__fill" :style="{ width: `${Math.max(2, m.share * 100)}%` }" />
                  </div>
                </li>
              </ul>
            </section>
          </div>
        </template>
    </div>

    <!-- ── edit — the same scrim + elastic card the app's modals use, anchored
         top-right where the Edit button sits (not centred) ───────────────── -->
    <div
      v-if="editing"
      class="fixed inset-0 z-50 flex items-start justify-end overflow-hidden p-6"
    >
      <motion.div
        class="modal-scrim absolute inset-0"
        :initial="{ opacity: 0, backdropFilter: 'blur(0px)' }"
        :animate="{
          opacity: editShown ? 1 : 0,
          backdropFilter: editShown ? 'blur(4px)' : 'blur(0px)',
        }"
        :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
        @click="closeEdit"
      />

      <motion.div
        class="modal-card edit-card relative z-20 w-full max-w-md overflow-hidden"
        :style="{ transformOrigin: 'top right' }"
        :initial="{ opacity: 0, y: -10, scale: 0.96 }"
        :animate="{
          opacity: editShown ? 1 : 0,
          y: editShown ? 0 : -10,
          scale: editShown ? 1 : 0.96,
        }"
        :transition="cardSpring"
        role="dialog"
        aria-modal="true"
        aria-label="Edit profile"
      >
        <div class="edit-inner">
          <!-- header band — the curved band the pickers frame with -->
          <div class="picker-header edit-head -mx-4 -mt-4 mb-4 flex items-center justify-between gap-4">
            <span class="edit-head__title">Edit profile</span>
            <button type="button" class="edit-head__close" aria-label="Close" @click="closeEdit">
              <HugeiconsIcon :icon="Cancel01Icon" :size="16" :stroke-width="2" aria-hidden="true" />
            </button>
          </div>

          <div class="edit-body">
            <label class="edit__field">
              <span class="edit__label">Display name</span>
              <input v-model="nameOverride" type="text" class="edit__input" :placeholder="name" />
            </label>
            <label class="edit__field">
              <span class="edit__label">Handle</span>
              <input v-model="handleOverride" type="text" class="edit__input" :placeholder="handle" />
            </label>
            <div class="edit__field">
              <span class="edit__label">Avatar</span>
              <div class="edit__avatar-row">
                <div class="edit__preview" :style="avatarStyle" aria-hidden="true">
                  <template v-if="!image">{{ initial }}</template>
                </div>
                <button type="button" class="edit__photo" @click="pickPhoto">
                  <HugeiconsIcon :icon="Camera01Icon" :size="14" :stroke-width="2" aria-hidden="true" />
                  <span>{{ image ? "Replace photo" : "Upload photo" }}</span>
                </button>
                <button v-if="image" type="button" class="edit__photo edit__photo--muted" @click="removePhoto">
                  <HugeiconsIcon :icon="Cancel01Icon" :size="14" :stroke-width="2" aria-hidden="true" />
                  <span>Remove</span>
                </button>
                <input ref="fileEl" type="file" accept="image/*" class="sr-only" @change="onPhoto" />
              </div>
              <div v-if="!image" class="edit__swatches">
                <button
                  v-for="c in colors"
                  :key="c.id"
                  type="button"
                  class="edit__swatch"
                  :class="{ 'edit__swatch--on': color === c.value }"
                  :style="{ backgroundColor: c.value || 'var(--ink)' }"
                  :aria-label="c.label"
                  @click="setColor(c.value)"
                />
              </div>
            </div>
          </div>

          <!-- footer band — right-aligned confirm with the accent submit arrow,
               the same forward cue as the folder picker's Open action -->
          <div class="picker-footer edit-foot -mx-4 -mb-4 mt-4 flex items-center justify-end">
            <button type="button" class="edit-action" @click="closeEdit">
              <span>Done</span>
              <span class="edit-submit-arrow" aria-hidden="true">→</span>
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  </div>
</template>

<style scoped>
.profile-body {
  font-family: var(--font-sans);
}
.profile-inner {
  max-width: 820px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 2.5rem;
}

/* ── identity ─────────────────────────────────────────────────────────────── */
.ident {
  display: flex;
  align-items: center;
  gap: 18px;
}
.ident__avatar {
  flex-shrink: 0;
  width: 72px;
  height: 72px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 30px;
  line-height: 1;
  background-size: cover;
  background-position: center;
  user-select: none;
}
.ident__who {
  flex: 1;
  min-width: 0;
}
.ident__name {
  margin: 0;
  font-size: clamp(1.65rem, 3.5vw, 2rem);
  letter-spacing: -0.03em;
  line-height: 1.05;
  color: var(--ink);
  text-wrap: balance;
}
.ident__handle {
  margin: 4px 0 0;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--muted);
}
.ident__edit {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-radius: 999px;
  font-size: 13px;
  color: var(--ink-soft);
  cursor: pointer;
  transition: background-color 0.18s ease;
}
.ident__edit:hover {
  background-color: var(--hover);
}

/* ── edit modal — the pickers' shell (scrim + card + curved bands) ──────────── */
.modal-scrim {
  background: color-mix(in srgb, var(--ground) 62%, transparent);
}
.modal-card {
  background: var(--panel);
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  display: flex;
  flex-direction: column;
}
/* Band tokens — the quiet fill + arc radius the picker header/footer draw with. */
.edit-card {
  --band-bg: var(--band);
  --band-arc: 14px;
}
.edit-inner {
  display: flex;
  flex-direction: column;
  padding: 1rem;
}

/* Header + footer bands, curved into the card corners exactly like the pickers:
   a filled band whose outer edge carries four radial-gradient arcs so the fill
   tucks into the body with a soft inner radius instead of a hard step. */
.picker-header,
.picker-footer {
  position: relative;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}
.picker-header::before,
.picker-header::after,
.picker-footer::before,
.picker-footer::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  pointer-events: none;
}
.picker-footer::before,
.picker-footer::after {
  bottom: 100%;
}
.picker-footer::before {
  left: 0;
  background: radial-gradient(circle at top right, transparent var(--band-arc), var(--band-bg) 0);
}
.picker-footer::after {
  right: 0;
  background: radial-gradient(circle at top left, transparent var(--band-arc), var(--band-bg) 0);
}
.picker-header::before,
.picker-header::after {
  top: 100%;
}
.picker-header::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}
.picker-header::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}

.edit-head__title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.edit-head__close {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  margin: -4px -6px -4px 0;
  border-radius: 999px;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 0.18s ease, color 0.18s ease;
}
.edit-head__close:hover {
  background-color: var(--hover);
  color: var(--ink);
}

/* Confirm action — the folder picker's forward cue: label + an accent arrow
   that eases right on hover. */
.edit-action {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
  cursor: pointer;
  transition: opacity 0.18s ease;
}
.edit-action:hover {
  opacity: 0.7;
}
.edit-submit-arrow {
  color: var(--accent);
  font-weight: 500;
  transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.edit-action:hover .edit-submit-arrow {
  transform: translateX(3px);
}

/* ── edit fields ────────────────────────────────────────────────────────────── */
.edit-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.edit__preview {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border-radius: 999px;
  background-size: cover;
  background-position: center;
  font-size: 15px;
  line-height: 1;
  user-select: none;
}
.edit__field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.edit__label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}
.edit__input {
  background: transparent;
  border: none;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  padding: 4px 0;
  font-size: 15px;
  color: var(--ink);
  outline: none;
}
.edit__input:focus {
  border-bottom-color: var(--accent);
}
.edit__avatar-row {
  display: flex;
  gap: 10px;
}
.edit__photo {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 12px;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  font-size: 13px;
  color: var(--ink-soft);
  cursor: pointer;
  transition: background-color 0.18s ease;
}
.edit__photo:hover {
  background-color: color-mix(in srgb, var(--ink) 10%, transparent);
}
.edit__photo--muted {
  color: var(--muted);
}
.edit__swatches {
  display: flex;
  gap: 10px;
  margin-top: 4px;
}
.edit__swatch {
  width: 24px;
  height: 24px;
  border-radius: 999px;
  cursor: pointer;
  outline: 2px solid transparent;
  outline-offset: 2px;
  transition: outline-color 0.18s ease;
}
.edit__swatch--on {
  outline-color: color-mix(in srgb, var(--ink) 40%, transparent);
}

/* ── empty ─────────────────────────────────────────────────────────────────── */
.profile-empty {
  font-size: 16px;
  color: var(--muted);
  padding: 2rem 0;
}

/* ── stat band ─────────────────────────────────────────────────────────────── */
.stats {
  display: grid;
  grid-template-columns: 1.35fr repeat(4, 1fr);
  border-block: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
}
.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 18px 10px;
  text-align: center;
}
.stat + .stat {
  border-left: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
}
.stat__value {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 22px;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  color: var(--ink);
  line-height: 1;
}
.stat--lead .stat__value {
  font-size: 28px;
  letter-spacing: -0.03em;
}
.stat__label {
  margin: 0;
  font-size: 11px;
  color: var(--muted);
}

/* ── blocks ─────────────────────────────────────────────────────────────────── */
.eyebrow {
  margin: 0 0 14px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}
.cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2.5rem;
}

/* ── heatmap ─────────────────────────────────────────────────────────────────── */
.heat {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.heat__grid {
  overflow-x: auto;
}
.heat__months {
  position: relative;
  height: 14px;
  margin-left: 26px;
}
.heat__month {
  position: absolute;
  left: calc(var(--col) * 15px);
  font-size: 10px;
  color: var(--muted);
}
.heat__body {
  display: flex;
  gap: 4px;
}
.heat__dow {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 22px;
  flex-shrink: 0;
}
.heat__dow-label {
  height: 12px;
  font-size: 9px;
  line-height: 12px;
  color: var(--muted);
}
.heat__cols {
  display: flex;
  gap: 3px;
}
.heat__col {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.heat__cell {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
}
.heat__cell[data-level="1"] {
  background-color: color-mix(in srgb, var(--accent) 32%, transparent);
}
.heat__cell[data-level="2"] {
  background-color: color-mix(in srgb, var(--accent) 55%, transparent);
}
.heat__cell[data-level="3"] {
  background-color: color-mix(in srgb, var(--accent) 78%, transparent);
}
.heat__cell[data-level="4"] {
  background-color: var(--accent);
}
.heat__legend {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--muted);
}

/* ── insights ─────────────────────────────────────────────────────────────────── */
.insights {
  margin: 0;
  display: flex;
  flex-direction: column;
}
.insight {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 0;
  border-top: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
}
.insight:first-child {
  border-top: none;
}
.insight__label {
  font-size: 13px;
  color: var(--muted);
}
.insight__value {
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  font-size: 14px;
  color: var(--ink);
  min-width: 0;
}
.insight__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.insight__logo {
  flex-shrink: 0;
}
.insight__sub {
  margin-left: 8px;
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

/* ── model bars ─────────────────────────────────────────────────────────────────── */
.bars {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.bar__head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}
.bar__name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bar__logo {
  flex-shrink: 0;
}
.bar__pct {
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.bar__track {
  height: 6px;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  overflow: hidden;
}
.bar__fill {
  height: 100%;
  border-radius: 999px;
  background-color: var(--accent);
  transition: width 0.5s cubic-bezier(0.22, 1, 0.36, 1);
}

@media (max-width: 720px) {
  .cols {
    grid-template-columns: 1fr;
    gap: 2rem;
  }
  .stats {
    grid-template-columns: repeat(2, 1fr);
  }
  .stat + .stat {
    border-left: none;
  }
  .stat:nth-child(odd) {
    border-right: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
  }
  .stat:nth-child(n + 3) {
    border-top: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
  }
  .stat--lead {
    grid-column: span 2;
    border-right: none;
  }
}
</style>

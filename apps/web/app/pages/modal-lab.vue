<script setup lang="ts">
// Every modal in the app, in one place, so they can be looked at side by side.
//
// Each one is normally reached through the surface that owns it — a picker in
// the composer, a sheet in a settings pane, an approval that only appears
// mid-turn — which means the only way to compare two of them has been to
// remember what the last one looked like. This page removes the remembering:
// open one, capture what it actually computes to, open the next, and the
// differences end up in one table instead of in your head.
//
// Measurement is read off the live DOM rather than transcribed from each file's
// stylesheet, because what is on screen is the thing being judged and a
// stylesheet is only a claim about it — inherited type, a token that resolves
// differently per theme, and a utility class layered over scoped CSS all land
// in the computed value and in none of the source.
//
// Temporary. It exists to settle a design question, and should go once the
// modals agree.

import { computed, nextTick, ref } from "vue";
import AgentApprovalModal from "~/components/agent/AgentApprovalModal.vue";
import CreateAgentModal from "~/components/agent/CreateAgentModal.vue";
import BranchPickerModal from "~/components/conversation/BranchPickerModal.vue";
import CommitModal from "~/components/git-space/CommitModal.vue";
import ModelPickerModal from "~/components/model/ModelPickerModal.vue";
import CreateProjectModal from "~/components/project/CreateProjectModal.vue";
import ProjectPickerModal from "~/components/project/ProjectPickerModal.vue";
import SkillAddSheet from "~/components/skill/SkillAddSheet.vue";
import ThemeBrowseModal from "~/components/theme/ThemeBrowseModal.vue";
import ThemeEditorModal from "~/components/theme/ThemeEditorModal.vue";
import FolderPickerModal from "~/components/ui/FolderPickerModal.vue";
import GitHubCloneModal from "~/components/ui/GitHubCloneModal.vue";
import UserInputModal from "~/components/ui/UserInputModal.vue";
import { buildModelCatalog, type ModelOption, type PickerProvider } from "~/utils/modelCatalog";
import { PROVIDER_BRAND, PROVIDER_VENDOR } from "~/utils/modelPicker";
import type { ApprovalRequest, ProviderKind, UserInputQuestion } from "~/types/desktop";
import type { ChangeItem } from "~/types/change";

type SurfaceId =
  | "folder"
  | "clone"
  | "create-project"
  | "project-picker"
  | "commit"
  | "branch"
  | "model"
  | "approval"
  | "user-input"
  | "create-agent"
  | "theme-browse"
  | "theme-editor"
  | "skill-add";

/** Where the surface puts itself, and what it puts behind itself. Written down
 *  rather than measured because it is a decision the file makes once, and the
 *  measurement below can only see the result of it. */
type Surface = {
  id: SurfaceId;
  label: string;
  file: string;
  anchor: string;
  group: string;
  /** What it needs that this page can only pretend to give it. */
  caveat?: string;
};

const SURFACES: Surface[] = [
  {
    id: "folder",
    label: "Folder picker",
    file: "ui/FolderPickerModal.vue",
    anchor: "Bottom right · viewport",
    group: "Projects",
  },
  {
    id: "clone",
    label: "GitHub clone",
    file: "ui/GitHubCloneModal.vue",
    anchor: "Bottom right · viewport",
    group: "Projects",
  },
  {
    id: "create-project",
    label: "Create project",
    file: "project/CreateProjectModal.vue",
    anchor: "Bottom right · viewport",
    group: "Projects",
  },
  {
    id: "project-picker",
    label: "Project switcher",
    file: "project/ProjectPickerModal.vue",
    anchor: "Anchored popover · no scrim",
    group: "Projects",
    caveat: "Reads your real recent projects; opens its own sub-modals.",
  },
  {
    id: "commit",
    label: "Commit",
    file: "git-space/CommitModal.vue",
    anchor: "Bottom right · viewport",
    group: "Git",
    caveat: "Fed a made-up change list — committing it will fail, by design.",
  },
  {
    id: "branch",
    label: "Branch picker",
    file: "conversation/BranchPickerModal.vue",
    anchor: "Bottom left · viewport",
    group: "Git",
    caveat: "Lists the chosen project's real branches, and will really switch one.",
  },
  {
    id: "model",
    label: "Model picker",
    file: "model/ModelPickerModal.vue",
    anchor: "Bottom right · viewport or drawer",
    group: "Session",
    caveat: "Reads your installed providers; empty until they answer.",
  },
  {
    id: "approval",
    label: "Tool approval",
    file: "agent/AgentApprovalModal.vue",
    anchor: "Bottom centre · viewport",
    group: "Session",
  },
  {
    id: "user-input",
    label: "Agent question",
    file: "ui/UserInputModal.vue",
    anchor: "Bottom centre · viewport",
    group: "Session",
  },
  {
    id: "create-agent",
    label: "Create agent",
    file: "agent/CreateAgentModal.vue",
    anchor: "Bottom right · settings drawer",
    group: "Settings",
    caveat: "Anchors to the settings drawer; with none here it uses the viewport.",
  },
  {
    id: "theme-browse",
    label: "Theme browser",
    file: "theme/ThemeBrowseModal.vue",
    anchor: "Bottom right · settings drawer",
    group: "Settings",
    caveat: "Hits the extension registry; needs the network to fill.",
  },
  {
    id: "theme-editor",
    label: "Theme editor",
    file: "theme/ThemeEditorModal.vue",
    anchor: "Bottom right · settings drawer",
    group: "Settings",
    caveat: "Previews live — it will repaint the app while open.",
  },
  {
    id: "skill-add",
    label: "Add a skill",
    file: "skill/SkillAddSheet.vue",
    anchor: "Inline sheet · no scrim",
    group: "Settings",
  },
];

const groups = computed(() => {
  const out = new Map<string, Surface[]>();
  for (const s of SURFACES) {
    const list = out.get(s.group) ?? [];
    list.push(s);
    out.set(s.group, list);
  }
  return [...out];
});

const open = ref<SurfaceId | null>(null);
const active = computed(() => SURFACES.find((s) => s.id === open.value) ?? null);

function show(id: SurfaceId): void {
  open.value = id;
  captured.value = null;
  // The card animates in, and measuring mid-tween reports the scale it is
  // passing through rather than the one it settles at.
  window.setTimeout(() => void measure(), 420);
}
function hide(): void {
  open.value = null;
}

// ── the project these surfaces are pointed at ────────────────────────────────
// Half of them are meaningless without one, and a made-up path would make the
// git surfaces render their error state instead of themselves.
const { recents } = useRecentProjects();
const projectPath = ref<string>("");
const projectName = computed(
  () => recents.value.find((p) => p.path === projectPath.value)?.name ?? "no project",
);
if (recents.value[0]) projectPath.value = recents.value[0].path;

const skills = useSkills(() => projectPath.value || null);

// ── fixtures ────────────────────────────────────────────────────────────────
const approval: ApprovalRequest = {
  kind: "command",
  title: "rm -rf node_modules && npm install",
  detail: "Reinstalling from a clean tree so the lockfile is the only source of versions.",
};
const approvalQueue = [
  { requestId: "lab-1", approval },
  {
    requestId: "lab-2",
    approval: {
      kind: "file-change",
      title: "apps/web/app/pages/modal-lab.vue",
      detail: "Write a new file.",
    } satisfies ApprovalRequest,
  },
  {
    requestId: "lab-3",
    approval: { kind: "tool", title: "WebFetch", detail: "https://example.com" } satisfies ApprovalRequest,
  },
];

const questions: UserInputQuestion[] = [
  {
    id: "scope",
    header: "Scope",
    question: "How far should the rename go?",
    options: [
      { label: "This file only", description: "Leave every other reference alone." },
      { label: "The whole package", description: "Every import in the workspace follows." },
      { label: "Callers too", description: "Including the two apps that consume it." },
    ],
  },
  {
    id: "note",
    header: "Note",
    question: "Anything the commit message should say?",
    options: [],
  },
];

const changes: ChangeItem[] = [
  { path: "app/pages/modal-lab.vue", name: "modal-lab.vue", added: 214, removed: 0, staged: false, isNew: true, deleted: false },
  { path: "app/components/inbox/InboxThreadList.vue", name: "InboxThreadList.vue", added: 31, removed: 12, staged: true, isNew: false, deleted: false },
  { path: "app/utils/legacyPicker.ts", name: "legacyPicker.ts", added: 0, removed: 88, staged: false, isNew: false, deleted: true },
];

// The picker reads live catalogs, built the same way the settings pane builds
// them, so what it shows here is what it shows there.
const providers = useAgentProviders();
const providerSettings = useProviderSettings();
onMounted(() => void providers.prepare());

const catalogs = computed<Partial<Record<ProviderKind, ModelOption[]>>>(() => {
  const out: Partial<Record<ProviderKind, ModelOption[]>> = {};
  for (const [prov, list] of Object.entries(providers.modelCache.value)) {
    if (!list) continue;
    // SAFETY: modelCache is keyed by ProviderKind, so Object.entries yields
    // exactly those keys.
    out[prov as ProviderKind] = buildModelCatalog(list);
  }
  return out;
});

const pickerProviders = computed<PickerProvider[]>(() => {
  const visible = providerSettings.modelVisiblePredicate.value;
  return providers.ready.value
    .filter((s) => providerSettings.isEnabled(s.provider))
    .map((s) => {
      const models = (catalogs.value[s.provider] ?? []).filter((m) => visible(s.provider, m.key));
      return {
        id: s.provider,
        label: s.label,
        sub: `${PROVIDER_VENDOR[s.provider]} · ${models.length} model${models.length === 1 ? "" : "s"}`,
        brand: PROVIDER_BRAND[s.provider],
        ready: s.readiness === "ready",
        models,
      };
    });
});
const activeProvider = computed<ProviderKind>(() => pickerProviders.value[0]?.id ?? "claudeAgent");

// ── measurement ─────────────────────────────────────────────────────────────
/** One measured property. `shared` marks the ones the modals are supposed to
 *  agree on — a card's size is its own business, its corner radius is the
 *  app's — and only those are counted when ranking drift. */
type Trait = {
  key: TraitKey;
  label: string;
  shared: boolean;
  /** Renders as a colour chip beside the value. */
  swatch?: boolean;
};

type TraitKey =
  | "size"
  | "cap"
  | "radius"
  | "pad"
  | "background"
  | "shadow"
  | "peak"
  | "body"
  | "scrim";

const TRAITS: Trait[] = [
  { key: "radius", label: "Radius", shared: true },
  { key: "background", label: "Background", shared: true, swatch: true },
  { key: "shadow", label: "Ring / shadow", shared: true },
  { key: "pad", label: "Inner pad", shared: true },
  { key: "peak", label: "Largest type", shared: true },
  { key: "body", label: "Body type", shared: true },
  { key: "scrim", label: "Scrim", shared: true, swatch: true },
  { key: "size", label: "Size", shared: false },
  { key: "cap", label: "Width cap", shared: false },
];

type Reading = Record<TraitKey, string> & {
  id: SurfaceId;
  label: string;
  /** What was actually measured, so a wrong pick is visible rather than quietly
   *  reported as fact. */
  matched: string;
};

const captured = ref<Reading | null>(null);
const table = ref<Reading[]>([]);

/** The card, found by what a card is: the largest rounded, filled box that
 *  isn't the scrim and isn't this page. Guessing beats asking each modal to
 *  grow a marker attribute for a page that should not outlive the question. */
function findCard(): HTMLElement | null {
  const viewport = window.innerWidth * window.innerHeight;
  let best: HTMLElement | null = null;
  let bestArea = 0;
  for (const el of document.querySelectorAll<HTMLElement>("body *")) {
    if (el.closest(".lab, .hud")) continue;
    const box = el.getBoundingClientRect();
    const area = box.width * box.height;
    if (box.width < 220 || box.height < 96 || area <= bestArea) continue;
    // A box covering nearly everything is the shell or the scrim, not the card.
    if (area > viewport * 0.88) continue;
    const cs = getComputedStyle(el);
    if (Number.parseFloat(cs.borderTopLeftRadius) < 8) continue;
    if (cs.backgroundColor === "rgba(0, 0, 0, 0)") continue;
    best = el;
    bestArea = area;
  }
  return best;
}

function findScrim(): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>("body *")) {
    if (el.closest(".lab, .hud")) continue;
    const cs = getComputedStyle(el);
    if (cs.backdropFilter !== "none" && cs.backdropFilter !== "") return el;
  }
  return null;
}

function describe(el: HTMLElement): string {
  // Read through the attribute rather than `className`, which is not a string
  // for an SVG element and would print as an object here.
  const cls = el.getAttribute("class")?.trim() ?? "";
  const name = cls === "" ? el.tagName.toLowerCase() : cls;
  return name.length > 72 ? `${name.slice(0, 72)}…` : name;
}

function round(px: string): string {
  const n = Number.parseFloat(px);
  return Number.isFinite(n) ? `${Math.round(n * 10) / 10}px` : px;
}

/** Four sides collapse to one number when they agree, two when they pair off.
 *  A padding that reads `14px` next to one that reads `14px 16px 16px 16px` is
 *  a difference in the writing, not in the box, and the table should only ever
 *  show the second kind. */
function shorthand(top: string, right: string, bottom: string, left: string): string {
  const [t, r, b, l] = [top, right, bottom, left].map(round);
  if (t === r && r === b && b === l) return t ?? "";
  if (t === b && r === l) return `${t} ${r}`;
  return `${t} ${r} ${b} ${l}`;
}

/** The card's own padding is always zero — these cards are frames, and the
 *  inset belongs to the header or band inside them. So the number worth
 *  comparing is the first one a child actually sets. */
function innerPad(card: HTMLElement): string {
  for (const el of card.querySelectorAll<HTMLElement>("*")) {
    const cs = getComputedStyle(el);
    if (cs.paddingTop === "0px" && cs.paddingLeft === "0px") continue;
    return shorthand(cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft);
  }
  return "0px";
}

/** The biggest type in the card, which is its title whether or not it is marked
 *  up as one — and in this app it never is: every modal names itself with an
 *  aria-label and renders the words as a plain span, so asking for a heading
 *  element would report nothing for almost all of them. */
function peakType(card: HTMLElement): string {
  let best: CSSStyleDeclaration | null = null;
  let bestSize = 0;
  for (const el of card.querySelectorAll<HTMLElement>("*")) {
    if (el.textContent === null || el.textContent.trim() === "") continue;
    const cs = getComputedStyle(el);
    const size = Number.parseFloat(cs.fontSize);
    if (!Number.isFinite(size) || size <= bestSize) continue;
    best = cs;
    bestSize = size;
  }
  return best ? `${round(best.fontSize)} / ${best.fontWeight}` : "—";
}

async function measure(): Promise<void> {
  const surface = active.value;
  if (!surface) return;
  await nextTick();
  const card = findCard();
  if (!card) {
    captured.value = null;
    return;
  }
  const cs = getComputedStyle(card);
  const box = card.getBoundingClientRect();
  const scrim = findScrim();
  const scrimStyle = scrim ? getComputedStyle(scrim) : null;

  captured.value = {
    id: surface.id,
    label: surface.label,
    matched: describe(card),
    size: `${Math.round(box.width)} × ${Math.round(box.height)}`,
    cap: cs.maxWidth === "none" ? "—" : round(cs.maxWidth),
    radius: shorthand(
      cs.borderTopLeftRadius,
      cs.borderTopRightRadius,
      cs.borderBottomRightRadius,
      cs.borderBottomLeftRadius,
    ),
    pad: innerPad(card),
    background: cs.backgroundColor,
    shadow: cs.boxShadow === "none" ? "none" : cs.boxShadow,
    peak: peakType(card),
    body: `${round(cs.fontSize)} / ${cs.fontWeight}`,
    scrim: scrimStyle ? `${scrimStyle.backgroundColor} · ${scrimStyle.backdropFilter}` : "none",
  };
  keep();
}

/** Captures replace rather than accumulate, so re-opening a surface after a
 *  change updates its column instead of adding a second one, and the column
 *  order stays the order you first looked at them in. */
function keep(): void {
  const reading = captured.value;
  if (!reading) return;
  const at = table.value.findIndex((r) => r.id === reading.id);
  if (at === -1) {
    table.value = [...table.value, reading];
    return;
  }
  const next = [...table.value];
  next[at] = reading;
  table.value = next;
}

function drop(id: SurfaceId): void {
  table.value = table.value.filter((r) => r.id !== id);
}

function clearTable(): void {
  table.value = [];
  captured.value = null;
}

// ── the comparison ──────────────────────────────────────────────────────────
// The question is never "what is this modal's radius" — it is "which modals
// disagree about radius, and which value is the app's actual convention". So
// each trait is reduced to the value most of them already use, and every cell
// is judged against it. The majority is treated as the convention because it is
// the cheapest thing to standardise on: the fewest files have to change.

type Cell = { value: string; odd: boolean };
type Row = {
  key: TraitKey;
  label: string;
  shared: boolean;
  swatch: boolean;
  /** How many distinct values this trait has across the captured set. 1 is
   *  agreement; anything else is the work. */
  variants: number;
  common: string;
  cells: Cell[];
};

/** The most-used value, ties broken by which was captured first — so a 2-2 split
 *  names one side rather than flickering as the set grows. */
function majority(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0] ?? "";
  let bestCount = 0;
  for (const v of values) {
    const n = counts.get(v) ?? 0;
    if (n > bestCount) {
      best = v;
      bestCount = n;
    }
  }
  return best;
}

const rows = computed<Row[]>(() => {
  const readings = table.value;
  if (readings.length === 0) return [];
  const built = TRAITS.map((t) => {
    const values = readings.map((r) => r[t.key]);
    const common = majority(values);
    return {
      key: t.key,
      label: t.label,
      shared: t.shared,
      swatch: t.swatch ?? false,
      variants: new Set(values).size,
      common,
      cells: values.map((value) => ({ value, odd: t.shared && value !== common })),
    };
  });
  // Worst drift first, so the table opens on the argument rather than on the
  // things already settled. Informational traits sink below all of them.
  return built.sort((a, b) => {
    if (a.shared !== b.shared) return a.shared ? -1 : 1;
    return b.variants - a.variants;
  });
});

/** Agreement, as one number: how many of the shared traits every captured modal
 *  already renders identically. */
const agreement = computed(() => {
  const shared = rows.value.filter((r) => r.shared);
  if (shared.length === 0) return null;
  return { same: shared.filter((r) => r.variants === 1).length, of: shared.length };
});

/** Which traits the surface on screen parts company with the rest of the set
 *  on — the same judgement the matrix makes, asked about one column. */
const oddNow = computed<Set<TraitKey>>(() => {
  const id = active.value?.id;
  const at = table.value.findIndex((r) => r.id === id);
  if (at === -1) return new Set();
  return new Set(rows.value.filter((r) => r.cells[at]?.odd === true).map((r) => r.key));
});

/** The leading `rgb(...)`/`rgba(...)` of a value, for the chip. A trait like the
 *  scrim carries its blur in the same string; the colour is the part a swatch
 *  can show. */
function chip(value: string): string | null {
  const match = /rgba?\([^)]*\)/.exec(value);
  return match ? match[0] : null;
}

// ── the readout's own placement ─────────────────────────────────────────────
// Every modal here dims and blurs the page behind it, which is exactly what
// puts the numbers out of reach: they describe the thing that is covering them.
// So while one is open the readout leaves the page and becomes an overlay above
// the scrim — and because most of these surfaces sit bottom-right, it starts on
// the opposite side and can be sent back.
const hudSide = ref<"left" | "right">("left");
const hudOpen = ref(true);
function flipHud(): void {
  hudSide.value = hudSide.value === "left" ? "right" : "left";
}
</script>

<template>
  <main class="lab">
    <header class="lab__head">
      <div>
        <h1 class="lab__title">Modals</h1>
        <p class="lab__sub">
          {{ SURFACES.length }} surfaces · {{ table.length }} captured
          <template v-if="agreement">
            · {{ agreement.same }} of {{ agreement.of }} traits agree
          </template>
        </p>
      </div>

      <div class="lab__headacts">
        <label class="lab__project">
          <span>Project</span>
          <select v-model="projectPath">
            <option v-if="recents.length === 0" value="">No recent projects</option>
            <option v-for="p in recents" :key="p.path" :value="p.path">{{ p.name }}</option>
          </select>
        </label>
        <button v-if="table.length" type="button" class="lab__btn" @click="clearTable">
          Clear captures
        </button>
      </div>
    </header>

    <div class="lab__body">
      <nav class="lab__rail">
        <section v-for="[group, items] in groups" :key="group" class="lab__group">
          <h2 class="lab__groupname">{{ group }}</h2>
          <button
            v-for="s in items"
            :key="s.id"
            type="button"
            class="lab__item"
            :class="{
              'lab__item--on': open === s.id,
              'lab__item--seen': table.some((r) => r.id === s.id),
            }"
            @click="show(s.id)"
          >
            <span class="lab__itemname">{{ s.label }}</span>
            <span class="lab__itemfile">{{ s.file }}</span>
            <span class="lab__itemanchor">{{ s.anchor }}</span>
          </button>
        </section>
      </nav>

      <section class="lab__main">
        <p v-if="table.length === 0" class="lab__none">
          Open a surface and it measures itself into the table. Walk the list once and every
          modal is side by side.
        </p>

        <div v-else class="m">
          <table class="m__grid">
            <thead>
              <tr>
                <th class="m__corner">Trait</th>
                <th v-for="r in table" :key="r.id" class="m__col">
                  <span class="m__colname">{{ r.label }}</span>
                  <button
                    type="button"
                    class="m__drop"
                    :aria-label="`Drop ${r.label}`"
                    @click="drop(r.id)"
                  >
                    ×
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in rows"
                :key="row.key"
                class="m__row"
                :class="{
                  'm__row--agreed': row.shared && row.variants === 1,
                  'm__row--loose': !row.shared,
                }"
              >
                <th scope="row" class="m__trait">
                  <span class="m__traitname">{{ row.label }}</span>
                  <!-- The count is the finding: one value is a convention, five
                       are a decision nobody has made yet. -->
                  <span class="m__variants">{{ row.variants }}</span>
                </th>
                <td
                  v-for="(cell, i) in row.cells"
                  :key="table[i]?.id ?? i"
                  class="m__cell"
                  :class="{ 'm__cell--odd': cell.odd }"
                >
                  <span
                    v-if="row.swatch && chip(cell.value)"
                    class="m__swatch"
                    :style="{ background: chip(cell.value) ?? undefined }"
                  />
                  {{ cell.value }}
                </td>
              </tr>
            </tbody>
          </table>

          <dl class="m__legend">
            <div v-for="r in table" :key="r.id" class="m__legendrow">
              <dt>{{ r.label }}</dt>
              <dd>{{ r.matched }}</dd>
            </div>
          </dl>
        </div>
      </section>
    </div>
  </main>

  <!-- Outside .lab on purpose: the measurement walks the document and skips
       anything inside this page's own chrome, which is only a workable rule if
       the thing being measured is not inside it. -->
  <div class="lab-stage">
    <FolderPickerModal v-if="open === 'folder'" @select="hide" @cancel="hide" />
    <GitHubCloneModal v-if="open === 'clone'" @clone="hide" @cancel="hide" />
    <CreateProjectModal v-if="open === 'create-project'" @create="hide" @cancel="hide" />
    <ProjectPickerModal
      v-if="open === 'project-picker'"
      :current-path="projectPath"
      @select="hide"
      @cancel="hide"
    />
    <CommitModal
      v-if="open === 'commit'"
      :project-path="projectPath"
      :branch="null"
      :changes="changes"
      @close="hide"
      @committed="hide"
    />
    <BranchPickerModal
      v-if="open === 'branch'"
      :project-path="projectPath"
      @switched="hide"
      @cancel="hide"
    />
    <ModelPickerModal
      v-if="open === 'model'"
      :providers="pickerProviders"
      :active-provider="activeProvider"
      @select="hide"
      @cancel="hide"
    />
    <AgentApprovalModal
      v-if="open === 'approval'"
      request-id="lab-1"
      :approval="approval"
      :queue="approvalQueue"
      @decide="hide"
    />
    <UserInputModal
      v-if="open === 'user-input'"
      request-id="lab-q"
      :questions="questions"
      @answer="hide"
      @cancel="hide"
    />
    <CreateAgentModal v-if="open === 'create-agent'" @close="hide" @created="hide" @saved="hide" />
    <ThemeBrowseModal :open="open === 'theme-browse'" @close="hide" />
    <ThemeEditorModal :open="open === 'theme-editor'" :theme="null" @close="hide" @saved="hide" />
    <div v-if="open === 'skill-add'" class="lab-stage__sheet">
      <SkillAddSheet :skills="skills" @done="hide" />
    </div>
  </div>

  <!-- Above the scrim, because it is describing the thing the scrim is hiding
       the page behind. -->
  <aside v-if="active" class="hud" :class="[`hud--${hudSide}`, { 'hud--shut': !hudOpen }]">
    <header class="hud__head">
      <h2 class="hud__title">{{ active.label }}</h2>
      <div class="hud__acts">
        <button type="button" class="hud__btn" title="Move to the other side" @click="flipHud">
          {{ hudSide === "left" ? "→" : "←" }}
        </button>
        <button
          type="button"
          class="hud__btn"
          :title="hudOpen ? 'Collapse' : 'Expand'"
          @click="hudOpen = !hudOpen"
        >
          {{ hudOpen ? "–" : "+" }}
        </button>
        <button type="button" class="hud__btn" title="Close the modal" @click="hide">×</button>
      </div>
    </header>

    <template v-if="hudOpen">
      <p v-if="active.caveat" class="hud__caveat">{{ active.caveat }}</p>

      <template v-if="captured">
        <dl class="hud__list">
          <div v-for="row in rows" :key="row.key" class="hud__pair">
            <dt>{{ row.label }}</dt>
            <dd :class="{ 'hud__odd': oddNow.has(row.key) }">
              <span
                v-if="row.swatch && chip(captured[row.key])"
                class="m__swatch"
                :style="{ background: chip(captured[row.key]) ?? undefined }"
              />
              {{ captured[row.key] }}
              <!-- What the rest of the set does, shown only where this one
                   parts company with it — the number alone never says which
                   way to move. -->
              <em v-if="oddNow.has(row.key)">
                most: {{ row.common }}
              </em>
            </dd>
          </div>
        </dl>
        <p class="hud__matched">{{ captured.matched }}</p>
      </template>
      <p v-else class="hud__matched">
        Nothing card-shaped on screen yet — give it a beat, then re-measure.
      </p>

      <button type="button" class="hud__wide" @click="measure">Re-measure</button>
    </template>
  </aside>
</template>

<style scoped>
.lab {
  min-height: 100vh;
  padding: 22px 24px 40px;
  background: var(--ground);
  color: var(--ink);
  font-family: var(--font-sans);
}

.lab__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  padding-bottom: 16px;
}
.lab__title {
  font-size: 19px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.lab__sub {
  margin-top: 3px;
  font-size: 12px;
  color: var(--muted);
}
.lab__headacts {
  display: flex;
  align-items: center;
  gap: 10px;
}

.lab__project {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--muted);
}
.lab__project select {
  padding: 5px 8px;
  border-radius: 8px;
  background: var(--panel);
  color: var(--ink-soft);
  font-family: var(--font-mono);
  font-size: 11.5px;
  box-shadow: inset 0 0 0 1px var(--line);
}

.lab__btn,
.hud__btn,
.hud__wide {
  padding: 5px 11px;
  border-radius: 8px;
  font-size: 11.5px;
  color: var(--ink-soft);
  background: var(--hover);
  cursor: pointer;
  transition: background-color 200ms cubic-bezier(0.33, 1, 0.68, 1);
}
.lab__btn:hover,
.hud__btn:hover,
.hud__wide:hover {
  background: var(--selected);
  transition-duration: 90ms;
}

.lab__body {
  display: grid;
  grid-template-columns: 250px minmax(0, 1fr);
  gap: 22px;
  align-items: start;
}

.lab__rail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.lab__group {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.lab__groupname {
  padding: 0 6px 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--faint);
}

.lab__item {
  display: grid;
  gap: 1px;
  padding: 8px 10px;
  border-radius: 10px;
  text-align: left;
  background: transparent;
  cursor: pointer;
  transition: background-color 240ms cubic-bezier(0.33, 1, 0.68, 1);
}
.lab__item:hover {
  background: var(--hover);
  transition-duration: 110ms;
}
.lab__item--on {
  background: var(--selected);
}
.lab__itemname {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-soft);
}
/* A captured surface is marked rather than removed: the list is also the
   checklist of what is still unaudited. */
.lab__item--seen .lab__itemname::after {
  content: " ·";
  color: var(--accent);
}
.lab__itemfile,
.lab__itemanchor {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--faint);
}

.lab__main {
  min-width: 0;
}
.lab__none {
  font-size: 12.5px;
  color: var(--muted);
  max-width: 40ch;
}

/* ── the matrix ───────────────────────────────────────────────────────────── */
.m {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}
.m__grid {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: nowrap;
}

.m__corner {
  text-align: left;
}
.m__col {
  padding: 0 14px 8px 0;
  text-align: left;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ink-soft);
  font-family: var(--font-sans);
}
.m__colname {
  margin-right: 5px;
}
.m__drop {
  color: var(--faint);
  cursor: pointer;
  background: transparent;
  transition: color 140ms ease;
}
.m__drop:hover {
  color: var(--ink-soft);
}

.m__trait {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 7px 20px 7px 0;
  text-align: left;
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-soft);
}
/* A count sitting where a count belongs — beside the name, not in a column of
   its own, because it qualifies the row rather than being data in it. */
.m__variants {
  padding: 1px 6px;
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  color: var(--ground);
  background: var(--accent);
}
.m__row--agreed .m__variants {
  color: var(--faint);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--line);
}
.m__row--loose .m__variants {
  color: var(--faint);
  background: transparent;
}

.m__cell {
  padding: 7px 14px 7px 0;
  vertical-align: top;
  color: var(--faint);
}
/* Agreement is the quiet state and difference is the loud one, so a settled row
   recedes and the cells that break it are the only thing at full strength. */
.m__cell--odd {
  color: var(--ink);
}
.m__row--agreed .m__cell {
  color: var(--muted);
}
.m__row + .m__row .m__trait,
.m__row + .m__row .m__cell {
  box-shadow: inset 0 1px 0 var(--line-soft);
}
.m__row--loose .m__trait,
.m__row--loose .m__cell {
  box-shadow: inset 0 1px 0 var(--line);
}

.m__swatch {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 5px;
  border-radius: 3px;
  vertical-align: baseline;
  box-shadow: inset 0 0 0 1px var(--line);
}

/* What each column was actually taken from. Kept out of the grid because it is
   an audit of the measurement, not a property of the modal. */
.m__legend {
  display: grid;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--faint);
}
.m__legendrow {
  display: flex;
  gap: 10px;
}
.m__legendrow dt {
  flex: none;
  width: 120px;
  color: var(--muted);
}
.m__legendrow dd {
  overflow-wrap: anywhere;
}

/* ── the overlay readout ──────────────────────────────────────────────────── */
.hud {
  position: fixed;
  top: 18px;
  z-index: 999;
  width: 320px;
  max-height: calc(100vh - 36px);
  overflow-y: auto;
  padding: 12px 14px 14px;
  border-radius: 14px;
  background: var(--panel);
  box-shadow:
    inset 0 0 0 1px var(--line),
    0 18px 44px rgb(0 0 0 / 34%);
  font-family: var(--font-sans);
  color: var(--ink);
}
.hud--left {
  left: 18px;
}
.hud--right {
  right: 18px;
}
.hud--shut {
  width: auto;
}

.hud__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.hud__title {
  font-size: 13px;
  font-weight: 640;
}
.hud__acts {
  display: flex;
  gap: 3px;
}
.hud__btn {
  padding: 2px 8px;
  font-family: var(--font-mono);
}

.hud__caveat {
  margin-top: 8px;
  font-size: 11px;
  line-height: 15px;
  color: var(--muted);
}

.hud__list {
  display: grid;
  gap: 6px;
  margin-top: 12px;
}
.hud__pair {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr);
  gap: 10px;
  align-items: baseline;
}
.hud__pair dt {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--faint);
}
.hud__pair dd {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.hud__odd {
  color: var(--ink);
}
.hud__odd em {
  display: block;
  margin-top: 2px;
  font-style: normal;
  font-size: 10px;
  color: var(--accent);
}

.hud__matched {
  margin-top: 10px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--faint);
  overflow-wrap: anywhere;
}

.hud__wide {
  width: 100%;
  margin-top: 12px;
  text-align: center;
}

/* The sheet is normally a block inside a settings pane, so it gets one here
   rather than being measured floating against the page. */
.lab-stage__sheet {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 40px;
  background: color-mix(in srgb, var(--ground) 62%, transparent);
  overflow: auto;
}
</style>

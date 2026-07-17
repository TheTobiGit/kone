<script setup lang="ts">
import { computed, onMounted } from "vue";

// "Project Home" boards). Three lines: a constant "Hey, {you}" welcome, then a
// headline + subline that adapt to the repo's state. The Paper active board
// leans on agents + token counts we haven't built yet, so lines 2–3 here are
// rebuilt entirely from the git signals we already read for the folder + rail.
//
// Copy is assembled as tone-tagged segments so the mono +/− counts and branch
// names can sit inline with the sans prose, exactly like the board.

type Tone = "ink" | "muted" | "add" | "del" | "num";
interface Seg {
  t: string;
  tone: Tone;
}

const props = defineProps<{
  projectName: string;
  /** false until the first git read resolves — keeps lines 2–3 from flashing a
   *  stale "all clean" before the working tree is known. */
  loading: boolean;
  /** Whether the folder is a git repository at all. */
  repo: boolean;
  /** Whether the repo has any commits (false on a fresh, unborn branch). */
  hasCommits: boolean;
  branch: string | null;
  clean: boolean;
  added: number;
  removed: number;
  /** Files with any change (staged + unstaged + untracked). */
  fileCount: number;
  staged: number;
  ahead: number;
  behind: number;
}>();

const { displayName, initial, resolve } = useUser();
onMounted(resolve);

// ── segment helpers ───────────────────────────────────────────────────────
const ink = (t: string): Seg => ({ t, tone: "ink" });
const mut = (t: string): Seg => ({ t, tone: "muted" });
const add = (t: string): Seg => ({ t, tone: "add" });
const del = (t: string): Seg => ({ t, tone: "del" });
const num = (t: string | number): Seg => ({ t: String(t), tone: "num" });

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// The +A −R pair, joined by a non-breaking space so the diffstat never splits
// across a line wrap.
function diffSegs(): Seg[] {
  const out: Seg[] = [];
  if (props.added > 0) out.push(add(`+${props.added}`));
  if (props.removed > 0) {
    if (out.length) out.push(mut(" "));
    out.push(del(`−${props.removed}`));
  }
  return out;
}

// Optional "on {branch}" tail, skipped on a detached / unborn HEAD.
function onBranch(): Seg[] {
  return props.branch ? [mut(" on "), num(props.branch)] : [];
}

const lines = computed<{ headline: Seg[]; subline: Seg[] }>(() => {
  const name = props.projectName;

  // While the first read is in flight, show just the project name — no subline
  // that could momentarily contradict the real state.
  if (props.loading) {
    return { headline: [ink(name)], subline: [] };
  }

  // A — not a git repository.
  if (!props.repo) {
    return {
      headline: [ink(name), mut(" isn't a git repository yet")],
      subline: [
        mut("Initialize a repo to track changes, then start your first session"),
      ],
    };
  }

  const n = props.fileCount;
  const s = props.staged;

  // B — a repository with no commits yet (unborn branch).
  if (!props.hasCommits) {
    if (props.clean) {
      return {
        headline: [ink(name), mut(" is a fresh repository")],
        subline: [
          mut("Nothing committed yet — your first changes will show up here"),
        ],
      };
    }
    const headline = [ink(name), mut(" is ready for its first commit")];
    const subline =
      s > 0
        ? [
            num(s),
            mut(" of "),
            num(n),
            mut(plural(n, " file staged", " files staged")),
            mut(" — commit when you're ready"),
          ]
        : [
            num(n),
            mut(plural(n, " file", " files")),
            mut(" to stage for your first commit"),
          ];
    return { headline, subline };
  }

  // C — commits on record, working tree clean.
  if (props.clean) {
    const headline = [ink(name), mut(" is ready when you are")];
    let subline: Seg[];
    if (props.ahead > 0 && props.behind > 0) {
      subline = [
        mut("Working tree clean — "),
        num(props.ahead),
        mut(" ahead, "),
        num(props.behind),
        mut(" behind"),
        ...onBranch(),
      ];
    } else if (props.ahead > 0) {
      subline = [
        mut("Working tree clean — you're "),
        num(props.ahead),
        mut(plural(props.ahead, " commit ahead", " commits ahead")),
        ...onBranch(),
      ];
    } else if (props.behind > 0) {
      subline = [
        mut("Working tree clean — "),
        num(props.behind),
        mut(plural(props.behind, " commit behind", " commits behind")),
        ...onBranch(),
        mut(", pull when you're ready"),
      ];
    } else {
      subline = [mut("No changes — everything's committed"), ...onBranch()];
    }
    return { headline, subline };
  }

  // D — commits on record, with uncommitted work (the everyday state).
  const headline = [
    ink(name),
    mut(" has "),
    num(n),
    mut(plural(n, " file with changes", " files with changes")),
  ];

  const diff = diffSegs();
  const subline: Seg[] =
    diff.length > 0
      ? [mut("You have "), ...diff, mut(" uncommitted")]
      : [mut("You have "), num(n), mut(plural(n, " uncommitted change", " uncommitted changes"))];

  if (n > 0) {
    if (s === n) subline.push(mut(", all staged"));
    else if (s > 0) subline.push(mut(", "), num(s), mut(" staged"));
    else subline.push(mut(" — nothing staged yet"));
  }

  return { headline, subline };
});

// The state message reads as continuing prose, not stacked rows: the headline
// and subline flow into one paragraph joined by a sentence break, then wrap
// naturally against the greeting's max-width.
const body = computed<Seg[]>(() => {
  const { headline, subline } = lines.value;
  return subline.length ? [...headline, mut(". "), ...subline] : headline;
});
</script>

<template>
  <div class="greet">
    <!-- Line 1 — the welcome. Constant across states. Laid out as a centered
         flex row so the avatar chip aligns to the text, not the baseline. -->
    <p class="line line--hey">
      <span class="t-muted">Hey,</span>
      <template v-if="displayName">
        <span class="chip">{{ initial }}</span>
        <span class="t-ink">{{ displayName }}</span>
      </template>
      <span v-else class="t-ink">there</span>
    </p>

    <!-- The state message — one continuous, wrapping paragraph. -->
    <p class="line line--body">
      <span
        v-for="(seg, i) in body"
        :key="`b${i}`"
        :class="`t-${seg.tone}`"
        >{{ seg.t }}</span
      >
    </p>
  </div>
</template>

<style scoped>
.greet {
  --hi-muted: #b4b1aa;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: var(--font-sans);
}

.line {
  margin: 0;
  line-height: 44px;
  letter-spacing: -0.01em;
}
/* Welcome row: chip + words share one centered lane. */
.line--hey {
  display: flex;
  align-items: center;
  gap: 10px;
}
/* State message: flowing prose that wraps rather than fixed one-per-row lines. */
.line--body {
  max-width: 620px;
  line-height: 40px;
  text-wrap: pretty;
}

/* Sans prose — 30px, semibold. */
.t-ink,
.t-muted {
  font-size: 30px;
  font-weight: 600;
}
.t-ink {
  color: var(--ink);
}
.t-muted {
  color: var(--hi-muted);
}

/* Mono figures — 26px, bold, baseline-aligned with the prose. Tabular so the
   counts don't reflow the line as they update between reads. */
.t-add,
.t-del,
.t-num {
  font-family: var(--font-mono);
  font-size: 26px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.t-add {
  color: var(--diff-add);
}
.t-del {
  color: var(--diff-del);
}
.t-num {
  color: var(--ink);
}

/* Avatar chip — inverts with the ground, like the orb ring. */
.chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 999px;
  background-color: var(--orb-ring);
  color: var(--ground);
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
}

@media (prefers-color-scheme: dark) {
  .greet {
    --hi-muted: #6c6c74;
  }
}
</style>

import { computed, ref } from "vue";

// Brain for the "Clone from GitHub" flow. The clone action's real work (spawning
// `git clone` in the Electron main process, streaming its progress) is a
// follow-up — for now `runClone` is a faithful mock that walks the same phases a
// real clone would, so the modal's morph → progress → open choreography is built
// and demoable in `nuxt dev`.
//
// State lives at module scope on purpose: while the user detours through the
// folder picker to choose a destination, `GitHubCloneModal` unmounts — the typed
// URL and chosen destination have to survive that round-trip and be there when it
// remounts. `reset()` clears it when the flow ends.

export type ParsedRepo = { owner: string; name: string; url: string };
export type ClonePhase = "idle" | "cloning" | "done" | "error";

// The raw text in the reference field (owner/repo, an https URL, or git@ SSH).
const raw = ref("");
// Absolute path of the folder the repo will be cloned INTO (the clone creates a
// `<name>` subfolder here). Seeded to ~/Developer on first resolve.
const destParent = ref("");
// Resolved home, for rendering paths as `~/…`.
const homePath = ref("");

const phase = ref<ClonePhase>("idle");
const progress = ref(0); // 0..1
const stage = ref(""); // human caption for the current clone phase
const cloneError = ref<string | null>(null);

let raf: number | null = null;

// ── reference parsing ─────────────────────────────────────────────────────────
// Accept the shapes a person actually pastes: `owner/repo`, a github.com web URL
// (with or without a trailing `/tree/branch`, `.git`, query, or hash), a bare
// `github.com/owner/repo`, and `git@github.com:owner/repo.git`. Everything
// normalizes to the canonical https clone URL.
function parseRepoRef(input: string): ParsedRepo | null {
  const s = input.trim().replace(/\/+$/, "");
  if (!s) return null;

  let pathPart: string | null = null;
  const ssh = s.match(/^git@github\.com:(.+)$/i);
  if (ssh) {
    pathPart = ssh[1] ?? null;
  } else if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.hostname.replace(/^www\./i, "").toLowerCase() !== "github.com") {
        return null;
      }
      pathPart = u.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  } else if (/^github\.com\//i.test(s)) {
    pathPart = s.replace(/^github\.com\//i, "");
  } else if (/^[\w.-]+\/[\w.-]+$/.test(s)) {
    pathPart = s; // owner/repo shorthand
  } else {
    return null;
  }

  if (!pathPart) return null;
  const segs = pathPart.split("/").filter(Boolean);
  const owner = segs[0];
  const name = segs[1]?.replace(/\.git$/i, "");
  if (!owner || !name) return null;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null;

  return { owner, name, url: `https://github.com/${owner}/${name}.git` };
}

// `/abs/path` → `~/path` for display, when it sits under home.
function collapse(path: string, home: string): string {
  if (!path) return "";
  if (!home) return path;
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}

function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

// Caption + coarse progress a git clone reports, mapped onto the 0..1 ramp — so
// the mock reads like the real thing (receiving is the long middle stretch).
function stageFor(t: number): string {
  if (t < 0.14) return "Connecting to github.com…";
  if (t < 0.32) return "Counting objects…";
  if (t < 0.5) return "Compressing objects…";
  if (t < 0.92) return "Receiving objects…";
  if (t < 1) return "Resolving deltas…";
  return "Checking out files…";
}

export function useGitClone() {
  const { home } = useFileSystem();

  const repo = computed<ParsedRepo | null>(() => parseRepoRef(raw.value));
  const valid = computed(() => repo.value !== null);
  const busy = computed(() => phase.value === "cloning");

  const destParentDisplay = computed(() =>
    collapse(destParent.value, homePath.value),
  );
  const destPath = computed(() =>
    repo.value ? joinPath(destParent.value, repo.value.name) : "",
  );
  const destPathDisplay = computed(() =>
    collapse(destPath.value, homePath.value),
  );

  // Resolve home once and seed the destination to the home directory itself the
  // first time the modal opens (the user picks a deeper folder via Choose…).
  async function ensureHome(): Promise<void> {
    if (homePath.value) return;
    const h = await home();
    homePath.value = h;
    if (!destParent.value) destParent.value = h;
  }

  function setDestParent(path: string): void {
    if (path) destParent.value = path;
  }

  // Mock clone: ramp progress 0→1 over ~2.1s on rAF, updating the stage caption,
  // then resolve with the folder that would have been created. Bails to null if
  // there's nothing valid to clone or one is already running.
  function runClone(): Promise<{ path: string; name: string } | null> {
    return new Promise((resolve) => {
      if (!repo.value || phase.value === "cloning") return resolve(null);
      const target = { path: destPath.value, name: repo.value.name };
      phase.value = "cloning";
      cloneError.value = null;
      progress.value = 0;
      stage.value = stageFor(0);

      const start = performance.now();
      const DURATION = 2100;
      const tick = (now: number) => {
        const t = Math.min((now - start) / DURATION, 1);
        progress.value = t;
        stage.value = stageFor(t);
        if (t < 1) {
          raf = requestAnimationFrame(tick);
        } else {
          raf = null;
          phase.value = "done";
          // Let the filled bar + "done" read for a beat before handing back.
          window.setTimeout(() => resolve(target), 420);
        }
      };
      raf = requestAnimationFrame(tick);
    });
  }

  // Clear the form + progress. Keeps the resolved home/destination so reopening
  // the modal lands back where the user last pointed it.
  function reset(): void {
    if (raf !== null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    raw.value = "";
    phase.value = "idle";
    progress.value = 0;
    stage.value = "";
    cloneError.value = null;
  }

  return {
    // state
    raw,
    repo,
    valid,
    busy,
    phase,
    progress,
    stage,
    cloneError,
    destParent,
    destParentDisplay,
    destPath,
    destPathDisplay,
    homePath,
    // actions
    ensureHome,
    setDestParent,
    runClone,
    reset,
  };
}

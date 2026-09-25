import { computed, ref } from "vue";
import { collapseHome, joinPath } from "~/utils/paths";
import { peelIpcError } from "~/utils/ipcError";
import { desktopBridge, needsDesktop } from "~/utils/desktopBridge";

// Brain for the "Clone from GitHub" flow. In the desktop app `runClone` drives a
// real `git clone` in the Electron main process and follows its streamed
// progress; with no bridge it fails with the reason.
//
// State lives at module scope on purpose: while the user detours through the
// folder picker to choose a destination, `GitHubCloneModal` unmounts — the typed
// URL and chosen destination have to survive that round-trip and be there when it
// remounts. `reset()` clears it when the flow ends.

export type ParsedRepo = { owner: string; name: string; url: string };
export type ClonePhase = "idle" | "cloning" | "done" | "error";
export type CloneTarget = { path: string; name: string };

// The raw text in the reference field (owner/repo, an https URL, or git@ SSH).
const raw = ref("");
// Absolute path of the folder the repo will be cloned INTO (the clone creates a
// `<name>` subfolder here). Seeded to ~/Developer on first resolve.
const destParent = ref("");
// Resolved home, for rendering paths as `~/…`.
const homePath = ref("");

const phase = ref<ClonePhase>("idle");
const progress = ref(0); // 0..1
const stage = ref("");
const cloneError = ref<string | null>(null);

// Set while the user is deliberately aborting the clone in flight, so its
// rejection reads as a cancellation (quiet return to idle) rather than a failure.
let aborting = false;

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

/** The caption git reports at a point along the clone's 0..1 progress
 *  (receiving is the long middle stretch). */
export function cloneStageAt(t: number): string {
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
    collapseHome(destParent.value, homePath.value),
  );
  const destPath = computed(() =>
    repo.value ? joinPath(destParent.value, repo.value.name) : "",
  );
  const destPathDisplay = computed(() =>
    collapseHome(destPath.value, homePath.value),
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

  // Run the clone: spawn `git clone` and follow its streamed progress. Resolves
  // with the created folder, or null when nothing valid is pending / one is
  // already running (a failure sets `cloneError` + the error phase and resolves
  // null).
  async function runClone(): Promise<CloneTarget | null> {
    if (!repo.value || phase.value === "cloning") return null;
    const git = desktopBridge()?.git;
    if (!git) {
      cloneError.value = needsDesktop("Cloning");
      phase.value = "error";
      return null;
    }
    const target = { path: destPath.value, name: repo.value.name };
    aborting = false;
    phase.value = "cloning";
    cloneError.value = null;
    progress.value = 0;
    stage.value = cloneStageAt(0);

    const off = git.onCloneProgress((p) => {
      // Guard against a stray tick arriving after we've settled the phase.
      if (phase.value !== "cloning") return;
      progress.value = p.progress;
      stage.value = p.stage;
    });
    try {
      const result = await git.clone(repo.value.url, target.path);
      progress.value = 1;
      stage.value = "Done";
      phase.value = "done";
      // Let the filled bar + "done" read for a beat before handing back.
      await new Promise((r) => window.setTimeout(r, 420));
      return { path: result.root, name: result.name };
    } catch (error) {
      // A deliberate abort isn't a failure — drop back to the form silently.
      if (aborting) {
        phase.value = "idle";
      } else {
        cloneError.value = peelIpcError(error, "Clone failed");
        phase.value = "error";
      }
      return null;
    } finally {
      off();
    }
  }

  // Abort the clone in flight: kill the git process (its promise then rejects,
  // handled quietly above). No-op when nothing is cloning.
  function abort(): void {
    if (phase.value !== "cloning") return;
    aborting = true;
    void desktopBridge()?.git.cancelClone();
  }

  // Clear the form + progress. Keeps the resolved home/destination so reopening
  // the modal lands back where the user last pointed it.
  function reset(): void {
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
    abort,
    reset,
  };
}

import { computed, ref } from "vue";
import type { CreateProjectOptions } from "~/types/desktop";
import { collapseHome, joinPath } from "~/utils/paths";
import { peelIpcError } from "~/utils/ipcError";

// Brain for the "Create a new project" flow — the sibling of `useGitClone`.
// Instead of pulling a repo down, it lays a fresh folder on disk and (when
// version control is on) turns it into a git repo. In the desktop app `create`
// drives the real filesystem + git through the Electron bridge; in `nuxt dev`
// (no bridge) it falls back to a faithful mock that walks the same phases, so
// the modal's settle → open choreography stays demoable in the browser.
//
// State lives at module scope so the modal and its parent share one instance:
// `pages/index.vue` calls `reset()` after a create/cancel, and the values must
// be the same ones the modal is bound to.

export type CreatePhase = "idle" | "creating" | "done" | "error";
export type CreateTarget = { path: string; name: string };

// The project name as typed (becomes the folder's basename).
const name = ref("");
// Absolute path of the parent folder the project is created inside. Seeded to
// the home directory on first resolve (the user drills deeper via "Change").
const parentDir = ref("");
// Resolved home, for rendering paths as `~/…`.
const homePath = ref("");

// "More" options — surfaced only in the modal's More panel, so the default
// sheet stays lean (git off ⇒ a fresh project is just a plain folder).
const useGit = ref(false);
const useReadme = ref(false);
// Also create a remote repository on GitHub (implies a local git repo). Its
// name defaults to the project name; visibility is public or private.
const useRemote = ref(false);
const repoName = ref("");
const visibility = ref<"public" | "private">("private");
// A shell command to run in the new folder after it's created (a scaffolder).
const command = ref("");

const phase = ref<CreatePhase>("idle");
const createError = ref<string | null>(null);

let timer: number | null = null;

// A trimmed name is valid when it's a single, safe path segment.
function isValidName(raw: string): boolean {
  const s = raw.trim();
  if (!s || s === "." || s === "..") return false;
  return !/[/\\\0]/.test(s);
}

export function useCreateProject() {
  const { home } = useFileSystem();

  const trimmedName = computed(() => name.value.trim());
  const valid = computed(() => isValidName(name.value));
  const busy = computed(() => phase.value === "creating");

  const parentDisplay = computed(() =>
    collapseHome(parentDir.value, homePath.value),
  );
  const projectPath = computed(() =>
    valid.value ? joinPath(parentDir.value, trimmedName.value) : "",
  );
  const projectPathDisplay = computed(() =>
    collapseHome(projectPath.value, homePath.value),
  );

  // Resolve home once and seed the location to the home directory itself the
  // first time the modal opens (the user picks a deeper folder via "Change").
  async function ensureHome(): Promise<void> {
    if (homePath.value) return;
    const h = await home();
    homePath.value = h;
    if (!parentDir.value) parentDir.value = h;
  }

  function setParent(path: string): void {
    if (path) parentDir.value = path;
  }

  // Create the project. On the desktop this makes the folder + optional git repo
  // for real; without the bridge it falls back to a short mock beat. Either way
  // it resolves with the created folder, or null when nothing valid is pending /
  // one is already running (a failure sets `createError` + the error phase and
  // resolves null).
  function create(): Promise<CreateTarget | null> {
    if (!valid.value || phase.value === "creating") {
      return Promise.resolve(null);
    }
    const target = { path: projectPath.value, name: trimmedName.value };
    // A remote repo needs a local one, so requesting a remote implies git.
    const wantGit = useGit.value || useRemote.value;
    const options: CreateProjectOptions = {
      parent: parentDir.value,
      name: trimmedName.value,
      git: wantGit,
      readme: wantGit && useReadme.value,
      remote: useRemote.value,
      repoName: useRemote.value
        ? repoName.value.trim() || trimmedName.value
        : undefined,
      visibility: useRemote.value ? visibility.value : undefined,
      command: command.value.trim() || undefined,
    };

    phase.value = "creating";
    createError.value = null;

    const bridge = import.meta.client ? window.koneDesktop?.git : undefined;
    return bridge?.create
      ? realCreate(bridge, options)
      : mockCreate(target);
  }

  async function realCreate(
    bridge: NonNullable<Window["koneDesktop"]>["git"],
    options: CreateProjectOptions,
  ): Promise<CreateTarget | null> {
    try {
      const result = await bridge.create(options);
      phase.value = "done";
      // Let the finished readout settle for a beat before handing back.
      await new Promise((r) => (timer = window.setTimeout(r, 460)));
      return { path: result.root, name: result.name };
    } catch (error) {
      createError.value = peelIpcError(error, "Couldn’t create the project");
      phase.value = "error";
      return null;
    }
  }

  // Mock create: a short "creating" beat, then resolve with the folder that
  // would have been created (so the browser demo walks the same choreography).
  function mockCreate(target: CreateTarget): Promise<CreateTarget | null> {
    return new Promise((resolve) => {
      timer = window.setTimeout(() => {
        phase.value = "done";
        timer = window.setTimeout(() => resolve(target), 460);
      }, 900);
    });
  }

  // Clear the per-project inputs (name + setup command) and phase. Keeps the
  // resolved home/location and the git toggle so reopening lands where the user
  // last left it.
  function reset(): void {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    name.value = "";
    command.value = "";
    // Creating a GitHub repo is a real side effect — never carry it into the
    // next open. The local-git toggle is cheaper and stays as the user left it.
    useRemote.value = false;
    repoName.value = "";
    phase.value = "idle";
    createError.value = null;
  }

  return {
    // state
    name,
    trimmedName,
    valid,
    busy,
    phase,
    createError,
    parentDisplay,
    projectPathDisplay,
    // "more" options
    useGit,
    useReadme,
    useRemote,
    repoName,
    visibility,
    command,
    // actions
    ensureHome,
    setParent,
    create,
    reset,
  };
}

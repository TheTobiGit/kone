import { computed, nextTick, reactive, ref, watch } from "vue";
import type { DirEntry, DirListing, GitRepo } from "~/types/desktop";

// Shared brain for the in-app folder browser. Both shells — the full-page
// `FolderPicker` and the elastic `FolderPickerModal` — consume this, so the
// only thing that differs between them is the container/animation, never the
// navigation, git enrichment, or the focus-stack FLIP choreography.

export type Crumb = { name: string; path: string; repo: boolean };

// Breadcrumbs + the focused level are rendered as ONE keyed list. A folder keeps
// the same :key as it turns from a row into a breadcrumb, so it's the same DOM
// node before and after — it doesn't re-animate (stays crisp) and rides a manual
// FLIP up to the breadcrumb slot.
export type Row =
  | {
      kind: "crumb";
      name: string;
      path: string;
      index: number;
      current: boolean;
      repo: boolean;
      git?: GitRepo;
    }
  | { kind: "entry"; name: string; path: string; repo: boolean; git?: GitRepo };

export function useFolderPicker() {
  const { home, listDir } = useFileSystem();
  const { detect } = useGit();

  // Absolute home path, resolved once — used to display paths as `~/…`.
  const homePath = ref("");
  // The path from home (index 0) down to the folder in focus (last).
  const trail = ref<Crumb[]>([]);
  // Subdirectories of the focused folder.
  const entries = ref<DirEntry[]>([]);
  // Lazily-resolved git summaries (branch + line diffstat), keyed by absolute
  // path and cached, so re-visiting a folder never re-runs git.
  const summaries = reactive<Record<string, GitRepo>>({});
  const loading = ref(false);
  // Set when `init()` itself fails (unreadable home directory) — the modal
  // has nothing to show, so it renders this message in place of the list
  // instead of sitting there empty and unresponsive.
  const error = ref<string | null>(null);
  // Set when a listing mid-session (descend / climb / typed path) comes back
  // unreadable — distinct from a folder that's genuinely empty, so the list
  // can say which one happened instead of showing "No subfolders" for both.
  const readError = ref(false);

  const current = computed<Crumb | null>(
    () => trail.value[trail.value.length - 1] ?? null,
  );
  const currentPath = computed(() => current.value?.path ?? "");
  // Git summary for the folder in focus (the one the Open button would open).
  const currentGit = computed(() =>
    current.value ? summaries[current.value.path] : undefined,
  );
  // Breadcrumbs are every trail node below home, tagged with their trail index.
  const crumbs = computed(() =>
    trail.value
      .map((node, index) => ({ node, index }))
      .filter((c) => c.index > 0),
  );

  // ── ascend above the trail's anchor ─────────────────────────────────────────
  // The trail is always anchored at home (or, after a typed path, at "/") — so
  // clicking around never reaches `/Users` or a sibling of home. `ascend` steps
  // the anchor itself up to its parent, re-rooting the whole trail one level
  // higher (`goToPath` decides whether the new anchor is still under home).
  const rootPath = computed(() => trail.value[0]?.path);
  // The anchor's parent path, or `null` when there's nowhere left to climb
  // (no anchor yet, or the anchor already IS the filesystem root).
  const parentPath = computed(() => {
    const p = rootPath.value;
    if (!p || p === "/") return null;
    const cut = p.lastIndexOf("/");
    return cut <= 0 ? "/" : p.slice(0, cut);
  });
  const canAscend = computed(() => parentPath.value !== null);
  // Basename of the parent, shown as the up-affordance's label — "/" itself
  // when ascending lands on the filesystem root (e.g. from `/Users`).
  const parentName = computed(() => {
    const p = parentPath.value;
    if (!p) return "";
    return p === "/" ? "/" : (p.split("/").filter(Boolean).pop() ?? p);
  });
  async function ascend() {
    const p = parentPath.value;
    if (!p) return; // nothing above the current anchor
    await goToPath(p);
  }

  const STEP = 26; // px of indent per level of depth
  const MAX_STEPS = 4; // clamp so deep trees don't march off the edge
  function indent(level: number): number {
    return Math.min(Math.max(level, 0), MAX_STEPS) * STEP;
  }
  const childIndent = computed(() => indent(trail.value.length - 1));

  const rows = computed<Row[]>(() => {
    const last = trail.value.length - 1;
    return [
      ...crumbs.value.map((c) => ({
        kind: "crumb" as const,
        name: c.node.name,
        path: c.node.path,
        index: c.index,
        current: c.index === last,
        repo: c.node.repo,
        git: summaries[c.node.path],
      })),
      ...entries.value.map((e) => ({
        kind: "entry" as const,
        name: e.name,
        path: e.path,
        repo: e.repo,
        git: summaries[e.path],
      })),
    ];
  });

  function rowIndent(row: Row): number {
    return row.kind === "crumb" ? indent(row.index - 1) : childIndent.value;
  }

  // ── git summaries ──────────────────────────────────────────────────────────
  // Repo rows are flagged synchronously (from `entry.repo`) so they render at
  // once; their branch + line diffstat resolve lazily and fill in afterwards.
  const pending = new Set<string>();

  async function ensureSummary(path: string) {
    if (summaries[path] || pending.has(path)) return;
    pending.add(path);
    try {
      const repo = await detect(path);
      if (repo) summaries[path] = repo;
    } finally {
      pending.delete(path);
    }
  }

  // Enrich every repo in view (the trail's repo crumbs + the focused folder's
  // repo children) whenever the listing changes. Keyed off `trail`/`entries` —
  // not `rows`, which reads `summaries` — so resolving a summary can't retrigger
  // this.
  watch(
    () => [
      ...trail.value.filter((c) => c.repo).map((c) => c.path),
      ...entries.value.filter((e) => e.repo).map((e) => e.path),
    ],
    (paths) => {
      for (const path of paths) void ensureSummary(path);
    },
    { immediate: true },
  );

  // ── transition constants ────────────────────────────────────────────────────
  // Incoming rows rise up + fade in on a bouncy spring — they "push up" into
  // place. Persisting rows keep their :key so they never re-run this (they stay
  // put and ride the FLIP instead); only incoming rows animate.
  const enter = {
    type: "spring",
    stiffness: 320,
    damping: 20,
    mass: 0.8,
  } as const;
  const itemHidden = { opacity: 0, y: 24 };
  const itemShown = { opacity: 1, y: 0 };

  // Git metadata (branch + diffstat) resolves a beat after the row lands, then
  // settles in: it drifts over from the glyph and de-blurs into focus, rather
  // than snapping on. The delay lets the row come to rest first, so the git info
  // reads as a distinct, unhurried second reveal once its work is done.
  const metaHidden = { opacity: 0, x: -6, filter: "blur(3px)" };
  const metaShown = { opacity: 1, x: 0, filter: "blur(0px)" };
  const metaEnter = {
    type: "spring",
    stiffness: 240,
    damping: 26,
    mass: 0.8,
    delay: 0.08,
  } as const;

  // ── FLIP ─────────────────────────────────────────────────────────────────────
  // How long the cross-dissolve (FLIP + entrance) takes to settle.
  const TRANSITION_MS = 440;
  // True while a cross-dissolve is in flight (and during the first paint) —
  // locks the scroll overflow closed so the reflowing rows can't flash the
  // scrollbar mid-transition or as the initial listing pops in.
  const navigating = ref(true);

  // ── scroll-edge fades ───────────────────────────────────────────────────────
  const scrollEl = ref<HTMLElement | null>(null);
  const canScrollUp = ref(false);
  const canScrollDown = ref(false);
  const FADE = 22; // px

  function findRow(path: string): HTMLElement | null {
    const els = scrollEl.value?.querySelectorAll<HTMLElement>("[data-path]");
    if (!els) return null;
    for (const el of els) if (el.dataset.path === path) return el;
    return null;
  }

  // FLIP one surviving row from where it was (`from`) to where it landed. The
  // transform rides the inner `.picker-travel` span (motion owns the button's
  // own transform). Big delta = the selected folder rising to a breadcrumb;
  // small delta = a breadcrumb drifting as the centered block re-centers.
  function flipRow(path: string, from: DOMRect): void {
    const el = findRow(path);
    if (!el) return;
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    const inner = el.querySelector<HTMLElement>(".picker-travel") ?? el;
    inner
      .animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: "translate(0px, 0px)" },
        ],
        // easeOutBack — the traveling folder overshoots its slot and springs back.
        { duration: 460, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
      )
      .finished.catch(() => {});
  }

  function measure() {
    const el = scrollEl.value;
    if (!el) return;
    canScrollUp.value = el.scrollTop > 1;
    canScrollDown.value = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }

  async function settle() {
    await nextTick();
    measure();
  }

  const maskImage = computed(() => {
    const top = canScrollUp.value ? `transparent 0, #000 ${FADE}px` : "#000 0";
    const bottom = canScrollDown.value
      ? `#000 calc(100% - ${FADE}px), transparent 100%`
      : "#000 100%";
    return `linear-gradient(to bottom, ${top}, ${bottom})`;
  });

  async function load(path: string): Promise<DirEntry[]> {
    try {
      const listing = await listDir(path);
      readError.value = false;
      return listing.entries;
    } catch {
      // Unreadable (permissions) — flag it so the modal can tell this apart
      // from a folder that's just empty.
      readError.value = true;
      return [];
    }
  }

  // One navigation for both directions: snapshot the current rows, load the new
  // level, then FLIP — survivors glide to their new slot, incomers fade in.
  async function navigate(opts: { loadPath: string; nextTrail: Crumb[] }) {
    if (loading.value) return;
    loading.value = true;
    navigating.value = true;

    // FIRST: snapshot every visible row's screen rect.
    const oldRects = new Map<string, DOMRect>();
    const container = scrollEl.value;
    if (container) {
      for (const el of container.querySelectorAll<HTMLElement>("[data-path]")) {
        const p = el.dataset.path;
        if (p) oldRects.set(p, el.getBoundingClientRect());
      }
    }

    const next = await load(opts.loadPath);
    trail.value = opts.nextTrail;
    entries.value = next;
    loading.value = false;
    error.value = null; // any successful navigation clears init()'s fatal error

    const newPaths = new Set(rows.value.map((r) => r.path));

    await nextTick();
    // LAST / INVERT / PLAY: FLIP every row that persisted.
    for (const path of newPaths) {
      const from = oldRects.get(path);
      if (from) flipRow(path, from);
    }
    measure();
    window.setTimeout(() => {
      navigating.value = false;
      measure();
    }, TRANSITION_MS);
  }

  // Open a folder: it lifts up to become the newest breadcrumb.
  function descend(entry: DirEntry) {
    return navigate({
      loadPath: entry.path,
      nextTrail: [
        ...trail.value,
        { name: entry.name, path: entry.path, repo: entry.repo },
      ],
    });
  }

  // Go back to the parent of the crumb at trail index `k`: the clicked crumb
  // glides back down into the list.
  function climbTo(k: number) {
    if (k < 1) return;
    const target = trail.value[k - 1];
    const clicked = trail.value[k];
    if (!target || !clicked) return;
    return navigate({
      loadPath: target.path,
      nextTrail: trail.value.slice(0, k),
    });
  }

  // Jump straight to a typed absolute path (the header address bar). Leading
  // `~` expands to home; a trailing slash is tolerated. The path is validated
  // by listing it — if it can't be read (typo, permissions) we leave the view
  // untouched. The result is discriminated so the caller (the modal's
  // `submitPath`) can tell "the path was bad" from "we were mid-navigation and
  // ignored it" apart — the two need very different field behavior. The
  // ancestor chain becomes the breadcrumb trail, anchored at home when the path
  // sits under it, else at the filesystem root.
  async function goToPath(raw: string): Promise<"ok" | "invalid" | "busy"> {
    if (loading.value) return "busy";
    const root = await home();
    homePath.value = root;
    let path = raw.trim();
    if (path === "~") path = root;
    else if (path.startsWith("~/")) path = root + path.slice(1);
    if (path.length > 1) path = path.replace(/\/+$/, ""); // drop trailing slash
    if (!path) return "invalid";
    if (path === current.value?.path) return "ok";

    let listing: DirListing;
    try {
      listing = await listDir(path);
    } catch {
      return "invalid"; // unreadable / nonexistent — caller restores the field
    }

    // Anchor the trail at home if `path` lives under it, otherwise at "/".
    const base = path === root || path.startsWith(root + "/") ? root : "/";
    const baseName =
      base === "/" ? "/" : (base.split("/").filter(Boolean).pop() ?? base);
    const nextTrail: Crumb[] = [{ name: baseName, path: base, repo: false }];
    const rel = path === base ? "" : path.slice(base.length).replace(/^\/+/, "");
    let acc = base === "/" ? "" : base;
    for (const seg of rel ? rel.split("/") : []) {
      acc = `${acc}/${seg}`;
      nextTrail.push({ name: seg, path: acc, repo: false });
    }
    // The focused folder's repo flag is known from the listing we just read.
    const last = nextTrail[nextTrail.length - 1];
    if (last) last.repo = listing.repo;

    await navigate({ loadPath: path, nextTrail });
    return "ok";
  }

  // Child directory names of a path, cached, for the header's autocomplete.
  // Cached entries expire after a short TTL — long enough to skip re-listing
  // on every keystroke of a single completion, short enough that a folder
  // created/removed mid-session shows up without waiting out the whole modal
  // lifetime (the cache never had a global invalidation otherwise).
  const CHILD_CACHE_TTL_MS = 10_000;
  const childCache = new Map<string, { names: string[]; at: number }>();
  async function childDirs(path: string): Promise<string[]> {
    const hit = childCache.get(path);
    if (hit && Date.now() - hit.at < CHILD_CACHE_TTL_MS) return hit.names;
    try {
      const listing = await listDir(path);
      const names = listing.entries.map((e) => e.name);
      childCache.set(path, { names, at: Date.now() });
      return names;
    } catch {
      return [];
    }
  }

  // Load the home directory as the initial level. Guarded end-to-end: if the
  // home directory itself can't be read, the modal would otherwise be stuck
  // invisible and permanently locked (nothing ever sets `shown`, no listeners
  // get attached). Failing here instead leaves `trail`/`entries` empty and
  // records `error` so the modal can show a message with Cancel still live.
  async function init() {
    error.value = null;
    readError.value = false;
    try {
      const root = await home();
      homePath.value = root; // resolved before listDir so the header never blanks
      const listing = await listDir(root);
      trail.value = [
        { name: listing.name, path: listing.path, repo: listing.repo },
      ];
      entries.value = listing.entries;
    } catch {
      trail.value = [];
      entries.value = [];
      error.value = "Couldn't read this folder.";
    }
  }

  return {
    // state
    homePath,
    trail,
    entries,
    current,
    currentPath,
    currentGit,
    rows,
    error,
    readError,
    // layout
    childIndent,
    rowIndent,
    scrollEl,
    maskImage,
    measure,
    settle,
    enter,
    itemHidden,
    itemShown,
    metaHidden,
    metaShown,
    metaEnter,
    // FLIP
    navigating,
    TRANSITION_MS,
    // ascend above the trail's anchor
    canAscend,
    parentName,
    ascend,
    // actions
    descend,
    climbTo,
    goToPath,
    childDirs,
    init,
  };
}

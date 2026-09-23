<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Folder01Icon, GitBranchIcon, LinkSquare02Icon } from "@hugeicons/core-free-icons";
import WorktreeIcon from "~/components/icons/WorktreeIcon.vue";
import { basename, hasOwnWorkspace, isWorkspacePending } from "~/utils/threadWorkspace";
import type { GitRemote, ThreadEnvMode } from "~/types/desktop";

// The thread-info panel's Project group: the repo the thread's project tracks,
// the branch the thread is on and the folder it works in. Rendered straight
// into the panel's list, so it brings the list's row styles with it.

const props = defineProps<{
  /** The project's folder name — shown when the thread lives in a git repo. */
  repo?: string;
  /** The project's own checkout on disk — where a thread that is not in a
   *  worktree works, and so what its Folder row opens. */
  projectPath?: string;
  /** The project's current git branch, if any. Its presence is what marks the
   *  thread as living in a git project. */
  branch?: string;
  /** The project's origin remote, when it has one — what turns the Repo row
   *  from a folder name into the hosted repo it tracks. */
  origin?: GitRemote | null;
  /** The directory this conversation works in, when that is not the project's
   *  own checkout. The Branch and Folder rows read it rather than the project's. */
  worktreePath?: string | null;
  /** What this conversation asked for. A worktree choice with no directory yet
   *  is still being built — derived from these two facts, not a separate flag. */
  envMode?: ThreadEnvMode | null;
}>();

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

// ── the folder it works in ──────────────────────────────────────────────────
// Every thread works somewhere on disk: its own worktree, or the project's
// checkout. The row opens that folder in the file manager the way the Repo row
// opens the hosted repo. The folder name shows; the full path is the tooltip.
const inWorktree = computed(() => hasOwnWorkspace({ worktreePath: props.worktreePath }));
const folderPath = computed(() =>
  inWorktree.value ? props.worktreePath ?? null : props.projectPath?.trim() || null,
);
const folderName = computed(() => (folderPath.value ? basename(folderPath.value) : null));
const worktreePending = computed(() =>
  isWorkspacePending({ envMode: props.envMode ?? null, worktreePath: props.worktreePath ?? null }),
);
const { reveal } = useReveal();
function openFolder(): void {
  const path = folderPath.value;
  if (!path) return;
  cue("press");
  void reveal(path);
}

// ── the branch it is on ─────────────────────────────────────────────────────
// A worktree carries a branch of its own, which is not the one the project's
// checkout is on — so a thread in one asks its own folder. Until that answers,
// or when it cannot, the row falls back to the project's branch.
const worktreeBranch = ref<string | null>(null);
watch(
  () => props.worktreePath,
  async (path) => {
    worktreeBranch.value = null;
    if (!path) return;
    try {
      const status = await git.status(path);
      if (props.worktreePath === path) worktreeBranch.value = status?.branch ?? null;
    } catch {
      // Gone from disk, or not a repository any more: the fallback stands.
    }
  },
  { immediate: true },
);
const shownBranch = computed(() => worktreeBranch.value ?? props.branch);

/** The group stands for a thread in a git repo, and for any thread with a
 *  folder to open — a plain folder is still somewhere it works. */
const shown = computed(() => Boolean(props.branch) || Boolean(folderPath.value));
</script>

<template>
  <template v-if="shown">
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
    <div v-if="shownBranch" class="tip__row">
      <dt>Branch</dt>
      <dd class="tip__branch" :title="shownBranch">
        <HugeiconsIcon :icon="GitBranchIcon" :size="13" :stroke-width="2" aria-hidden="true" />
        <span>{{ shownBranch }}</span>
      </dd>
    </div>
    <!-- Where the thread works, whichever kind of place that is. A
         worktree wears its mark ahead of the name, so the one row says
         both where and what. -->
    <div v-if="worktreePending || folderName" class="tip__row">
      <dt>Folder</dt>
      <dd class="tip__repo">
        <span v-if="worktreePending" class="tip__folder tip__muted">
          <WorktreeIcon :size="12" />
          Worktree being created…
        </span>
        <a
          v-else-if="folderName && folderPath"
          class="tip__link"
          :href="`file://${folderPath}`"
          :title="`${inWorktree ? 'Worktree' : 'Project folder'} — show in Finder\n${folderPath}`"
          @click.prevent="openFolder()"
        >
          <WorktreeIcon v-if="inWorktree" :size="12" class="tip__folder-mark" />
          <span class="tip__link-text">{{ folderName }}</span>
          <HugeiconsIcon :icon="Folder01Icon" :size="12" :stroke-width="1.9" aria-hidden="true" />
        </a>
      </dd>
    </div>
  </template>
</template>

<style scoped src="./threadInfoRows.css"></style>

<style scoped>
/* Repo and Folder — real links, so each wears the underline every other link
   in the app wears, with its glyph trailing the name. The name truncates before
   the glyph does; the full URL or path is on the title. */
.tip__repo {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 0;
  overflow: visible;
}
.tip__folder {
  display: inline-flex;
  align-items: center;
  gap: 5px;
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
</style>

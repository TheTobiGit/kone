import { reactive } from "vue";
import type { FolderFile } from "~/components/ProjectFolder.vue";
import type { GitFileStatus } from "~/types/desktop";

export interface ProjectSummary {
  loading: boolean;
  repo: boolean;
  branch: string | null;
  added: number;
  removed: number;
  files: FolderFile[];
}

function langOf(path: string): FolderFile["lang"] {
  if (path.endsWith(".vue")) return "vue";
  if (/\.(js|mjs|cjs|jsx)$/.test(path)) return "js";
  return "ts";
}

function isNew(status: GitFileStatus): boolean {
  return status === "added" || status === "untracked";
}

export function useProjectSummaries() {
  const git = useGit();
  const summaries = reactive<Record<string, ProjectSummary>>({});

  async function enrich(path: string): Promise<void> {
    if (summaries[path]) return; // already resolved (or resolving)
    summaries[path] = {
      loading: true,
      repo: true,
      branch: null,
      added: 0,
      removed: 0,
      files: [],
    };

    const [detected, status] = await Promise.all([
      git.detect(path),
      git.status(path),
    ]);
    const changes = status?.changes ?? [];

    summaries[path] = {
      loading: false,
      repo: detected !== null,
      branch: detected?.branch ?? null,
      added: detected?.added ?? 0,
      removed: detected?.removed ?? 0,
      files: changes.slice(0, 3).map((c) => ({
        lang: langOf(c.path),
        change:
          c.status === "deleted"
            ? "deleted"
            : isNew(c.status)
              ? "new"
              : "edit",
        added: c.added ?? 0,
        removed: c.removed ?? 0,
        name: c.path,
      })),
    };
  }

  return { summaries, enrich };
}

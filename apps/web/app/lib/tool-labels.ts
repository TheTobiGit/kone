import type { ToolActivity } from "~/types/conversation";

const SEARCH_PATTERN_MAX = 40;
const COMMAND_MAX = 48;
const ELLIPSIS = "…";

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/);
  const last = segments[segments.length - 1];
  return last && last.length > 0 ? last : path;
}

function truncate(text: string, max: number): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}${ELLIPSIS}`;
}

function hostnameFromUrl(value: string): string | null {
  try {
    return new URL(value.trim()).hostname || null;
  } catch {
    return null;
  }
}

function impliesCreation(activity: ToolActivity): boolean {
  const name = activity.name.toLowerCase();
  if (/creat/.test(name)) return true;
  if (/write/.test(name) && !/(edit|patch)/.test(name)) return true;
  const summary = activity.inputSummary?.toLowerCase() ?? "";
  return /\bcreate[sd]?\b|\bnew file\b/.test(summary);
}

function fallbackLabel(activity: ToolActivity): string {
  const name = activity.name?.trim();
  return name && name.length > 0 ? name : "Tool";
}

/**
 * Derives a concise, human-readable label for a tool activity row from its
 * kind, paths, command, and input summary. Falls back to the raw tool name
 * (and finally "Tool") when there isn't enough structured data to work with.
 */
export function toolActivityLabel(activity: ToolActivity): string {
  const fallback = fallbackLabel(activity);

  switch (activity.kind) {
    case "read": {
      const path = activity.paths[0];
      return path ? `Read ${basename(path)}` : fallback;
    }

    case "write": {
      const path = activity.paths[0];
      if (!path) return fallback;
      return `${impliesCreation(activity) ? "Created" : "Edited"} ${basename(path)}`;
    }

    case "search": {
      const pattern = activity.inputSummary?.trim();
      return pattern ? `Searched "${truncate(pattern, SEARCH_PATTERN_MAX)}"` : fallback;
    }

    case "execute": {
      const command = activity.command?.trim() || activity.inputSummary?.trim();
      return command ? `Ran ${truncate(command, COMMAND_MAX)}` : fallback;
    }

    case "network": {
      const url = activity.inputSummary?.trim();
      if (!url) return fallback;
      const hostname = hostnameFromUrl(url);
      return `Fetched ${hostname ?? truncate(url, SEARCH_PATTERN_MAX)}`;
    }

    default:
      return fallback;
  }
}

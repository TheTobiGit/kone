import type { GitBranch } from "../types/desktop";
import { peelIpcErrorLine } from "./ipcError";

/** Keep local branches and remote branches that have no local counterpart. */
export function branchPickerOptions(branches: GitBranch[]): GitBranch[] {
  const local = branches.filter((branch) => !branch.remote);
  const names = new Set(local.map((branch) => branch.name));
  const upstreams = new Set(local.map((branch) => branch.upstream).filter(Boolean));
  const remote = branches.filter((branch) =>
    branch.remote &&
    !names.has(branch.name.slice(branch.name.indexOf("/") + 1)) &&
    !upstreams.has(branch.name),
  );
  return [...local.sort((a, b) => Number(b.current) - Number(a.current)), ...remote];
}

/** What to show when a branch switch fails. git's most common refusal (local
 *  changes would be overwritten) ends on a bare "Aborting", so that case gets
 *  the actionable hint; anything else shows git's own last line. */
export function checkoutErrorMessage(message: string): string {
  if (/would be overwritten by (checkout|switch)|commit your changes or stash them/i.test(message)) {
    return "Couldn’t switch — commit or stash changes first";
  }
  return peelIpcErrorLine(message, "Couldn’t switch branches");
}

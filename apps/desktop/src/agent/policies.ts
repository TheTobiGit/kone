// The policy enforcer: given an agent's standing prohibitions and one action it
// is about to take, decide whether that action is allowed. Pure — no store, no
// events, no side effects — so it can be reasoned about and unit-tested on its
// own. The capability layer answers "what may this agent reach for"; this layer
// answers "what may it never do", and a policy wins over a capability: an agent
// pinned to a provider can still be forbidden a command that provider offers.

import type { AgentPolicies } from "./ConversationStore.js";
import type { ApprovalRequestKind } from "./types.js";

/** One thing an agent is about to do, normalized for the enforcer: the kind of
 *  approval it tripped, and the string that names it — a command line for a
 *  command, a path for a file action, a tool name for a bare permission. */
export type PolicyAction = {
  kind: ApprovalRequestKind;
  /** The command line, the path, or the tool/permission name. */
  target: string;
};

/** The enforcer's answer. A denial carries the human-readable reason so the
 *  caller can tell the agent (and the user) exactly which rule stopped it. */
export type PolicyVerdict = { allowed: true } | { allowed: false; reason: string };

const ALLOWED: PolicyVerdict = { allowed: true };

/** A command action is one whose target reads like an invocation — an actual
 *  command, or a bare permission/tool call kone hasn't classified as a file
 *  action. All of these are matched against the denied-command list. */
function isCommandKind(kind: ApprovalRequestKind): boolean {
  return kind === "command" || kind === "permission" || kind === "tool";
}

function isPathKind(kind: ApprovalRequestKind): boolean {
  return kind === "file-read" || kind === "file-change";
}

/** A denied command matches a command line by case-insensitive substring, so
 *  `rm -rf` catches `rm -rf /tmp/x` and `git push` catches an env-prefixed
 *  `FOO=1 git push origin`. Deliberately loose: a prohibition is meant to catch
 *  the shape of a command however it is dressed up, not to be out-typed. */
function commandDenied(commandLine: string, entry: string): boolean {
  return commandLine.toLowerCase().includes(entry.toLowerCase());
}

/** Slashes one way, no trailing separator, for a stable comparison. */
function normalizePath(path: string): string {
  const forward = path.trim().replace(/\\/g, "/");
  return forward.length > 1 ? forward.replace(/\/+$/, "") : forward;
}

function basename(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? path : path.slice(at + 1);
}

/** A denied path matches a target three ways, so a single `.env` covers the
 *  file wherever it sits:
 *   - a glob (any entry with `*`): `*` spans one segment, `**` spans many, matched
 *     against the whole path and against the leaf on its own;
 *   - a leaf: the target's basename is the entry, or opens the entry's dotfile /
 *     extension family (`.env` denies `.env.local`, `secret` denies `secret.txt`);
 *   - a fragment: the entry is one or more whole path segments of the target
 *     (`secrets` denies `/app/secrets/key`, `config/prod` denies `/app/config/prod/x`).
 */
function pathDenied(target: string, rawEntry: string): boolean {
  const path = normalizePath(target);
  const entry = normalizePath(rawEntry);
  if (!entry) return false;

  if (entry.includes("*")) {
    const rx = globToRegExp(entry);
    return rx.test(path) || rx.test(basename(path));
  }

  if (path === entry) return true;

  const leaf = basename(path);
  if (leaf === entry) return true;
  if (leaf.startsWith(`${entry}.`)) return true;

  // The entry as a run of whole segments: bounded by separators or the ends of
  // the path, never a bare substring — so `env` never trips on `/environment`.
  if (path.endsWith(`/${entry}`)) return true;
  if (path.startsWith(`${entry}/`)) return true;
  if (path.includes(`/${entry}/`)) return true;

  return false;
}

/** `*` → any run of non-separator, `**` → any run including separators, every
 *  other regex metacharacter escaped, anchored end to end. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (/[.+?^${}()|[\]\\]/.test(ch as string)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Weigh one action against an agent's policies. Empty lists forbid nothing, so
 * an agent with no policies (the shipped default) always lands on `allowed`.
 * The first matching rule wins and names itself in the reason.
 */
export function evaluatePolicies(
  policies: AgentPolicies | null | undefined,
  action: PolicyAction,
): PolicyVerdict {
  if (!policies) return ALLOWED;
  const target = action.target.trim();
  if (!target) return ALLOWED;

  if (isCommandKind(action.kind)) {
    for (const entry of policies.deniedCommands) {
      if (entry && commandDenied(target, entry)) {
        return { allowed: false, reason: `Command blocked by policy: "${entry}"` };
      }
    }
  }

  if (isPathKind(action.kind)) {
    for (const entry of policies.deniedPaths) {
      if (entry && pathDenied(target, entry)) {
        return { allowed: false, reason: `Path blocked by policy: "${entry}"` };
      }
    }
  }

  return ALLOWED;
}

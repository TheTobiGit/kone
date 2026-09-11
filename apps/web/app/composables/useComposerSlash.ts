import {
  AiChipIcon,
  BotIcon,
  FoldVerticalIcon,
  GitBranchIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import {
  filterSlashCommandItems,
  type SlashCommandItem,
} from "~/utils/composerMentions";

/** Which capability surface a slash row needs. One name per row, shared by the
 *  menu filter and the send-time dispatch so a row can never be offered where
 *  its send-time twin would refuse to run. */
export type SlashGate = "agent" | "model" | "compact" | "branch" | "create";

export type SlashCapabilities = Record<SlashGate, boolean>;

/** One slash command: its row, the gate that hides it, and what a run keeps.
 *  `keepDraft` rows never consume text (`/agent` hands the pending draft to
 *  the roster); `clearsAll` rows drop the whole editor even from the menu
 *  (`/new` abandons the draft, never carries it over); `silent` rows run
 *  without the pick chime. The effect itself (which emit) lives in the
 *  composer's single dispatch — the table owns visibility and consumption. */
export type SlashCommandDef = {
  description: string;
  icon: typeof AiChipIcon;
  gatedBy: SlashGate;
  keepDraft?: boolean;
  clearsAll?: boolean;
  silent?: boolean;
};

/** The composer's `/` commands, one row per name. Alphabetical by name —
 *  project/user file commands shadow by name once they exist. */
export const SLASH_COMMANDS: Record<string, SlashCommandDef> = {
  agent: {
    description: "Hand the turn to someone else",
    icon: BotIcon,
    gatedBy: "agent",
    keepDraft: true,
  },
  branch: {
    description: "Switch or fork the thread branch",
    icon: GitBranchIcon,
    gatedBy: "branch",
  },
  compact: {
    description: "Compact the conversation",
    icon: FoldVerticalIcon,
    gatedBy: "compact",
  },
  model: {
    description: "Open model picker",
    icon: AiChipIcon,
    gatedBy: "model",
  },
  new: {
    description: "Start a new thread",
    icon: PlusSignIcon,
    gatedBy: "create",
    clearsAll: true,
    silent: true,
  },
};

/** The picker's rows, derived from the table so the menu can never list a
 *  command the dispatch doesn't know. Sorted by name — the table already is,
 *  but the order is a contract, not an accident of insertion. */
export const BUILTIN_SLASH_COMMANDS: readonly SlashCommandItem[] = Object.entries(SLASH_COMMANDS)
  .map(([name, def]) => ({ name, description: def.description, icon: def.icon }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** Pure gate check, so both the menu filter and the send-time dispatch — and
 *  tests — read the same rule. Unknown names are never allowed: anything the
 *  table doesn't name falls through to the provider, which owns its commands. */
export function slashAllowed(gates: SlashCapabilities, name: string): boolean {
  const def = SLASH_COMMANDS[name];
  if (!def) return false;
  return gates[def.gatedBy];
}

/** The composer's `/` config: the capability gates plus the row source and
 *  the gate check. Trigger state (the token, the index, the keyboard) lives in
 *  the shared trigger machine — this only knows commands. */
export function useComposerSlash(deps: {
  /** The row only runs where its surface exists — `/agent` needs a roster. */
  canSwitchAgent: () => boolean;
  /** The row only runs where its surface exists — `/model` needs a picker. */
  canSwitchModel: () => boolean;
  /** The row only runs where compaction exists — `/compact` needs a host. */
  canCompact: () => boolean;
  /** The row only runs where the tray branch can switch — `/branch` needs a host picker. */
  canBranch: () => boolean;
  /** The row only runs where a fresh thread can start — `/new` needs a host. */
  canCreate: () => boolean;
}) {
  function readGates() {
    return {
      agent: deps.canSwitchAgent(),
      model: deps.canSwitchModel(),
      compact: deps.canCompact(),
      branch: deps.canBranch(),
      create: deps.canCreate(),
    } satisfies SlashCapabilities;
  }

  /** Gated per row, not on busy: opening a picker or compacting is local
   *  ui, never a send, so a running turn must not hide any of them. */
  function isSlashAllowed(name: string): boolean {
    return slashAllowed(readGates(), name);
  }

  function slashItemsFor(query: string): SlashCommandItem[] {
    const visible = BUILTIN_SLASH_COMMANDS.filter((item) => isSlashAllowed(item.name));
    return filterSlashCommandItems(visible, query);
  }

  return {
    slashItemsFor,
    isSlashAllowed,
  };
}

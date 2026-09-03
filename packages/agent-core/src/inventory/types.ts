// ── Agents-page inventory data model ────────────────────────────────────────
// A READ-ONLY snapshot of three things kone finds on the machine: skills, MCP
// servers, and agent instruction files (CLAUDE.md/AGENTS.md). This module
// never writes anything — it only scans and reports, for the "Agents" page.
// Spec: docs/skills-mcp-research.md §2 (MCP config sources), §3 (skills
// discovery roots + SKILL.md frontmatter), §4 (data models this mirrors).

/** One on-disk copy of a skill: enough to name where it is and who would
 *  have offered it, never the file's contents. */
export type SkillCopy = { origin: string; scope: SkillEntry["scope"]; path: string };

/** One discovered skill (a directory containing a SKILL.md). `origin` names
 *  which CLI's root the skill was found under — kept as a plain string
 *  (rather than a literal union) so a new origin never breaks this contract;
 *  today's values are "claude" | "codex" | "opencode" | "cursor" | "agents" |
 *  "kone". */
export type SkillEntry = {
  name: string;
  description: string | null;
  /** Absolute SKILL.md path. */
  path: string;
  directory: string;
  origin: string;
  scope: "user" | "project" | "plugin" | "system";
  displayName: string | null;
  shortDescription: string | null;
  /** Who the SKILL.md credits, from `author` (or nested `metadata.author`) frontmatter; null when unsigned. */
  author: string | null;
  /** SKILL.md mtime, epoch ms. The scan already stats the file to size-check
   *  it, so carrying the stamp costs nothing and saves the list a per-row read
   *  just to say how stale a skill is. */
  modifiedAt: number;
  /** Copies of this same skill name that lost the precedence contest, nearest
   *  loser first. Empty for the overwhelming majority of skills. */
  shadowedBy: SkillCopy[];
  /** True when the SKILL.md asks not to be invoked automatically
   *  (`disable-model-invocation: true`) — the skill is still there, but the
   *  model won't reach for it on its own. */
  manualOnly: boolean;
  /** Whether the skill is currently enabled. Mirrors t3's ServerProviderSkill.enabled.
   *  v1 stable defaults to true at discovery; effective state is resolved via skillState. */
  enabled: boolean;
};

/** How an MCP server is reached. `unknown` is a real, expected value — plenty
 *  of on-disk configs omit an explicit `type` tag and give us nothing to
 *  shape-infer from (no `command`, no `url`). */
export type McpTransport = "stdio" | "http" | "sse" | "ws" | "unknown";

/** One discovered MCP server, normalized from whatever config shape it came
 *  from. `envKeys` is deliberately KEY NAMES ONLY — the values may be API
 *  keys/tokens and must never cross this boundary. */
export type McpServerEntry = {
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  url: string | null;
  /** Env var KEY NAMES the server config declares — never the values. */
  envKeys: string[];
  /** The config file this entry was read from. */
  sourcePath: string;
  /** Human label for the source, e.g. "Claude Code · project". */
  sourceLabel: string;
  scope: "user" | "project";
  /** `null` when the source has no enable/disable concept at all — distinct
   *  from a server the source explicitly turned off. */
  enabled: boolean | null;
};

/** One discovered CLAUDE.md/AGENTS.md instruction file. */
export type InstructionFile = {
  path: string;
  kind: "AGENTS.md" | "CLAUDE.md" | "other";
  scope: "user" | "project" | "nested";
  bytes: number;
  modifiedAt: number;
  /** First ~400 chars, plain text — frontmatter and markdown heading marks
   *  stripped so it reads as prose, not markup. */
  excerpt: string;
};

/** One discovered plugin — a container that holds N skills. */
export type PluginEntry = {
  name: string;
  description: string | null;
  path: string;
  origin: string;
  scope: "user" | "project" | "plugin" | "system";
  skills: SkillEntry[];
};

/** One scan-step failure, kept alongside a successful (partial) result rather
 *  than rejecting the whole inventory. */
export type InventoryError = { source: string; message: string };

/** The full read-only snapshot `scanAgentInventory` returns. */
export type AgentInventory = {
  scannedAt: number;
  projectPath: string | null;
  skills: SkillEntry[];
  plugins: PluginEntry[];
  mcpServers: McpServerEntry[];
  instructions: InstructionFile[];
  errors: InventoryError[];
};

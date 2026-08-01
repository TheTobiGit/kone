<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import type { VNode } from "vue";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
// Tool-call glyphs are Hugeicons stroke icons — same family as the rest of the
// app's iconography (brain, chevron, copy) — each carrying a soft family hue so a
// run of calls reads as a legible, lightly-coloured timeline rather than a wall of
// grey — Read blues, Write violets, Search ambers, Run greens, Delete red.
import {
  AiBrain01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  Copy01Icon,
  Tick02Icon,
  Note01Icon,
  File01Icon,
  FileEditIcon,
  ListViewIcon,
  Delete02Icon,
  Search01Icon,
  SourceCodeIcon,
  CommandLineIcon,
  GlobalSearchIcon,
  Link01Icon,
  WorkflowSquare01Icon,
  Rocket01Icon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import type { RuntimeItem } from "~/types/desktop";
import type { AssistantBlock, ThreadBlock } from "~/composables/useAgent";
import MarkdownMessage from "~/components/MarkdownMessage.vue";
import FileChip from "~/components/FileChip.vue";
import SiteChip from "~/components/SiteChip.vue";
import TurnOrb from "~/components/TurnOrb.vue";
import type { ToolOrbFamily } from "~/utils/toolOrbDraw";
import { stateForToolFamily } from "~/utils/thinkingOrb";
import { THINKING_ORB_HUE } from "~/utils/toolOrbDraw";
import { looksLikeDirectoryPath, looksLikeSite } from "~/utils/siteChip";
import CodeGolfArt from "~/components/ui/CodeGolfArt.vue";

// The live conversation — where the agent's turns become a timeline.
//
// The rule (the convention every serious agent UI + every provider wire format
// converges on): a turn is a single ORDERED list of parts — thinking, tool
// calls, and text — rendered strictly in the order they arrived. We never regroup
// by kind. Our provider stream already hands `block.items` in arrival order; here
// we only coalesce *adjacent* same-kind items into segments (a run of thoughts,
// a run of tool calls, a run of text) so the layout has rhythm, then render the
// segments in place. This is what makes tools-at-the-start, a tool-after-text,
// and interleaved thinking all read correctly.
//
// The look is an editorial transcript: a calm warm-paper base with generous
// rhythm, colour and motion held back for the *live* moments so the dynamism
// feels earned. While a turn runs a quiet highlight travels the tool rail; the
// moment it settles it collapses to quiet, dotted-leader meta.
//
//   · thinking streams live behind a plain muted "Thinking…" label and a violet
//     dot-globe orb, then collapses to a brain icon + "Thought for Xs" disclosure;
//   · a general working orb holds any quiet gap — left-aligned particles that
//     grow longer and denser the longer the wait; step orbs + streaming text
//     take over once activity starts;
//   · text renders as rich Markdown the whole way through — streaming or settled
//     — so a reply reads as a proper preview as it grows, never a raw block;
//
// Purely presentational — it reads the reduced blocks from useAgent and never
// learns which CLI is underneath.

const props = defineProps<{
  blocks: ThreadBlock[];
  /** Ticking clock from useAgent, so "working · Xs" counts up live. */
  now: number;
  /** A session-level error (start failure, crashed process) — shown as a
   *  single banner above the thread when set. */
  sessionError?: string | null;
  /** Strip column key — forwarded with scratchpad captures. */
  sourceKey?: string;
}>();

const emit = defineEmits<{
  "to-scratchpad": [text: string];
}>();

const { cue } = useSound();

// Warm the Markdown parser on mount: markdown-it is code-split behind a dynamic
// import, so the very first streamed reply would otherwise flash raw source for a
// beat while it loads. Kicking the load off now means text renders formatted from
// the first chunk.
if (import.meta.client) void useMarkdown().parse("");

// ── tool-call vocabulary → icon + label + family hue + running orb ──────────
// Icons are Hugeicons SVG data objects (the `:icon` prop of <HugeiconsIcon>), not
// Vue components — same shape as AiBrain01Icon et al.
type HugeIcon = typeof AiBrain01Icon;
type ToolMeta = { icon: HugeIcon; label: string; hue: string; family: ToolOrbFamily };
// Family hues — mid-tone so they read on both the warm-light and near-black
// grounds without a per-theme table. Double-encoded with the tool's icon glyph
// and label text, never colour alone.
const HUE = {
  read: "#5b9dd9", // blues — read / list / inspect
  write: "#8b7ff0", // violets — write / edit
  search: "#d99a4e", // ambers — grep / glob / search
  intel: "#48b0b8", // teal — code intelligence
  run: "#4fae86", // greens — shell / commands
  web: "#3fa9c9", // cyan — the network
  agent: "#d97aa8", // pink — sub-agents / orchestration
  del: "var(--diff-del)", // red — destructive
  neutral: "var(--muted)",
} as const;
const TOOL_TABLE: Record<string, ToolMeta> = {
  // filesystem
  read_file: { icon: File01Icon, label: "Read", hue: HUE.read, family: "read" },
  view_file: { icon: File01Icon, label: "Read", hue: HUE.read, family: "read" },
  read: { icon: File01Icon, label: "Read", hue: HUE.read, family: "read" },
  write_to_file: { icon: FileEditIcon, label: "Write", hue: HUE.write, family: "write" },
  create_file: { icon: FileEditIcon, label: "Write", hue: HUE.write, family: "write" },
  write: { icon: FileEditIcon, label: "Write", hue: HUE.write, family: "write" },
  edit_file: { icon: FileEditIcon, label: "Edit", hue: HUE.write, family: "write" },
  apply_patch: { icon: FileEditIcon, label: "Edit", hue: HUE.write, family: "write" },
  str_replace: { icon: FileEditIcon, label: "Edit", hue: HUE.write, family: "write" },
  replace_file_content: { icon: FileEditIcon, label: "Edit", hue: HUE.write, family: "write" },
  edit: { icon: FileEditIcon, label: "Edit", hue: HUE.write, family: "write" },
  multiedit: { icon: FileEditIcon, label: "Edit", hue: HUE.write, family: "write" }, // Claude
  notebookedit: { icon: FileEditIcon, label: "Edit", hue: HUE.write, family: "write" }, // Claude
  list_dir: { icon: ListViewIcon, label: "List", hue: HUE.read, family: "read" },
  ls: { icon: ListViewIcon, label: "List", hue: HUE.read, family: "read" },
  delete_file: { icon: Delete02Icon, label: "Delete", hue: HUE.del, family: "del" },
  rm: { icon: Delete02Icon, label: "Delete", hue: HUE.del, family: "del" },
  // search & navigation
  grep_search: { icon: Search01Icon, label: "Grep", hue: HUE.search, family: "search" },
  ripgrep: { icon: Search01Icon, label: "Grep", hue: HUE.search, family: "search" },
  glob_file_search: { icon: Search01Icon, label: "Glob", hue: HUE.search, family: "search" },
  find_by_name: { icon: Search01Icon, label: "Glob", hue: HUE.search, family: "search" },
  glob: { icon: Search01Icon, label: "Glob", hue: HUE.search, family: "search" }, // Claude
  codebase_search: { icon: Search01Icon, label: "Search", hue: HUE.search, family: "search" },
  grep: { icon: Search01Icon, label: "Grep", hue: HUE.search, family: "search" },
  search: { icon: Search01Icon, label: "Search", hue: HUE.search, family: "search" },
  go_to_definition: { icon: SourceCodeIcon, label: "Code intel", hue: HUE.intel, family: "intel" },
  view_code_item: { icon: SourceCodeIcon, label: "Code intel", hue: HUE.intel, family: "intel" },
  lsp: { icon: SourceCodeIcon, label: "Code intel", hue: HUE.intel, family: "intel" },
  // execution
  bash: { icon: CommandLineIcon, label: "Run", hue: HUE.run, family: "run" },
  run_terminal_cmd: { icon: CommandLineIcon, label: "Run", hue: HUE.run, family: "run" },
  execute_command: { icon: CommandLineIcon, label: "Run", hue: HUE.run, family: "run" },
  run_command: { icon: CommandLineIcon, label: "Run", hue: HUE.run, family: "run" },
  run: { icon: CommandLineIcon, label: "Run", hue: HUE.run, family: "run" },
  command: { icon: CommandLineIcon, label: "Run", hue: HUE.run, family: "run" },
  // web
  web_search: { icon: GlobalSearchIcon, label: "Web search", hue: HUE.web, family: "web" },
  search_web: { icon: GlobalSearchIcon, label: "Web search", hue: HUE.web, family: "web" },
  websearch: { icon: GlobalSearchIcon, label: "Web search", hue: HUE.web, family: "web" }, // Claude
  web_fetch: { icon: Link01Icon, label: "Web fetch", hue: HUE.web, family: "web" },
  read_url_content: { icon: Link01Icon, label: "Web fetch", hue: HUE.web, family: "web" },
  view_web_document: { icon: Link01Icon, label: "Web fetch", hue: HUE.web, family: "web" },
  webfetch: { icon: Link01Icon, label: "Web fetch", hue: HUE.web, family: "web" }, // Claude
  list: { icon: ListViewIcon, label: "List", hue: HUE.read, family: "read" },
  todowrite: { icon: WorkflowSquare01Icon, label: "Plan", hue: HUE.agent, family: "agent" },
  patch: { icon: FileEditIcon, label: "Edit", hue: HUE.write, family: "write" },
  // planning & orchestration
  task: { icon: WorkflowSquare01Icon, label: "Subagent", hue: HUE.agent, family: "agent" },
  new_task: { icon: WorkflowSquare01Icon, label: "Subagent", hue: HUE.agent, family: "agent" },
  agent: { icon: WorkflowSquare01Icon, label: "Subagent", hue: HUE.agent, family: "agent" },
  mcp: { icon: WorkflowSquare01Icon, label: "MCP tool", hue: HUE.agent, family: "agent" },
  // context & specialized
  deploy_web_app: { icon: Rocket01Icon, label: "Deploy", hue: HUE.run, family: "run" },
};
function toolMeta(name: string | undefined): ToolMeta {
  if (!name) return { icon: ToolsIcon, label: "Tool", hue: HUE.neutral, family: "neutral" };
  const key = name.trim().toLowerCase();
  if (TOOL_TABLE[key]) return TOOL_TABLE[key]!;
  // MCP tools arrive as `mcp__server__tool` — read the last segment as the label
  // and hue them as external/orchestration rather than a raw title-cased blob.
  if (key.startsWith("mcp__")) {
    const tail = key.split("__").filter(Boolean).pop() ?? key;
    const label = tail.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return { icon: WorkflowSquare01Icon, label, hue: HUE.agent, family: "agent" };
  }
  const label = key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { icon: ToolsIcon, label, hue: HUE.neutral, family: "neutral" };
}
// The provider hands args as `read_file: src/foo.ts`; peel the name so we're left
// with the target (path / command / query). Long tails keep their end — the full
// value stays reachable in the row's title attribute.
function toolTargetRaw(t: RuntimeItem): string {
  const name = (t.name ?? "").trim();
  const raw = (t.text ?? "").trim();
  const prefix = `${name}:`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw === name ? "" : raw;
}
function toolTarget(t: RuntimeItem, max = 64): string {
  const d = toolTargetRaw(t);
  if (d.length <= max) return d;
  const name = (t.name ?? "").trim().toLowerCase();
  const isCommand =
    ["bash", "run_terminal_cmd", "execute_command", "run_command", "run", "command"].includes(name) ||
    looksLikeCommand(d);
  if (isCommand) {
    return d.slice(0, max - 1) + "…";
  }
  if (looksLikeFilePath(d) || looksLikeDirectoryPath(d)) {
    return "…" + d.slice(-(max - 1));
  }
  return d.slice(0, max - 1) + "…";
}
function toolDetailFull(t: RuntimeItem): string {
  return toolTargetRaw(t);
}
function looksLikeFilePath(s: string): boolean {
  if (!s) return false;
  const base = s.split("/").filter(Boolean).pop() ?? s;
  const stem = base.replace(/:\d+(?:-\d+)?$/, "");
  if (/^[\w.-]+\.(vue|ts|tsx|js|jsx|css|md|json|py|go|rs|rb|php|html|yaml|yml|toml|svg|png|jpg|jpeg|webp|gif|log|sh|sql|toml|lock)$/i.test(stem))
    return true;
  if (/[\\/]/.test(s) && /\.[a-z0-9]{1,8}$/i.test(stem)) return true;
  return false;
}
function looksLikeCommand(s: string): boolean {
  return /^(bun|npm|pnpm|yarn|git|cargo|make|python3?|node|deno|npx|bunx|docker|go|pytest|vitest|sh|bash|zsh)\s/i.test(s);
}
// Natural-language row copy — reads like a brief status line, not "Verb: target".
type ToolPhraseTarget =
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string }
  | { kind: "site"; url: string }
  | { kind: "mono"; text: string };
type ToolPhrase = { before: string; target?: ToolPhraseTarget; after?: string };
function targetPhrase(
  lead: string,
  text?: string,
  tail = "",
  force?: ToolPhraseTarget["kind"],
): ToolPhrase {
  if (!text) return { before: `${lead}${tail}` };
  const kind =
    force ??
    (looksLikeSite(text)
      ? "site"
      : looksLikeCommand(text)
        ? "mono"
        : looksLikeFilePath(text)
          ? "file"
          : looksLikeDirectoryPath(text)
            ? "folder"
            : "mono");
  if (kind === "file") return { before: lead, target: { kind: "file", path: text }, after: tail || undefined };
  if (kind === "folder") return { before: lead, target: { kind: "folder", path: text }, after: tail || undefined };
  if (kind === "site") return { before: lead, target: { kind: "site", url: text }, after: tail || undefined };
  return { before: lead, target: { kind: "mono", text }, after: tail || undefined };
}
function plain(text: string): ToolPhrase {
  return { before: text };
}
function toolPhrase(t: RuntimeItem): ToolPhrase {
  const status = toolStatus(t);
  const ing = status === "running";
  const fail = status === "error";
  const detail = toolTarget(t);
  const full = toolTargetRaw(t);
  const name = (t.name ?? "").trim().toLowerCase();

  // grep-style "query · N matches"
  const matchSplit = full.match(/^(.+?)\s*·\s*(\d+)\s+matches?$/i);
  if (matchSplit) {
    const [, query, count] = matchSplit;
    if (ing) return plain(`Searching for ${query}`);
    if (fail) return plain(`Couldn't search for ${query}`);
    return plain(`Found ${count} matches for ${query}`);
  }

  // code-intel "symbol → file:line"
  const defSplit = full.match(/^(.+?)\s*→\s*(.+)$/);
  if (name === "go_to_definition" || name === "view_code_item" || name === "lsp") {
    if (defSplit) {
      const [, symbol, loc] = defSplit;
      if (ing) return plain(`Looking up ${symbol}`);
      if (fail) return plain(`Couldn't find ${symbol}`);
      return targetPhrase(`Jumped to ${symbol} in `, loc, "", "file");
    }
    if (ing) return plain(full ? `Looking up ${full}` : "Looking up a symbol");
    if (fail) return plain(full ? `Couldn't find ${full}` : "Lookup failed");
    return looksLikeFilePath(full) ? targetPhrase("Jumped to ", full, "", "file") : plain(`Jumped to ${full}`);
  }

  // web fetch "url · label"
  const fetchSplit = full.match(/^(.+?)\s*·\s*(.+)$/);
  if (name === "web_fetch" || name === "read_url_content" || name === "view_web_document" || name === "webfetch") {
    const url = fetchSplit?.[1]?.trim() ?? full;
    if (ing) return targetPhrase("Fetching ", url, "", "site");
    if (fail) return targetPhrase("Couldn't fetch ", url, "", "site");
    return targetPhrase("Fetched ", url, "", "site");
  }

  switch (name) {
    case "read_file":
    case "view_file":
    case "read":
      if (!detail) return plain(ing ? "Reading a file" : fail ? "Couldn't read file" : "Read a file");
      if (ing) return targetPhrase("Reading ", detail, "", "file");
      if (fail) return targetPhrase("Couldn't read ", detail, "", "file");
      return targetPhrase("Read ", detail, "", "file");
    case "write_to_file":
    case "create_file":
    case "write":
      if (!detail) return plain(ing ? "Writing a file" : fail ? "Couldn't write file" : "Wrote a file");
      if (ing) return targetPhrase("Writing ", detail, "", "file");
      if (fail) return targetPhrase("Couldn't write ", detail, "", "file");
      return targetPhrase("Wrote ", detail, "", "file");
    case "edit_file":
    case "apply_patch":
    case "str_replace":
    case "replace_file_content":
    case "edit":
    case "multiedit":
    case "notebookedit":
      if (!detail) return plain(ing ? "Editing a file" : fail ? "Couldn't edit file" : "Edited a file");
      if (ing) return targetPhrase("Editing ", detail, "", "file");
      if (fail) return targetPhrase("Couldn't edit ", detail, "", "file");
      return targetPhrase("Edited ", detail, "", "file");
    case "list_dir":
    case "ls":
      if (!detail) return plain(ing ? "Listing a folder" : fail ? "Couldn't list folder" : "Listed a folder");
      if (ing) return targetPhrase("Listing ", detail, "", "folder");
      if (fail) return targetPhrase("Couldn't list ", detail, "", "folder");
      return targetPhrase("Listed ", detail, "", "folder");
    case "delete_file":
    case "rm":
      if (!detail) return plain(ing ? "Deleting a file" : fail ? "Couldn't delete file" : "Deleted a file");
      if (ing) return targetPhrase("Deleting ", detail, "", "file");
      if (fail) return targetPhrase("Couldn't delete ", detail, "", "file");
      return targetPhrase("Deleted ", detail, "", "file");
    case "grep_search":
    case "ripgrep":
    case "grep":
      if (!detail) return plain(ing ? "Searching the codebase" : fail ? "Search failed" : "Searched the codebase");
      if (ing) return plain(`Searching for ${detail}`);
      if (fail) return plain(`Couldn't search for ${detail}`);
      return plain(`Searched for ${detail}`);
    case "glob_file_search":
    case "find_by_name":
    case "glob":
      if (!detail) return plain(ing ? "Finding files" : fail ? "File search failed" : "Found matching files");
      if (ing) return plain(`Finding files matching ${detail}`);
      if (fail) return plain(`Couldn't find files matching ${detail}`);
      return plain(`Found files matching ${detail}`);
    case "codebase_search":
    case "search":
      if (!detail) return plain(ing ? "Searching the codebase" : fail ? "Search failed" : "Searched the codebase");
      if (ing) return plain(`Searching the codebase for ${detail}`);
      if (fail) return plain(`Couldn't find ${detail} in the codebase`);
      return plain(`Searched the codebase for ${detail}`);
    case "bash":
    case "run_terminal_cmd":
    case "execute_command":
    case "run_command":
    case "run":
    case "command":
      if (!detail) return plain(ing ? "Running a command" : fail ? "Command failed" : "Ran a command");
      if (ing) return targetPhrase("Running ", detail, "", "mono");
      if (fail) return targetPhrase("Couldn't run ", detail, "", "mono");
      return targetPhrase("Ran ", detail, "", "mono");
    case "web_search":
    case "search_web":
    case "websearch":
      if (!detail) return plain(ing ? "Searching the web" : fail ? "Web search failed" : "Searched the web");
      if (ing) return plain(`Searching the web for ${detail}`);
      if (fail) return plain(`Couldn't search the web for ${detail}`);
      return plain(`Searched the web for ${detail}`);
    case "task":
    case "new_task":
    case "agent":
      if (!detail) return plain(ing ? "Starting a sub-task" : fail ? "Sub-task failed" : "Finished a sub-task");
      if (ing) return plain(`Running a sub-task — ${detail}`);
      if (fail) return plain(`Sub-task failed — ${detail}`);
      return plain(`Ran a sub-task — ${detail}`);
    case "mcp":
      if (!detail) return plain(ing ? "Running an MCP tool" : fail ? "MCP tool failed" : "Ran an MCP tool");
      if (ing) return plain(`Running an MCP tool — ${detail}`);
      if (fail) return plain(`MCP tool failed — ${detail}`);
      return plain(`Ran an MCP tool — ${detail}`);
    case "deploy_web_app":
      if (!detail) return plain(ing ? "Deploying" : fail ? "Deploy failed" : "Deployed");
      if (ing) return plain(`Deploying ${detail}`);
      if (fail) return plain(`Couldn't deploy ${detail}`);
      return plain(`Deployed ${detail}`);
    default: {
      const human = name.replace(/[_-]+/g, " ");
      if (name.includes("screenshot") || name.includes("capture")) {
        if (ing) return plain("Taking a screenshot");
        if (fail) return plain("Couldn't capture screenshot");
        return detail ? targetPhrase("Captured ", detail, "", "file") : plain("Captured a screenshot");
      }
      if (!detail) {
        if (ing) return plain(`Running ${human}`);
        if (fail) return plain(`${human} failed`);
        return plain(`Ran ${human}`);
      }
      if (ing) return plain(`Running ${human} on ${detail}`);
      if (fail) return plain(`Couldn't run ${human} on ${detail}`);
      return plain(`Ran ${human} on ${detail}`);
    }
  }
}
type ToolPhrasePart =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string }
  | { kind: "site"; url: string }
  | { kind: "mono"; text: string };
function toolPhraseParts(t: RuntimeItem): ToolPhrasePart[] {
  const p = toolPhrase(t);
  const out: ToolPhrasePart[] = [{ kind: "text", text: p.before }];
  if (p.target?.kind === "file") out.push({ kind: "file", path: p.target.path });
  else if (p.target?.kind === "folder") out.push({ kind: "folder", path: p.target.path });
  else if (p.target?.kind === "site") out.push({ kind: "site", url: p.target.url });
  else if (p.target?.kind === "mono") out.push({ kind: "mono", text: p.target.text });
  if (p.after) out.push({ kind: "text", text: p.after });
  return out;
}

// ── the ordered-parts model ───────────────────────────────────────────────────
// Walk the block's items (already in arrival order) and coalesce runs of the same
// kind into segments. Order is never changed — only adjacent same-kind items join.
type SegKind = "thinking" | "tools" | "text";
type Segment = { kind: SegKind; key: string; items: RuntimeItem[] };

function segKindOf(item: RuntimeItem): SegKind {
  if (item.kind === "reasoning_text") return "thinking";
  if (item.kind === "tool_call") return "tools";
  return "text"; // assistant_text — plan_text renders in the dock, not the thread
}
function segmentsOf(block: AssistantBlock): Segment[] {
  const out: Segment[] = [];
  for (const it of block.items) {
    if (it.kind === "plan_text") continue;
    const kind = segKindOf(it);
    const cur = out[out.length - 1];
    if (cur && cur.kind === kind) cur.items.push(it);
    else out.push({ kind, key: `${block.id}:${it.itemId}`, items: [it] });
  }
  return out;
}
function segStreaming(seg: Segment): boolean {
  return seg.items.some((i) => i.status === "in-progress");
}
function segText(seg: Segment): string {
  return seg.items
    .map((i) => i.text)
    .join("\n\n")
    .trim();
}
// Some models never surface their reasoning — the turn carries a thinking marker
// but no text. There's nothing to reveal, so such a segment renders as a bare
// label with no disclosure (no chevron, no expand/collapse).
function thinkHasContent(seg: Segment): boolean {
  return segText(seg).length > 0;
}
function toolCalls(seg: Segment): RuntimeItem[] {
  return seg.items.filter((i) => i.kind === "tool_call");
}
function toolStatus(t: RuntimeItem): "running" | "done" | "error" {
  if (t.status === "in-progress") return "running";
  if (t.status === "failed") return "error";
  return "done";
}

// Thinking and tool calls are "steps" — rows in one continuous list with a
// connecting line. The agent's task plan lives in the bottom-right dock, not
// here. Text breaks the rail and starts fresh.
type RenderGroup = { kind: "steps"; key: string; segments: Segment[] } | { kind: "text"; seg: Segment };
function renderGroups(block: AssistantBlock): RenderGroup[] {
  const out: RenderGroup[] = [];
  for (const seg of segmentsOf(block)) {
    if (seg.kind === "text") {
      out.push({ kind: "text", seg });
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.kind === "steps") last.segments.push(seg);
    else out.push({ kind: "steps", key: seg.key, segments: [seg] });
  }
  return out;
}
function stepRowCount(segments: Segment[]): number {
  return segments.reduce((n, s) => n + (s.kind === "thinking" ? 1 : toolCalls(s).length), 0);
}
// Row index within the whole group (thinking + tool calls together), so the
// entrance stagger runs continuously across a mixed group instead of resetting
// at each segment boundary.
function stepOffset(segments: Segment[], segIdx: number): number {
  return stepRowCount(segments.slice(0, segIdx));
}
const STEP_SPRING = { type: "spring", stiffness: 480, damping: 17, mass: 0.7 } as const;
function stepDelay(i: number): number {
  return Math.min(i * 0.06, 0.36);
}

// Each step's connector line lives inside its animated row so the rail and icon
// enter together — the old full-height rail jumped to the next row before the
// icon's stagger finished.
const stepLinkObservers = new WeakMap<HTMLElement, ResizeObserver>();
// `@vue:mounted` / `@vue:unmounted` hand us the VNode, so the row element is
// `vnode.el` — on a component vnode that's its rendered root.
function stepEntryEl(vnode: VNode): HTMLElement | null {
  return vnode.el instanceof HTMLElement ? vnode.el : null;
}
function layoutStepEntry(vnode: VNode): void {
  const entry = stepEntryEl(vnode);
  if (!entry) return;
  const link = entry.querySelector(".step-entry__link");
  if (!(link instanceof HTMLElement)) return;
  const prev = entry.previousElementSibling;
  if (!(prev instanceof HTMLElement)) return;
  const sync = () => link.style.setProperty("--step-link-h", `${prev.offsetHeight}px`);
  sync();
  stepLinkObservers.get(entry)?.disconnect();
  const ro = new ResizeObserver(sync);
  ro.observe(prev);
  ro.observe(entry);
  stepLinkObservers.set(entry, ro);
}
function unlayoutStepEntry(vnode: VNode): void {
  const entry = stepEntryEl(vnode);
  if (!entry) return;
  stepLinkObservers.get(entry)?.disconnect();
  stepLinkObservers.delete(entry);
}

// ── per-item timing (for "Thought for Xs") ────────────────────────────────────
// Items carry no timestamps, so we clock them ourselves: when we first see an
// item, and when it settles. A thinking segment's duration spans its earliest
// first-seen to its latest settle.
const seenAt = new Map<string, number>();
const doneAt = new Map<string, number>();
watch(
  () =>
    props.blocks
      .flatMap((b) => (b.role === "assistant" ? b.items.map((i) => `${i.itemId}:${i.status}`) : []))
      .join(","),
  () => {
    const t = Date.now();
    for (const b of props.blocks) {
      if (b.role !== "assistant") continue;
      for (const it of b.items) {
        if (!seenAt.has(it.itemId)) seenAt.set(it.itemId, t);
        if ((it.status === "completed" || it.status === "failed") && !doneAt.has(it.itemId))
          doneAt.set(it.itemId, t);
      }
    }
  },
  { immediate: true },
);
function thinkingDuration(seg: Segment): number | null {
  if (segStreaming(seg)) return null;
  const starts = seg.items.map((i) => seenAt.get(i.itemId)).filter((x): x is number => x != null);
  const ends = seg.items.map((i) => doneAt.get(i.itemId)).filter((x): x is number => x != null);
  if (!starts.length || !ends.length) return null;
  return Math.max(1, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000));
}

// ── thinking collapse ─────────────────────────────────────────────────────────
// Expanded while it streams; auto-collapses the moment it settles. A click pins
// an explicit state either way.
const thinkOpen = reactive<Record<string, boolean>>({});
function thinkingExpanded(seg: Segment): boolean {
  return seg.key in thinkOpen ? thinkOpen[seg.key]! : segStreaming(seg);
}
function toggleThinking(seg: Segment): void {
  thinkOpen[seg.key] = !thinkingExpanded(seg);
  cue("toggle");
}

// ── waiting ───────────────────────────────────────────────────────────────────
// A live turn with nothing currently in flight — the opening gap after send,
// or a lull between one step settling and the next starting. The working orb
// fills it; step orbs and streaming text take over while those run.
function isWaiting(block: AssistantBlock): boolean {
  if (block.state !== "running") return false;
  const last = block.items[block.items.length - 1];
  return !last || last.status !== "in-progress";
}

// ── tool-call detail expand ───────────────────────────────────────────────────
// A tool row expands on click only when it carries a `detail` body (command
// output, a diff, a file list) — no dead affordance otherwise.
const toolOpen = reactive<Record<string, boolean>>({});
function toolExpanded(t: RuntimeItem): boolean {
  return Boolean(toolOpen[t.itemId]);
}
function toggleTool(t: RuntimeItem): void {
  if (!t.detail) return;
  toolOpen[t.itemId] = !toolOpen[t.itemId];
  cue("toggle");
}

// ── markdown (settled text segments) ──────────────────────────────────────────
// While a text segment streams we show its growing string as plain text; once it
// settles we hand the whole segment to <MarkdownMessage>, which renders it as a
// rich component tree (highlighted code, favicon links, file chips, tables…).

// ── timing / status ────────────────────────────────────────────────────────────
function fmt(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}
function elapsed(block: AssistantBlock): string {
  const end = block.endedAt ?? props.now;
  return fmt(Math.max(0, Math.round((end - block.at) / 1000)));
}
function statusOf(block: AssistantBlock): { text: string; tone: "live" | "muted" | "error" } {
  if (block.state === "running") return { text: `working · ${elapsed(block)}`, tone: "live" };
  if (block.state === "failed") return { text: "couldn't finish", tone: "error" };
  if (block.state === "interrupted") return { text: "stopped", tone: "muted" };
  return { text: `replied in ${elapsed(block)}`, tone: "muted" };
}
function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function assistantText(block: AssistantBlock): string {
  return block.items
    .filter((i) => i.kind === "assistant_text" || i.kind === "plan_text")
    .map((i) => i.text)
    .join("\n\n")
    .trim();
}

// The turn meta flashes in the moment a turn settles, then fades — back on hover.
const flash = reactive<Record<string, boolean>>({});
const flashed = new Set<string>();
watch(
  () => props.blocks.map((b) => (b.role === "assistant" ? `${b.id}:${b.state}` : b.id)).join(","),
  () => {
    for (const b of props.blocks) {
      if (b.role !== "assistant" || b.state === "running" || flashed.has(b.id)) continue;
      flashed.add(b.id);
      flash[b.id] = true;
      if (import.meta.client) window.setTimeout(() => (flash[b.id] = false), 3000);
    }
  },
  { immediate: true },
);

// ── copy ──────────────────────────────────────────────────────────────────────
const copied = ref<string | null>(null);
const USER_REQUEST_LIMIT = 900;
const expandedUserRequests = reactive<Record<string, boolean>>({});
function isLongUserRequest(block: Extract<ThreadBlock, { role: "user" }>): boolean {
  return block.text.length > USER_REQUEST_LIMIT;
}
function userRequestText(block: Extract<ThreadBlock, { role: "user" }>): string {
  if (!isLongUserRequest(block) || expandedUserRequests[block.id]) return block.text;
  return `${block.text.slice(0, USER_REQUEST_LIMIT).trimEnd()}…`;
}
function toggleUserRequest(block: Extract<ThreadBlock, { role: "user" }>): void {
  expandedUserRequests[block.id] = !expandedUserRequests[block.id];
  cue("toggle");
}
async function copyUserRequest(block: Extract<ThreadBlock, { role: "user" }>) {
  if (!block.text || !import.meta.client) return;
  try {
    await navigator.clipboard.writeText(block.text);
    cue("toggle");
    copied.value = block.id;
    window.setTimeout(() => {
      if (copied.value === block.id) copied.value = null;
    }, 1600);
  } catch {
    // Clipboard blocked — nothing to do.
  }
}
function addUserRequestToScratchpad(block: Extract<ThreadBlock, { role: "user" }>) {
  if (!block.text?.trim()) return;
  emit("to-scratchpad", block.text);
  cue("press");
}
async function copy(block: AssistantBlock) {
  const text = assistantText(block);
  if (!text || !import.meta.client) return;
  try {
    await navigator.clipboard.writeText(text);
    cue("toggle");
    copied.value = block.id;
    window.setTimeout(() => {
      if (copied.value === block.id) copied.value = null;
    }, 1600);
  } catch {
    // Clipboard blocked — nothing to do.
  }
}

function addToScratchpad(block: AssistantBlock) {
  const text = assistantText(block);
  if (!text.trim()) return;
  emit("to-scratchpad", text);
  cue("press");
}

// ── auto-scroll ────────────────────────────────────────────────────────────────
const root = ref<HTMLElement | null>(null);
function tailSignature(): string {
  const last = props.blocks[props.blocks.length - 1];
  if (!last) return "";
  if (last.role === "user") return `${props.blocks.length}:u:${last.text.length}`;
  const chars = last.items.reduce((n, i) => n + i.text.length, 0);
  return `${props.blocks.length}:a:${last.items.length}:${chars}:${last.state}`;
}
watch(tailSignature, () => {
  void nextTick(() => {
    const sc = scroller();
    if (!sc) return;
    const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 260;
    if (nearBottom) sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" });
  });
});
function scroller(): HTMLElement | null {
  let el = root.value?.parentElement ?? null;
  while (el) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}
const hasBlocks = computed(() => props.blocks.length > 0);
</script>

<template>
  <div ref="root" class="thread" :class="{ 'thread--empty': !hasBlocks }">
    <p v-if="sessionError" class="body body--error thread__error">{{ sessionError }}</p>

    <!-- Background generative art in the empty state -->
    <CodeGolfArt v-if="!hasBlocks" class="thread__art" />

    <div v-if="!hasBlocks" class="empty relative z-10 sr-only">
      <p>Nothing here yet — say something to begin.</p>
    </div>

    <motion.div
      v-for="block in blocks"
      :key="block.id"
      class="turn"
      :class="[
        block.role === 'user' ? 'turn--you' : 'turn--kone',
        block.role === 'assistant' && block.state !== 'running' ? 'turn--settled' : '',
        block.role === 'assistant' && flash[block.id] ? 'turn--flash' : '',
      ]"
      :initial="block.historical ? false : { opacity: 0, y: 14, x: block.role === 'user' ? 18 : -6 }"
      :animate="{ opacity: 1, y: 0, x: 0 }"
      :transition="{ type: 'spring', stiffness: 320, damping: 30, mass: 0.8 }"
    >
      <!-- ── User turn — right-aligned ─────────────────────────────────── -->
      <template v-if="block.role === 'user'">
         <div v-if="block.text" class="body body--you selectable" :class="{ 'body--you-expanded': expandedUserRequests[block.id] }">
           <p class="you-text">{{ userRequestText(block) }}</p>
           <button
             v-if="isLongUserRequest(block)"
             type="button"
             class="you-expand"
             :aria-expanded="expandedUserRequests[block.id] ? 'true' : 'false'"
             :aria-label="expandedUserRequests[block.id] ? 'Collapse request' : 'Show full request'"
             @click="toggleUserRequest(block)"
           >
             <HugeiconsIcon
               :icon="expandedUserRequests[block.id] ? ArrowUp01Icon : ArrowDown01Icon"
               :size="14"
               :stroke-width="2"
             />
           </button>
         </div>
        <!-- What was attached to this turn — the same file chips the agent uses
             in prose. Metadata only (bytes live on disk), so images show their
             file-type glyph rather than a thumbnail. -->
        <div v-if="block.attachments?.length" class="you-attachments selectable">
          <FileChip
            v-for="att in block.attachments"
            :key="att.id"
            :path="att.name"
            :title="`${att.name} · ${att.mimeType}`"
          />
        </div>
        <div v-if="block.text" class="you-foot">
          <button
            type="button"
            class="foot__copy"
            :aria-label="copied === block.id ? 'Copied' : 'Copy request'"
            @click="copyUserRequest(block)"
          >
            <HugeiconsIcon :icon="copied === block.id ? Tick02Icon : Copy01Icon" :size="13" :stroke-width="2" />
            <span>{{ copied === block.id ? "Copied" : "Copy" }}</span>
          </button>
          <button
            type="button"
            class="foot__copy"
            aria-label="Add request to scratchpad"
            @click="addUserRequestToScratchpad(block)"
          >
            <HugeiconsIcon :icon="Note01Icon" :size="13" :stroke-width="2" />
            <span>Scratchpad</span>
          </button>
        </div>
      </template>

      <!-- ── Assistant (kone) turn — parts, in the order they arrived ────── -->
      <template v-else>
        <div class="stack selectable">
          <template v-for="grp in renderGroups(block)" :key="grp.kind === 'text' ? grp.seg.key : grp.key">
            <!-- Steps — thinking and tool calls share one flat list, a single
                 line threading through every icon in arrival order. Thinking
                 rows are a disclosure when the model surfaced reasoning text
                 (icon → label → chevron → collapsible body); with nothing to
                 reveal, or for a tool with no detail, the row is just inert. -->
            <div v-if="grp.kind === 'steps'" class="step-list" aria-label="Steps">
              <template v-for="(seg, si) in grp.segments" :key="seg.key">
                <motion.div
                  v-if="seg.kind === 'thinking'"
                  class="step-entry"
                  :style="{ transformOrigin: '0% 50%' }"
                  :initial="block.historical ? false : { opacity: 0, y: 10, scale: 0.96 }"
                  :animate="{ opacity: 1, y: 0, scale: 1 }"
                  :transition="{ ...STEP_SPRING, delay: stepDelay(stepOffset(grp.segments, si)) }"
                  @vue:mounted="layoutStepEntry"
                  @vue:unmounted="unlayoutStepEntry"
                >
                  <span
                    v-if="stepOffset(grp.segments, si) > 0"
                    class="step-entry__link"
                    aria-hidden="true"
                  />
                  <component
                    :is="thinkHasContent(seg) ? 'button' : 'div'"
                    :type="thinkHasContent(seg) ? 'button' : undefined"
                    class="step"
                    :class="{ 'step--clickable': thinkHasContent(seg) }"
                    :style="{ '--hue': THINKING_ORB_HUE }"
                    @click="thinkHasContent(seg) && toggleThinking(seg)"
                  >
                    <span class="step__icon">
                      <TurnOrb v-if="segStreaming(seg)" state="thinking" :size="14" aria-label="Thinking" />
                      <HugeiconsIcon v-else :icon="AiBrain01Icon" :size="14" :stroke-width="1.8" />
                    </span>
                    <span class="step__label">
                      {{ segStreaming(seg) ? "Thinking…" : `Thought for ${thinkingDuration(seg) ?? 1}s` }}
                    </span>
                    <HugeiconsIcon
                      v-if="thinkHasContent(seg)"
                      :icon="ArrowRight01Icon"
                      :size="14"
                      :stroke-width="2"
                      class="step__chev"
                      :class="{ 'step__chev--open': thinkingExpanded(seg) }"
                    />
                  </component>
                  <div
                    v-if="thinkHasContent(seg)"
                    class="step__body"
                    :class="{ 'step__body--open': thinkingExpanded(seg) }"
                  >
                    <div class="step__body-inner">
                      <p class="think__text">{{ segText(seg) }}</p>
                    </div>
                  </div>
                </motion.div>

                <template v-if="seg.kind === 'tools'">
                  <motion.div
                    v-for="(t, i) in toolCalls(seg)"
                    :key="t.itemId"
                    class="step-entry"
                    :style="{ transformOrigin: '0% 50%' }"
                    :initial="block.historical ? false : { opacity: 0, y: 10, scale: 0.96 }"
                    :animate="{ opacity: 1, y: 0, scale: 1 }"
                    :transition="{ ...STEP_SPRING, delay: stepDelay(stepOffset(grp.segments, si) + i) }"
                    @vue:mounted="layoutStepEntry"
                    @vue:unmounted="unlayoutStepEntry"
                  >
                    <span
                      v-if="stepOffset(grp.segments, si) + i > 0"
                      class="step-entry__link"
                      aria-hidden="true"
                    />
                    <div
                      class="step"
                      :class="[`step--${toolStatus(t)}`, { 'step--clickable': !!t.detail }]"
                      :style="{ '--hue': toolMeta(t.name).hue }"
                      :role="t.detail ? 'button' : undefined"
                      :tabindex="t.detail ? 0 : undefined"
                      :title="toolDetailFull(t) || undefined"
                      @click="toggleTool(t)"
                      @keydown.enter="toggleTool(t)"
                    >
                      <span class="step__icon">
                        <TurnOrb
                          v-if="toolStatus(t) === 'running'"
                          :state="stateForToolFamily(toolMeta(t.name).family)"
                          :size="14"
                          :aria-label="`${toolMeta(t.name).label} running`"
                        />
                        <HugeiconsIcon
                          v-else
                          :icon="toolMeta(t.name).icon"
                          :size="14"
                          :stroke-width="1.8"
                        />
                      </span>
                      <span class="step__label">
                        <template v-for="(part, pi) in toolPhraseParts(t)" :key="pi">
                          <FileChip
                            v-if="part.kind === 'file'"
                            class="step__chip"
                            :path="part.path"
                            :title="toolDetailFull(t) || part.path"
                          />
                          <FileChip
                            v-else-if="part.kind === 'folder'"
                            class="step__chip"
                            folder
                            :path="part.path"
                            :title="toolDetailFull(t) || part.path"
                          />
                          <SiteChip
                            v-else-if="part.kind === 'site'"
                            class="step__chip"
                            :url="part.url"
                            :title="toolDetailFull(t) || part.url"
                          />
                          <span v-else-if="part.kind === 'mono'" class="step__target">{{ part.text }}</span>
                          <template v-else>{{ part.text }}</template>
                        </template>
                      </span>
                      <span v-if="toolStatus(t) === 'error'" class="step__err">failed</span>
                      <HugeiconsIcon
                        v-if="t.detail"
                        :icon="ArrowRight01Icon"
                        :size="14"
                        :stroke-width="2"
                        class="step__chev"
                        :class="{ 'step__chev--open': toolExpanded(t) }"
                      />
                    </div>
                    <div class="step__body" :class="{ 'step__body--open': t.detail && toolExpanded(t) }">
                      <div class="step__body-inner">
                        <pre v-if="t.detail" class="output">{{ t.detail }}</pre>
                      </div>
                    </div>
                  </motion.div>
                </template>
              </template>
            </div>

            <!-- Text — rendered as rich Markdown the whole way through, streaming
                 or settled, so the reply reads as a proper preview as it grows
                 (never a raw block that only formats once complete). -->
            <div
              v-else
              class="answer-wrap"
              :data-markdown-source="segText(grp.seg)"
            >
              <MarkdownMessage
                class="answer"
                :source="segText(grp.seg)"
                :historical="block.historical"
              />
            </div>
          </template>

          <!-- Working orb — visible while the turn is alive but nothing is
               streaming (request just sent, or a quiet gap between steps). -->
          <AnimatePresence>
            <motion.div
              v-if="isWaiting(block)"
              class="waiting"
              :initial="{ opacity: 0, scale: 0.86 }"
              :animate="{ opacity: 1, scale: 1 }"
              :exit="{ opacity: 0, scale: 0.86 }"
              :transition="{ type: 'spring', stiffness: 300, damping: 26, mass: 0.7 }"
            >
              <TurnOrb state="working" :size="20" aria-label="Working" />
            </motion.div>
          </AnimatePresence>

          <!-- Failure note. -->
          <p v-if="block.state === 'failed' && block.error" class="body body--error">
            {{ block.error }}
          </p>

          <!-- Turn footer — an editorial dotted-leader meta line, quiet until the
               turn settles / you hover it. Hidden entirely while running (the live
               header carries the status then). -->
          <div v-if="block.state !== 'running'" class="foot">
            <span class="foot__time">{{ clock(block.at) }}</span>
            <span class="foot__status" :class="`foot__status--${statusOf(block).tone}`">{{
              statusOf(block).text
            }}</span>
            <button
              v-if="block.state === 'completed' && assistantText(block)"
              type="button"
              class="foot__copy"
              :aria-label="copied === block.id ? 'Copied' : 'Copy reply'"
              @click="copy(block)"
            >
              <HugeiconsIcon :icon="copied === block.id ? Tick02Icon : Copy01Icon" :size="13" :stroke-width="2" />
              <span>{{ copied === block.id ? "Copied" : "Copy" }}</span>
            </button>
            <button
              v-if="block.state === 'completed' && assistantText(block)"
              type="button"
              class="foot__copy"
              aria-label="Add to scratchpad"
              @click="addToScratchpad(block)"
            >
              <HugeiconsIcon :icon="Note01Icon" :size="13" :stroke-width="2" />
              <span>Scratchpad</span>
            </button>
          </div>
        </div>
      </template>
    </motion.div>
  </div>
</template>

<style scoped>
.thread {
  --rail: color-mix(in srgb, var(--ink) 12%, transparent);

  display: flex;
  flex-direction: column;
  gap: 34px;
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
}
.thread--empty {
  position: relative;
  flex: 1;
  width: 100%;
  min-height: 100%;
  align-items: center;
  justify-content: center;
}
.thread__art {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 0;
  width: 100%;
  height: min(72vh, 580px);
  pointer-events: none;
  opacity: 0.4;
  transform: translate(-50%, -50%);
}

/* ── Empty state ───────────────────────────────────────────────────────────── */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}
.empty__bead {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
  opacity: 0.6;
  animation: bead-breathe 3.2s ease-in-out infinite;
}
.empty__line {
  margin: 0;
  font-size: 15px;
  line-height: 1.5;
  color: var(--muted);
  text-wrap: pretty;
}

.turn {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.turn--you {
  align-items: flex-end;
}

/* ── The turn's body stack ─────────────────────────────────────────────────── */
.stack {
  display: flex;
  flex-direction: column;
  gap: 15px;
  align-items: flex-start;
  width: 100%;
}

/* ── Message body ──────────────────────────────────────────────────────────── */
.body {
  margin: 0;
  font-size: 16px;
  line-height: 1.68;
  color: var(--ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* You — a warm, accent-tinted surface (not a flat grey chip); soft, no shadow. */
.body--you {
  text-align: left;
  max-width: 80%;
  padding: 12px 17px;
  border-radius: 18px 18px 6px 18px;
  background: linear-gradient(
    135deg,
    color-mix(in oklab, var(--accent) 12%, var(--ground)) 0%,
    color-mix(in oklab, var(--accent) 6%, var(--ground)) 100%
  );
  text-wrap: pretty;
}
.you-text {
  margin: 0;
  white-space: pre-wrap;
}
.you-expand {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 20px;
  margin: 5px -4px -5px auto;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.you-expand:hover,
.you-expand:focus-visible {
  background: var(--hover);
  color: var(--ink);
}
.you-expand:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 30%, transparent);
  outline-offset: 1px;
}
/* Attachments that rode this turn — a right-aligned wrap of file chips under
   the message (or standing alone on an attachment-only turn). */
.you-attachments {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  max-width: 80%;
}
.you-foot {
  display: flex;
  justify-content: flex-end;
  width: 100%;
  max-width: 80%;
  opacity: 0;
  transform: translateY(-2px);
  transition: opacity 0.45s ease, transform 0.3s ease;
}
.turn--you:hover .you-foot,
.turn--you:focus-within .you-foot {
  opacity: 1;
  transform: none;
}
@media (hover: none) {
  .you-foot {
    opacity: 1;
    transform: none;
  }
}
.body--error {
  color: var(--diff-del);
  font-size: 14px;
  line-height: 1.55;
}
.thread__error {
  align-self: stretch;
}

/* The settled rich answer — capped to a comfortable measure (~66ch) so long
   replies stay readable; its internals live in MarkdownMessage. */
.answer {
  width: 100%;
  max-width: 42rem;
}

/* ── Steps — a flat list shared by thinking and tool-call rows: icon, label,
   trailing chevron. Rows with a body (reasoning text / tool output) slide it
   open on click; rows with nothing to show are inert, no fake affordance. ── */
.step-list {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
}
/* Per-step connector — lives inside the same animated row as its icon so the
   line never races ahead of the glyph. Height is synced from the previous row
   via ResizeObserver (--step-link-h); 24px covers a collapsed neighbour. */
.step-entry {
  position: relative;
}
.step-entry__link {
  position: absolute;
  left: 7px;
  top: 12px;
  width: 1.5px;
  height: var(--step-link-h, 24px);
  transform: translateY(-100%);
  transform-origin: bottom center;
  background: var(--rail);
  z-index: 0;
}
.step {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--ink-soft);
  font-size: 13px;
  letter-spacing: -0.005em;
  text-align: left;
  cursor: default;
}
.step--clickable {
  cursor: pointer;
}
.step--clickable:hover {
  color: var(--ink);
}
/* Opaque so the rail reads as touching its tip, not showing through the glyph —
   a beat of line between icons, not a line drawn across them. */
.step__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  background: var(--ground);
  color: var(--hue, var(--muted));
}
.step__label {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.step__chip {
  flex: 0 1 auto;
  min-width: 0;
  max-width: min(100%, 16rem);
}
.step__target {
  font-family: var(--font-mono);
  color: var(--muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.step--error .step__label {
  color: var(--diff-del);
}
.step__err {
  flex: none;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--diff-del);
}
.step__chev {
  flex: none;
  opacity: 0.45;
  transition: transform 0.22s ease;
}
.step__chev--open {
  transform: rotate(90deg);
}
/* Height-animated disclosure (grid 0fr → 1fr) so the body slides open/closed
   instead of snapping. */
.step__body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}
.step__body--open {
  grid-template-rows: 1fr;
}
.step__body-inner {
  overflow: hidden;
  min-height: 0;
  padding-left: 24px;
}
.think__text {
  margin: 0 0 6px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  text-wrap: pretty;
}

/* ── Waiting orb ───────────────────────────────────────────────────────────── */
.waiting {
  display: flex;
  align-items: center;
  margin: -2px 0;
  will-change: transform, opacity;
}

.output {
  margin: 0 0 6px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--hover);
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-soft);
  white-space: pre-wrap;
  overflow-x: auto;
  max-width: 100%;
}

/* ── Turn footer (meta) — editorial dotted leader ──────────────────────────── */
.foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
  width: 100%;
  max-width: 42rem;
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  opacity: 0;
  transform: translateY(-2px);
  transition: opacity 0.45s ease, transform 0.3s ease;
}
.turn--flash .foot,
.turn--kone.turn--settled:hover .foot,
.foot:focus-within {
  opacity: 1;
  transform: none;
}
/* The dotted rule that carried the eye from the timestamp to the status is
   gone — the meta row now reads as a row of quiet items, no leader line. */
.foot__status--live {
  color: var(--ink-soft);
}
.foot__status--error {
  color: var(--diff-del);
}
.foot__copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.foot__copy:hover {
  background: var(--hover);
  color: var(--ink);
}

/* ── Keyframes ─────────────────────────────────────────────────────────────── */
@keyframes bead-breathe {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.14);
  }
}
@media (prefers-reduced-motion: reduce) {
  .empty__bead {
    animation: none;
  }
  .step__chev {
    transition: none;
  }
  .step__body {
    transition: none;
  }
}
</style>

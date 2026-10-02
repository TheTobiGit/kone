// FILE: skillInvocation.ts
// Purpose: invoking a skill inside a conversation. Three steps, one module:
//   1. discovery — which skills a provider can run for a turn in a cwd
//      (listInvokableSkills), honoring the provider's own per-skill switch and
//      kone's internal gate;
//   2. validation — resolving the `{ name, path }` references a turn carries
//      against that list before the prompt is journaled
//      (resolveSkillReferences), so a removed or disabled skill fails the send
//      with a sentence instead of silently doing nothing;
//   3. delivery — turning the resolved references into what the provider's
//      CLI actually runs (buildSkillPrompt): a `/name` slash command for
//      Claude Code, a structured `skill` input item plus `$name` mention for
//      Codex, and the SKILL.md inlined into the prompt for any skill the CLI
//      cannot load by itself.
// Exports: listInvokableSkills, listInvokableSkillsChecked,
// resolveSkillReferences, buildSkillPrompt, inlineSkills,
// isNativeSkillFor, SkillUnavailableError, MAX_INLINE_SKILL_CHARS

import { readFile as fsReadFile, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { discoverSkills } from "./inventory/skills.js";
import { readSkillState, type SkillStateContext, type SkillStateFs, type SkillStateResult } from "./inventory/skillState.js";
import type { InvokableSkill, SkillEntry } from "./inventory/types.js";
import { isSkillInternallyEnabled, readInternalSkillsSettings, type InternalSkillsSettings } from "./skillsSettings.js";
import type { ProviderKind, SkillReference } from "./types.js";
import { ProviderKindSchema, SkillReferenceListSchema } from "./types.js";

/** One inlined SKILL.md is cut here. Real skills run a few KB; the cap only
 *  stops a pathological file from eating the provider's turn budget. */
export const MAX_INLINE_SKILL_CHARS = 48_000;

/** A send that names a skill the provider cannot run. The message is the
 *  whole user-facing sentence. */
export class SkillUnavailableError extends Error {
  constructor(name: string, reason: string) {
    super(`Skill "${name}" is not available: ${reason}`);
    this.name = "SkillUnavailableError";
  }
}

// ── native roots ────────────────────────────────────────────────────────────

/** The config-directory names whose `skills/` folder each CLI loads on its
 *  own. A skill found anywhere else has to be inlined for that CLI. Claude
 *  Code answers a slash command for a skill outside `.claude/skills` with
 *  "Unknown command"; Codex silently ignores a `skill` item whose path is
 *  outside its roots. Every other provider kone drives has no skill input it
 *  can be handed, so nothing is native there. */
function nativeSkillDirs(provider: ProviderKind): readonly string[] {
  switch (provider) {
    case "claudeAgent":
      return [".claude"];
    case "codex":
      return [".codex", ".agents"];
    default:
      return [];
  }
}

/** Whether `provider`'s CLI loads the skill at `skillPath` by itself — true
 *  when the path runs through `<native dir>/skills/`. */
export function isNativeSkillFor(provider: ProviderKind, skillPath: string): boolean {
  const dirs = nativeSkillDirs(provider);
  if (dirs.length === 0) return false;
  const segments = path.resolve(skillPath).split(path.sep);
  return segments.some((segment, index) => dirs.includes(segment) && segments[index + 1] === "skills");
}

/** The origin whose config file holds `provider`'s own per-skill switch, when
 *  it has one kone can read. */
function providerStateOrigin(provider: ProviderKind): string | null {
  switch (provider) {
    case "claudeAgent":
      return "claude";
    case "codex":
      return "codex";
    case "opencode":
      return "opencode";
    default:
      return null;
  }
}

// ── discovery ───────────────────────────────────────────────────────────────

/** Seams for tests: the default reaches the real skill roots, the CLIs' real
 *  config files and kone's real internal settings. */
export type InvokableSkillDeps = {
  discover?: (cwd: string | null) => Promise<{ skills: SkillEntry[]; shadowed: SkillEntry[] }>;
  readState?: (context: SkillStateContext) => Promise<SkillStateResult>;
  internalSettings?: () => InternalSkillsSettings;
};

/** A readFile that reads each config file once per listing — every skill's
 *  state check reads the same two or three settings files. */
function memoizedStateFs(): SkillStateFs {
  const reads = new Map<string, Promise<string | null>>();
  return {
    readFile(filePath) {
      let read = reads.get(filePath);
      if (!read) {
        read = fsReadFile(filePath, "utf8").catch(() => null);
        reads.set(filePath, read);
      }
      return read;
    },
    writeFile() {
      return Promise.reject(new Error("Listing invokable skills never writes a config file."));
    },
  };
}

async function isDisabled(
  copy: SkillEntry,
  provider: ProviderKind,
  cwd: string | null,
  readState: (context: SkillStateContext) => Promise<SkillStateResult>,
  fs: SkillStateFs,
): Promise<boolean> {
  // The copy's own CLI may have switched it off, and so may the CLI that is
  // about to run it — a skill the user disabled in either place stays off.
  const origins = new Set([copy.origin]);
  const providerOrigin = providerStateOrigin(provider);
  if (providerOrigin) origins.add(providerOrigin);
  const states = await Promise.all(
    [...origins].map((origin) =>
      readState({
        origin,
        skillName: copy.name,
        skillPath: copy.path,
        scope: copy.scope,
        projectPath: cwd,
        fs,
      }),
    ),
  );
  return states.some((result) => result.state === "disabled");
}

/** The skills `provider` can run for a turn in `cwd`: one row per name,
 *  enabled in the provider's own config and in kone's internal gate, sorted by
 *  name. When the same name lives in several roots, the copy the provider
 *  loads natively wins, then the user-scope copy over the project's — so a
 *  pick is delivered natively whenever it can be. Each row carries only what
 *  the picker shows — never inventory state like enabled/shadowed, which is
 *  already settled by reaching this list. Never rejects: a root that
 *  cannot be read just contributes nothing. */
export async function listInvokableSkills(
  provider: ProviderKind,
  cwd: string | null,
  deps: InvokableSkillDeps = {},
): Promise<InvokableSkill[]> {
  const discover = deps.discover ?? discoverSkills;
  const readState = deps.readState ?? readSkillState;
  let found: { skills: SkillEntry[]; shadowed: SkillEntry[] };
  try {
    found = await discover(cwd);
  } catch {
    return [];
  }
  const settings = (deps.internalSettings ?? readInternalSkillsSettings)();
  const fs = memoizedStateFs();

  const copies = [...found.skills, ...found.shadowed].filter((copy) => isSkillInternallyEnabled(copy, settings));
  const enabled = await Promise.all(
    copies.map(async (copy) => ((await isDisabled(copy, provider, cwd, readState, fs).catch(() => false)) ? null : copy)),
  );

  const rank = (copy: SkillEntry): number =>
    (isNativeSkillFor(provider, copy.path) ? 0 : 2) + (copy.scope === "user" ? 0 : 1);
  const byName = new Map<string, SkillEntry>();
  for (const copy of enabled) {
    if (!copy) continue;
    const key = copy.name.toLowerCase();
    const held = byName.get(key);
    if (!held || rank(copy) < rank(held)) byName.set(key, copy);
  }

  return [...byName.values()]
    .map(
      (copy): InvokableSkill => ({
        name: copy.name,
        path: copy.path,
        description: copy.description,
        shortDescription: copy.shortDescription,
        scope: copy.scope,
        origin: copy.origin,
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

const ListInvokableArgsSchema = z.tuple([ProviderKindSchema, z.string().nullable()]);

/** listInvokableSkills for arguments that crossed a process boundary, where
 *  the declared types are only the sender's promise: anything but a known
 *  provider and an absolute cwd (or null) lists nothing rather than scanning
 *  somewhere the caller didn't mean. */
export async function listInvokableSkillsChecked(provider: string, cwd: string | null): Promise<InvokableSkill[]> {
  const parsed = ListInvokableArgsSchema.safeParse([provider, cwd ?? null]);
  if (!parsed.success) return [];
  const [kind, dir] = parsed.data;
  if (dir !== null && !path.isAbsolute(dir)) return [];
  return listInvokableSkills(kind, dir);
}

// ── validation ──────────────────────────────────────────────────────────────

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/** Resolve the skill references a turn carries against what `provider` can
 *  run in `cwd`. Matches the exact SKILL.md path first, then the name
 *  (case-insensitively), and returns the listed copy's own name and path, one
 *  per skill. Throws SkillUnavailableError for a malformed reference or one
 *  that names nothing runnable. Resolves to [] when the turn carries none. */
export async function resolveSkillReferences(
  provider: ProviderKind,
  cwd: string | null,
  references: readonly SkillReference[] | undefined,
  deps: InvokableSkillDeps = {},
): Promise<SkillReference[]> {
  if (!references?.length) return [];
  const parsed = SkillReferenceListSchema.safeParse(references);
  if (!parsed.success) throw new SkillUnavailableError("unknown", "the reference is not a { name, path } pair.");

  for (const ref of parsed.data) {
    const label = ref.name.trim() || ref.path;
    if (!ref.name.trim()) throw new SkillUnavailableError(label, "the reference has no name.");
    if (!path.isAbsolute(ref.path) || path.basename(ref.path) !== "SKILL.md") {
      throw new SkillUnavailableError(label, "its path must be the absolute path of a SKILL.md file.");
    }
  }

  const invokable = await listInvokableSkills(provider, cwd, deps);
  const byPath = new Map(invokable.map((skill) => [path.resolve(skill.path), skill]));
  const byName = new Map(invokable.map((skill) => [skill.name.toLowerCase(), skill]));

  const resolved: SkillReference[] = [];
  const seen = new Set<string>();
  for (const ref of parsed.data) {
    const name = ref.name.trim();
    const match = byPath.get(path.resolve(ref.path)) ?? byName.get(name.toLowerCase());
    if (!match) {
      const reason = (await fileExists(ref.path))
        ? "it is disabled for this provider, or this provider cannot load it in this project."
        : `its SKILL.md no longer exists at ${ref.path}.`;
      throw new SkillUnavailableError(name, reason);
    }
    const key = match.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ name: match.name, path: match.path });
  }
  return resolved;
}

// ── delivery ────────────────────────────────────────────────────────────────

/** A Codex app-server `skill` user-input item. */
export type CodexSkillItem = { type: "skill"; name: string; path: string };

/** What a turn's skills add to the prompt. `text` is the prose with any
 *  native invocation leading it; `inlineBlock` is the SKILL.md text of every
 *  skill the CLI can't load itself ("" when there are none), which the adapter
 *  appends after its attached-files block; `codexItems` are the structured
 *  items Codex receives beside the text. */
export type SkillPrompt = {
  text: string;
  inlineBlock: string;
  codexItems: CodexSkillItem[];
};

/** A name that reads unambiguously as a single command token. Anything else
 *  is inlined rather than risk the CLI parsing half of it. */
const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function leadWith(lead: string, text: string): string {
  if (!lead) return text;
  return text ? `${lead} ${text}` : lead;
}

/** One `<skill>` block per skill, each SKILL.md read off disk and capped. A
 *  file that can't be read by now fails the turn: the user asked for that
 *  skill, and sending the prompt without it would answer a different
 *  question. */
async function inlineSkillBlock(
  skills: readonly SkillReference[],
  readFile: (filePath: string) => Promise<string>,
): Promise<string> {
  if (skills.length === 0) return "";
  const blocks = await Promise.all(
    skills.map(async (skill) => {
      let content: string;
      try {
        content = (await readFile(skill.path)).trim();
      } catch {
        throw new SkillUnavailableError(skill.name, `its SKILL.md at ${skill.path} could not be read.`);
      }
      if (content.length > MAX_INLINE_SKILL_CHARS) {
        content = `${content.slice(0, MAX_INLINE_SKILL_CHARS)}\n[skill truncated]`;
      }
      return `<skill name=${JSON.stringify(skill.name)} path=${JSON.stringify(skill.path)}>\n${content}\n</skill>`;
    }),
  );
  return [
    "<invoked_skills>",
    "The user invoked the following skill(s) for this turn. Follow each skill's instructions; files a skill refers to are relative to the directory of its SKILL.md.",
    ...blocks,
    "</invoked_skills>",
  ].join("\n\n");
}

/** Shape a turn's prompt so `provider` runs the resolved `skills`:
 *  - Claude Code expands one slash command per message, so the first skill it
 *    loads natively leads the text as `/name`; every other skill is inlined.
 *  - Codex gets a `skill` item per natively loaded skill plus a `$name`
 *    mention leading the text (the app-server expects both); skills from
 *    other CLIs' roots are inlined, since Codex would ignore their paths.
 *  - Every other provider has the SKILL.md inlined. */
export async function buildSkillPrompt(
  provider: ProviderKind,
  text: string,
  skills: readonly SkillReference[] | undefined,
  readFile: (filePath: string) => Promise<string> = (filePath) => fsReadFile(filePath, "utf8"),
): Promise<SkillPrompt> {
  if (!skills?.length) return { text, inlineBlock: "", codexItems: [] };

  const native = skills.filter((skill) => isNativeSkillFor(provider, skill.path) && COMMAND_NAME_PATTERN.test(skill.name));

  if (provider === "claudeAgent") {
    const command = native[0];
    const inline = skills.filter((skill) => skill !== command);
    return {
      text: command ? leadWith(`/${command.name}`, text) : text,
      inlineBlock: await inlineSkillBlock(inline, readFile),
      codexItems: [],
    };
  }

  if (provider === "codex") {
    const inline = skills.filter((skill) => !native.includes(skill));
    return {
      text: leadWith(native.map((skill) => `$${skill.name}`).join(" "), text),
      inlineBlock: await inlineSkillBlock(inline, readFile),
      codexItems: native.map((skill) => ({ type: "skill", name: skill.name, path: skill.path })),
    };
  }

  return { text, inlineBlock: await inlineSkillBlock(skills, readFile), codexItems: [] };
}

/** For a provider with no native skill input: the composed prompt with every
 *  invoked skill inlined after it. Every skill is inlined here because the
 *  callers have no skill input to hand the CLI; native-vs-inline routing
 *  lives in buildSkillPrompt for the two providers that do. */
export async function inlineSkills(
  promptText: string,
  skills: readonly SkillReference[] | undefined,
  readFile: (filePath: string) => Promise<string> = (filePath) => fsReadFile(filePath, "utf8"),
): Promise<string> {
  if (!skills?.length) return promptText;
  const inlineBlock = await inlineSkillBlock(skills, readFile);
  if (!inlineBlock) return promptText;
  return promptText ? `${promptText}\n\n${inlineBlock}` : inlineBlock;
}

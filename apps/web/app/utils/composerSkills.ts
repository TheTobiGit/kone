import { PuzzleIcon } from "@hugeicons/core-free-icons";
import type { InvokableSkill, SkillReference } from "~/types/desktop";
import {
  splitComposerMentionSegments,
  type ComposerMentionSegment,
  type SlashCommandItem,
} from "./composerMentions";

/** The identity two picks of the same skill share. Names match without
 *  case, the way the backend resolves them, so one skill never appears twice
 *  because its frontmatter and the user disagree on capitals. */
export function skillKey(skill: Pick<SkillReference, "name">): string {
  return skill.name.trim().toLowerCase();
}

/** The `/` picker's skill rows, after the commands. A skill whose name a
 *  command already owns is left out: `/model` must always open the model
 *  picker, and a chip nobody can type back would only confuse the draft. */
export function buildSkillSlashItems(
  commands: readonly SlashCommandItem[],
  skills: readonly InvokableSkill[],
): SlashCommandItem[] {
  const taken = new Set(commands.map((c) => skillKey(c)));
  const rows: SlashCommandItem[] = [];
  for (const entry of skills) {
    const name = entry.name.trim();
    const key = skillKey(entry);
    if (!name || taken.has(key)) continue;
    taken.add(key);
    rows.push({
      name,
      description: entry.shortDescription ?? entry.description ?? "",
      icon: PuzzleIcon,
      skill: { name, path: entry.path },
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return rows;
}

export type PickedSkills = { resolved: SkillReference[]; missing: SkillReference[] };

/** Picked skills checked against what the conversation can invoke right now.
 *  A pick resolves by name, so the same skill installed for another provider
 *  survives a provider switch and goes out with the current provider's path;
 *  one with no match is `missing` and must not be sent as though it were.
 *  Frontend pre-check only — the send path enforces the same
 *  case-insensitive, deduped name match before a turn runs. */
export function resolvePickedSkills(
  picked: readonly SkillReference[],
  available: readonly SkillReference[],
): PickedSkills {
  const byKey = new Map<string, SkillReference>();
  for (const entry of available) {
    const key = skillKey(entry);
    if (!byKey.has(key)) byKey.set(key, { name: entry.name.trim(), path: entry.path });
  }
  const resolved: SkillReference[] = [];
  const missing: SkillReference[] = [];
  const seen = new Set<string>();
  for (const pick of picked) {
    const key = skillKey(pick);
    if (seen.has(key)) continue;
    seen.add(key);
    const match = byKey.get(key);
    if (match) resolved.push(match);
    else missing.push(pick);
  }
  return { resolved, missing };
}

/** The composer field read as an ordered run of prose and skill chips —
 *  @mentions already folded into their `@path` text. */
export type ComposerDraftPart =
  | { type: "text"; text: string }
  | { type: "skill"; skill: SkillReference };

export type ComposedSkillTurn = { input: string; skills: SkillReference[] };

/** A draft split into what a turn sends: the prose and the skills apart.
 *  `skills[]` is the invocation; the text never carries a `/name` token, so
 *  no provider ever has to reparse the prompt to find one. A chip in the
 *  middle of a sentence still reads as part of it — "use animate-text on the
 *  heading" — so it stays as the bare name; chips leading or trailing the
 *  prose are pure invocation and drop out. A chip-only draft sends no text. */
export function composeSkillTurn(parts: readonly ComposerDraftPart[]): ComposedSkillTurn {
  const hasProse = (part: ComposerDraftPart) => part.type === "text" && part.text.trim().length > 0;
  const first = parts.findIndex(hasProse);
  let last = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part && hasProse(part)) {
      last = i;
      break;
    }
  }
  const skills: SkillReference[] = [];
  const seen = new Set<string>();
  let input = "";
  parts.forEach((part, i) => {
    if (part.type === "text") {
      input += part.text;
      return;
    }
    const key = skillKey(part.skill);
    if (!seen.has(key)) {
      seen.add(key);
      skills.push(part.skill);
    }
    if (i > first && i < last) input += part.skill.name;
  });
  return { input: input.trim(), skills };
}

/** A restored draft's pieces: the @mention split, plus skill chips. */
export type ComposerDraftSegment =
  | ComposerMentionSegment
  | { type: "skill"; skill: SkillReference; source: string };

const SKILL_TOKEN_REGEX = /(^|\s)\/([^\s/@"][^\s@"]*)(?=\s|$)/g;

/** Re-chip a persisted draft. Drafts are saved as text plus the skills that
 *  were chips when they were saved, where a skill chip wrote itself as
 *  `/name`; names in that saved list turn back into chips, so a `/path` or an
 *  unknown command stays prose. The saved list is the gate — not the live
 *  one — so a restore rebuilds in one pass and never waits for it. Unlike an
 *  @mention, a skill token may close the draft: it was written by a chip,
 *  never mid-typing, and must name a saved skill to match at all. */
export function splitComposerDraftSegments(
  text: string,
  skills: readonly SkillReference[],
): ComposerDraftSegment[] {
  const segments = splitComposerMentionSegments(text);
  if (skills.length === 0) return segments;
  const byKey = new Map<string, SkillReference>();
  for (const entry of skills) byKey.set(skillKey(entry), { name: entry.name.trim(), path: entry.path });

  const out: ComposerDraftSegment[] = [];
  for (const segment of segments) {
    if (segment.type !== "text") {
      out.push(segment);
      continue;
    }
    let cursor = 0;
    for (const match of segment.text.matchAll(SKILL_TOKEN_REGEX)) {
      const skill = byKey.get(skillKey({ name: match[2] ?? "" }));
      if (!skill) continue;
      const start = (match.index ?? 0) + (match[1] ?? "").length;
      if (start > cursor) out.push({ type: "text", text: segment.text.slice(cursor, start) });
      const source = `/${match[2] ?? ""}`;
      out.push({ type: "skill", skill, source });
      cursor = start + source.length;
    }
    if (cursor < segment.text.length) out.push({ type: "text", text: segment.text.slice(cursor) });
  }
  return out;
}

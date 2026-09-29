import type { SkillEntry } from "~/types/desktop";
import { ORIGIN_ORDER, originLabel } from "~/utils/detailFormat";

// The data behind the Space's Skills column, kept apart from the component so
// it can be tested. The scan hands over every skill an agent on this machine
// could reach from the project — the user's own roots and the project's — and
// this lays them out by the agent that reads them: one group per provider, each
// listing what that provider can use.

export type SkillRow = {
  /** The SKILL.md path: two copies of one name never share it. */
  key: string;
  name: string;
  description: string | null;
  /** Lives in the project itself, rather than in a root shared by every project. */
  project: boolean;
  /** A higher-precedence copy in the same provider's roots wins over this one. */
  shadowed: boolean;
  /** Switched off, in the provider or in kone. */
  off: boolean;
};

export type SkillGroup = {
  origin: string;
  label: string;
  rows: SkillRow[];
};

const byName = (a: SkillRow, b: SkillRow): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/** The project's own skills lead: they are what makes this project's list
 *  different from any other's. */
const projectFirst = (a: SkillRow, b: SkillRow): number => Number(b.project) - Number(a.project) || byName(a, b);

function rowOf(skill: SkillEntry, off: ReadonlySet<string>): SkillRow {
  return {
    key: skill.path,
    name: skill.displayName ?? skill.name,
    description: skill.description ?? skill.shortDescription,
    project: skill.scope === "project",
    // The scan's dedupe runs across providers, so a copy that lost to another
    // provider's is not shadowed for its own: both are reachable, each from its
    // own agent. Only a loss inside the provider's own roots hides the copy.
    shadowed: skill.shadowed === true && skill.shadowedByWinner?.origin === skill.origin,
    off: off.has(skill.path),
  };
}

const ORIGIN_RANK = new Map(ORIGIN_ORDER.map((origin, at) => [origin, at]));
const rank = (origin: string): number => ORIGIN_RANK.get(origin) ?? ORIGIN_ORDER.length;

/**
 * The skills grouped by provider, in ORIGIN_ORDER (an origin it doesn't name
 * follows, alphabetically). Within a group the project's own skills come first,
 * then by name. `off` holds the paths of the skills switched off; the caller owns
 * that because it depends on state the scan doesn't carry.
 */
export function groupSkills(skills: readonly SkillEntry[], off: ReadonlySet<string>): SkillGroup[] {
  const groups = new Map<string, SkillRow[]>();
  for (const skill of skills) {
    const rows = groups.get(skill.origin) ?? [];
    rows.push(rowOf(skill, off));
    groups.set(skill.origin, rows);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([origin, rows]) => ({ origin, label: originLabel(origin), rows: rows.sort(projectFirst) }));
}

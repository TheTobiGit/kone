// FILE: skillSignals.ts
// Purpose: the two fact groups behind a skill's detail page — what the skill
// costs at rest (its description and listing against the caps) and the calm
// security signals. Pure and static: nothing here reads disk and nothing
// talks to a model. The caller walks the filesystem and hands over what it
// found; this module only shapes facts out of that, in table order.
//
// The signal set is deliberately conservative. A signal is a fact readable
// off the files — content that exists, grants that are declared, changes
// that are measurable. Nothing is ever judged as hostile, and the noise
// classes (verdicts, bare mentions of tools or URLs, absence-of-restriction
// as a warning) are not detected at all, so the list stays calm and never
// cries wolf.
// Exports: deriveSignals, SkillSignals, CostFacts, SecuritySignal,
//          SkillSignalsInput, SiblingFile, LIMITATION_NOTE, cap constants.

/** The hard cap on a skill's description field. */
export const DESCRIPTION_CAP_CHARS = 1024;
/** The cap on the combined listing: description + when_to_use. */
export const LISTING_CAP_CHARS = 1536;
// ~1% of a 200k-token context is about 2,000 tokens; at the ~4 characters
// per token the caps above are set on, that is 8,000 characters. It is a
// share figure for the detail page ("this listing eats X% of the budget"),
// not a threshold — nothing fails past it.
export const LISTING_BUDGET_CHARS = 8_000;

/** The honest limit of static analysis, shown once in a footnote — never as
 *  a banner: the pane says what the files are; the human decides what to
 *  trust. */
export const LIMITATION_NOTE =
  "Static analysis can't judge whether a skill's instructions are hostile — " +
  "that requires reading them, and even reading won't catch invisible " +
  "payloads. This pane shows what the files are; you decide what to trust.";

/** One sibling entry of a skill folder, as listed by the caller. */
export type SiblingFile = {
  name: string;
  kind: "file" | "directory";
  /** True when the caller observed a shebang or an executable bit. */
  isExecutable?: boolean;
};

/** Everything deriveSignals needs to know about a skill. Caller-supplied so
 *  the module stays pure; the caller is the one with filesystem access. */
export type SkillSignalsInput = {
  /** Parsed frontmatter — keys kept exactly as written by the parser. */
  frontmatter: Record<string, string>;
  /** SKILL.md markdown body after the frontmatter block. */
  body: string;
  /** The skill folder's other entries, in the caller's listing order. */
  siblingFiles: SiblingFile[];
  /** The skill folder's absolute path — provenance context, never read. */
  directory: string;
  /** Where the skill lives: user | project | managed | plugin. */
  scope: string;
  /** Which agent's root the skill came from (claude, codex, opencode, ...). */
  origin: string;
  /** The when_to_use text, if any. */
  whenToUse: string | null;
  /** Epoch ms of the recorded install baseline; null when no baseline store
   *  exists yet. */
  installedAt?: number | null;
  /** Epoch ms of the skill's newest file mtime, as read by the caller. */
  modifiedAt?: number | null;
  /** The skill folder's git remote, if the caller found one. */
  gitRemote?: string | null;
};

/** How a skill's description measures against the caps. */
export type CostFacts = {
  descriptionChars: number;
  listingChars: number;
  overSpecCap: boolean;
  overListingCap: boolean;
};

/** One informative fact about a skill. `label` is the calm one-liner;
 *  `detail` carries the specifics (which tools, which paths, which keys);
 *  `preview` is used only for hidden-text (decoded) and credentials
 *  (redacted). */
export type SecuritySignal = {
  id: string;
  label: string;
  detail: string | null;
  preview: string | null;
};

export type SkillSignals = {
  cost: CostFacts;
  security: SecuritySignal[];
  limitation: string;
};

// Frontmatter keys are compared case-insensitively: the parser keeps keys
// exactly as written, and skill files are not consistent about casing.
function field(frontmatter: Record<string, string>, name: string): string {
  for (const key of Object.keys(frontmatter)) {
    if (key.toLowerCase() === name) return frontmatter[key] ?? "";
  }
  return "";
}

function fieldAny(frontmatter: Record<string, string>, names: readonly string[]): string {
  for (const name of names) {
    const value = field(frontmatter, name).trim();
    if (value) return value;
  }
  return "";
}

function makeSignal(id: string, label: string, detail: string | null, preview: string | null = null): SecuritySignal {
  return { id, label, detail, preview };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function deriveCost(input: SkillSignalsInput, whenToUse: string | null): CostFacts {
  const descriptionChars = field(input.frontmatter, "description").trim().length;
  const listingChars = descriptionChars + (whenToUse ?? "").length;
  return {
    descriptionChars,
    listingChars,
    overSpecCap: descriptionChars > DESCRIPTION_CAP_CHARS,
    overListingCap: listingChars > LISTING_CAP_CHARS,
  };
}

// ── Signal 1: ships executable content ─────────────────────────────────────
// A data-only skill (references, JSON) reports nothing here; the presence of
// anything the agent could be asked to run is the differentiator. A listed
// `scripts/` or `hooks/` directory counts by its presence — the listing can't
// show emptiness, and an empty one is rare enough to tolerate.
function executableContentSignal(input: SkillSignalsInput): SecuritySignal | null {
  const hits: string[] = [];
  for (const file of input.siblingFiles) {
    if (file.kind === "directory") {
      if (file.name === "scripts" || file.name === "hooks") hits.push(`${file.name}/`);
      continue;
    }
    if (file.isExecutable || /\.(py|sh|mjs|js)$/i.test(file.name) || file.name === "package.json") {
      hits.push(file.name);
    }
  }
  if (hits.length === 0) return null;
  return makeSignal("executable-content", "Ships scripts an agent can run.", hits.join(", "));
}

// ── Signal 2: auto-executed content ────────────────────────────────────────
// The harness runs `!` lines and fenced ```! blocks when the skill loads,
// without the model choosing to — so their mere presence is the fact. `hooks:`
// frontmatter and plugin markers run the same way. Only the skill body and
// when_to_use are scanned for bang lines; sibling markdown contents are not
// part of the input.
function autoExecutedSignal(input: SkillSignalsInput, whenToUse: string | null): SecuritySignal | null {
  const content = `${input.body}\n${whenToUse ?? ""}`;
  const forms: string[] = [];

  const bangLines = content.match(/(?:^|\n)!\s*`/g)?.length ?? 0;
  if (bangLines > 0) forms.push(`${bangLines} \`!\` command line${bangLines === 1 ? "" : "s"}`);
  if (/```!/.test(content)) forms.push("```! block");

  if (field(input.frontmatter, "hooks").trim()) forms.push("`hooks:` frontmatter");
  for (const file of input.siblingFiles) {
    if (file.name === ".mcp.json" || file.name === ".claude-plugin" || file.name === ".claude-plugin/plugin.json") {
      forms.push(file.name);
    }
  }
  if (forms.length === 0) return null;
  return makeSignal("auto-executed", "Runs shell commands automatically when loaded.", forms.join(", "));
}

// ── Signals 3 & 4: tool grants vs. no restrictions ─────────────────────────
// `allowed-tools` is a per-turn grant, not a whitelist — its presence is the
// fact, and the granted tools are listed. A disallowed-tools-only skill
// declares restrictions but no grant, so its phrasing says so. When neither
// key declares anything, the neutral fact is emitted instead — absence is the
// norm, and it is never a warning.
function toolGrantsSignal(frontmatter: Record<string, string>): SecuritySignal | null {
  const allowed = fieldAny(frontmatter, ["allowed-tools", "allowedTools"]);
  const disallowed = fieldAny(frontmatter, ["disallowed-tools", "disallowedTools"]);
  if (!allowed && !disallowed) return null;

  const parts: string[] = [];
  if (allowed) {
    const tools = allowed
      .split(/\s+/)
      .filter(Boolean)
      .map((tool) => `\`${tool}\``)
      .join(", ");
    parts.push(`Pre-approved: ${tools}`);
  }
  if (disallowed) {
    const tools = disallowed
      .split(/\s+/)
      .filter(Boolean)
      .map((tool) => `\`${tool}\``)
      .join(", ");
    parts.push(`Disallowed: ${tools}`);
  }

  const label = allowed ? "Pre-approves for one turn." : "Declares per-turn tool restrictions.";
  return makeSignal("tool-grants", label, parts.join("; "));
}

function noRestrictionsSignal(frontmatter: Record<string, string>): SecuritySignal | null {
  const allowed = fieldAny(frontmatter, ["allowed-tools", "allowedTools"]);
  const disallowed = fieldAny(frontmatter, ["disallowed-tools", "disallowedTools"]);
  if (allowed || disallowed) return null;
  return makeSignal("no-tool-restrictions", "Declares no tool restrictions.", null);
}

// ── Signal 5: can be auto-invoked ──────────────────────────────────────────
// Only an explicit `disable-model-invocation: true` turns this off; anything
// else (including absent) means the agent may load the skill on its own.
function autoInvocationSignal(frontmatter: Record<string, string>): SecuritySignal | null {
  const flag = fieldAny(frontmatter, ["disable-model-invocation", "disableModelInvocation"]).toLowerCase();
  if (flag === "true") return null;
  return makeSignal("auto-invocation", "The agent may load this automatically.", null);
}

// ── Signal 6: fetches or runs remote code ──────────────────────────────────
// High-signal fetch-and-run forms only. A bare mention of `curl` or a plain
// `http(s)://` reference is how half the ecosystem describes its workflow, so
// it is deliberately not counted — the fact is the pipe into a shell, the
// decode, the eval, or the unconfirmed package run.
const REMOTE_EXECUTION_FORMS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "`| sh`", pattern: /\|\s*(?:ba|z)?sh\b/ },
  { name: "`| source`", pattern: /\|\s*source\b/ },
  { name: "`base64 -d`", pattern: /\bbase64\s+-{1,2}(?:d|decode)\b/ },
  { name: "`eval`", pattern: /\beval\b/ },
  { name: "`npx -y`", pattern: /\bnpx\s+-y\b/ },
  { name: "`wget`", pattern: /\bwget\b/ },
];

function remoteCodeSignal(input: SkillSignalsInput, whenToUse: string | null): SecuritySignal | null {
  const text = `${input.body}\n${whenToUse ?? ""}\n${Object.values(input.frontmatter).join("\n")}`;
  const matched = REMOTE_EXECUTION_FORMS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
  if (matched.length === 0) return null;
  return makeSignal("remote-code", "Contains instructions to download or run remote code.", matched.join(", "));
}

// ── Signal 7: obfuscated or hidden text ────────────────────────────────────
// Tag characters decode onto ASCII by subtracting the tag-plane offset, so a
// preview can show exactly what the invisible text says. Zero-width
// characters are counted and their surroundings shown with the characters
// stripped. A long base64 blob is decoded when it is readable text.
const TAG_PLANE_BASE = 0xe0000;

function decodeTags(text: string): string {
  let decoded = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= TAG_PLANE_BASE && cp <= TAG_PLANE_BASE + 0x7f) {
      decoded += String.fromCodePoint(cp - TAG_PLANE_BASE);
    }
  }
  return decoded;
}

const ZERO_WIDTH_CHARS: ReadonlyArray<{ char: string; name: string }> = [
  { char: "\u200b", name: "U+200B" },
  { char: "\u200c", name: "U+200C" },
  { char: "\ufeff", name: "U+FEFF" },
];

function zeroWidthFacts(text: string): { count: number; kinds: string; firstIndex: number } | null {
  let count = 0;
  const kinds: string[] = [];
  let firstIndex = -1;
  for (const { char, name } of ZERO_WIDTH_CHARS) {
    const index = text.indexOf(char);
    if (index === -1) continue;
    kinds.push(name);
    count += text.split(char).length - 1;
    if (firstIndex === -1 || index < firstIndex) firstIndex = index;
  }
  if (count === 0) return null;
  return { count, kinds: kinds.join(", "), firstIndex };
}

function obfuscatedTextSignal(input: SkillSignalsInput, whenToUse: string | null): SecuritySignal | null {
  const text = `${input.body}\n${whenToUse ?? ""}\n${Object.values(input.frontmatter).join("\n")}`;
  const forms: string[] = [];
  const lines: string[] = [];

  const tagMatches = text.match(/[\u{e0000}-\u{e007f}]/gu);
  const tagCount = tagMatches?.length ?? 0;
  if (tagCount > 0) {
    forms.push("hidden tag characters");
    lines.push(`Hidden tag characters decode to: "${clip(decodeTags(text), 80)}"`);
  }

  const zws = zeroWidthFacts(text);
  if (zws) {
    forms.push("zero-width characters");
    lines.push(
      `${zws.count} zero-width character${zws.count === 1 ? "" : "s"} (${zws.kinds}) removed from the text`,
    );
    // A short window around the first hidden character, with the invisible
    // characters stripped, so the human can see where the text was.
    const start = Math.max(0, zws.firstIndex - 40);
    const end = Math.min(text.length, zws.firstIndex + 40);
    let window = text.slice(start, end).replace(/[\u200b\u200c\ufeff]/g, "");
    if (start > 0) window = `…${window}`;
    if (end < text.length) window = `${window}…`;
    lines.push(`After removal: "${clip(window, 120)}"`);
  }

  const blob = longestBase64Blob(text);
  if (blob) {
    forms.push("a long base64 blob");
    const decoded = Buffer.from(blob, "base64").toString("utf8");
    if (decoded.includes("\uFFFD")) {
      lines.push(`A base64 blob holds binary data (${blob.length} characters)`);
    } else {
      lines.push(`A base64 blob decodes to: "${clip(decoded, 120)}"`);
    }
  }

  if (forms.length === 0) return null;
  return makeSignal("obfuscated-text", "Contains hidden or obfuscated text.", forms.join(", "), clip(lines.join("\n"), 240));
}

function longestBase64Blob(text: string): string | null {
  let best: string | null = null;
  for (const match of text.matchAll(/[A-Za-z0-9+/]{64,}={0,2}/g)) {
    const blob = match[0];
    if (!blob) continue;
    if (!best || blob.length > best.length) best = blob;
  }
  return best;
}

// ── Signal 8: embedded credential ──────────────────────────────────────────
// Known key prefixes plus long hex/base64 runs. The preview is always
// redacted — a few leading and trailing characters only — so the fact can be
// shown without ever putting the secret itself in the renderer. A long
// base64 blob can legitimately satisfy both this and the obfuscation check;
// they are different facts and both are reported.
const CREDENTIAL_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "OpenAI key", pattern: /sk-[A-Za-z0-9_-]{16,}/g },
  { name: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/g },
  { name: "GitHub token", pattern: /ghp_[A-Za-z0-9]{36}/g },
  { name: "long hex", pattern: /\b[0-9a-fA-F]{64,}\b/g },
  { name: "long base64", pattern: /[A-Za-z0-9+/]{64,}={0,2}/g },
];

function redactCredential(match: string): string {
  if (match.length <= 8) return `${match.slice(0, 4)}…`;
  return `${match.slice(0, 4)}…${match.slice(-4)}`;
}

function embeddedCredentialSignal(input: SkillSignalsInput, whenToUse: string | null): SecuritySignal | null {
  const text = `${input.body}\n${whenToUse ?? ""}\n${Object.values(input.frontmatter).join("\n")}`;
  const names: string[] = [];
  const redactions = new Set<string>();
  for (const { name, pattern } of CREDENTIAL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const full = match[0];
      if (!full) continue;
      if (!names.includes(name)) names.push(name);
      redactions.add(redactCredential(full));
    }
  }
  if (names.length === 0) return null;
  const preview = [...redactions].slice(0, 3).join(", ");
  return makeSignal("embedded-credential", "Contains an embedded credential.", names.join(", "), clip(preview, 120));
}

// ── Signal 9: changes agent behavior ───────────────────────────────────────
// Frontmatter keys that steer how the turn runs — model, effort, shell,
// background — and a forked context. Anything else in the body is just
// prose and is not counted.
const BEHAVIOR_KEYS: readonly string[] = ["model", "effort", "shell", "background"];

function behaviorModifiersSignal(frontmatter: Record<string, string>): SecuritySignal | null {
  const parts: string[] = [];
  for (const key of BEHAVIOR_KEYS) {
    const value = field(frontmatter, key).trim();
    if (value) parts.push(`${key}: ${value}`);
  }
  const context = field(frontmatter, "context").trim();
  if (/\bfork\b/i.test(context)) parts.push("context: fork");
  if (parts.length === 0) return null;
  return makeSignal("behavior-modifiers", "Alters agent behavior.", parts.join(", "));
}

// ── Signal 10: modified since install ──────────────────────────────────────
// Only meaningful against a recorded baseline. When no install time was ever
// recorded, the signal is omitted entirely — claiming change (or its absence)
// without a baseline would be invented. With one, a newer file mtime is the
// fact; the install record belongs to the caller's store.
function modifiedSinceInstallSignal(input: SkillSignalsInput): SecuritySignal | null {
  if (input.installedAt == null || input.modifiedAt == null) return null;
  if (input.modifiedAt <= input.installedAt) return null;
  return makeSignal(
    "modified-since-install",
    "Changed since it was installed.",
    "The skill's files are newer than the recorded install time.",
  );
}

// ── Signal 11: origin / provenance ─────────────────────────────────────────
// The scope class is the label; the detail carries the agent origin, the git
// remote when one exists, and any author/source from metadata. Author and
// source may be their own frontmatter keys or inline in the `metadata`
// value.
function metadataSubkey(value: string, key: string): string {
  const match = new RegExp(`(?:^|[,\n;])\\s*${key}\\s*:\\s*([^,\n;]+)`).exec(value);
  return match?.[1]?.trim() ?? "";
}

function provenanceLabel(scope: string): string {
  switch (scope) {
    case "user":
      return "From your personal skills folder.";
    case "project":
      return "From your project.";
    case "plugin":
      return "From a plugin.";
    case "managed":
    case "system":
      return "From managed skill storage.";
    default:
      return "Origin unknown.";
  }
}

function provenanceSignal(input: SkillSignalsInput): SecuritySignal {
  const parts: string[] = [];
  if (input.origin.trim()) parts.push(input.origin.trim());
  if (input.gitRemote?.trim()) parts.push(`git: ${input.gitRemote.trim()}`);

  const metadata = field(input.frontmatter, "metadata");
  const author = field(input.frontmatter, "metadata.author") || metadataSubkey(metadata, "author");
  const source = field(input.frontmatter, "metadata.source") || metadataSubkey(metadata, "source");
  if (author) parts.push(`author: ${author}`);
  if (source) parts.push(`source: ${source}`);

  return makeSignal("provenance", provenanceLabel(input.scope), parts.length > 0 ? parts.join(" · ") : null);
}

/** Derives a skill's cost facts and security signals from caller-supplied
 *  filesystem findings. Pure — no reads, no writes, no model calls. */
export function deriveSignals(input: SkillSignalsInput): SkillSignals {
  const whenToUse = input.whenToUse ?? (fieldAny(input.frontmatter, ["when_to_use", "whenToUse"]) || null);

  const security: SecuritySignal[] = [];
  const executable = executableContentSignal(input);
  if (executable) security.push(executable);
  const autoExecuted = autoExecutedSignal(input, whenToUse);
  if (autoExecuted) security.push(autoExecuted);
  const grants = toolGrantsSignal(input.frontmatter);
  if (grants) {
    security.push(grants);
  } else {
    const noRestrictions = noRestrictionsSignal(input.frontmatter);
    if (noRestrictions) security.push(noRestrictions);
  }
  const autoInvocation = autoInvocationSignal(input.frontmatter);
  if (autoInvocation) security.push(autoInvocation);
  const remote = remoteCodeSignal(input, whenToUse);
  if (remote) security.push(remote);
  const obfuscated = obfuscatedTextSignal(input, whenToUse);
  if (obfuscated) security.push(obfuscated);
  const credential = embeddedCredentialSignal(input, whenToUse);
  if (credential) security.push(credential);
  const behavior = behaviorModifiersSignal(input.frontmatter);
  if (behavior) security.push(behavior);
  const modified = modifiedSinceInstallSignal(input);
  if (modified) security.push(modified);
  security.push(provenanceSignal(input));

  return { cost: deriveCost(input, whenToUse), security, limitation: LIMITATION_NOTE };
}

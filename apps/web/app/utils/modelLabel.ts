// Turn a provider's raw model id into a friendly display label.
//
// Antigravity's `agy models` emits ids like `gemini-3.5-flash-medium`,
// `claude-opus-4-6-thinking`, `gpt-oss-120b-medium` — the reasoning/effort
// tier is baked into the id itself. We keep the id verbatim (that's exactly
// what `--model` expects) and only prettify the label shown in the picker, so
// the list always mirrors the CLI's real model set rather than hand-written
// names that drift out of date.

const EFFORT: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };

// Known families → clean base name (longest, most specific prefix first).
const FAMILIES: Array<[RegExp, string]> = [
  [/^gemini-3\.6-flash/, "Gemini 3.6 Flash"],
  [/^gemini-3\.5-flash/, "Gemini 3.5 Flash"],
  [/^gemini-3\.1-pro/, "Gemini 3.1 Pro"],
  [/^gemini-/, "Gemini"],
  [/^claude-opus-4-6/, "Claude Opus 4.6"],
  [/^claude-sonnet-4-6/, "Claude Sonnet 4.6"],
  [/^claude-/, "Claude"],
  [/^gpt-oss-120b/, "GPT-OSS 120B"],
  [/^gpt-/, "GPT"],
];

export function modelLabel(id: string): string {
  // Peel a trailing effort / "thinking" tier off the id → a readable suffix.
  const suffixes: string[] = [];
  let core = id;
  for (;;) {
    const m = core.match(/-([a-z]+)$/i);
    const tail = m?.[1]?.toLowerCase();
    if (m && tail && EFFORT[tail]) {
      suffixes.unshift(EFFORT[tail]);
      core = core.slice(0, m.index);
      continue;
    }
    if (m && tail === "thinking") {
      suffixes.unshift("Thinking");
      core = core.slice(0, m.index);
      continue;
    }
    break;
  }
  const family = FAMILIES.find(([re]) => re.test(core));
  const base = family ? family[1] : titleCase(core);
  return suffixes.length ? `${base} · ${suffixes.join(" ")}` : base;
}

function titleCase(id: string): string {
  return id
    .split("-")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

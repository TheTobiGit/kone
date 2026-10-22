import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "vue/compiler-sfc";

// The two per-provider limit switches, read off the pane's own template. They
// belong to one provider's Limits block — not the deck's foot, not the model
// roster — and they may only write through the provider-settings composable, so
// the mirror and main's store stay the single source of truth.

/** One attribute or directive of a template node. */
type Prop = {
  type: number;
  name: string;
  rawName: string;
  arg?: { content: string };
  exp?: { content: string };
  value?: { content: string };
};

/** One template node, as the SFC compiler hands it over. */
type Node = {
  type: number;
  tag?: string;
  props?: Prop[];
  children?: Node[];
  content?: string;
  branches?: { children?: Node[] }[];
};

const PANE = "./SettingsProvidersPane.vue";

function source(): string {
  return readFileSync(new URL(PANE, import.meta.url), "utf8");
}

function template(): Node {
  const { descriptor, errors } = parse(source(), { filename: PANE });
  if (errors.length > 0) throw new Error(`${PANE}: ${errors[0]!.message}`);
  // SAFETY: the parse reported no errors, so the template exists and its AST is
  // the root this walker starts from; `Node` is the subset the assertions read.
  return descriptor.template!.ast as Node;
}

/** Every element with this tag among these nodes, at any depth. */
function elements(nodes: Node[], tag: string): Node[] {
  const found: Node[] = [];
  for (const node of nodes) {
    if (node.type === 1 && node.tag === tag) found.push(node);
    found.push(...elements(node.children ?? [], tag));
    for (const branch of node.branches ?? []) found.push(...elements(branch.children ?? [], tag));
  }
  return found;
}

/** A static attribute's value. */
function attribute(el: Node, name: string): string | undefined {
  return el.props?.find((prop) => prop.type === 6 && prop.name === name)?.value?.content;
}

/** The expression of a directive (or bound attribute), by its written name. */
function binding(el: Node, rawName: string): string | undefined {
  return el.props?.find((prop) => prop.rawName === rawName)?.exp?.content;
}

function classes(el: Node): string[] {
  return (attribute(el, "class") ?? "").split(/\s+/).filter(Boolean);
}

/** A node's text, whatever wrappers sit between it and the tag. */
function text(node: Node): string {
  if (node.type === 2) return node.content ?? "";
  let out = "";
  for (const child of node.children ?? []) out += text(child);
  for (const branch of node.branches ?? []) {
    for (const child of branch.children ?? []) out += text(child);
  }
  return out;
}

/** The open provider's Limits block — the section the rows have to live in. */
function limitsSection(pane: Node): Node {
  const section = elements([pane], "section").find(
    (el) => attribute(el, "aria-label") === "Limits" && classes(el).includes("pp__limits"),
  );
  if (!section) throw new Error("no <section class=\"pp__limits\" aria-label=\"Limits\"> in the pane");
  return section;
}

type Row = { el: Node; label: string };

/** The switches inside the Limits block, with the label each one shows. */
function limitRows(pane: Node): Row[] {
  return elements([limitsSection(pane)], "button")
    .filter((el) => attribute(el, "role") === "switch")
    .map((el) => ({
      el,
      label: elements([el], "span")
        .filter((span) => classes(span).includes("pp__checklabel"))
        .map(text)
        .join("")
        .trim(),
    }));
}

test("the Limits block carries the two limit switches, labelled exactly", () => {
  const rows = limitRows(template());

  expect(rows.map((row) => row.label)).toEqual([
    "Auto-resume at reset",
    "Snooze limited threads",
  ]);
  for (const row of rows) {
    // The deck-foot's own row shape, reused — no second switch style on the page.
    expect(classes(row.el)).toContain("pp__checkrow");
    expect(elements([row.el], "span").some((span) => classes(span).includes("pp__switch"))).toBe(true);
  }
});

test("each switch reads and writes through the provider-settings composable", () => {
  const rows = limitRows(template());
  const [resume, snooze] = rows;

  expect(binding(resume!.el, ":aria-checked")).toContain("resumeAtReset");
  expect(binding(resume!.el, ":aria-checked")).toContain("current.provider");
  expect(binding(resume!.el, "@click")).toMatch(/resumeAtReset/i);

  expect(binding(snooze!.el, ":aria-checked")).toContain("snoozeWhenLimited");
  expect(binding(snooze!.el, ":aria-checked")).toContain("current.provider");
  expect(binding(snooze!.el, "@click")).toMatch(/snoozeWhenLimited/i);

  // The script persists through the composable's setters, never a bridge call.
  const script = source();
  expect(script).toContain("setResumeAtReset(");
  expect(script).toContain("setSnoozeWhenLimited(");
  expect(script).not.toContain("patchSettings(");
});

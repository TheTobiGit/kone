import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "vue/compiler-sfc";

// Where each host of the sign-in modal lives, read off the templates themselves.
// The card is one component mounted twice: the app shell's copy for the
// composer's tray, and the providers pane's copy, which must render inside the
// pane (the pane's page frame carries the overlay slot and the positioned
// ancestor the shell's `contained` mode covers).

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
  branches?: { children?: Node[] }[];
};

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

function template(relative: string): Node {
  const { descriptor, errors } = parse(source(relative), { filename: relative });
  if (errors.length > 0) throw new Error(`${relative}: ${errors[0]!.message}`);
  // SAFETY: the parse reported no errors, so the template exists and its AST is
  // the root this walker starts from; `Node` is the subset of that node tree the
  // assertions below read.
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

function element(node: Node, tag: string): Node {
  const found = elements([node], tag)[0];
  if (!found) throw new Error(`no <${tag}> in the template`);
  return found;
}

/** The expression of `v-if` (or any directive), by its written name. */
function directive(el: Node, rawName: string): string | undefined {
  return el.props?.find((prop) => prop.rawName === rawName)?.exp?.content;
}

/** A static attribute's value. */
function attribute(el: Node, name: string): string | undefined {
  return el.props?.find((prop) => prop.type === 6 && prop.name === name)?.value?.content;
}

/** The name of a `<template #slot>` wrapper. */
function slotName(el: Node): string | undefined {
  const prop = el.props?.find((p) => p.name === "slot");
  return prop?.arg?.content ?? prop?.exp?.content;
}

function styleOf(relative: string): string {
  return parse(source(relative), { filename: relative }).descriptor.styles.map((s) => s.content).join("\n");
}

test("the providers pane mounts the modal inside its own page frame, gated on the pane host", () => {
  const pane = template("../settings/SettingsProvidersPane.vue");
  const shell = element(pane, "SettingsPageShell");
  const overlay = (shell.children ?? []).find((child) => child.tag === "template" && slotName(child) === "overlay");
  expect(overlay).toBeDefined();

  const modal = element(overlay!, "ProviderSignInModal");
  expect(modal.props?.some((prop) => prop.type === 6 && prop.name === "contained")).toBe(true);
  expect(directive(modal, "v-if")).toContain("host.value");
  expect(directive(modal, "v-if")).toContain("'pane'");
});

test("the page frame owns the overlay slot, last, over a positioned section", () => {
  const shell = template("../settings/SettingsPageShell.vue");
  const section = element(shell, "section");
  const last = (section.children ?? []).filter((child) => child.type === 1).at(-1);
  expect(last?.tag).toBe("slot");
  expect(attribute(last!, "name")).toBe("overlay");

  expect(styleOf("../settings/SettingsPageShell.vue")).toMatch(/\.sps\s*\{[^}]*position:\s*relative/);
});

test("the card hands its contained mode to the one shell that draws the scrim", () => {
  const modal = template("../provider/ProviderSignInModal.vue");
  const shell = element(modal, "UiModalShell");
  expect(directive(shell, ":contained")).toBe("contained");

  const modalSource = source("../provider/ProviderSignInModal.vue");
  expect(modalSource).not.toContain("modal-scrim");
  expect(source("../ui/ModalShell.vue")).toContain("modal-scrim");
});

test("the card keeps its focus trap and capture-phase Escape", () => {
  const modalSource = source("../provider/ProviderSignInModal.vue");
  expect(modalSource).toContain('window.addEventListener("keydown", onKeydown, true)');
  expect(modalSource).toContain("dismiss(() => closed(myTicket))");
});

test("the page shell hosts the app-level modal for the composer's tray", () => {
  const page = template("../../pages/index.vue");
  const modal = element(page, "ProviderSignInModal");
  expect(directive(modal, "v-if")).toContain("host.value");
  expect(directive(modal, "v-if")).toContain("'app'");
});

test("both pane call sites name the pane host; the composer keeps the app's", () => {
  const pane = source("../settings/SettingsProvidersPane.vue");
  expect(pane.match(/signIn\.open\([^)]*["']pane["']\)/g) ?? []).toHaveLength(2);

  const composer = source("../agent/AgentComposer.vue");
  expect(composer).toContain("signIn.open(props.healthStatus.provider)");
  expect(composer).not.toContain('"pane"');
});

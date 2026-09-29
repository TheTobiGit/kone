import { computed, isRef, ref, watch, type Ref } from "vue";
import { useFileSystem } from "~/composables/useFileSystem";

export type InstructionSection = {
  title: string;
  level: number;
};

export type InstructionFileInfo = {
  kind: "agents" | "claude";
  path: string;
  detected: boolean;
  text: string | null;
  size: number;
  lines: number;
  sections: InstructionSection[];
  commands: string[];
};

export type SpaceInstructions = {
  loading: Ref<boolean>;
  agents: Ref<InstructionFileInfo>;
  claude: Ref<InstructionFileInfo>;
  refresh: () => Promise<void>;
  reveal: (relPath: string) => Promise<void>;
  createAgentsMd: () => Promise<void>;
  createClaudeMd: () => Promise<void>;
};

const AGENTS_CANDIDATES = ["AGENTS.md", ".agents.md", ".agents/AGENTS.md", "agents.md"];
const CLAUDE_CANDIDATES = ["CLAUDE.md", ".claude/CLAUDE.md", "claude.md"];

function parseSections(text: string): InstructionSection[] {
  const sections: InstructionSection[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const match = line.match(/^(#{1,3})\s+(.+)$/);
    if (match) {
      const hashes = match[1];
      const title = match[2]?.trim();
      if (hashes && title) {
        sections.push({
          level: hashes.length,
          title,
        });
      }
    }
  }
  return sections;
}

function extractCommands(text: string): string[] {
  const commands: string[] = [];
  const lines = text.split("\n");
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("//") && !trimmed.startsWith("/*")) {
        commands.push(trimmed);
      }
    } else {
      const matches = line.matchAll(/`([^`]+)`/g);
      for (const m of matches) {
        const code = m[1]?.trim();
        if (code && /^(?:bun|npm|pnpm|yarn|cargo|git|pytest|make|npx)\b/.test(code)) {
          if (!commands.includes(code)) {
            commands.push(code);
          }
        }
      }
    }
  }
  return commands.slice(0, 10);
}

export function useSpaceInstructions(
  projectPath: Ref<string> | (() => string),
  visible: Ref<boolean> | (() => boolean) = ref(true),
): SpaceInstructions {
  const fs = useFileSystem();

  const getPath = () => (isRef(projectPath) ? projectPath.value : projectPath());
  const getVisible = () => (isRef(visible) ? visible.value : visible());

  const loading = ref(false);
  const agents = ref<InstructionFileInfo>({
    kind: "agents",
    path: "AGENTS.md",
    detected: false,
    text: null,
    size: 0,
    lines: 0,
    sections: [],
    commands: [],
  });

  const claude = ref<InstructionFileInfo>({
    kind: "claude",
    path: "CLAUDE.md",
    detected: false,
    text: null,
    size: 0,
    lines: 0,
    sections: [],
    commands: [],
  });

  async function probeCandidates(
    root: string,
    candidates: string[],
    kind: "agents" | "claude",
  ): Promise<InstructionFileInfo> {
    for (const rel of candidates) {
      try {
        const file = await fs.readProjectFile(root, rel);
        if (file && file.text !== null && !file.binary) {
          const lines = file.text.split("\n").length;
          return {
            kind,
            path: rel,
            detected: true,
            text: file.text,
            size: file.size,
            lines,
            sections: parseSections(file.text),
            commands: extractCommands(file.text),
          };
        }
      } catch {
        // Candidate file does not exist in root
      }
    }

    return {
      kind,
      path: candidates[0] ?? (kind === "agents" ? "AGENTS.md" : "CLAUDE.md"),
      detected: false,
      text: null,
      size: 0,
      lines: 0,
      sections: [],
      commands: [],
    };
  }

  async function refresh(): Promise<void> {
    const root = getPath();
    if (!root) return;

    loading.value = true;
    try {
      const [agentsInfo, claudeInfo] = await Promise.all([
        probeCandidates(root, AGENTS_CANDIDATES, "agents"),
        probeCandidates(root, CLAUDE_CANDIDATES, "claude"),
      ]);
      agents.value = agentsInfo;
      claude.value = claudeInfo;
    } finally {
      loading.value = false;
    }
  }

  async function reveal(relPath: string): Promise<void> {
    const root = getPath();
    if (!root) return;
    if (import.meta.client && window.koneDesktop?.system?.reveal) {
      const fullPath = root.endsWith("/") ? `${root}${relPath}` : `${root}/${relPath}`;
      await window.koneDesktop.system.reveal(fullPath);
    }
  }

  async function createAgentsMd(): Promise<void> {
    const root = getPath();
    if (!root) return;
    const template = `# AGENTS.md

## Overview
Guidelines and instructions for autonomous coding agents working in this repository.

## Repo Layout
- Describe the key packages, applications, or folders here.

## Working Rules
- Build & verify before completing changes.
- Respect existing code conventions and types.
`;
    await fs.writeProjectFile(root, "AGENTS.md", template);
    await refresh();
  }

  async function createClaudeMd(): Promise<void> {
    const root = getPath();
    if (!root) return;
    const template = `# CLAUDE.md

Guidelines and commands for Claude Code in this repository.

## Commands
- Build: \`bun run build\`
- Test: \`bun test\`
- Lint: \`bun run lint\`

## Architecture & Conventions
- Maintain strict TypeScript types.
- Follow existing patterns in the codebase.
`;
    await fs.writeProjectFile(root, "CLAUDE.md", template);
    await refresh();
  }

  watch(
    [() => getPath(), () => getVisible()],
    ([root, isVis]) => {
      if (root && isVis) {
        void refresh();
      }
    },
    { immediate: true },
  );

  return {
    loading: computed(() => loading.value),
    agents: computed(() => agents.value),
    claude: computed(() => claude.value),
    refresh,
    reveal,
    createAgentsMd,
    createClaudeMd,
  };
}

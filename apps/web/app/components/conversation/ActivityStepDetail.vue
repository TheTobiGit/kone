<script setup lang="ts">
import { computed, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  CommandLineIcon,
  Copy01Icon,
  File01Icon,
  FileEditIcon,
  Search01Icon,
  Tick02Icon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import CodeBlock from "~/components/markdown/CodeBlock.vue";
import FileChip from "~/components/git-space/FileChip.vue";
import ToolDiffView from "~/components/conversation/ToolDiffView.vue";

const props = defineProps<{
  detail: string;
  toolName?: string;
  toolText?: string;
}>();

const { cue } = useSound();
const copied = ref(false);

interface RawToolRecord {
  CommandLine?: string;
  command?: string;
  cmd?: string;
  Cwd?: string;
  cwd?: string;
  TargetFile?: string;
  targetFile?: string;
  file?: string;
  path?: string;
  ReplacementContent?: string;
  replacementContent?: string;
  TargetContent?: string;
  targetContent?: string;
  CodeContent?: string;
  codeContent?: string;
  content?: string;
  Instruction?: string;
  instruction?: string;
  Description?: string;
  description?: string;
  AbsolutePath?: string;
  absolutePath?: string;
  StartLine?: number;
  endLine?: number;
  EndLine?: number;
  Query?: string;
  query?: string;
  Pattern?: string;
  pattern?: string;
  SearchPath?: string;
  SearchDirectory?: string;
}

type ParsedPayload =
  | { kind: "command"; command: string; cwd?: string }
  | {
      kind: "file_edit";
      file: string;
      replacement?: string;
      target?: string;
      code?: string;
      instruction?: string;
    }
  | { kind: "file_read"; file: string; startLine?: number; endLine?: number }
  | { kind: "search"; query: string; path?: string; pattern?: string }
  | { kind: "json"; formatted: string }
  | { kind: "diff"; content: string }
  | { kind: "raw"; content: string };

const payload = computed<ParsedPayload>(() => {
  const raw = props.detail.trim();
  if (!raw) return { kind: "raw", content: "" };

  if (
    raw.startsWith("diff --git") ||
    (raw.startsWith("--- ") && raw.includes("+++ ")) ||
    (raw.includes("@@ -") && (raw.includes("\n+") || raw.includes("\n-")))
  ) {
    return { kind: "diff", content: raw };
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed instanceof Object && !Array.isArray(parsed)) {
      // SAFETY: Parsed JSON payload matching arbitrary tool argument schemas
      const obj = parsed as RawToolRecord;

      // Command execution
      const cmd = obj.CommandLine || obj.command || obj.cmd;
      if (cmd && String(cmd).trim()) {
        return {
          kind: "command",
          command: String(cmd).trim(),
          cwd: obj.Cwd || obj.cwd,
        };
      }

      // File edits / writes
      const targetFile = obj.TargetFile || obj.targetFile || obj.file || obj.path;
      const replacement = obj.ReplacementContent || obj.replacementContent;
      const target = obj.TargetContent || obj.targetContent;
      const code = obj.CodeContent || obj.codeContent || obj.content;
      const instruction =
        obj.Instruction || obj.instruction || obj.Description || obj.description;
      if (targetFile && (replacement || code || target)) {
        return {
          kind: "file_edit",
          file: targetFile,
          replacement,
          target,
          code,
          instruction,
        };
      }

      // File reads
      const absPath = obj.AbsolutePath || obj.absolutePath;
      if (absPath) {
        return {
          kind: "file_read",
          file: absPath,
          startLine: obj.StartLine,
          endLine: obj.EndLine || obj.endLine,
        };
      }

      // Search / grep
      const query = obj.Query || obj.query || obj.Pattern || obj.pattern;
      if (query) {
        return {
          kind: "search",
          query,
          path: obj.SearchPath || obj.SearchDirectory,
          pattern: obj.Pattern || obj.pattern,
        };
      }

      // General JSON
      return { kind: "json", formatted: JSON.stringify(obj, null, 2) };
    }
  } catch {
    // Not valid JSON
  }

  return { kind: "raw", content: raw };
});

function detectLang(filename?: string): string {
  if (!filename) return "plaintext";
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    vue: "vue",
    py: "python",
    rs: "rust",
    go: "go",
    css: "css",
    html: "html",
    json: "json",
    md: "markdown",
    sh: "shellscript",
    bash: "shellscript",
    zsh: "shellscript",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
  };
  return (ext && map[ext]) ?? "plaintext";
}

const copyText = computed(() => {
  const p = payload.value;
  switch (p.kind) {
    case "command":
      return p.command;
    case "file_edit":
      return p.replacement ?? p.code ?? props.detail;
    case "json":
      return p.formatted;
    case "diff":
    case "raw":
      return p.content;
    default:
      return props.detail;
  }
});

async function onCopy(): Promise<void> {
  if (!copyText.value || !import.meta.client) return;
  try {
    await navigator.clipboard.writeText(copyText.value);
    cue("success");
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1600);
  } catch {
    // Clipboard blocked
  }
}
</script>

<template>
  <div class="sdetail">
    <!-- Header bar with category and copy button -->
    <div class="sdetail__head">
      <div class="sdetail__meta">
        <template v-if="payload.kind === 'command'">
          <HugeiconsIcon :icon="CommandLineIcon" :size="13" :stroke-width="2" />
          <span>Command</span>
          <span v-if="payload.cwd" class="sdetail__tag">{{ payload.cwd }}</span>
        </template>
        <template v-else-if="payload.kind === 'file_edit'">
          <HugeiconsIcon :icon="FileEditIcon" :size="13" :stroke-width="2" />
          <span>File edit</span>
        </template>
        <template v-else-if="payload.kind === 'file_read'">
          <HugeiconsIcon :icon="File01Icon" :size="13" :stroke-width="2" />
          <span>File view</span>
        </template>
        <template v-else-if="payload.kind === 'search'">
          <HugeiconsIcon :icon="Search01Icon" :size="13" :stroke-width="2" />
          <span>Search parameters</span>
        </template>
        <template v-else-if="payload.kind === 'diff'">
          <HugeiconsIcon :icon="FileEditIcon" :size="13" :stroke-width="2" />
          <span>Diff</span>
        </template>
        <template v-else-if="payload.kind === 'json'">
          <HugeiconsIcon :icon="ToolsIcon" :size="13" :stroke-width="2" />
          <span>Parameters</span>
        </template>
        <template v-else>
          <HugeiconsIcon :icon="ToolsIcon" :size="13" :stroke-width="2" />
          <span>Tool detail</span>
        </template>
      </div>

      <button
        type="button"
        class="sdetail__copy"
        :aria-label="copied ? 'Copied' : 'Copy content'"
        @click.stop="onCopy"
      >
        <HugeiconsIcon
          :icon="copied ? Tick02Icon : Copy01Icon"
          :size="12"
          :stroke-width="2"
        />
        <span>{{ copied ? "Copied" : "Copy" }}</span>
      </button>
    </div>

    <!-- Body contents -->
    <div class="sdetail__body">
      <!-- Command -->
      <template v-if="payload.kind === 'command'">
        <CodeBlock :code="payload.command" info="bash" />
      </template>

      <!-- File edit -->
      <template v-else-if="payload.kind === 'file_edit'">
        <div class="sdetail__file-row">
          <FileChip :path="payload.file" />
          <span v-if="payload.instruction" class="sdetail__instruct">
            {{ payload.instruction }}
          </span>
        </div>
        <ToolDiffView
          v-if="payload.target && payload.replacement"
          :file="payload.file"
          :target-content="payload.target"
          :replacement-content="payload.replacement"
        />
        <ToolDiffView
          v-else-if="payload.replacement || payload.code"
          :file="payload.file"
          :code-content="payload.replacement ?? payload.code"
        />
      </template>

      <!-- File read -->
      <template v-else-if="payload.kind === 'file_read'">
        <div class="sdetail__file-row">
          <FileChip :path="payload.file" />
          <span
            v-if="payload.startLine !== undefined && payload.endLine !== undefined"
            class="sdetail__tag"
          >
            lines {{ payload.startLine }}–{{ payload.endLine }}
          </span>
        </div>
      </template>

      <!-- Search -->
      <template v-else-if="payload.kind === 'search'">
        <div class="sdetail__search-grid">
          <div class="sdetail__search-item">
            <span class="sdetail__search-label">Query</span>
            <span class="sdetail__search-val">{{ payload.query }}</span>
          </div>
          <div v-if="payload.path" class="sdetail__search-item">
            <span class="sdetail__search-label">Path</span>
            <span class="sdetail__search-val">{{ payload.path }}</span>
          </div>
        </div>
      </template>

      <!-- JSON -->
      <template v-else-if="payload.kind === 'json'">
        <CodeBlock :code="payload.formatted" info="json" />
      </template>

      <!-- Diff -->
      <template v-else-if="payload.kind === 'diff'">
        <ToolDiffView :raw-diff="payload.content" />
      </template>

      <!-- Raw text / fallback -->
      <template v-else>
        <pre class="sdetail__raw">{{ payload.content }}</pre>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sdetail {
  display: flex;
  flex-direction: column;
  margin: 4px 0 8px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--ink) 3%, var(--ground));
  border: 1px solid var(--btn-border);
  overflow: hidden;
}
.sdetail__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 5%, transparent);
  background: color-mix(in srgb, var(--ink) 2%, transparent);
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--muted);
}
.sdetail__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.sdetail__tag {
  display: inline-flex;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--hover);
  color: var(--ink-soft);
  font-size: 10.5px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sdetail__copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.sdetail__copy:hover {
  background: var(--hover);
  color: var(--ink);
}
.sdetail__body {
  max-height: min(44vh, 360px);
  overflow-y: auto;
  overflow-x: auto;
  padding: 8px;
}
.sdetail__body :deep(.code-block) {
  margin: 0;
  border-radius: 6px;
}
.sdetail__file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 2px 0 6px;
}
.sdetail__instruct {
  font-size: 12px;
  color: var(--ink-soft);
}
.sdetail__diff-view {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
@media (max-width: 540px) {
  .sdetail__diff-view {
    grid-template-columns: 1fr;
  }
}
.sdetail__diff-pane {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sdetail__diff-sub {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
  padding-left: 2px;
}
.sdetail__diff-pane--old .sdetail__diff-sub {
  color: var(--diff-del);
}
.sdetail__diff-pane--new .sdetail__diff-sub {
  color: var(--diff-add, #10b981);
}
.sdetail__search-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 2px;
}
.sdetail__search-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
}
.sdetail__search-label {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  width: 50px;
  flex: none;
}
.sdetail__search-val {
  font-family: var(--font-mono);
  color: var(--ink);
  word-break: break-all;
}
.sdetail__raw {
  margin: 0;
  padding: 8px 10px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink-soft);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>

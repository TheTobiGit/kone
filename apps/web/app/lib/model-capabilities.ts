import type { ProviderId } from "~/lib/model-catalog";
import { getModelProviderId } from "~/lib/model-catalog";

export interface EffortLevel {
  id: string;
  label: string;
  hint: string;
  isDefault?: boolean;
}

export interface ModelCapabilities {
  effortLevels: EffortLevel[];
  supportsFastMode: boolean;
  supportsThinkingToggle: boolean;
}

const CODEX_EFFORT: EffortLevel[] = [
  { id: "low", label: "Quick", hint: "Fast answers with lighter reasoning" },
  { id: "medium", label: "Balanced", hint: "Default reasoning depth", isDefault: true },
  { id: "high", label: "Deep", hint: "More reasoning before responding" },
  { id: "xhigh", label: "Maximum", hint: "Deepest reasoning, slowest replies" },
];

const CLAUDE_FLAGSHIP_EFFORT: EffortLevel[] = [
  { id: "low", label: "Quick", hint: "Light thinking budget" },
  { id: "medium", label: "Balanced", hint: "Standard thinking depth", isDefault: true },
  { id: "high", label: "Deep", hint: "Extended thinking before responding" },
  { id: "xhigh", label: "Extra high", hint: "Deeper reasoning before responding" },
  { id: "max", label: "Max", hint: "Maximum thinking budget" },
  { id: "ultrathink", label: "Ultrathink", hint: "Prompt-injected deep reasoning" },
];

const CLAUDE_EXTENDED_EFFORT: EffortLevel[] = [
  { id: "low", label: "Quick", hint: "Light thinking budget" },
  { id: "medium", label: "Balanced", hint: "Standard thinking depth", isDefault: true },
  { id: "high", label: "Deep", hint: "Extended thinking before responding" },
  { id: "max", label: "Max", hint: "Maximum thinking budget" },
  { id: "ultrathink", label: "Ultrathink", hint: "Prompt-injected deep reasoning" },
];

const CLAUDE_SONNET_EFFORT: EffortLevel[] = [
  { id: "low", label: "Quick", hint: "Light thinking budget" },
  { id: "medium", label: "Balanced", hint: "Standard thinking depth", isDefault: true },
  { id: "high", label: "Deep", hint: "Extended thinking before responding" },
  { id: "max", label: "Max", hint: "Maximum thinking budget" },
];

const GEMINI_3_EFFORT: EffortLevel[] = [
  { id: "LOW", label: "Low", hint: "Faster responses with lighter thinking" },
  { id: "HIGH", label: "High", hint: "Deeper thinking before responding", isDefault: true },
];

const GEMINI_25_EFFORT: EffortLevel[] = [
  { id: "-1", label: "Dynamic", hint: "Adaptive thinking budget", isDefault: true },
  { id: "512", label: "512 tokens", hint: "Fixed thinking budget" },
];

const GROK_EFFORT: EffortLevel[] = [
  { id: "none", label: "None", hint: "No extra reasoning" },
  { id: "low", label: "Low", hint: "Light reasoning", isDefault: true },
  { id: "medium", label: "Medium", hint: "Balanced reasoning depth" },
  { id: "high", label: "High", hint: "Maximum reasoning depth" },
];

const CODEX_CAPS: ModelCapabilities = {
  effortLevels: CODEX_EFFORT,
  supportsFastMode: true,
  supportsThinkingToggle: false,
};

const CLAUDE_FLAGSHIP_CAPS: ModelCapabilities = {
  effortLevels: CLAUDE_FLAGSHIP_EFFORT,
  supportsFastMode: true,
  supportsThinkingToggle: false,
};

const CLAUDE_EXTENDED_CAPS: ModelCapabilities = {
  effortLevels: CLAUDE_EXTENDED_EFFORT,
  supportsFastMode: true,
  supportsThinkingToggle: false,
};

const CLAUDE_SONNET_CAPS: ModelCapabilities = {
  effortLevels: CLAUDE_SONNET_EFFORT,
  supportsFastMode: false,
  supportsThinkingToggle: false,
};

const CURSOR_NATIVE_CAPS: ModelCapabilities = {
  effortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
};

const GEMINI_3_CAPS: ModelCapabilities = {
  effortLevels: GEMINI_3_EFFORT,
  supportsFastMode: false,
  supportsThinkingToggle: false,
};

const GEMINI_25_CAPS: ModelCapabilities = {
  effortLevels: GEMINI_25_EFFORT,
  supportsFastMode: false,
  supportsThinkingToggle: false,
};

const GROK_CAPS: ModelCapabilities = {
  effortLevels: GROK_EFFORT,
  supportsFastMode: false,
  supportsThinkingToggle: false,
};

const NO_CAPABILITIES: ModelCapabilities = {
  effortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
};

/** Native model capabilities keyed by the provider that serves the model. */
const NATIVE_MODEL_CAPABILITIES: Record<ProviderId, Record<string, ModelCapabilities>> = {
  codex: {
    "gpt-5.5": CODEX_CAPS,
    "gpt-5.4": CODEX_CAPS,
    "gpt-5.3-codex": CODEX_CAPS,
    "gpt-5.3-codex-spark": CODEX_CAPS,
    "gpt-5.2-codex": CODEX_CAPS,
  },
  claudeAgent: {
    "claude-fable-5": CLAUDE_EXTENDED_CAPS,
    "claude-opus-4-8": CLAUDE_FLAGSHIP_CAPS,
    "claude-opus-4-6": CLAUDE_EXTENDED_CAPS,
    "claude-sonnet-4-6": CLAUDE_SONNET_CAPS,
    "claude-haiku-4-5": {
      effortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: true,
    },
  },
  cursor: {
    auto: CURSOR_NATIVE_CAPS,
    "composer-2": CURSOR_NATIVE_CAPS,
  },
  gemini: {
    "auto-gemini-3": GEMINI_3_CAPS,
    "gemini-3.1-pro-preview": GEMINI_3_CAPS,
    "gemini-3-flash-preview": GEMINI_3_CAPS,
    "gemini-3-pro": GEMINI_3_CAPS,
    "gemini-2.5-pro": GEMINI_25_CAPS,
    "gemini-2.5-flash": GEMINI_25_CAPS,
  },
  grok: {
    "grok-build-0.1": GROK_CAPS,
    "grok-build": GROK_CAPS,
  },
};

export function getModelCapabilities(routeProvider: ProviderId, modelId: string): ModelCapabilities {
  const modelProviderId = getModelProviderId(routeProvider, modelId);
  return NATIVE_MODEL_CAPABILITIES[modelProviderId]?.[modelId] ?? NO_CAPABILITIES;
}

export function getEffortLevels(provider: ProviderId, modelId: string) {
  return getModelCapabilities(provider, modelId).effortLevels;
}

export function getDefaultEffort(provider: ProviderId, modelId: string) {
  const levels = getEffortLevels(provider, modelId);
  return levels.find((level) => level.isDefault)?.id ?? levels[0]?.id ?? "";
}

export function normalizeEffort(provider: ProviderId, modelId: string, effortId: string) {
  const levels = getEffortLevels(provider, modelId);
  if (levels.some((level) => level.id === effortId)) {
    return effortId;
  }
  return getDefaultEffort(provider, modelId);
}

export function getEffortLabel(provider: ProviderId, modelId: string, effortId: string) {
  return (
    getEffortLevels(provider, modelId).find((level) => level.id === effortId)?.label ?? effortId
  );
}

export function modelSupportsFastMode(provider: ProviderId, modelId: string) {
  return getModelCapabilities(provider, modelId).supportsFastMode;
}

export function modelSupportsThinkingToggle(provider: ProviderId, modelId: string) {
  return getModelCapabilities(provider, modelId).supportsThinkingToggle;
}

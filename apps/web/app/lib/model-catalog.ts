export type ProviderId =
  | "codex"
  | "claudeAgent"
  | "cursor"
  | "gemini"
  | "grok";

export interface ModelOption {
  id: string;
  name: string;
}

export interface ProviderOption {
  id: ProviderId;
  label: string;
  models: ModelOption[];
}

export const MODEL_CATALOG: ProviderOption[] = [
  {
    id: "codex",
    label: "Codex",
    models: [
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      { id: "gpt-5-codex", name: "GPT-5 Codex" },
    ],
  },
  {
    id: "claudeAgent",
    label: "Claude",
    models: [
      { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    models: [
      { id: "composer-2", name: "Composer 2" },
      { id: "auto", name: "Auto" },
    ],
  },
  {
    id: "gemini",
    label: "Gemini",
    models: [
      { id: "auto-gemini-3", name: "Auto Gemini 3" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    ],
  },
  {
    id: "grok",
    label: "Grok",
    models: [
      { id: "grok-build-0.1", name: "Grok Build 0.1" },
      { id: "grok-build", name: "Grok 4.3" },
    ],
  },
];

export const DEFAULT_PROVIDER: ProviderId = "codex";
export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderId, string> = {
  codex: "gpt-5.3-codex",
  claudeAgent: "claude-sonnet-4-6",
  cursor: "composer-2",
  gemini: "auto-gemini-3",
  grok: "grok-build-0.1",
};

export function getProviderOption(providerId: ProviderId) {
  return MODEL_CATALOG.find((provider) => provider.id === providerId);
}

export function getModelsForProvider(providerId: ProviderId) {
  return getProviderOption(providerId)?.models ?? [];
}

export function getProviderLabel(providerId: ProviderId) {
  return getProviderOption(providerId)?.label ?? providerId;
}

export function getModelLabel(providerId: ProviderId, modelId: string) {
  return (
    getModelsForProvider(providerId).find((model) => model.id === modelId)?.name ??
    modelId
  );
}

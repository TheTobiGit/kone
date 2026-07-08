import { getDroidModel } from "~/lib/droid-model-store";

export type ProviderId =
  | "droid"
  | "codex"
  | "claudeAgent"
  | "cursor"
  | "gemini"
  | "grok";

export interface ModelOption {
  id: string;
  name: string;
  /** Provider that actually serves the model (may differ from the route provider). */
  modelProviderId: ProviderId;
}

export interface ProviderOption {
  id: ProviderId;
  label: string;
  models: ModelOption[];
}

export const MODEL_CATALOG: ProviderOption[] = [
  {
    id: "droid",
    label: "Droid",
    models: [],
  },
  {
    id: "codex",
    label: "Codex",
    models: [
      { id: "gpt-5.5", name: "GPT-5.5", modelProviderId: "codex" },
      { id: "gpt-5.4", name: "GPT-5.4", modelProviderId: "codex" },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", modelProviderId: "codex" },
      { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", modelProviderId: "codex" },
      { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", modelProviderId: "codex" },
    ],
  },
  {
    id: "claudeAgent",
    label: "Claude",
    models: [
      { id: "claude-fable-5", name: "Claude Fable 5", modelProviderId: "claudeAgent" },
      { id: "claude-opus-4-8", name: "Claude Opus 4.8", modelProviderId: "claudeAgent" },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", modelProviderId: "claudeAgent" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", modelProviderId: "claudeAgent" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", modelProviderId: "claudeAgent" },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    models: [
      { id: "auto", name: "Auto", modelProviderId: "cursor" },
      { id: "composer-2", name: "Composer 2", modelProviderId: "cursor" },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", modelProviderId: "claudeAgent" },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", modelProviderId: "codex" },
      { id: "gemini-3-pro", name: "Gemini 3 Pro", modelProviderId: "gemini" },
    ],
  },
  {
    id: "gemini",
    label: "Gemini",
    models: [
      { id: "auto-gemini-3", name: "Auto Gemini 3", modelProviderId: "gemini" },
      { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", modelProviderId: "gemini" },
      { id: "gemini-3-flash-preview", name: "Gemini 3 Flash", modelProviderId: "gemini" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", modelProviderId: "gemini" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", modelProviderId: "gemini" },
    ],
  },
  {
    id: "grok",
    label: "Grok",
    models: [
      { id: "grok-build-0.1", name: "Grok Build 0.1", modelProviderId: "grok" },
      { id: "grok-build", name: "Grok 4.3", modelProviderId: "grok" },
    ],
  },
];

export const DEFAULT_PROVIDER: ProviderId = "droid";
export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderId, string> = {
  droid: "",
  codex: "gpt-5.5",
  claudeAgent: "claude-sonnet-4-6",
  cursor: "auto",
  gemini: "auto-gemini-3",
  grok: "grok-build",
};

export function getProviderOption(providerId: ProviderId) {
  return MODEL_CATALOG.find((provider) => provider.id === providerId);
}

export function getModelsForProvider(providerId: ProviderId) {
  return getProviderOption(providerId)?.models ?? [];
}

export function getModelOption(providerId: ProviderId, modelId: string) {
  if (providerId === "droid") {
    const droidModel = getDroidModel(modelId);
    if (droidModel) {
      return {
        id: droidModel.id,
        name: droidModel.name,
        modelProviderId: "droid" as ProviderId,
      };
    }
  }

  return getModelsForProvider(providerId).find((model) => model.id === modelId);
}

export function getModelProviderId(providerId: ProviderId, modelId: string): ProviderId {
  return getModelOption(providerId, modelId)?.modelProviderId ?? providerId;
}

export function getProviderLabel(providerId: ProviderId) {
  return getProviderOption(providerId)?.label ?? providerId;
}

export function getModelLabel(providerId: ProviderId, modelId: string) {
  if (providerId === "droid") {
    const droidModel = getDroidModel(modelId);
    if (droidModel) return droidModel.name;
  }

  return getModelOption(providerId, modelId)?.name ?? modelId;
}

export function isRoutedModel(providerId: ProviderId, modelId: string) {
  return getModelProviderId(providerId, modelId) !== providerId;
}

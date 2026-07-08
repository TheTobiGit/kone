import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createSession } from "@factory/droid-sdk";
import type { DroidModelDescriptor } from "@kone/bridge-protocol";

const FACTORY_SETTINGS_PATH = path.join(os.homedir(), ".factory", "settings.json");

type FactorySettings = {
  sessionDefaultSettings?: {
    model?: string;
    reasoningEffort?: string;
  };
};

let cachedModels: DroidModelDescriptor[] | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60_000;

function mapAvailableModel(model: Record<string, unknown>): DroidModelDescriptor {
  return {
    id: String(model.id),
    name: String(model.displayName ?? model.id),
    shortName: String(model.shortDisplayName ?? model.displayName ?? model.id),
    isCustom: Boolean(model.isCustom),
    modelProvider: String(model.modelProvider ?? "factory"),
    supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.map(String)
      : [],
    defaultReasoningEffort: String(model.defaultReasoningEffort ?? "medium"),
  };
}

async function readFactoryDefaults(): Promise<{
  defaultModelId: string;
  defaultReasoningEffort: string;
}> {
  try {
    const raw = await readFile(FACTORY_SETTINGS_PATH, "utf8");
    const settings = JSON.parse(raw) as FactorySettings;
    return {
      defaultModelId: settings.sessionDefaultSettings?.model ?? "claude-opus-4-8",
      defaultReasoningEffort: settings.sessionDefaultSettings?.reasoningEffort ?? "medium",
    };
  } catch {
    return {
      defaultModelId: "claude-opus-4-8",
      defaultReasoningEffort: "medium",
    };
  }
}

export async function loadDroidModels(options?: {
  cwd?: string;
  forceRefresh?: boolean;
}): Promise<{
  models: DroidModelDescriptor[];
  defaultModelId: string;
  defaultReasoningEffort: string;
}> {
  const now = Date.now();
  const defaults = await readFactoryDefaults();

  if (!options?.forceRefresh && cachedModels && now - cachedAt < CACHE_TTL_MS) {
    return {
      models: cachedModels,
      defaultModelId: defaults.defaultModelId,
      defaultReasoningEffort: defaults.defaultReasoningEffort,
    };
  }

  const cwd = options?.cwd ?? process.env.KONE_CWD ?? process.cwd();
  const session = await createSession({
    apiKey: process.env.FACTORY_API_KEY!,
    cwd,
  });

  try {
    const available = session.initResult?.availableModels ?? [];
    const models = available.map((model) =>
      mapAvailableModel(model as unknown as Record<string, unknown>),
    );

    cachedModels = models;
    cachedAt = now;

    const defaultModelExists = models.some((model) => model.id === defaults.defaultModelId);
    const defaultModelId = defaultModelExists
      ? defaults.defaultModelId
      : (models[0]?.id ?? defaults.defaultModelId);

    const defaultDescriptor = models.find((model) => model.id === defaultModelId);

    return {
      models,
      defaultModelId,
      defaultReasoningEffort:
        defaults.defaultReasoningEffort ||
        defaultDescriptor?.defaultReasoningEffort ||
        "medium",
    };
  } finally {
    await session.close();
  }
}

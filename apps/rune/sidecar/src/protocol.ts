import path from "node:path";
import { z } from "zod";

export const providerSchema = z.enum(["codex", "claudeAgent", "opencode", "cursor", "droid", "antigravity"]);
const optionalText = z.string().nullish().transform((value) => value ?? undefined);
const mode = z.enum(["ask", "accept-edits", "full-access"]).optional();
const target = z.object({ provider: providerSchema, model: optionalText });
const selection = {
  model: optionalText,
  mode,
  effort: optionalText,
  fallbacks: z.array(target).optional(),
};

export const sessionSchema = z.object({
  threadId: z.string().min(1),
  provider: providerSchema,
  cwd: z.string().min(1).refine(path.isAbsolute, "Project path must be absolute"),
  ...selection,
  resume: optionalText,
  resumeSessionAt: optionalText,
  agent: z.object({ name: z.string(), instructions: optionalText }).optional(),
  workspace: z.object({ mode: z.enum(["local", "worktree"]), branch: optionalText, base: optionalText }).optional(),
});

export const turnSchema = z.object({
  threadId: z.string().min(1),
  input: z.string(),
  ...selection,
  userBlockId: optionalText,
  dispatchMode: z.enum(["queue", "steer"]).optional(),
  serviceTier: optionalText,
  contextWindow: optionalText,
  attachments: z.array(z.object({ type: z.enum(["image", "file"]), id: z.string().min(1), name: z.string(), mimeType: z.string(), sizeBytes: z.number().int().nonnegative() })).optional(),
});

export const studioLayoutSchema = z.object({
  version: z.literal(2),
  rows: z.array(z.object({ projectPath: z.string(), panes: z.array(z.unknown()), focusedId: z.string().nullable().default(null) })),
  focusedRow: z.string().nullable().default(null),
});

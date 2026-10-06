import { z } from "zod";

/** Meaning and transport are independent: an MCP call can read, edit or run. */
export const ToolActionSchema = z.enum([
  "read", "list", "search", "write", "edit", "delete", "run", "fetch",
  "web-search", "agent", "plan", "image", "other",
]);
export type ToolAction = z.infer<typeof ToolActionSchema>;

export const ToolCallSchema = z.object({
  action: ToolActionSchema,
  target: z.string().optional(),
  nativeCallId: z.string().optional(),
  title: z.string().optional(),
  transport: z.object({ server: z.string(), tool: z.string() }).optional(),
  /** Serialized input, kept separately from output (including executable wrappers). */
  input: z.string().optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolFileChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(["created", "edited", "removed", "renamed"]),
  oldPath: z.string().optional(),
  diff: z.string().optional(),
  /** A proposed edit is not a confirmed filesystem mutation. */
  applied: z.boolean(),
});
export type ToolFileChange = z.infer<typeof ToolFileChangeSchema>;

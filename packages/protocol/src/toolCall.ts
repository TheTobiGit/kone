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
  /** Line counts measured on the whole diff. Set where `diff` reaches the
   *  renderer clipped, so the counts stay exact while the preview is partial. */
  added: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
  diffClipped: z.boolean().optional(),
});
export type ToolFileChange = z.infer<typeof ToolFileChangeSchema>;

/** A tool_call whose bodies were clipped on their way to the renderer: where
 *  the full call lives, and the full length of each clipped body. The store
 *  always keeps the whole call; this is only the wire copy's receipt. */
export type ToolCallClip = {
  threadId: string;
  turnId: string;
  detail?: number;
  input?: number;
  diffs?: boolean;
};

export type TurnStatus =
  | "queued"
  | "pending"
  | "streaming"
  | "completed"
  | "error"
  | "cancelled";

export type ToolActivityStatus =
  | "queued"
  | "awaiting_permission"
  | "running"
  | "completed"
  | "error"
  | "cancelled";

export type ToolActivity = {
  id: string;
  name: string;
  kind?: string;
  status: ToolActivityStatus;
  inputSummary?: string;
  outputSummary?: string;
  command?: string;
  paths: string[];
  startedAt: string;
  completedAt?: string;
  isError?: boolean;
};

export type ArtifactKind =
  | "text"
  | "code"
  | "markdown"
  | "image"
  | "diff"
  | "url"
  | "file";

export type ArtifactReference = {
  id: string;
  kind: ArtifactKind;
  title: string;
  source: string;
  language?: string;
  content?: string;
  mimeType?: string;
  size?: number;
};

export type ConversationTurn = {
  id: string;
  prompt: string;
  responseText: string;
  thinkingText: string;
  thinkingExpanded: boolean;
  thinkingUserToggled: boolean;
  status: TurnStatus;
  tools: ToolActivity[];
  artifacts: ArtifactReference[];
  errorMessage?: string;
  modelId: string;
  reasoningEffort: string;
  createdAt: string;
  completedAt?: string;
};

export type PermissionRequestKind =
  | "command"
  | "file-read"
  | "file-change"
  | "network"
  | "unknown";

export type PermissionRequest = {
  requestId: string;
  turnId?: string;
  toolCallId?: string;
  requestKind: PermissionRequestKind;
  detail: string;
  target?: string;
  expiresAt?: string;
};

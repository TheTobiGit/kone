import type { ToolCall, ToolFileChange } from "@kone/protocol/tool-call";
import type { RuntimeItemStatus } from "./types.js";

export type Authority = "fallback" | "inferred" | "explicit";
type Value<T> = { value: T; authority: Authority };
type Content = { value: string; mode: "snapshot" | "delta" };
export type ToolObservation = {
  name?: Value<string>;
  action?: Value<ToolCall["action"]>;
  target?: Value<string>;
  title?: string;
  transport?: ToolCall["transport"];
  input?: string;
  detail?: Content;
  status?: RuntimeItemStatus;
  /** Turn-end inference may be corrected by a real completion. */
  provisional?: boolean;
  fileChanges?: ToolFileChange[];
};

const rank = { fallback: 0, inferred: 1, explicit: 2 };
const actionRank = (action: Value<ToolCall["action"]>) => action.value === "other" && action.authority !== "explicit" ? -1 : rank[action.authority];

/** Adapters supply observations; this class never interprets provider JSON. */
export class ToolCallAccumulator {
  private identity?: Value<string>;
  private action?: Value<ToolCall["action"]>;
  private target?: Value<string>;
  name?: string;
  text = "";
  detail = "";
  status: RuntimeItemStatus = "in-progress";
  tool: ToolCall = { action: "other" };
  fileChanges?: ToolFileChange[];

  observe(o: ToolObservation): this {
    if (o.name && (!this.identity || rank[o.name.authority] >= rank[this.identity.authority])) {
      this.identity = o.name;
      this.name = o.name.value;
    }
    if (o.action && (!this.action || actionRank(o.action) >= actionRank(this.action))) {
      this.action = o.action;
      this.tool.action = o.action.value;
    }
    if (o.target && (!this.target || rank[o.target.authority] >= rank[this.target.authority])) {
      this.target = o.target;
      this.text = o.target.value;
      this.tool.target = o.target.value;
    }
    if (o.title !== undefined) this.tool.title = o.title;
    if (o.transport !== undefined) this.tool.transport = o.transport;
    if (o.input !== undefined) this.tool.input = o.input;
    if (o.detail) this.detail = o.detail.mode === "delta" ? this.detail + o.detail.value : o.detail.value;
    if (o.status && (this.status === "in-progress" || (o.status !== "in-progress" && !o.provisional))) {
      this.status = o.status;
    }
    if (o.fileChanges !== undefined) this.fileChanges = o.fileChanges;
    return this;
  }

  snapshot() {
    return { name: this.name, text: this.text, detail: this.detail, status: this.status,
      tool: { ...this.tool }, fileChanges: this.fileChanges?.map((f) => ({ ...f })) };
  }
}

export type ScratchpadListInput = {
  projectPath: string;
};

export type ScratchpadSaveInput = {
  scratchpadId: string;
  projectPath: string;
  title: string;
  body: string;
  /** The editor's last-known revision — the web editor always sends it so
   *  user and agent (gateway) writes never silently clobber each other.
   *  Omit to overwrite unconditionally. */
  expectedRevision?: number;
};

/** The result of scratchpad:save — either the persisted state, or a
 *  revision conflict carrying the current revision so the editor can retry
 *  against fresh state. Null = store failure. */
export type ScratchpadSaveResult =
  | { savedAt: number; revision: number }
  | { conflict: number }
  | null;

export type ScratchpadDeleteInput = {
  scratchpadId: string;
};

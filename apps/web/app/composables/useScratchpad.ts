import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from "vue";
import { useDebounceFn, useEventListener } from "@vueuse/core";
import type { ScratchpadRecord, ScratchpadWriter } from "~/types/desktop";
import { normalizeTaskLists } from "~/utils/padMarkdown";

export type Snippet = {
  /** Markdown — what the thread's capture bubble hands over. */
  text: string;
};

/** The pad's remembered pens: whichever highlight / text colour you used last
 *  stays armed, per project, across reopening the column and restarting the app. */
export type PadMarker = {
  highlight: string;
  text: string;
};

export type ScratchpadSession = {
  key: string;
  scratchpadId: string;
  /** The pad document, as rich HTML (the editor formats as you type). */
  doc: Ref<string>;
  savedAt: number | null;
  status: "ready" | "saving" | "error";
  /** Timestamp of the last append — drives the flash highlight in the pane. */
  flashAt: Ref<number | null>;
  /** The armed colours, and the setter that re-arms (and persists) them. */
  marker: Ref<PadMarker>;
  setMarker: (patch: Partial<PadMarker>) => void;
};

export type UseScratchpadOptions = {
  projectPath: string | (() => string);
};

/** The one pad's fixed title — there is a single scratchpad per project and it
 *  can't be renamed, so nothing derives or stores a title any more. */
export const SCRATCHPAD_TITLE = "Scratchpad";

function uid(): string {
  return import.meta.client && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function storageKey(projectPath: string): string {
  return `kone:scratchpad:${projectPath}`;
}

function markerKey(projectPath: string): string {
  return `kone:scratchpad-marker:${projectPath}`;
}

// Copper is the highlighter you start with — kone's own accent. The text pen
// starts on "default" (plain ink), so nothing looks armed that isn't.
const DEFAULT_MARKER: PadMarker = { highlight: "copper", text: "default" };

function readMarker(projectPath: string): PadMarker {
  if (!import.meta.client) return { ...DEFAULT_MARKER };
  try {
    const raw = localStorage.getItem(markerKey(projectPath));
    if (!raw) return { ...DEFAULT_MARKER };
    const parsed = JSON.parse(raw) as Partial<PadMarker>;
    return {
      highlight: parsed.highlight ?? DEFAULT_MARKER.highlight,
      text: parsed.text ?? DEFAULT_MARKER.text,
    };
  } catch {
    return { ...DEFAULT_MARKER };
  }
}

function writeMarker(projectPath: string, marker: PadMarker): void {
  if (!import.meta.client) return;
  try {
    localStorage.setItem(markerKey(projectPath), JSON.stringify(marker));
  } catch {
    // best effort
  }
}

function readLocal(projectPath: string): ScratchpadRecord[] {
  if (!import.meta.client) return [];
  try {
    const raw = localStorage.getItem(storageKey(projectPath));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ScratchpadRecord[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(projectPath: string, records: ScratchpadRecord[]): void {
  if (!import.meta.client) return;
  try {
    localStorage.setItem(storageKey(projectPath), JSON.stringify(records));
  } catch {
    // best effort
  }
}

/**
 * One scratchpad per project.
 *
 * The pad's markdown is the project's, not the column's: it is loaded once from
 * the store (desktop) or localStorage (browser dev), lives on across closing and
 * reopening the column, and is only ever wiped by the pane's explicit Clear.
 * `sessions` therefore holds at most one entry — the pad while its strip column
 * is open — and keeps the array shape the strip's column registry expects.
 */
export function useScratchpad(options: UseScratchpadOptions) {
  const resolvePath = () =>
    typeof options.projectPath === "function" ? options.projectPath() : options.projectPath;
  const bridge = () => (import.meta.client ? window.koneDesktop?.scratchpad : undefined);

  const { render } = useMarkdown();

  const sessions = shallowRef<ScratchpadSession[]>([]);
  const hydrated = ref(false);
  /** The project's pad row — its id and last-known body, even while closed. */
  const scratchpadId = ref("");
  const storedBody = ref("");
  /** The exact raw body last persisted (or last landed from a gateway write) —
   *  the no-op save guard compares drafts against this, not the html form. */
  const storedRawBody = ref<string | null>(null);
  const storedSavedAt = ref<number | null>(null);
  /** Last-known revision (the editor is the revision source of truth — it
   *  sends this with every save so user edits and gateway agent writes never
   *  silently clobber each other). */
  const storedRevision = ref<number | null>(null);
  /** The agent session that last wrote this pad via the gateway, if any —
   *  the board renders a subtle "written by <model> via kone" marker. */
  const lastWriter = ref<ScratchpadWriter | null>(null);
  let saveDebounced: ReturnType<typeof useDebounceFn> | null = null;
  let detachEvents: (() => void) | null = null;

  function current(): ScratchpadSession | undefined {
    return sessions.value[0];
  }

  /** Render Markdown into the pad's own HTML. Bodies saved before the pad became
   *  a formatting editor are plain Markdown, so they come through here too. */
  async function toPadHtml(source: string): Promise<string> {
    const text = source.trim();
    if (!text) return "";
    if (/^\s*<(p|h[1-6]|ul|ol|li|blockquote|pre|hr|div)\b/i.test(text)) return text;
    const html = await render(text);
    return normalizeTaskLists(html ?? `<p>${text}</p>`);
  }

  async function persist(session: ScratchpadSession): Promise<void> {
    const projectPath = resolvePath();
    // No-op guard: never bump the revision (and never trip a concurrent agent
    // write into revision_conflict) for a draft identical to what's already
    // persisted. Only meaningful once a save exists — a fresh empty pad still
    // needs its row created.
    if (storedRawBody.value !== null && session.doc.value === storedRawBody.value) {
      session.status = "ready";
      return;
    }
    session.status = "saving";
    sessions.value = [...sessions.value];

    const payload = {
      scratchpadId: session.scratchpadId,
      projectPath,
      title: SCRATCHPAD_TITLE,
      body: session.doc.value,
      // The optimistic lock: the revision this draft was based on. A gateway
      // agent write that landed since is a conflict — retry once against the
      // fresh revision (the user's draft wins; the agent's write is replaced).
      expectedRevision: storedRevision.value ?? undefined,
    };

    const api = bridge();
    let savedAt: number | null = null;
    let revision = storedRevision.value;
    if (api) {
      let result = await api.save(payload);
      if (result && "conflict" in result) {
        result = await api.save({ ...payload, expectedRevision: result.conflict });
      }
      const saved = result && "revision" in result ? result : null;
      savedAt = saved?.savedAt ?? Date.now();
      revision = saved?.revision ?? revision;
    } else {
      const list = readLocal(projectPath);
      const idx = list.findIndex((r) => r.id === session.scratchpadId);
      const now = Date.now();
      const row: ScratchpadRecord = {
        id: session.scratchpadId,
        projectPath,
        title: payload.title,
        body: payload.body,
        createdAt: idx >= 0 ? list[idx]!.createdAt : now,
        updatedAt: now,
        sortIndex: idx >= 0 ? list[idx]!.sortIndex : list.length,
        revision: idx >= 0 ? list[idx]!.revision + 1 : 1,
      };
      if (idx >= 0) list[idx] = row;
      else list.push(row);
      writeLocal(projectPath, list);
      savedAt = now;
      revision = row.revision;
    }

    session.savedAt = savedAt;
    session.status = "ready";
    storedBody.value = session.doc.value;
    storedRawBody.value = payload.body;
    storedSavedAt.value = savedAt;
    storedRevision.value = revision;
    sessions.value = [...sessions.value];
  }

  function scheduleSave(): void {
    if (!saveDebounced) {
      saveDebounced = useDebounceFn(() => {
        const s = current();
        if (s) void persist(s);
      }, 500);
    }
    saveDebounced();
  }

  function makeSession(): ScratchpadSession {
    const marker = ref<PadMarker>(readMarker(resolvePath()));
    const session: ScratchpadSession = {
      key: uid(),
      scratchpadId: scratchpadId.value,
      doc: ref(storedBody.value),
      savedAt: storedSavedAt.value,
      status: "ready",
      flashAt: ref(null),
      marker,
      setMarker: (patch) => {
        marker.value = { ...marker.value, ...patch };
        writeMarker(resolvePath(), marker.value);
      },
    };
    watch(session.doc, () => scheduleSave(), { flush: "post" });
    return session;
  }

  async function flush(): Promise<void> {
    const s = current();
    if (!s) return;
    await persist(s);
  }

  /**
   * Load the project's pad row. Legacy multi-pad projects collapse to the most
   * recently touched row; the rest are dropped so one pad is the only truth.
   */
  async function hydrate(): Promise<void> {
    if (hydrated.value) return;
    hydrated.value = true;
    const projectPath = resolvePath();
    const api = bridge();
    const records = api ? await api.list({ projectPath }) : readLocal(projectPath);
    const sorted = [...records].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const keep = sorted[0];
    if (!keep) {
      scratchpadId.value = uid();
      return;
    }
    scratchpadId.value = keep.id;
    storedBody.value = await toPadHtml(keep.body);
    storedRawBody.value = keep.body;
    storedSavedAt.value = keep.updatedAt ?? null;
    storedRevision.value = keep.revision ?? null;
    const stale = sorted.slice(1);
    if (stale.length) {
      if (api) {
        await Promise.all(stale.map((r) => api.delete({ scratchpadId: r.id })));
      } else {
        writeLocal(projectPath, [keep]);
      }
    }
  }

  /** Open the project's pad and return its strip key — idempotent. */
  async function open(): Promise<string> {
    await hydrate();
    const existing = current();
    if (existing) return existing.key;
    const session = makeSession();
    sessions.value = [session];
    return session.key;
  }

  /** Close the pad column — flush, drop the session, keep the saved markdown. */
  async function close(key: string): Promise<void> {
    const s = current();
    if (!s || s.key !== key) return;
    await flush();
    sessions.value = [];
  }

  /** Drop a captured snippet at the end of the pad — formatted, and nothing else:
   *  no source line, no timestamp. */
  async function append(key: string, snippet: Snippet): Promise<void> {
    const s = current();
    if (!s || s.key !== key) return;
    const chunk = await toPadHtml(snippet.text);
    if (!chunk) return;
    const base = s.doc.value.trim();
    s.doc.value = base ? `${base}${chunk}` : chunk;
    s.flashAt.value = Date.now();
    scheduleSave();
  }

  /**
   * Live updates from the agent gateway (docs/mcp-gateway-design.md §6): a
   * kone_scratchpad_write lands as `scratchpad.updated` on the shared
   * agent:event stream. Applied only when the incoming revision is newer than
   * what this pane last knew. An open editor with unsaved edits keeps its
   * draft — the stored state still moves forward so the draft's next save
   * overwrites the agent write (user drafts win until their save lands).
   */
  function subscribeToGatewayEvents(): void {
    if (!import.meta.client) return;
    const api = window.koneDesktop?.agent;
    if (!api) return;
    detachEvents = api.onEvent((event) => {
      if (event.type !== "scratchpad.updated") return;
      if (event.projectPath !== resolvePath()) return;
      if (storedRevision.value != null && event.revision <= storedRevision.value) return;
      void applyAgentWrite(event);
    });
  }

  async function applyAgentWrite(event: {
    scratchpadId: string;
    body: string;
    savedAt: number;
    revision: number;
    writer: ScratchpadWriter | null;
  }): Promise<void> {
    const html = await toPadHtml(event.body);
    const session = current();
    // Only touch the live editor when it holds no unsaved draft — otherwise
    // the user's typing wins and the agent write is replaced on next save.
    if (session && session.doc.value === storedBody.value) {
      session.doc.value = html;
      session.savedAt = event.savedAt;
      session.status = "ready";
    }
    if (event.scratchpadId) scratchpadId.value = event.scratchpadId;
    storedBody.value = html;
    storedRawBody.value = event.body;
    storedSavedAt.value = event.savedAt;
    storedRevision.value = event.revision;
    lastWriter.value = event.writer;
    sessions.value = [...sessions.value];
  }

  if (import.meta.client) {
    useEventListener(window, "beforeunload", () => {
      void flush();
    });
  }

  subscribeToGatewayEvents();

  onBeforeUnmount(() => {
    void flush();
    detachEvents?.();
    detachEvents = null;
  });

  return { sessions, open, close, append, hydrate, flush, lastWriter };
}

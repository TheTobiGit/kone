import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from "vue";
import { useDebounceFn, useEventListener } from "@vueuse/core";
import type { ScratchpadRecord } from "~/types/desktop";
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
  padId: string;
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
  const padId = ref("");
  const storedBody = ref("");
  const storedSavedAt = ref<number | null>(null);
  let saveDebounced: ReturnType<typeof useDebounceFn> | null = null;

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
    session.status = "saving";
    sessions.value = [...sessions.value];

    const payload = {
      padId: session.padId,
      projectPath,
      title: SCRATCHPAD_TITLE,
      body: session.doc.value,
    };

    const api = bridge();
    let savedAt: number | null = null;
    if (api) {
      const result = await api.save(payload);
      savedAt = result?.savedAt ?? Date.now();
    } else {
      const list = readLocal(projectPath);
      const idx = list.findIndex((r) => r.id === session.padId);
      const now = Date.now();
      const row: ScratchpadRecord = {
        id: session.padId,
        projectPath,
        title: payload.title,
        body: payload.body,
        createdAt: idx >= 0 ? list[idx]!.createdAt : now,
        updatedAt: now,
        sortIndex: idx >= 0 ? list[idx]!.sortIndex : list.length,
      };
      if (idx >= 0) list[idx] = row;
      else list.push(row);
      writeLocal(projectPath, list);
      savedAt = now;
    }

    session.savedAt = savedAt;
    session.status = "ready";
    storedBody.value = session.doc.value;
    storedSavedAt.value = savedAt;
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
      padId: padId.value,
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
      padId.value = uid();
      return;
    }
    padId.value = keep.id;
    storedBody.value = await toPadHtml(keep.body);
    storedSavedAt.value = keep.updatedAt ?? null;
    const stale = sorted.slice(1);
    if (stale.length) {
      if (api) {
        await Promise.all(stale.map((r) => api.delete({ padId: r.id })));
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

  if (import.meta.client) {
    useEventListener(window, "beforeunload", () => {
      void flush();
    });
  }

  onBeforeUnmount(() => {
    void flush();
  });

  return { sessions, open, close, append, hydrate, flush };
}

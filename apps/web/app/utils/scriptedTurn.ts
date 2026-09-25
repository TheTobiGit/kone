// The clock a scripted turn plays on — the dev bridge's canned replies and the
// Conversation settings preview both stream a turn at the pace a real provider
// does, and both have to be able to stop dead mid-sentence.

/** One word per tick: close to how fast a provider's deltas land. */
export const SCRIPTED_WORD_MS = 42;

/** Timers a script waits on, all of which `stop` strands at once. A stranded
 *  wait never resolves, so a script that was stopped simply goes no further. */
export function createScriptClock() {
  const pending = new Set<ReturnType<typeof setTimeout>>();

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        pending.delete(t);
        resolve();
      }, ms);
      pending.add(t);
    });
  }

  function stop(): void {
    for (const t of pending) clearTimeout(t);
    pending.clear();
  }

  return { wait, stop };
}

/** Grow `body` a word at a time, handing each longer prefix to `onText` and
 *  pausing between words. Whitespace is kept as written, so a markdown line
 *  break arrives as a line break. Resolves false as soon as `pause` answers
 *  false — the script has been cut off and the text is left where it stood. */
export async function streamWords(
  body: string,
  onText: (text: string) => void,
  pause: (ms: number) => Promise<boolean>,
  perWord = SCRIPTED_WORD_MS,
): Promise<boolean> {
  const words = body.split(/(\s+)/);
  let text = "";
  for (let i = 0; i < words.length; i += 2) {
    text += (words[i] ?? "") + (words[i + 1] ?? "");
    onText(text);
    if (!(await pause(perWord))) return false;
  }
  return true;
}

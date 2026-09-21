// One answer, worked out ahead of the question.
//
// A surface that can tell what it will be asked before it is asked — a composer
// holding a draft the user has stopped typing — can spend the wait on the
// answer instead of spending it after the send. This holds exactly one such
// answer: not a cache, because a cache would have to decide when an old answer
// is still good enough, and there is no honest answer to that. This one
// describes the precise question it was asked, and anything else asks again.

export type WarmedRoute<T> = {
  /** Ask ahead, after the debounce. Cheap to call on every keystroke. */
  warm: (request: string) => void;
  /** The answer to exactly this question, or null. Consumed: a warmed answer
   *  belongs to one asking, and the next one starts over. */
  take: (request: string) => Promise<T> | null;
  /** Forget the pending ask and the held answer. */
  clear: () => void;
};

export function createWarmedRoute<T>(o: {
  /** Ask for real. Called once per warm, with the request as given. */
  route: (request: string) => Promise<T>;
  /** Everything other than the request that the answer depends on, as one
   *  string. Read when the answer is stored and again when it is taken, so an
   *  answer worked out under conditions that have since changed is refused
   *  rather than trusted. */
  context: () => string;
  /** How long the request sits untouched before it is asked. */
  debounceMs: number;
  /** Re-asked when the debounce fires. The surface may have moved on in the
   *  meantime, and an answer nobody can use is worse than no answer — it is a
   *  call spent to produce one. */
  stillWanted?: (request: string) => boolean;
}): WarmedRoute<T> {
  /** A question is its words plus the conditions they were asked under. Built
   *  in one place so the store and the take can never spell it differently. */
  const keyFor = (request: string): string => `${request}\0${o.context()}`;

  let held: { key: string; promise: Promise<T> } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scheduledKey: string | null = null;

  function cancelPending(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    scheduledKey = null;
  }

  function warm(request: string): void {
    const key = keyFor(request);
    if (scheduledKey === key) return;
    // Anything else that was pending is about a question no longer being
    // asked. Dropped before the held answer is checked, so a timer for what
    // the user typed and then deleted can never land on top of the answer
    // they came back to.
    cancelPending();
    if (held?.key === key) return;
    scheduledKey = key;
    timer = setTimeout(() => {
      timer = null;
      scheduledKey = null;
      if (o.stillWanted && !o.stillWanted(request)) return;
      held = { key: keyFor(request), promise: o.route(request) };
    }, o.debounceMs);
  }

  function take(request: string): Promise<T> | null {
    const key = keyFor(request);
    cancelPending();
    const answer = held;
    held = null;
    return answer?.key === key ? answer.promise : null;
  }

  function clear(): void {
    cancelPending();
    held = null;
  }

  return { warm, take, clear };
}

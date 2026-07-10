export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

/**
 * Deep-clone JSON-safe data into a plain, non-reactive value.
 *
 * `structuredClone` throws `DataCloneError` on Vue reactive proxies, so it
 * cannot be used to snapshot reactive turn/thread state. Everything we persist
 * is already JSON-serialisable (strings, numbers, booleans, arrays, plain
 * objects), so a JSON round-trip is both safe and unwraps reactivity.
 */
export function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

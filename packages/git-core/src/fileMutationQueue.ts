import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<unknown>>();
let registrationQueue: Promise<void> = Promise.resolve();

function isAbsentPathError(error: Error): boolean {
  return (
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function getMutationQueueKey(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath);
  try {
    return await realpath(resolvedPath);
  } catch (error) {
    if (!(error instanceof Error) || !isAbsentPathError(error)) {
      throw error;
    }
  }

  // File is missing: canonicalize the parent so `/tmp/x` and the realpath of
  // `/tmp` (e.g. `/private/tmp/x` on macOS) still share a queue once created.
  try {
    const canonicalParent = await realpath(dirname(resolvedPath));
    return join(canonicalParent, basename(resolvedPath));
  } catch (error) {
    if (!(error instanceof Error) || !isAbsentPathError(error)) {
      throw error;
    }
    return resolvedPath;
  }
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 *
 * @param filePath - The target file path to serialize mutations for
 * @param fn - The async file mutation operation to execute
 * @returns The return value of fn()
 */
export async function withFileMutationQueue<T>(
  filePath: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const registration = registrationQueue.then(async () => {
    const key = await getMutationQueueKey(filePath);
    const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

    const { promise: nextQueue, resolve: releaseNext } = Promise.withResolvers<void>();
    const chainedQueue = currentQueue.then(
      () => nextQueue,
      () => nextQueue,
    );
    fileMutationQueues.set(key, chainedQueue);

    return { key, currentQueue, chainedQueue, releaseNext };
  });

  registrationQueue = registration.then(
    () => undefined,
    () => undefined,
  );

  const { key, currentQueue, chainedQueue, releaseNext } = await registration;
  await currentQueue;

  try {
    return await fn();
  } finally {
    releaseNext();
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key);
    }
  }
}

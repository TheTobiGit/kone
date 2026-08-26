import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { withFileMutationQueue } from "@kone/git-core";

// Atomic single-file writes for the desktop main process's JSON state.
//
// A plain `writeFileSync(target, …)` truncates the destination and writes the
// new bytes in place. If the process dies or the machine loses power partway
// through, the file is left torn: the reader on next boot either fails to
// parse it and silently falls back to defaults, or — worse — persists the
// half-written content as if it were real state. The three single-file stores
// that carry user-meaningful data (window geometry, per-provider install
// settings, the provider surface cache) all used to write that way, so a crash
// exactly at a write could forget a custom CLI path or a carefully arranged
// window, with no error anywhere to explain it.
//
// The fix is to never write the destination in place. Everything is written to
// a unique sibling temp file in the same directory, fsynced, and then moved
// over the destination with rename — which is atomic on the filesystem the
// file already lives on. A reader therefore sees either the complete old
// contents or the complete new contents, never a mix. The parent directory is
// fsynced after the rename (POSIX only) so the rename itself survives a power
// cut rather than being reordered away by the filesystem.
//
// Both a sync and an async variant are provided because the call sites are
// split across the two: window-state persists on the window `close` event
// where an async write could be abandoned by the process exiting, while the
// usage-scan cache already awaits its write on an async path.

/** Unique sibling temp path for `filePath`. Living in the same directory is
 *  what makes the final rename atomic — a cross-directory rename can copy. */
function tempPathFor(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

/** Best-effort fsync of a directory entry so a just-completed rename is
 *  durable. Unsupported on Windows (opening a directory as a file fails
 *  there), and never allowed to turn a successful write into a failure. */
function fsyncDirectorySync(dirPath: string): void {
  if (process.platform === "win32") return;
  let fd: number | undefined;
  try {
    fd = fs.openSync(dirPath, "r");
    fs.fsyncSync(fd);
  } catch {
    // The rename already happened; a failed dir fsync only widens the crash
    // window the rename itself can be lost in — the file contents are intact.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* closing best-effort */
      }
    }
  }
}

/** Atomically replace (or create) `filePath` with `contents`. Throws on
 *  failure; the destination keeps its previous contents in that case. Callers
 *  that treat persistence as best-effort wrap this in try/catch, exactly as
 *  they did the in-place write it replaces. */
export function writeFileAtomicSync(filePath: string, contents: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = tempPathFor(filePath);
  let fd: number | undefined;
  try {
    // O_EXCL: never clobber a temp file that happens to exist — that would be
    // another writer's in-flight bytes, and overwriting them mid-flight is the
    // exact torn-write this exists to prevent.
    fd = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    );
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
    fsyncDirectorySync(path.dirname(filePath));
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* closing best-effort */
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* a leftover temp is orphan-eligible, never fatal */
    }
    throw err;
  }
}

/** Async counterpart of {@link writeFileAtomicSync} for call sites that
 *  already await their persistence. */
export async function writeFileAtomic(filePath: string, contents: string | Uint8Array): Promise<void> {
  return withFileMutationQueue(filePath, async () => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = tempPathFor(filePath);
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(
        tempPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      );
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.promises.rename(tempPath, filePath);
      fsyncDirectorySync(path.dirname(filePath));
    } catch (err) {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          /* closing best-effort */
        }
      }
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        /* a leftover temp is orphan-eligible, never fatal */
      }
      throw err;
    }
  });
}

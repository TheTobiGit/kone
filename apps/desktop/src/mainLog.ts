import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";

/** The main process's console, copied to a file under the app's user-data
 *  dir. Nothing else keeps it: a packaged app has no terminal, so an error a
 *  provider session died on — or a send that failed — was printed nowhere
 *  anyone could read it afterwards. */

/** The file grows to this, then moves aside to `main.log.1` (replacing the
 *  one before it) and starts over: at most twice this on disk. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

const LEVELS = ["log", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

type ConsoleLike = Pick<Console, Level>;

export type MainLogOptions = {
  /** The directory the log lives in; made if missing. */
  dir: string;
  /** The console to copy. Defaults to the process's own. */
  target?: ConsoleLike;
  maxBytes?: number;
};

/** Copy every console line to `<dir>/main.log`, stamped with the time and its
 *  level, as well as printing it. Writes are synchronous, so the last line
 *  before a crash is on disk. A log that can't be written is given up on
 *  quietly — the console still works, and logging never takes the app down.
 *  Returns the undo, which puts the console back as it was. */
export function installMainLog(options: MainLogOptions): () => void {
  const target = options.target ?? console;
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
  const file = path.join(options.dir, "main.log");
  let size = 0;
  let broken = false;
  try {
    fs.mkdirSync(options.dir, { recursive: true });
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch {
    broken = true;
  }

  const write = (level: Level, args: unknown[]): void => {
    if (broken) return;
    const line = `${new Date().toISOString()} [${level}] ${format(...args)}\n`;
    const bytes = Buffer.byteLength(line);
    try {
      if (size > 0 && size + bytes > maxBytes) {
        fs.renameSync(file, `${file}.1`);
        size = 0;
      }
      fs.appendFileSync(file, line);
      size += bytes;
    } catch {
      broken = true;
    }
  };

  const originals = LEVELS.map((level) => [level, target[level]] as const);
  for (const [level, original] of originals) {
    target[level] = (...args: unknown[]): void => {
      original.apply(target, args);
      write(level, args);
    };
  }
  return () => {
    for (const [level, original] of originals) target[level] = original;
  };
}

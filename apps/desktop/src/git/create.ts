import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { GitError, exists, git, lastStderrLine, run } from "./core.js";
import type { CreateProjectOptions, CreateProjectResult } from "./types.js";

// The counterpart to clone: instead of pulling a repo down, we lay a fresh
// folder on disk and (optionally) turn it into a git repo. Small, seeded files
// (`README.md`, `.gitignore`) give the first `git status` something to show, and
// when a git identity is configured we land an initial commit so the project
// opens on a real branch rather than an unborn one.

/** Built-in `.gitignore` seeds, keyed by the chip the UI offers. Deliberately
 *  tiny — a sensible starting point, not an exhaustive template. */
const GITIGNORE_TEMPLATES: Record<string, string> = {
  node: [
    "node_modules/",
    "dist/",
    "build/",
    ".env",
    ".env.*",
    ".DS_Store",
    "*.log",
    "",
  ].join("\n"),
};

/** Reject names that aren't a single, safe path segment before we touch disk. */
function isSafeSegment(name: string): boolean {
  if (!name || name === "." || name === "..") return false;
  return !/[/\\\0]/.test(name);
}

/** Whether a git identity is configured, so `git commit` won't fail on us. */
async function hasGitIdentity(cwd: string): Promise<boolean> {
  try {
    const email = (await git(cwd, ["config", "user.email"])).trim();
    return email.length > 0;
  } catch {
    return false;
  }
}

/** Run a user-supplied setup command inside the new project folder — the same
 *  trust boundary as a terminal the user opened there themselves. Runs through
 *  the shell so scaffolders with args (e.g. `npm create vite@latest .`) work,
 *  and rejects (GitError) with the command's own last stderr line on failure. */
function runSetupCommand(cwd: string, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env },
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (buf: Buffer) => {
      stderr += buf.toString();
    });
    child.on("error", (error) => reject(new GitError(error.message, null)));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new GitError(
            lastStderrLine(stderr, `Command exited with code ${code}`),
            code,
          ),
        );
      }
    });
  });
}

/** Create a repository on GitHub from the folder and push to it, via the `gh`
 *  CLI (which carries the user's own auth). Rejects (GitError) with a friendly
 *  message when `gh` is missing or the create fails. Requires the folder to be
 *  a git repo with at least one commit. */
async function createRemote(
  cwd: string,
  repoName: string,
  visibility: "public" | "private",
): Promise<void> {
  try {
    await run(
      "gh",
      [
        "repo",
        "create",
        repoName,
        `--${visibility}`,
        "--source=.",
        "--remote=origin",
        "--push",
      ],
      { cwd, env: { ...process.env }, timeout: 60_000, windowsHide: true },
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") {
      throw new GitError(
        "GitHub CLI (gh) not found — install it to create a remote repo",
        null,
      );
    }
    const message = lastStderrLine(
      err.stderr ?? "",
      err.message || "Couldn’t create the GitHub repository",
    );
    throw new GitError(message, null);
  }
}

/** Create a new project folder under `parent`, optionally initializing git.
 *  Resolves with the created folder; rejects (GitError) if the name is unsafe,
 *  the target already exists, or a filesystem/git step fails. */
export async function createProject(
  opts: CreateProjectOptions,
): Promise<CreateProjectResult> {
  const { parent, name, readme } = opts;
  // A remote repo needs a local one, so requesting a remote forces git on.
  const initGit = Boolean(opts.git) || Boolean(opts.remote);
  if (!isSafeSegment(name)) {
    throw new GitError(`"${name}" isn't a valid folder name`, null);
  }

  const target = path.resolve(parent, name);
  if (await exists(target)) {
    throw new GitError(`A folder already exists at ${target}`, null);
  }

  try {
    await mkdir(target, { recursive: true });
  } catch (error) {
    throw new GitError((error as Error).message, null);
  }

  // A setup command runs first, on the still-empty folder — scaffolders expect
  // that. It may lay down (or generate) files the steps below then respect.
  const command = opts.command?.trim();
  if (command) {
    await runSetupCommand(target, command);
  }

  // Seed files, but never clobber anything the command already produced.
  if (readme && !(await exists(path.join(target, "README.md")))) {
    await writeFile(path.join(target, "README.md"), `# ${name}\n`, "utf8");
  }
  const template = opts.gitignore
    ? GITIGNORE_TEMPLATES[opts.gitignore.toLowerCase()]
    : undefined;
  if (template && !(await exists(path.join(target, ".gitignore")))) {
    await writeFile(path.join(target, ".gitignore"), template, "utf8");
  }

  // A scaffolder may have already initialized git; only init when it didn't.
  if (initGit && !(await exists(path.join(target, ".git")))) {
    const branch = opts.branch?.trim() || "main";
    // `git init -b` sets the initial branch in one shot; on an older git that
    // doesn't know the flag, init plain and point HEAD at the branch by hand.
    try {
      await git(target, ["init", "-b", branch]);
    } catch {
      await git(target, ["init"]);
      await git(target, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    }
    // Land an initial commit only when we won't trip over a missing identity —
    // otherwise leave the seeds staged on an unborn branch, which is still a
    // valid repo the app can open. Staging and the identity probe are
    // independent, so run them together.
    try {
      const [, hasIdentity] = await Promise.all([
        git(target, ["add", "-A"]),
        hasGitIdentity(target),
      ]);
      if (hasIdentity) {
        await git(target, ["commit", "-m", "Initial commit", "--allow-empty"]);
      }
    } catch {
      // A failed stage/commit shouldn't sink the whole creation — the folder
      // (and its repo) exist; the user can commit themselves.
    }
  }

  // Create + push the remote last, once there's a repo with a commit to push.
  // A failure here surfaces to the UI, but the local folder/repo already exist.
  if (opts.remote) {
    await createRemote(
      target,
      opts.repoName?.trim() || name,
      opts.visibility === "public" ? "public" : "private",
    );
  }

  return { root: target, name };
}

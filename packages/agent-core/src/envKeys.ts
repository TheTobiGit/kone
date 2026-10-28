// Environment objects are plain records, but Windows treats variable names
// case-insensitively while Node still has to choose one key to pass to a
// child. Every place kone overlays or strips a child variable has to make that
// same choice, so the rule lives here instead of being restated per caller.

/** The key Node passes for `name` on Windows. It sorts the keys and keeps the
 *  first per case-insensitive name; undefined when the variable is absent
 *  under every casing. */
export function windowsEnvKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toUpperCase();
  return Object.keys(env)
    .sort()
    .find((key) => key.toUpperCase() === wanted);
}

/** The key to read or write for `name`. POSIX env is case-sensitive, so the
 *  exact name is the key. On Windows an existing key keeps the casing Node
 *  would pass to the child; a new variable uses `name` as written. */
export function envKeyFor(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return name;
  return windowsEnvKey(env, name) ?? name;
}

/** The value of `name`, read from the key Node would pass to the child. */
export function envValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return env[envKeyFor(env, name, platform)];
}

/** Whether `key` is `name` under the platform's case rules. */
export function envKeyMatches(
  key: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" ? key.toUpperCase() === name.toUpperCase() : key === name;
}

/** Remove `name`. On Windows every casing goes, so an overlay cannot leave a
 *  second copy for the child to pick; POSIX removes exactly the named key. */
export function deleteEnvVar(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") {
    delete env[name];
    return;
  }
  for (const key of Object.keys(env)) {
    if (envKeyMatches(key, name, platform)) delete env[key];
  }
}

/** Replace `name` with `value`. On Windows this keeps exactly one casing — the
 *  one Node would have passed, or `name` for a new variable — so an override
 *  replaces an inherited `Path` instead of sitting beside it. */
export function setEnvVar(
  env: NodeJS.ProcessEnv,
  name: string,
  value: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") {
    env[name] = value;
    return;
  }
  const key = envKeyFor(env, name, platform);
  deleteEnvVar(env, name, platform);
  env[key] = value;
}

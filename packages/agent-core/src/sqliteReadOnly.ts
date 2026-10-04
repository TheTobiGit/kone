import { DatabaseSync } from "./sqlite.js";

// Opening a database read-only, as its own module: the two drivers spell the
// option differently (`readOnly` here, `readonly` under the test runner), so
// the test setup replaces this one function rather than the driver seam every
// store test already stubs.

export function openDatabaseReadOnly(filePath: string): DatabaseSync {
  return new DatabaseSync(filePath, { readOnly: true });
}

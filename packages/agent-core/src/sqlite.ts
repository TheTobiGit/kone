// The one place the agent layer names its SQLite driver.
//
// `node:sqlite` is a built-in of the Node runtime Electron ships, and nothing
// about it is wrong at runtime. It is unresolvable under the test runner
// though, which has no such builtin and fails while *transpiling* the import —
// before any test body runs, so a single store import kills every test in the
// file rather than failing one assertion. A stub can't be swapped in at that
// point either: module mocking replaces a module that resolves, it can't invent
// a resolution for a builtin the runtime has never heard of, and `node:`
// specifiers are resolved ahead of any resolver plugin.
//
// Routing every importer through this module gives that swap somewhere to
// happen — a plain relative module the test runner can resolve and replace,
// while the shipped app still gets the real builtin.
export { DatabaseSync, type StatementSync } from "node:sqlite";

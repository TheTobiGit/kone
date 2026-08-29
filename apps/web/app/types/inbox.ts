/** Which list the inbox is showing. Places, not filters: each view is a
 *  disjoint set of threads rather than a subset of one list being sieved in the
 *  renderer, so switching swaps what there is rather than narrowing it. */
export type InboxViewId = "inbox" | "archived" | "done";

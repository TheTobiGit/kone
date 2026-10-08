// Who may read a thread's history. The gateway's read tools (search, and later
// app_read_thread) must not turn "read any thread by id" into a cross-project
// leak. The rule:
//
//   - a thread always reads itself;
//   - same-project threads read each other (the common case);
//   - a forked thread and its SOURCE read each other across projects — the
//     fork's whole point is on-demand history reads of where it came from, and
//     a handoff note tells the receiver to read the source thread;
//   - anything else needs a reference the user attached to this caller.
//
// Pure and injectable so both the tool and its tests share one rule.

export interface ReadScopeThread {
  projectPath: string;
  /** The thread this one was forked from (threads.source_thread_id), if any. */
  sourceThreadId?: string | null;
}

export interface ReadScopeInput {
  callerThreadId: string;
  targetThreadId: string;
  caller: ReadScopeThread | null;
  target: ReadScopeThread | null;
  /** Thread ids the user attached to the caller (a reference chip). */
  attachedReferences?: ReadonlySet<string>;
}

export function canReadThread(input: ReadScopeInput): boolean {
  if (input.callerThreadId === input.targetThreadId) return true;
  if (!input.target) return false;
  if (input.caller && input.caller.projectPath === input.target.projectPath) return true;
  // Fork lineage reads either way: a fork reads its source, and a source reads
  // the forks it spawned (the "read what it produced" direction).
  if (input.caller?.sourceThreadId === input.targetThreadId) return true;
  if (input.target.sourceThreadId === input.callerThreadId) return true;
  if (input.attachedReferences?.has(input.targetThreadId)) return true;
  return false;
}

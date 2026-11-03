# Overview git reads

`GitService` is the single, injected boundary for snapshots and file details.
`NativeGit` uses the bounded process runner in `repo.rs`; recents and Overview
share its NUL-delimited numstat parser. Existing tile total policies remain
independent of Overview's totals over unique changed paths.

Call the trait only on a background executor. Each operation has a shared
three-second deadline and a project-owned cancellation flag. Dropping the
project cancels in-flight git process groups. Git output is capped at 8 MiB
for snapshots and 512 KiB for diffs. File previews read regular files only,
without following the final symlink, and cap rendered content at 4000 lines.
Untracked line counts retain the 512 KiB file cap without the preview line cap.
Failures and exceeded limits remain errors, never clean snapshots.

The project view refreshes every five seconds while focused, drops stale
results by generation, and only redraws changed snapshots. File-detail refreshes
preserve source/wrap preferences and scroll. The trait carries native Rust data,
with no RPC client or background runtime dependency. A future backend can replace
`NativeGit` at the shell's injection point.

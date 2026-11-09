# Rune app (in progress)

Run `bun run --cwd apps/rune/sidecar build` and `cargo run -p kone-rune --release`. The sidecar uses an isolated Rune data directory; do not point it at an active Electron data directory. The Rune port is incomplete and does not yet have visual or feature parity.

On macOS, `apps/rune/scripts/package-macos.sh` builds `apps/rune/dist/Kone Rune.app` for the host architecture. It downloads the official standalone Node archive and checks its published SHA-256, bundles the agent SDK, native dependencies, and gateway proxy. Bun, Rust, curl, and internet access are needed to build. The app is unsigned and is not a distribution-ready release. `KONE_NODE_VERSION` overrides the Node version and `KONE_BUN_BIN` selects Bun.

The sidecar accepts newline-delimited JSON-RPC 2.0 requests with an ID and object params over stdin, and emits replies and event notifications over stdout. `KONE_RUNE_DATA_DIR` must be an absolute isolated directory. `projects.overview` returns repository metadata and working tree status; `history.list`, `history.latest`, `history.thread`, and `history.page` expose stored conversation data. Pin, done, visited and archive changes use `history.setPinned`, `history.setDone`, `history.setVisited`, and `history.archive`. Clone progress notifications carry the originating request ID.

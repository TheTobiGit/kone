# kone

This project was created with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack), a modern TypeScript stack that combines Nuxt, and more.

## Session Context & UI Specifications

We are demoing a new minimal, highly interactive design system for the agent app (research redesign).
- **research Location**: In the developer folder sibling to this project root: `/Users/gideonsarfo/Developer/research`.
- **Core Layout**: Clean, borderless, background-less centered textarea input for typing prompts.
- **Color Theme**: Clean responsive switching between light mode (`#fafafa`) and dark mode (`#070708`).
- **Typing Action**: Focuses automatically on keyboard input; automatically scales font size and shifts line-breaks cleanly.
- **Submission Action**: Pressing `Enter` automatically moves the prompt container to the top (`top-12`) via custom cubic-bezier animations.
- **Response Action**: Simulated response texts appear blockwise using `<SplitText>` components for clean float and fade-in animations.

## Features

- **TypeScript** - For type safety and improved developer experience
- **Nuxt** - The Intuitive Vue Framework
- **TailwindCSS** - Utility-first CSS for rapid UI development
- **Turborepo** - Optimized monorepo build system
- **Electron** - Desktop shell for the same Nuxt renderer and local Droid bridge

## Getting Started

First, install the dependencies:

```bash
bun install
```

### Web development

Run the web app and bridge in separate terminals:

```bash
bun run dev:web
bun run dev:bridge
```

Open [http://localhost:3001](http://localhost:3001) in your browser.

### Desktop development

`dev:desktop` orchestrates the Bun bridge, Nuxt dev server, and Electron:

```bash
bun run dev:desktop
```

Electron loads `http://localhost:3001` with `KONE_DESKTOP=1`. The bridge WebSocket stays on `ws://localhost:8787`.

## Project Structure

```
kone/
├── apps/
│   ├── web/         # Nuxt renderer (web + desktop UI)
│   ├── bridge/      # Bun WebSocket bridge to @factory/droid-sdk
│   └── desktop/     # Electron main/preload and packaging
├── packages/
│   ├── bridge-protocol/  # Shared WS message types and defaults
│   └── env/              # Env validation helpers
```

## Available Scripts

- `bun run dev`: Start all applications in development mode
- `bun run build`: Build all applications
- `bun run dev:web`: Start only the web application
- `bun run dev:bridge`: Start only the Droid bridge
- `bun run dev:desktop`: Start bridge + Nuxt + Electron for desktop dev
- `bun run build:desktop`: Build static Nuxt renderer and Electron main process
- `bun run package:desktop`: Create unpackaged desktop artifacts via electron-builder
- `bun run check-types`: Check TypeScript types across all apps

## Desktop build and packaging

Production desktop builds:

1. Generate a static Nuxt SPA (`apps/web` with `KONE_DESKTOP=1`)
2. Compile Electron `main` and `preload`
3. Stage renderer assets and bridge runtime under `apps/desktop/resources/`
4. Optionally compile the bridge with `bun build --compile` (falls back to requiring Bun on PATH)

```bash
bun run build:desktop
bun run package:desktop
```

Packaged output is written to `apps/desktop/release/`.

## Environment variables

| Variable | Used by | Description |
| --- | --- | --- |
| `FACTORY_API_KEY` | bridge | Factory/Droid API key |
| `KONE_CWD` | bridge | Working directory for Droid sessions (defaults to `process.cwd()` or user home in packaged desktop) |
| `KONE_DESKTOP=1` | web | Enables SPA/static desktop renderer mode |
| `NUXT_DESKTOP=1` | web | Alias for `KONE_DESKTOP` |
| `NUXT_PUBLIC_BRIDGE_WS_URL` | web | Override bridge WebSocket URL (default `ws://localhost:8787`) |
| `KONE_DEV=1` | desktop | Load renderer from dev server instead of `app://` protocol |
| `KONE_DEV_SERVER_URL` | desktop | Dev renderer URL (default `http://localhost:3001`) |

The desktop preload exposes `window.koneDesktop.bridgeWsUrl` so the renderer can connect without hardcoding Electron details in UI components.

## Known limitations (first milestone)

- No auto-update, code signing, or notarization
- Packaged bridge may require Bun on PATH if `bun build --compile` fails for `@factory/droid-sdk` (compile succeeded on macOS arm64 during validation)
- Bridge remains localhost WebSocket only (not in-process in Electron main)
- Desktop packaging targets unpacked directories (`--dir`), not full installers

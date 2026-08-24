# kone

A minimal monorepo starter with a Nuxt renderer that runs both on the web and inside an
Electron desktop shell.

## Features

- **TypeScript** - For type safety and improved developer experience
- **Nuxt** - The Intuitive Vue Framework
- **TailwindCSS** - Utility-first CSS for rapid UI development
- **Motion Vue** - Declarative animations (`motion-v`)
- **VueUse** - Composition-API utilities (`@vueuse/core`)
- **Turborepo** - Optimized monorepo build system
- **Electron** - Desktop shell for the same Nuxt renderer

## Getting Started

First, install the dependencies:

```bash
bun install
```

### Web development

```bash
bun run dev:web
```

Open [http://localhost:3001](http://localhost:3001) in your browser.

### Desktop development

`dev:desktop` orchestrates the Nuxt dev server and Electron:

```bash
bun run dev:desktop
```

Electron loads `http://localhost:3001` with `KONE_DESKTOP=1`.

## Project Structure

```
kone/
├── apps/
│   ├── web/         # Nuxt renderer (web + desktop UI)
│   └── desktop/     # Electron shell: main/preload at src root,
│                    #   src/lib/ = pure utilities, src/modules/ = IPC domains,
│                    #   src/agent/ = provider adapters, gateway, quota, usage
├── packages/
│   ├── config/      # Shared TypeScript config
│   └── protocol/    # Contracts shared by renderer & main (IPC error kinds,
│                    #   plan-task types/parsers) — environment-agnostic only
└── tools/
    └── oxlint/      # Custom lint rules
```

Anything imported by both apps belongs in `@kone/protocol`; keep it free of
electron/DOM/node builtins so both sides can consume it directly.

## Available Scripts

- `bun run dev`: Start all applications in development mode
- `bun run build`: Build all applications
- `bun run dev:web`: Start only the web application
- `bun run dev:desktop`: Start Nuxt + Electron for desktop dev
- `bun run build:desktop`: Build static Nuxt renderer and Electron main process
- `bun run package:desktop`: Create unpackaged desktop artifacts via electron-builder
- `bun run check-types`: Check TypeScript types across all apps

## Desktop build and packaging

Production desktop builds:

1. Generate a static Nuxt SPA (`apps/web` with `KONE_DESKTOP=1`)
2. Compile Electron `main` and `preload`
3. Stage renderer assets under `apps/desktop/resources/`

```bash
bun run build:desktop
bun run package:desktop
```

Packaged output is written to `apps/desktop/release/`.

## Environment variables

| Variable | Used by | Description |
| --- | --- | --- |
| `KONE_DESKTOP=1` | web | Enables SPA/static desktop renderer mode |
| `NUXT_DESKTOP=1` | web | Alias for `KONE_DESKTOP` |
| `KONE_DEV=1` | desktop | Load renderer from dev server instead of `app://` protocol |
| `KONE_DEV_SERVER_URL` | desktop | Dev renderer URL (default `http://localhost:3001`) |

The desktop preload exposes `window.koneDesktop` so the renderer can detect the Electron shell.

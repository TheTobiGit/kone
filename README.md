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

## Getting Started

First, install the dependencies:

```bash
bun install
```

Then, run the development server:

```bash
bun run dev
```

Open [http://localhost:3001](http://localhost:3001) in your browser to see the web application.

## Project Structure

```
kone/
├── apps/
│   ├── web/         # Frontend application (Nuxt)
```

## Available Scripts

- `bun run dev`: Start all applications in development mode
- `bun run build`: Build all applications
- `bun run dev:web`: Start only the web application
- `bun run check-types`: Check TypeScript types across all apps

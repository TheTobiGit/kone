# Third-party notices

Kone builds on the work of the open-source projects credited below. Each entry
identifies adapted material and implementation references, and includes the
upstream licence or applicable notice.

## T3 Code (t3code) — selected integration helpers

Upstream: https://github.com/pingdotgg/t3code
License: https://github.com/pingdotgg/t3code/blob/main/LICENSE

Adapted material:

- `packages/agent-core/src/antigravityAcpProfile.ts`: the browser-launch
  interception helper that captures authentication URLs, and selected launch
  environment filtering/setup, adapted from upstream
  `apps/server/src/provider/antigravityAuthSupport.ts`.
- `packages/agent-core/src/antigravityRelease.ts`: the pinned release manifest
  structure and asset-resolution helper, adapted from upstream
  `apps/server/src/provider/antigravityRelease.ts`.
- `apps/desktop/scripts/dev.ts`: the Linux development launcher check for the
  ownership and permissions of Electron's `chrome-sandbox`, and its conditional
  launch argument, adapted from upstream
  `apps/desktop/scripts/electron-launcher.mjs`.

Documented implementation references:

- `packages/git-core/src/processTree.ts`: process-tree discovery and descendant
  termination helpers were informed by implementations in both T3 Code and
  Synara.
- `packages/agent-core/src/store/ConversationDb.ts`: the 200-entry prepared
  statement cache budget was chosen with both projects as references.

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Synara — side-chat context and theme palette

Upstream: https://github.com/Emanuele-web04/synara
License: https://github.com/Emanuele-web04/synara/blob/main/LICENSE

Adapted material:

- `packages/agent-core/src/sidechat.ts`: the side-chat boundary instruction
  matches upstream `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`.
  The original portable transcript bootstrap also adapted the framing and
  selection policy in upstream `apps/server/src/orchestration/handoff.ts`:
  six recent messages, 2,400-character recent excerpts, 320-character earlier
  excerpts, and a 32,000-character history budget.
- `apps/web/app/theme/themes/synara.ts`: the named Synara theme adapts its
  light/dark surface, text, accent, diff, and skill palette from upstream
  `apps/web/src/theme/theme.seed.generated.ts`.

Documented implementation references:

- `packages/agent-core/src/store/itemTextChunks.ts`: the append-only text chunk
  approach was informed by upstream `apps/server/src/persistence/messageTextChunks.ts`,
  as recorded in `docs/archive/conversation-features-plan.md`.
- `packages/agent-core/src/store/ConversationDb.ts`: Synara informed SQLite
  page-cache/mmap sizing and, together with T3 Code, the prepared statement
  cache budget.
- `packages/git-core/src/processTree.ts`: process-tree discovery and descendant
  termination helpers were informed by implementations in both projects.

```
MIT License

Copyright (c) 2026 T3 Tools Inc.
Copyright (c) 2026 Emanuele Di Pietro

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## oh-my-pi (omp) — bundled agent prompts

Upstream: https://github.com/can1357/oh-my-pi

The standing instructions of the native preset sub-agents are adapted from the
bundled agent definitions of the oh-my-pi coding agent (scout, reviewer,
security-reviewer, librarian, task): same roles, criteria, procedures and
read-only constraints, restated for the sub-agent threads kone spawns. omp's
latest release removed the librarian definition; the text here derives from its
last revision in the upstream repository's history.

Derived files:

- `packages/protocol/src/subagentPresets.ts`

```
MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## bloub

Upstream: https://github.com/jeremy-prt/bloub

Derived files:

- `apps/web/app/utils/sphereFace.ts`
- `apps/web/app/components/SphereFace.vue`

```
MIT License

Copyright (c) 2026 Jérémy Perret

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## DiceBear — Thumbs

Upstream: https://github.com/dicebear/dicebear

Thread agent faces are generated at runtime by `@dicebear/core` and
`@dicebear/collection` (both MIT) using the *Thumbs* style. No DiceBear artwork
is vendored into this repository; the SVG is built from the style's own
geometry, with kone's palette substituted for the shipped one.

Consuming code:

- `apps/web/app/utils/agentIdentity.ts`
- `apps/web/app/components/AgentFace.vue`

The Thumbs artwork itself is dedicated to the public domain by its author
(DiceBear) under CC0 1.0, so the generated faces carry no attribution
requirement:

```
CC0 1.0 Universal

The person who associated a work with this deed has dedicated the work to the
public domain by waiving all of his or her rights to the work worldwide under
copyright law, including all related and neighboring rights, to the extent
allowed by law.

You can copy, modify, distribute and perform the work, even for commercial
purposes, all without asking permission.

https://creativecommons.org/publicdomain/zero/1.0/
```

## thinking-orbs

Upstream: https://github.com/Jakubantalik/thinking-orbs

Derived files and consuming code:

- `apps/web/app/utils/toolOrb/`
- `apps/web/app/utils/thinkingOrb/`
- `apps/web/app/components/turn/TurnOrb.vue`
- `apps/web/app/components/orb/ParticleOrb.vue`

```
MIT License

Copyright (c) 2026 Jakub Antalik

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## thinking-logos

Upstream: https://github.com/enesozturk/thinking-logos
Playground: https://thinking-logos.ozturkenes.com/

Derived files and consuming code:

- `apps/web/app/utils/thinkingLogo/`
- `apps/web/app/components/turn/ThinkingLogo.vue`

```
MIT License

Copyright (c) 2026 Jakub Antalik (thinking-orbs, the engine)
Copyright (c) 2026 Enes Ozturk (thinking-logo, the logo baking and logo modes)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Cuelume

Upstream: https://github.com/danielwh2/cuelume
Site: https://cuelume.dev/

Every interface sound is synthesized at runtime by the `cuelume` package; no
audio files ship with kone.

Consuming code:

- `apps/web/app/composables/useSound.ts`

```
MIT License

Copyright (c) 2026 Daniel Belyi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

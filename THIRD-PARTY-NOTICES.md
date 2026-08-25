# Third-party notices

Portions of this repository are derived from third-party work. Each entry below
names the files that carry the derivation and reproduces the upstream licence.

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

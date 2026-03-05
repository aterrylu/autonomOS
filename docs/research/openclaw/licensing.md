# OpenClaw — Licensing Analysis

## License

**MIT License** — Copyright (c) 2025 Peter Steinberger

### Full Text

```
MIT License

Copyright (c) 2025 Peter Steinberger

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

## Commercial Implications

### What MIT Allows

| Right | Allowed? | Notes |
|-------|----------|-------|
| Commercial use | Yes | No restrictions |
| Modification | Yes | Can modify freely |
| Distribution | Yes | Can distribute source and binaries |
| Sublicensing | Yes | Can sublicense under different terms |
| Private use | Yes | No disclosure requirement |
| Creating proprietary derivatives | Yes | Can build closed-source on top |

### Obligations

1. **Include license text** in copies/distributions
2. **Include copyright notice** ("Copyright (c) 2025 Peter Steinberger")
3. **No warranty** — provided "as-is"

### What This Means for autonomOS

1. **We can use OpenClaw commercially** without any restrictions
2. **We can build proprietary tools on top** — our dashboard, plugins, integrations
3. **We can modify OpenClaw** if needed (fork) without license issues
4. **We can distribute** our OpenClaw-integrated product commercially
5. **Only requirement:** include the MIT license notice somewhere in our distribution

## Additional Files

- **No NOTICE file** — no additional attribution requirements
- **No PATENTS file** — no patent grant or restriction
- **SECURITY.md** — addresses trust model, doesn't modify license
- **CONTRIBUTING.md** — contribution workflow, doesn't introduce CLA or license changes

## Comparison with dimensionalOS

| Aspect | OpenClaw | dimensionalOS (dimos) | roboclaw |
|--------|----------|----------------------|----------|
| License | MIT | Apache 2.0 | **No license** |
| Commercial use | Yes | Yes (with conditions) | Unknown |
| Patent grant | None stated | Explicit grant | None |
| Attribution | Copyright notice only | NOTICE file required | N/A |
| Modification | Unrestricted | Must state changes | N/A |

**Key difference:** MIT is simpler — just include the notice. Apache 2.0 has additional requirements (NOTICE file, state changes, patent grant). Both are commercially friendly.

## Takeaway for autonomOS

**No licensing concerns.** MIT is the most permissive mainstream license. We can:
- Build autonomOS as a commercial product using OpenClaw
- Create and sell OpenClaw plugins
- Fork OpenClaw if we ever need to diverge
- Bundle OpenClaw in our distribution

The only obligation is including the copyright notice and license text, which is trivial.

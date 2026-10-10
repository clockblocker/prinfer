---
"prinfer": minor
---

Type costs are much faster to count in a test suite, with the same numbers. `inferredTypeCost(file, { names: [...] })` returns costs by name and `{ targets: [...] }` costs in order, from one load of the file. Every count still gets a new checker, so a batch counts exactly what single calls do.

What changed underneath, on every TypeScript 6 surface: programs for different files of one project now share the files they have parsed, so loading a second file of a project no longer parses the project and its libraries again (about 300 ms per file down to 30–70 ms on prinfer's own source). Each program keeps its own checker, so printed types are unchanged. A count is kept while no file changes, so the same target counted twice (by `include_cost` and `inferredTypeCost`, or two tests) is counted once, and `inferredTypeCost` no longer resolves the type on the shared checker before counting it. On prinfer's own source, costing 17 targets across 6 files went from 2.9–3.3 s to 1.5–1.8 s, and costing them all again from 0.5 s to 30 ms.

The README now says how far TypeScript 6 and TypeScript 7 instantiation counts diverge (within 2% on most measured declarations, up to 17% for a recursive path type), and when to call `closeTestingSessions`: once per run, if at all, since each call makes the next TypeScript 7 call start and load a new compiler.

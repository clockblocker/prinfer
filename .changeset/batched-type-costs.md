---
"prinfer": minor
---

`inferredTypeCost` counts several targets of one file in one call: `{ names: [...] }` returns costs by name, `{ targets: [...] }` costs in order. Only `project`, `compiler`, and `strict` go next to them. Every count still gets a fresh checker, so a batch returns exactly what single calls would.

Type costs are also faster to count everywhere, with the same numbers. TypeScript 6 programs for different files of one project now share their parsed files, so loading a second file no longer parses the project and its libraries again (about 300 ms down to 30 to 70 ms per file on prinfer's own source), and a target that is counted again while no file has changed is not recounted. Printed types are unchanged: each program keeps its own checker. On prinfer's own source, costing 17 targets across 6 files went from about 3 s to 1.6 s, and costing them again from 0.5 s to 30 ms.

---
"prinfer": minor
---

Print and count with the project's own compilers. A new `compiler` option (`"bundled"`, the default; `"project"`; `"auto"`) in the library options and the `prinfer/testing` selectors, `--compiler` on the CLI, and `PRINFER_COMPILER` for every surface including the MCP server selects them. `"project"` resolves `typescript` (5.0 to 6.x) for the TypeScript 6 backend, and `typescript` 7 or `@typescript/native-preview` (7.0.0-dev.20260624.1 or later) for the TypeScript 7 backend, from the file's tsconfig directory, and runs that package's own API client and compiler binary. It throws with the package, version, and path when the project's compiler is missing or unsupported; `"auto"` falls back to the bundled one.

Every result reports the compiler that produced it as `compiler: { name, version, source }`: a non-enumerable property on library and testing results, so snapshots and equality checks don't change, and a field of `result` in the CLI's `--json` output and the MCP tools' structured content. Cost lines name the compiler that counted.

`@typescript/native` is now loaded only when a TypeScript 7 call needs it, and the package no longer ships sourcemaps (3.5 MiB smaller).

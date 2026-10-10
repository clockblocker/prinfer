---
"prinfer": minor
---

Print and count with the project's own TypeScript. The new `compiler` option picks the compilers: `"bundled"` (default, prinfer's own TypeScript 6 and 7, as before), `"project"`, or `"auto"` (the project's when supported, else bundled). Set it in the library options and `prinfer/testing` selectors, with `--compiler` on the CLI, or with `PRINFER_COMPILER` on every surface, including the MCP server.

`"project"` resolves `typescript` 5.0 to 6.x for the TypeScript 6 backend, and `typescript` 7 or `@typescript/native-preview` 7.0.0-dev.20260624.1 or later for the TypeScript 7 backend, from the directory of the file's tsconfig, and runs that package's own API client and compiler binary. A missing compiler throws a `TYPESCRIPT_ERROR`, and so does an unsupported one, naming its package, version, and path.

Every result now names the compiler that produced it as `compiler: { name, version, source }`. On library and `prinfer/testing` results it is a non-enumerable property, so snapshots, `toEqual`, and `JSON.stringify` output don't change. In the CLI's `--json` output and the MCP tools' structured content it is a field of `result`. Cost lines name the compiler that counted: `cost: 412 instantiations, 96 types (typescript 6.0.3, bundled)`.

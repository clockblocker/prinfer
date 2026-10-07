---
"prinfer": minor
---

`prinfer/testing` is easier to use for type regression tests.

- `inferredCompletions` no longer needs `backend: "typescript7"`; it is the default and still accepted.
- `inferredType`, `inferredTypeInfo`, and `inferredCompletions` accept `{ line, text, occurrence? }` targets. For completions the cursor goes right after the matched text; pass `cursor: "start"` to put it before.
- Teardown is optional: idle TypeScript 7 sessions no longer keep the test process alive. `closeTestingSessions` still shuts them down early.
- Relative string paths resolve against `process.cwd()`, as before; `new URL("../src/module.ts", import.meta.url)` resolves against the test file.
- Lookup failures throw `PrinferError` with the fix in the message: closest declaration names for an unknown name, the line text for missing text, the valid backends and target shapes, and how to resolve a missing relative path.
- The plugin skill, the `setup agents-md` block, and the MCP server instructions point agents writing type tests at `prinfer/testing`.

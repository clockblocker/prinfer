---
"prinfer": minor
---

`prinfer/testing`: the TypeScript 7 helpers are now synchronous. `inferredType` and `inferredTypeInfo` with `backend: "typescript7"`, and `inferredCompletions`, return a plain value instead of a promise. Before, a missing `await` under `bun test` made `toMatchInlineSnapshot()` record `Promise {}`, and the test passed. Now the snapshot records the type.

The TypeScript 7 compiler runs in a worker thread, and each call blocks until it answers. The worker and its compiler don't keep the process alive. The CLI, the MCP server and the library still use the async client.

New `timeout` selector option (milliseconds, default 60000). A test runner's own timeout can't interrupt a blocked call. A TypeScript 7 call that gets no answer in time throws a `TYPESCRIPT_ERROR` and stops that compiler. The next call starts a new one, so a hung compiler fails one test instead of the whole run.

`closeTestingSessions()` still returns a promise, settles on Node and Bun, and is still optional.

This changes how TypeScript 7 results behave in tests that relied on them being promises:

- `expect(await inferredType(...))` keeps working, since awaiting a plain value returns it. The `await` is now optional.
- `.resolves` no longer applies: `await expect(inferredType(file, { name, backend: "typescript7" })).resolves.toBe(...)` fails because the value is not a promise. Write `expect(inferredType(file, { name, backend: "typescript7" })).toBe(...)`.
- Errors are now thrown synchronously instead of rejecting, so `.rejects` and `.catch()` no longer see them. Use `expect(() => inferredType(...)).toThrow(...)` or `try`/`catch`.
- The TypeScript types follow: `inferredType` returns `string`, `inferredTypeInfo` returns `HoverResult` and `inferredCompletions` returns `string[]` on both backends.

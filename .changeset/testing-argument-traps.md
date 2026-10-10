---
"prinfer": patch
---

`prinfer/testing` catches two easy mistakes in untyped test files. Options passed as a third argument, such as `inferredType(file, { name }, { backend: "typescript7" })`, used to be ignored; now they throw with a message saying to move them into the selector. Unknown selector keys throw too, and suggest the closest valid key (`includeDocs` gets "Did you mean include_docs?").

A TypeScript 7 result that is snapshotted without `await` now fails in Vitest and Jest with a message saying to await it. Before, the snapshot recorded `Promise {}`. Bun's snapshot serializer still records `Promise {}`, but a failed `toBe` now prints the same hint.

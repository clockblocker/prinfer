---
"prinfer": minor
---

`prinfer/testing` catches two easy mistakes in untyped test files. Options passed as a third argument, such as `inferredType(file, { name }, { backend: "typescript7" })`, used to be ignored without an error. Now they throw, with a message saying to move them into the selector.

New `strict` selector option for `inferredType`, `inferredTypeInfo`, `inferredTypeCost` and `inferredCompletions`. With `strict: true`, an unknown selector key throws and names the closest valid key (`includeDocs` gets "Did you mean include_docs?"). Without it, unknown keys are ignored as before.

A TypeScript 7 result that is snapshotted without `await` now fails in Vitest and Jest with a message saying to await it. Before, the snapshot recorded `Promise {}`. Bun's snapshot serializer still records `Promise {}`, but a failed `toBe` now prints the same hint.

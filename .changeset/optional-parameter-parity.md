---
"prinfer": minor
---

Optional parameters and properties read the same on every backend, as `tsc` writes them in declaration emit and quick info: `(value: number, digits?: number): string`, not `digits?: number | undefined`. The TypeScript 7 language server already printed them this way; the TypeScript 6 backend (the library, the CLI, and `prinfer/testing` by default) and the `prinfer/testing` TypeScript 7 API now do too, in `signature`, `returnType`, and `overloads`. Update `prinfer/testing` snapshots that hold the old form.

- A `| undefined` the source wrote stays: `digits?: number | undefined` is printed as written.
- A `| undefined` the annotation does not account for stays too: `y?: number | undefined` for `y?: T` in a call with a number, and the properties of `Partial<T>` without `exactOptionalPropertyTypes`.
- Object types inside a signature follow the same rule: `(options?: { verbose?: boolean; }): void`, `(cb?: (x?: number) => void): void`.
- With `exactOptionalPropertyTypes`, hovering a property declared `digits?: number` reports `number` on every backend, as quick info does. TypeScript 6 and the TypeScript 7 API used to report `number | undefined`.
- On the TypeScript 7 language server, `overloads` now match `signature` (they used to keep `| undefined`, so the hovered overload was listed again), and an optional method no longer reports `unionMembers`.

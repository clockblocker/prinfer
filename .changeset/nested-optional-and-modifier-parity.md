---
"prinfer": patch
---

Signatures print the same on every backend in two more places:

- An optional property of an object type inside an array, tuple, type argument, union, intersection, or index or construct signature drops the `| undefined` its `?` implies on TypeScript 6 and the TypeScript 7 API too: `(rows: { z?: string; }[]): void`, as tsc and the TypeScript 7 language server print it. They used to print `z?: string | undefined` there. The language server backend also writes `Array<T>` and `ReadonlyArray<T>` as `T[]` and `readonly T[]`, and the TypeScript 7 API no longer prints tuples as `[ a, b ]`.
- The TypeScript 7 language server backend keeps the `const`, `in`, and `out` modifiers of a type alias's, class's, or interface's type parameters: `Holder<const T extends 1 | 2>`. It used to print `Holder<T extends 1 | 2>`.

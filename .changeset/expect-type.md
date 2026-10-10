---
"prinfer": minor
---

New `expectType` in `prinfer/testing` checks a target's printed type, its cost budget, and its readability in one call, and throws a `TypeExpectationError` that lists every failed check at once: the expected and actual text with the first difference marked, the count against its budget, and each readability issue. It only throws, so it works in any test runner; with a text mismatch the error also carries `actual` and `expected` for Vitest's and Jest's diff.

```ts
expectType(import.meta.url, {
  name: "user",
  printed: "{ id: string; name: string; }",
  maxInstantiations: 500,
  readable: true,
});
```

The selector is `inferredType`'s (`backend`, `compiler`, `sort_unions`, `full`, and `strict` apply) plus `printed`, `maxInstantiations`, `maxTypes`, and `readable`. Costs are always counted on TypeScript 6, also when `backend: "typescript7"` picks the text, and a failed budget names the compiler that counted (`counted on typescript 6.0.3, bundled`). `compiler` applies to the count too; with `backend: "typescript7"`, `compiler: "project"` counts on the project's TypeScript 6 when it has one and on the bundled one otherwise.

---
"prinfer": minor
---

New `expectType` in `prinfer/testing` checks a target's printed type, cost budget, and readability in one call, and throws a `TypeExpectationError` listing every failed check: the expected and actual text with the first difference marked, the count against its budget, and each readability issue. It only throws, so it works in any test runner; on a text mismatch the error carries `actual` and `expected`, so Vitest and Jest show their diff.

```ts
expectType(import.meta.url, {
  name: "user",
  printed: "{ id: string; name: string; }",
  maxInstantiations: 500,
  readable: true,
});
```

The selector is `inferredType`'s plus the checks `printed`, `maxInstantiations`, `maxTypes`, and `readable`. Costs are counted on TypeScript 6 even with `backend: "typescript7"`, which only picks where the text comes from.

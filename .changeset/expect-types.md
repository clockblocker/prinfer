---
"prinfer": minor
---

New `expectTypes` in `prinfer/testing` runs `expectType` on several targets of one file, with a budget for all of them together, and throws one `TypeExpectationError` listing every failed check: each entry's, with its `index`, and the group budget's, with every entry's own count.

```ts
expectTypes(import.meta.url, {
  types: [{ name: "userSchema", maxInstantiations: 3_000 }, { name: "User", printed: "{ id: string; }" }],
  maxInstantiations: 8_000,
});
```

The group budget counts one fresh TypeScript 6 checker resolving every target, so work they share is counted once, as a type check of the module counts it. Targets are resolved in source order, so the total doesn't depend on the order of `types` (a checker's count can otherwise differ by a type with the order it meets them in). `project`, `compiler`, and `costCompiler` go on the group; `backend`, `full`, `sort_unions`, `readable`, and `timeout` there are defaults for every entry.

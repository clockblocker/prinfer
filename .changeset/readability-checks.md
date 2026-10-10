---
"prinfer": minor
---

New readability checks in `prinfer/testing`: `typeReadabilityIssues(text, rules?)` for printed type text, `inferredTypeIssues(file, selector)` for a target, and `expectType`'s `readable` option. The default rules flag unresolved utility types (`Omit<User, "id">`, `Pick`, `Partial`, and the rest of `DEFAULT_UTILITY_TYPES`) at any depth, except over a type parameter of the printed signature; intersections with an object type (`User & { id: string; }`, but not `string & {}`); and truncation (`... 3 more ...`, `{ ...; }`, text cut at the length limit). The text is read with the TypeScript scanner and parser, so string literal types such as `"Omit<"` don't count. Rules take `utilityTypes` (your own aliases, or `false`), `objectIntersections`, `truncation`, and `allow` for fragments that are fine as printed.

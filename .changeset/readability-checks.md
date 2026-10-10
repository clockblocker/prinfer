---
"prinfer": minor
---

New readability checks in `prinfer/testing`: `typeReadabilityIssues(text, rules?)` for printed type text, `inferredTypeIssues(file, selector)` for a target's type, and `expectType`'s `readable` check. The default rules flag:

- unresolved utility types (`Omit<User, "id">`, `Pick`, `Partial`, and the rest of `DEFAULT_UTILITY_TYPES`) at any depth, unless they apply to a type parameter of the printed signature;
- intersections with an object type (`User & { id: string; }`, but not `string & {}`);
- truncation (`... 3 more ...`, `{ ...; }`, text cut at the length limit).

The text is parsed with the TypeScript scanner and parser, so a string literal type such as `"Omit<"` doesn't count. Rules take `utilityTypes` (your own names, or `false`), `objectIntersections`, `truncation`, and `allow` for fragments that are fine as printed.

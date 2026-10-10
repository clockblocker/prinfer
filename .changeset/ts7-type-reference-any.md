---
"prinfer": patch
---

TypeScript 7 testing API: a name in a type position (`Holder` in `let h: Holder<1>`, `ns.T`, an imported type, an enum, a type parameter, `interface A extends B<1>`) printed `any`; it now prints the declared type, as on TypeScript 6 (`Holder<T>`). The language-server backend's `unionMembers` for such a name (`let p: Pair`) now matches too.

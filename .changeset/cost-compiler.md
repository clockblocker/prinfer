---
"prinfer": minor
---

`expectType` takes `costCompiler` (`"bundled"`, `"project"`, or `"auto"`; default `compiler`'s) to count budgets on another TypeScript 6 than the one that prints: `{ backend: "typescript7", costCompiler: "project" }` prints on the bundled TypeScript 7 and counts on the project's TypeScript 6. A failed budget now names both compilers (`counted on typescript 5.9.3, project; printed on typescript 7.0.2, bundled`, or `counted and printed on ...` when they are the same), and a passing `expectType` result names the printing one in its non-enumerable `compiler`. `inferredTypeCost`, which only counts, throws on `costCompiler`: its `compiler` already picks the counting one.

---
"prinfer": minor
---

New `sort_unions` option prints union members in a fixed order, the same on TypeScript 6 and TypeScript 7, which order members differently. A `prinfer/testing` snapshot written with `inferredType(import.meta.url, { name: "x", sort_unions: true })` now holds on both backends. Every union in the type is sorted, at any depth: members by their printed text, with `null` and `undefined` last. Off by default; also available on the library's hover options and as `--sort-unions` on the CLI.

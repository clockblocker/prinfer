---
"prinfer": minor
---

An explicit `project` now works on the TypeScript 7 backend for any tsconfig that includes the file, not only the one the language server picks itself (the nearest `tsconfig.json`, or a project it references). An unreferenced `tsconfig.test.json` or `tsconfig.app.json` used to fail with `INVALID_ARGUMENT`; it is now opened through the TypeScript 7 API in the same warm session, so hovers, `hover_by_name`, `batch_hover` and `diagnostics` (MCP, `prinfer check --backend typescript7`) answer with that tsconfig's options. Hovers in such a project come from the checker, as in `prinfer/testing`, and have no `display`. Requests without `project`, or with the tsconfig the language server picks, are unchanged.

A tsconfig that doesn't include the file still fails with `INVALID_ARGUMENT`; the message now says so and suggests the `typescript6` backend, which adds the file to any project.

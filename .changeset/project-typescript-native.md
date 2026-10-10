---
"prinfer": minor
---

`compiler: "project"` also finds a project's `@typescript/native` (an alias of `typescript` 7, the name prinfer itself installs it under) for the TypeScript 7 backend. The nearest install wins, as before; side by side, `typescript` 7 comes first, then `@typescript/native`, then `@typescript/native-preview`. A dev build under any name is held to the same 7.0.0-dev.20260624.1 minimum.

Fixed: when a package manager hoists prinfer's own `typescript` or `@typescript/native` into the project's node_modules, `"project"` no longer runs it as if it were the project's. It counts only if the project's nearest package.json, or its workspace root's, declares the package; otherwise `"project"` throws, naming the copy it skipped, and `"auto"` uses the bundled compiler.

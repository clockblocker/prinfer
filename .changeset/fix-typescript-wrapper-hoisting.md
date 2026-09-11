---
"prinfer": patch
---

Depend directly on TypeScript 6 so Bun cannot hoist the compatibility wrapper into its own internal dependency and initialize an empty compiler host.

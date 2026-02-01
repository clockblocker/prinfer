---
"prinfer": minor
---

Replace name-based lookup with position-based hover API

BREAKING CHANGE: The API has changed from name-based to position-based lookup.

- New `hover(file, line, column, options?)` function replacing name-based lookup
- CLI syntax changed to `prinfer file:line:column [--docs] [--project path]`
- MCP tool changed to `hover` with file, line, column parameters
- Returns instantiated generic types at call sites
- JSDoc/TSDoc extraction with `include_docs` option
- Returns symbol kind and name in results

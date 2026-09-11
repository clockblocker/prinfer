# prinfer

## 2.1.0

### Minor Changes

- Collapse long hover types by default and add `--full` and the programmatic `full` option for untruncated output.

  Add optional per-symbol type-resolution timing to the MCP, CLI, and programmatic interfaces without including startup, project-loading, or lookup time.

## 2.0.0

### Major Changes

- c85e4bc: Make the MCP interface easier for agents to consume with structured errors,
  structured batch-item failures, validated 1-based positions, a bounded batch
  size, and a canonical `hover_by_name` tool. Retain `hoverByName` as a deprecated
  compatibility alias and clarify the intentionally default TypeScript 7 backend.

  The batch item `error` field now contains a structured error object instead of
  a string.

### Minor Changes

- bab9441: Add runner-neutral inferred-type snapshot helpers under `prinfer/testing`.
  Retain `prinfer/vitest` as a deprecated compatibility alias.

## 1.0.0

### Major Changes

- 42376a6: Remove `inferType` and `inferTypeFromOptions` from public API. Use `hover()` instead for type lookups.

## 0.6.0

### Minor Changes

- 9f5cec0: Replace name-based lookup with position-based hover API

  BREAKING CHANGE: The API has changed from name-based to position-based lookup.

  - New `hover(file, line, column, options?)` function replacing name-based lookup
  - CLI syntax changed to `prinfer file:line:column [--docs] [--project path]`
  - MCP tool changed to `hover` with file, line, column parameters
  - Returns instantiated generic types at call sites
  - JSDoc/TSDoc extraction with `include_docs` option
  - Returns symbol kind and name in results

### Patch Changes

- 0397e29: Rename `/check-type` skill command to `/hover` for consistency with the API naming

## 0.5.3

### Patch Changes

- fix: use `claude mcp add` instead of manual config file writing

## 0.5.2

### Patch Changes

- 3b9dd90: Fix: use settings.json for Claude Code MCP configuration instead of claude_desktop_config.json

## 0.5.1

### Patch Changes

- 7aeb91f: Fix postinstall script to skip when dist folder is not built yet

## 0.5.0

### Minor Changes

- b30545c: Add `prinfer setup` command and improve help

  - Run `prinfer setup` to manually configure MCP server and skill
  - `prinfer-mcp --help` now shows setup instructions
  - Better error messages when auto-install fails

## 0.4.2

### Patch Changes

- ab0ae9e: Add logo to README and rename skill file to prefer-infer.md

## 0.4.1

### Patch Changes

- 0ddb3e8: Update README with "typehints for your AI agent" positioning.

## 0.4.0

### Minor Changes

- 39a73e8: Add auto-installed Claude skill on global install. Includes coding guideline for type inference and `/check-type` slash command.

## 0.3.0

### Minor Changes

- 66a3c64: Add MCP server support. Run `prinfer-mcp` to start the MCP server for use with Claude Code or Claude Desktop.

## 0.2.1

### Patch Changes

- 278e9d4: Add line-based type inference support. You can now specify a line number to find variables at specific locations using `file.ts:75 varName` syntax.

## 0.2.0

### Minor Changes

- a10dc10: Initial release of prinfer - TypeScript type inference inspection tool.

  Features:

  - CLI command (`prinfer <file> <name>`) to inspect inferred types
  - Programmatic API (`inferType()`) for library consumers
  - Dual ESM/CJS builds with TypeScript type declarations
  - Automatic tsconfig.json detection

# prinfer

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

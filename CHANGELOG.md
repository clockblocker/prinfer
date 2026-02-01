# prinfer

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

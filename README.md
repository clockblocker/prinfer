<p align="center">
  <img src="printfer-logo.webp" alt="prinfer logo" width="400">
</p>

# prinfer

**Typehints for your AI agent.**

Give AI coding assistant the ability to inspect TypeScript's inferred types mimicking the IDE's hover behavior.
so they can write cleaner code without redundant type annotations.

## Why?

AI agents write TypeScript, but they can't see what the compiler infers. This leads to:

- Unnecessary explicit type annotations everywhere
- Verbose code that fights against TypeScript's design
- Missed opportunities to leverage type inference

prinfer solves this by exposing TypeScript's type inference to your agent via MCP.

## Quick Start

```bash
npm i -g prinfer
```

or

```bash
bun add -g prinfer
```

Installation does not modify any agent configuration. Configure the Codex
adapter explicitly:

```bash
prinfer setup codex
```

To inspect the command without changing configuration:

```bash
prinfer setup codex --print
```

## Interfaces

### MCP Server (`prinfer-mcp`)

Your agent gets tools to check what TypeScript infers:

```
hover(file: "src/utils.ts", line: 75, column: 10)
hover(file: "src/utils.ts", line: 75, column: 10, include_docs: true)

hoverByName(file: "src/utils.ts", name: "createHandler")
hoverByName(file: "src/utils.ts", name: "createHandler", line: 75)

batch_hover(file: "src/utils.ts", positions: [{line: 75, column: 10}, {line: 100, column: 5}])
```

The position-based API matches IDE behavior and returns instantiated generic types at call sites. The name-based API is useful when you know the symbol name but not the exact position.

### Experimental TypeScript 7 backend

The MCP tools accept `backend: "typescript7"` to use the native TypeScript 7
language server. The server process is kept warm and shared across hover
requests for the same project:

```text
hover(file: "src/utils.ts", line: 75, column: 10, backend: "typescript7")
```

The MCP server uses this backend by default. This backend is experimental
because TypeScript 7.0's LSP is stable for editors, but its programmatic API
and output mapping are not yet stable. Use `backend: "typescript6"` for one
request or set `PRINFER_BACKEND=typescript6` on the MCP server process to use
the existing compiler-API implementation.

## Manual Setup

The Codex adapter uses the standard Codex MCP command. You can run it manually
with the installed `prinfer-mcp` binary:

```bash
codex mcp add prinfer -- prinfer-mcp
```

## CLI Usage

prinfer also works as a standalone CLI:

```bash
# By position (line:column)
prinfer src/utils.ts:75:10
prinfer src/utils.ts:75:10 --docs

# Machine-readable output
prinfer src/utils.ts:75:10 --json

# By symbol name
prinfer src/utils.ts:createHandler
prinfer src/utils.ts:createHandler:75    # with line hint

prinfer src/utils.ts:75:10 --project ./tsconfig.json
```

Output:

```
(x: number, y: string) => boolean
returns: boolean
name: myFunction
kind: function
docs: Adds two numbers together.
```

### JSON contract

Pass `--json` to emit the versioned contract on stdout. Successful commands
exit with status 0:

```json
{
  "version": 1,
  "ok": true,
  "result": {
    "signature": "(x: number) => string",
    "returnType": "string",
    "line": 75,
    "column": 10,
    "kind": "function",
    "name": "createHandler"
  }
}
```

Failures emit the same contract on stdout and exit with status 1. Stderr stays
empty in JSON mode. Stable error codes are `INVALID_ARGUMENT`,
`FILE_NOT_FOUND`, `SYMBOL_NOT_FOUND`, `TYPESCRIPT_ERROR`, and `INTERNAL_ERROR`.

```json
{
  "version": 1,
  "ok": false,
  "error": {
    "code": "SYMBOL_NOT_FOUND",
    "message": "No symbol named \"missing\" found",
    "file": "/project/src/utils.ts"
  }
}
```

## Programmatic API

```typescript
import { hover, batchHover } from "prinfer";

// By position (line, column)
const result = hover("./src/utils.ts", 75, 10);
// => { signature: "(x: number) => string", returnType: "string", line: 75, column: 10, kind: "function", name: "myFunction" }

// By symbol name
const result2 = hover("./src/utils.ts", "createHandler");
// => { signature: "(config: Config) => Handler", ... }

// By name with line hint (for duplicate names)
const result3 = hover("./src/utils.ts", "createHandler", { line: 75 });

// With documentation
const result4 = hover("./src/utils.ts", 75, 10, { include_docs: true });
// => { ..., documentation: "Formats a number as a string." }

// With custom tsconfig
const result5 = hover("./src/utils.ts", 75, 10, { project: "./tsconfig.json" });

// Batch mode - multiple positions, single program load
const batch = batchHover("./src/utils.ts", [
  { line: 75, column: 10 },
  { line: 100, column: 5 },
]);
// => { items: [...], successCount: 2, errorCount: 0 }
```

## Requirements

- Node.js >= 20.0.0

## Development

The repository uses TypeScript 7 for type-checking (`bun run typecheck`).
Because TypeScript 7.0 does not yet expose a stable programmatic API, the
TypeScript 6 compatibility package is installed alongside it for `prinfer`'s
compiler-API integration and declaration bundling. It is isolated as an
internal dependency, so projects using TypeScript 7 do not need to alias or
downgrade their own `typescript` package.

## License

MIT

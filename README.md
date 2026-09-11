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
hover(file: "src/utils.ts", line: 75, column: 10, include_timing: true)

hover_by_name(file: "src/utils.ts", name: "createHandler")
hover_by_name(file: "src/utils.ts", name: "createHandler", line: 75)

batch_hover(file: "src/utils.ts", positions: [{line: 75, column: 10}, {line: 100, column: 5}])
```

The position-based API matches IDE behavior and returns instantiated generic types at call sites. The name-based API is useful when you know the symbol name but not the exact position. The former `hoverByName` MCP tool remains as a deprecated compatibility alias; new integrations should use `hover_by_name`.

Line and column values are positive, 1-based integers. `batch_hover` accepts 1-100 positions per request. Batch failures are returned per item with stable error codes, resolved paths, detected project configuration, nearby symbol candidates when available, and recovery suggestions, so one bad position does not discard successful results.

### Optional timing

Pass `include_timing: true` to `hover`, `hover_by_name`, or `batch_hover` to
measure type resolution. Timing is omitted by default:

```json
{
  "resolution_ms": 18.42
}
```

This intentionally excludes prinfer startup, project loading, cache state, file
reading, and name/position lookup. TypeScript 6 measures the in-process checker
operation that produces the hover type. TypeScript 7 measures the native
language-server hover exchange after the server is ready and the document is
open. `batch_hover` reports `resolution_ms` independently on every successful
item and does not expose aggregate wall-clock timing.

### Experimental TypeScript 7 backend

The MCP tools accept `backend: "typescript7"` to use the native TypeScript 7
language server. The server process is kept warm and shared across hover
requests for the same project:

```text
hover(file: "src/utils.ts", line: 75, column: 10, backend: "typescript7")
```

The MCP server intentionally uses this backend by default. It provides the
closest match to current editor hover behavior, keeps one warm language-server
session per project, and is the path prinfer expects most agents to use.

It is labelled experimental because TypeScript 7.0's programmatic API and
hover-output mapping may still change. If a request fails or its output differs
from your editor, retry that request with `backend: "typescript6"`. To use the
compiler-API implementation for every request, set
`PRINFER_BACKEND=typescript6` on the MCP server process. Explicit `backend`
arguments always override the environment setting.

### MCP error contract

MCP failures include both human-readable text and versioned structured content:

```json
{
  "version": 1,
  "ok": false,
  "error": {
    "code": "SYMBOL_NOT_FOUND",
    "message": "No symbol found at /project/src/utils.ts:75:10",
    "file": "/project/src/utils.ts",
    "line": 75,
    "column": 10,
    "project": "/project/tsconfig.json",
    "candidates": ["createHandler", "handler"],
    "suggestion": "Try hover_by_name when you know the symbol name, or move the position onto the symbol token."
  }
}
```

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
prinfer src/utils.ts:75:10 --timing --json

# By symbol name
prinfer src/utils.ts:createHandler
prinfer src/utils.ts:createHandler:75    # with line hint

# Long types use editor-style truncation by default; print everything when needed
prinfer src/utils.ts:largeType --full

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

// Disable editor-style truncation for long types
const full = hover("./src/utils.ts", "largeType", { full: true });

// Include only the hovered symbol's type-resolution timing
const timed = hover("./src/utils.ts", 75, 10, { include_timing: true });

// Batch mode - multiple positions, single program load
const batch = batchHover("./src/utils.ts", [
  { line: 75, column: 10 },
  { line: 100, column: 5 },
]);
// => { items: [...], successCount: 2, errorCount: 0 }
```

## Inferred type snapshots

Use the runner-neutral `prinfer/testing` entry point with ordinary snapshot
matchers in Vitest, Bun, Jest, and compatible test runners. Passing
`import.meta.url` keeps the lookup stable
when the test file moves; selecting a uniquely named declaration avoids brittle
line and column literals.

```typescript
import { expect, test } from "vitest";
import { inferredType } from "prinfer/testing";

const result = createRouter({ users: usersRoute });

test("preserves the public inferred type", () => {
  expect(inferredType(import.meta.url, { name: "result" }))
    .toMatchInlineSnapshot(`"Router<{ users: UserRoute; }>"`);
});
```

Update snapshots with the test runner's normal update command. TypeScript types
are erased at runtime, so the helper inspects the test source through the
nearest `tsconfig.json` rather than inspecting the runtime value.
The former `prinfer/vitest` entry point remains as a deprecated compatibility
alias.

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

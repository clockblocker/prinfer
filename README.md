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

On install, prinfer automatically configures itself for Claude Code. If auto-setup doesn't run (common with global installs), run:

```bash
prinfer setup
```

## What Gets Installed

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

### Claude Skill (`~/.claude/skills/prefer-infer.md`)

A coding guideline that encourages your agent to:

- Rely on type inference instead of explicit annotations
- Use prinfer to verify types before adding redundant hints
- Write idiomatic TypeScript

Plus a `/hover` command for quick lookups.

## Manual Setup

If `prinfer setup` doesn't work, configure manually:

**1. Add MCP server** using the Claude CLI:

```bash
claude mcp add prinfer node /path/to/node_modules/prinfer/dist/mcp.js
```

**2. Create skill file** at `~/.claude/skills/prefer-infer.md` with content from [prefer-infer.md](https://github.com/clockblocker/prinfer/blob/master/src/postinstall.ts#L10-L42)

## CLI Usage

prinfer also works as a standalone CLI:

```bash
# By position (line:column)
prinfer src/utils.ts:75:10
prinfer src/utils.ts:75:10 --docs

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

- Node.js >= 18.0.0
- TypeScript >= 4.7.0 (peer dependency)

## License

MIT

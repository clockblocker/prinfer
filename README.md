<p align="center">
  <img src="printfer-logo.webp" alt="prinfer logo" width="400">
</p>

# prinfer

**Typehints for your AI agent.**

prinfer gives AI coding assistants the ability to inspect TypeScript's inferred types — so they can write cleaner code without redundant type annotations.

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

Your agent gets an `infer_type` tool to check what TypeScript infers:

```
infer_type(file: "src/utils.ts", name: "myFunction")
infer_type(file: "src/utils.ts", name: "commandResult", line: 75)
```

### Claude Skill (`~/.claude/skills/prefer-infer.md`)

A coding guideline that encourages your agent to:

- Rely on type inference instead of explicit annotations
- Use prinfer to verify types before adding redundant hints
- Write idiomatic TypeScript

Plus a `/check-type` command for quick lookups.

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
prinfer src/utils.ts myFunction
prinfer src/utils.ts:75 commandResult
```

Output:

```
(x: number, y: string) => boolean
returns: boolean
```

## Programmatic API

```typescript
import { inferType } from "prinfer";

const result = inferType("./src/utils.ts", "myFunction");
// => { signature: "(x: number, y: string) => boolean", returnType: "boolean", line: 4 }

// With line number for disambiguation
const result2 = inferType("./src/utils.ts", "commandResult", { line: 75 });
```

## Requirements

- Node.js >= 18.0.0
- TypeScript >= 4.7.0 (peer dependency)

## License

MIT

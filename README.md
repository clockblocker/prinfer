# prinfer

TypeScript type inference inspection tool. Inspect the inferred types of functions and variables in your TypeScript code.

## Installation

```bash
npm install prinfer
```

## CLI Usage

```bash
# Basic usage
prinfer src/utils.ts myFunction

# Find variable at specific line
prinfer src/utils.ts:75 commandResult

# With custom tsconfig
prinfer src/utils.ts myFunction --project ./tsconfig.json

# Show help
prinfer --help
```

### Output

```
(x: number, y: string) => boolean
returns: boolean
```

## Programmatic API

```typescript
import { inferType } from "prinfer";

// Basic usage
const result = inferType("./src/utils.ts", "myFunction");
console.log(result.signature);
// => "(x: number, y: string) => boolean"
console.log(result.returnType);
// => "boolean"

// Find variable at specific line
const result2 = inferType("./src/utils.ts", "commandResult", { line: 75 });
console.log(result2.signature);
// => "Result<VaultAction[], CommandError>"

// With custom tsconfig
const result3 = inferType("./src/utils.ts", "myFunction", { project: "./tsconfig.json" });
```

### API Reference

#### `inferType(file, name, options?)`

Infer the type of a function or variable in a TypeScript file.

**Parameters:**
- `file` - Path to the TypeScript file
- `name` - Name of the function/variable to inspect
- `options` - Optional object with:
  - `line` - Line number to narrow search (1-based)
  - `project` - Path to tsconfig.json

**Returns:** `InferredTypeResult`
- `signature` - The inferred type signature
- `returnType` - The return type (for functions)
- `line` - The line number where the symbol was found

#### Types

```typescript
interface Options {
  file: string;
  name: string;
  line?: number;
  project?: string;
}

interface InferredTypeResult {
  signature: string;
  returnType?: string;
  line?: number;
}
```

## MCP Server (Claude Integration)

prinfer includes an MCP server for use with Claude Code or Claude Desktop.

### Setup for Claude Code

Add to your `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "prinfer": {
      "command": "npx",
      "args": ["prinfer-mcp"]
    }
  }
}
```

Or if installed globally (`npm i -g prinfer`):

```json
{
  "mcpServers": {
    "prinfer": {
      "command": "prinfer-mcp"
    }
  }
}
```

### Tool Usage

Once configured, Claude can use the `infer_type` tool:

```
infer_type(file: "src/utils.ts", name: "myFunction")
infer_type(file: "src/utils.ts", name: "commandResult", line: 75)
```

### Auto-installed Skill

When you install prinfer globally (`npm i -g prinfer`), a Claude skill is automatically added to `~/.claude/skills/prinfer.md`. This provides:

1. **Coding guideline** - Encourages Claude to prefer type inference over explicit annotations
2. **`/check-type` command** - Check types directly: `/check-type src/utils.ts:75 commandResult`

## Requirements

- Node.js >= 18.0.0
- TypeScript >= 4.7.0 (peer dependency)

## License

MIT

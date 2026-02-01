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

// With custom tsconfig
const result2 = inferType("./src/utils.ts", "myFunction", "./tsconfig.json");
```

### API Reference

#### `inferType(file, name, project?)`

Infer the type of a function or variable in a TypeScript file.

**Parameters:**
- `file` - Path to the TypeScript file
- `name` - Name of the function/variable to inspect
- `project` - Optional path to tsconfig.json

**Returns:** `InferredTypeResult`
- `signature` - The inferred type signature
- `returnType` - The return type (for functions)

#### Types

```typescript
interface Options {
  file: string;
  name: string;
  project?: string;
}

interface InferredTypeResult {
  signature: string;
  returnType?: string;
}
```

## Requirements

- Node.js >= 18.0.0
- TypeScript >= 4.7.0 (peer dependency)

## License

MIT

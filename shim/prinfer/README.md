# prinfer is now typeprobe

prinfer was renamed to [typeprobe](https://www.npmjs.com/package/typeprobe) in 4.0.0. This last prinfer release, 3.5.0, is a thin package that depends on `typeprobe@^4.0.0` and forwards to it, so existing setups keep working while you switch:

- `prinfer`, `prinfer/testing` and `prinfer/vitest` re-export `typeprobe`, `typeprobe/testing` and `typeprobe/vitest` (ESM, CommonJS and types).
- The `prinfer` command runs `typeprobe` and prints one notice line on stderr. `prinfer mcp` and `prinfer-mcp` start the typeprobe MCP server and print nothing, so MCP configs such as `npx -y prinfer mcp` keep working.
- `PRINFER_BACKEND` and `PRINFER_COMPILER` are still read when the `TYPEPROBE_*` variables are unset, and `PrinferError` is still exported as an alias of `TypeprobeError`.

prinfer gets no further releases. Move to typeprobe:

```bash
npm rm prinfer && npm i -D typeprobe
```

```diff
- import { inferredType } from "prinfer/testing";
+ import { inferredType } from "typeprobe/testing";
```

Then re-register the MCP server; setup replaces the old `prinfer` entry instead of adding a second one:

```bash
npx -y typeprobe setup claude    # or codex, cursor, vscode, gemini
```

The full migration guide is in the [typeprobe README](https://github.com/clockblocker/typeprobe#migrating-from-prinfer).
